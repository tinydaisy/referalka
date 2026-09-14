"""
Бонус в ПЛЮСОНе за оплату тарифа события (миграция 307).

Клиент кладёт внутрь своего тарифа доступ к модулю ПЛЮСОНа (напр.
Коллабораторную). Человек оплатил тариф → вебхук зовёт `grant_tariff_bonus`,
и покупатель получает кабинет ПЛЮСОНа с этим модулем. Раньше это делалось
руками: создать кабинет, выдать модуль, выслать доступы.

Что делает выдача:
  1. Ищет кабинет по почте покупателя. Нашёлся → продлеваем модуль.
  2. Не нашёлся → создаём кабинет и выдаём модуль. Реферал — владелец
     события: он привёл человека, кэшбэк его.
  3. Письмо покупателю: что он получил + ссылка «задайте пароль».
  4. Уведомление владельцу события в его боты.

⚠️ ГЕЙТ ПО ФИЧЕ `tariff_plusson_bonus`, проверяется у ВЛАДЕЛЬЦА события.
Деньги за тариф уходят на кассу клиента, а модуль списывается с ПЛЮСОНа —
поэтому фича есть только там, где касса общая с платформой (тариф `admin`).
Проверка идёт в момент ВЫДАЧИ, а не только при настройке: фичу могли снять
после того, как тариф уже настроили.

⚠️ Пароль в письме не отправляем — шлём ссылку на установку пароля
(`/password-reset/confirm?token=`), как при восстановлении. Пароль в почте
живёт в переписке вечно и утекает вместе с ящиком.

⚠️ Идемпотентность — таблица `tariff_bonus_grants` с UNIQUE по заказу.
Платёжные системы шлют оповещение по нескольку раз; без журнала повторный
вебхук выдал бы модуль ещё раз и повторно отправил письмо.
"""
import hashlib
import logging
import secrets
import string
from datetime import datetime, timedelta

import asyncpg

from app.services.addon_grant import grant_addon

logger = logging.getLogger(__name__)

# Ссылка на установку пароля живёт дольше часа (как у восстановления):
# человек читает письмо не сразу, а промахнувшись — останется без доступа,
# за который заплатил.
PASSWORD_LINK_TTL_HOURS = 72


async def _owner_client_id(db: asyncpg.Connection, event_id: int) -> int | None:
    """Владелец события. У `events` своего client_id нет — только event_owners."""
    return await db.fetchval(
        """SELECT client_id FROM event_owners
            WHERE event_id = $1 AND status = 'accepted'
            ORDER BY id LIMIT 1""",
        event_id,
    )


async def _buyer_identity(db: asyncpg.Connection, order) -> tuple[str | None, str | None, str | None]:
    """Почта, имя и телефон покупателя.

    ⚠️ Почта — это ИДЕНТИЧНОСТЬ (`platform_users` с platform_slug='email'),
    колонки `contacts.email` не существует (мигр. 282).
    """
    contact_id = order["contact_id"]
    if not contact_id:
        return None, None, None
    row = await db.fetchrow(
        """SELECT c.name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email
             FROM contacts c WHERE c.id = $1""",
        contact_id,
    )
    if not row:
        return None, None, None
    email = (row["email"] or "").strip().lower() or None
    return email, (row["name"] or None), (row["phone"] or None)


async def _record(db, *, order_id, tariff_id, feature_id, months,
                  client_id, client_created, email, status, note=None) -> None:
    """Журнал выдачи. Пишем и удачи, и отказы — оплаченный бонус не должен
    теряться молча: по этой таблице видно, кому не досталось и почему."""
    await db.execute(
        """INSERT INTO tariff_bonus_grants
             (order_id, event_tariff_id, feature_id, months, client_id,
              client_created, email, status, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (order_id) DO NOTHING""",
        order_id, tariff_id, feature_id, months, client_id,
        client_created, email, status, note,
    )


async def _create_client(db, *, email: str, name: str | None, phone: str | None,
                         referrer_client_id: int | None) -> int:
    """Создаёт кабинет ПЛЮСОНа под покупателя.

    Пароль ставим случайный и НИКОМУ не показываем — человек задаёт свой по
    ссылке из письма. Подписка — обычный триал, как при самостоятельной
    регистрации: бонусом идёт МОДУЛЬ, а не тариф.
    """
    alphabet = "23456789abcdefghjkmnpqrstuvwxyz"
    ref_code = None
    for _ in range(20):
        cand = "".join(secrets.choice(alphabet) for _ in range(8))
        if not await db.fetchval("SELECT 1 FROM clients WHERE referral_code = $1", cand):
            ref_code = cand
            break
    if not ref_code:
        raise RuntimeError("не удалось сгенерировать реф-код")

    from app.auth import hash_password
    random_pw = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(24))

    trial = await db.fetchrow(
        "SELECT id, COALESCE(default_duration_days, 7) AS dur FROM tariffs WHERE slug = 'trial'"
    )

    client_id = await db.fetchval(
        """INSERT INTO clients (name, email, phone, password_hash, integration_token,
                                referral_code, referred_by_client_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id""",
        (name or email.split("@")[0])[:200], email, phone,
        hash_password(random_pw), secrets.token_hex(32), ref_code, referrer_client_id,
    )

    await db.execute(
        "INSERT INTO client_bonus_balance (client_id, balance_kopecks) VALUES ($1, 0) "
        "ON CONFLICT DO NOTHING",
        client_id,
    )

    # Без активной подписки middleware блокирует любые правки в кабинете —
    # человек вошёл бы в неработающий кабинет.
    if trial:
        sub_id = await db.fetchval(
            """INSERT INTO client_subscriptions
                 (client_id, tariff_id, started_at, expires_at, status, source)
               VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'trial')
               RETURNING id""",
            client_id, trial["id"], str(int(trial["dur"] or 7)),
        )
        await db.execute(
            "UPDATE clients SET current_subscription_id = $1 WHERE id = $2", sub_id, client_id)

    await db.execute(
        "INSERT INTO client_modules (client_id, module_slug) VALUES ($1, 'base') "
        "ON CONFLICT DO NOTHING",
        client_id,
    )

    # Архитектура G: новому клиенту привязываем только системный email-канал.
    await db.execute(
        """INSERT INTO client_channels (client_id, channel_id, is_active)
           SELECT $1, ch.id, TRUE FROM channels ch
            WHERE ch.is_system AND NOT ch.is_test AND ch.platform_slug = 'email'
           ON CONFLICT DO NOTHING""",
        client_id,
    )

    # Ставка реф-программы замораживается на клиенте при рождении (мигр. 227).
    if referrer_client_id:
        try:
            from app.services.referral_rate import freeze_rate_for_new_client
            await freeze_rate_for_new_client(db, client_id)
        except Exception:
            logger.warning("bonus: не удалось заморозить реф-ставку у клиента %s", client_id)

    return client_id


async def _grant_module(db, *, client_id: int, feature_id: int, months: int) -> None:
    """Выдаёт/продлевает модуль.

    Модуль уже активен → срок ПРИБАВЛЯЕТСЯ к текущему `expires_at`, а не
    считается с сегодня: иначе оплаченные дни сгорали бы. Так же устроено
    продление при обычной покупке модуля.

    ⚠️ Флаги предупреждений об истечении сбрасываем — иначе при продлении
    таск решит, что уже уведомлял, и клиент не получит предупреждений.
    """
    add_days = 30 * max(1, months)
    # ⚠️ Выдача/продление — ТОЛЬКО через общий grant_addon (см. его докстринг):
    # своя копия падала на уникальном индексе, если у клиента оставалась истёкшая
    # строка со статусом 'active'.
    await grant_addon(
        db,
        client_id=client_id,
        feature_id=feature_id,
        days=add_days,
        source="paid",
        add_months=months,
    )


async def _password_link(db, client_id: int) -> str | None:
    """Одноразовая ссылка «задайте пароль». Тот же механизм, что у
    восстановления пароля — второй сущности заводить незачем."""
    try:
        from app.config import settings
        token = secrets.token_urlsafe(32)
        await db.execute(
            """INSERT INTO password_reset_tokens (client_id, token_hash, expires_at)
               VALUES ($1, $2, $3)""",
            client_id, hashlib.sha256(token.encode()).hexdigest(),
            datetime.utcnow() + timedelta(hours=PASSWORD_LINK_TTL_HOURS),
        )
        return f"{settings.frontend_url.rstrip('/')}/password-reset/confirm?token={token}"
    except Exception:
        logger.exception("bonus: не удалось создать ссылку на пароль для клиента %s", client_id)
        return None


async def _send_email(db, *, client_id: int, to_email: str, feature_name: str,
                      months: int, is_new: bool, password_url: str | None) -> bool:
    """Письмо покупателю. Ошибка отправки выдачу не отменяет — модуль уже
    выдан, и терять его из-за недоступного SMTP неправильно."""
    try:
        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token

        ch = await db.fetchrow(
            """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                      ch.email_subdomain, ch.email_from_local
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1 AND ch.platform_slug = 'email'
                  AND ch.is_system = TRUE
                LIMIT 1""",
            client_id,
        )
        if not ch:
            return False

        channel = dict(ch)
        channel["email_from_name"] = "iViSiON: ПЛЮСОН"

        srok = f"{months} мес." if months > 1 else "1 месяц"
        if is_new:
            body = (
                "Здравствуйте!\n\n"
                f"Вместе с покупкой вам открыт доступ в ПЛЮСОН: «{feature_name}» на {srok}.\n\n"
                "Мы завели для вас кабинет. Задайте пароль по ссылке:\n"
                f"{password_url}\n\n"
                f"Ссылка действует {PASSWORD_LINK_TTL_HOURS} часа. "
                "Если она перестанет работать — восстановите пароль на странице входа, "
                "кабинет уже создан на этот адрес.\n\n"
                "— Команда ПЛЮСОН"
            )
        else:
            body = (
                "Здравствуйте!\n\n"
                f"Вместе с покупкой вам открыт доступ: «{feature_name}» на {srok}.\n\n"
                "Он уже подключён к вашему кабинету ПЛЮСОНа — просто войдите под своей почтой.\n\n"
                "— Команда ПЛЮСОН"
            )

        EmailSender().send(
            channel=channel,
            client_brand_name="iViSiON: ПЛЮСОН",
            to_email=to_email,
            subject=f"Ваш доступ в ПЛЮСОН — {feature_name}",
            body_text=body,
            unsubscribe_token=make_email_unsubscribe_token(
                client_id=client_id, contact_id=0,
                client_channel_id=ch["client_channel_id"] or 0,
            ),
        )
        return True
    except Exception:
        logger.exception("bonus: письмо на %s не отправлено", to_email)
        return False


async def grant_tariff_bonus(db: asyncpg.Connection, order_id: int) -> dict:
    """Выдаёт бонус ПЛЮСОНа по оплаченному заказу тарифа события.

    Зовётся из вебхука оплаты. Никогда не бросает исключений: сбой выдачи
    бонуса не должен ломать обработку самой оплаты (участник уже
    зарегистрирован, деньги приняты).
    """
    try:
        order = await db.fetchrow(
            """SELECT o.id, o.event_id, o.contact_id, o.tariff_id,
                      t.bonus_feature_id, t.bonus_months, t.title AS tariff_title,
                      f.name AS feature_name, f.slug AS feature_slug
                 FROM event_participant_tariffs o
                 LEFT JOIN event_tariffs t ON t.id = o.tariff_id
                 LEFT JOIN features f ON f.id = t.bonus_feature_id
                WHERE o.id = $1""",
            order_id,
        )
        if not order or not order["bonus_feature_id"]:
            return {"ok": True, "skipped": "no_bonus"}

        # Уже выдавали по этому заказу — повторный вебхук.
        if await db.fetchval("SELECT 1 FROM tariff_bonus_grants WHERE order_id = $1", order_id):
            return {"ok": True, "already": True}

        owner_id = await _owner_client_id(db, order["event_id"])
        if not owner_id:
            return {"ok": False, "skipped": "no_owner"}

        # Гейт по фиче — у ВЛАДЕЛЬЦА события, в момент выдачи.
        from app.services.features import client_has_feature
        if not await client_has_feature(db, owner_id, "tariff_plusson_bonus"):
            await _record(db, order_id=order_id, tariff_id=order["tariff_id"],
                          feature_id=order["bonus_feature_id"],
                          months=order["bonus_months"] or 1, client_id=None,
                          client_created=False, email=None, status="failed",
                          note="у владельца события нет фичи tariff_plusson_bonus")
            logger.warning("bonus: заказ %s — у клиента %s нет фичи", order_id, owner_id)
            return {"ok": False, "skipped": "no_feature"}

        months = int(order["bonus_months"] or 1)
        feature_id = order["bonus_feature_id"]
        feature_name = order["feature_name"] or "доступ в ПЛЮСОН"

        email, name, phone = await _buyer_identity(db, order)
        if not email:
            # Без почты кабинет не завести и войти человеку некуда.
            await _record(db, order_id=order_id, tariff_id=order["tariff_id"],
                          feature_id=feature_id, months=months, client_id=None,
                          client_created=False, email=None, status="failed",
                          note="у покупателя нет почты — выдать бонус не удалось")
            logger.error("bonus: заказ %s оплачен, но у покупателя нет почты", order_id)
            return {"ok": False, "skipped": "no_email"}

        client_row = await db.fetchrow(
            "SELECT id FROM clients WHERE LOWER(email) = $1", email)
        is_new = client_row is None

        async with db.transaction():
            if is_new:
                client_id = await _create_client(
                    db, email=email, name=name, phone=phone, referrer_client_id=owner_id)
            else:
                client_id = client_row["id"]
            await _grant_module(db, client_id=client_id, feature_id=feature_id, months=months)
            await _record(db, order_id=order_id, tariff_id=order["tariff_id"],
                          feature_id=feature_id, months=months, client_id=client_id,
                          client_created=is_new, email=email, status="granted")

        # Письмо и уведомление — ВНЕ транзакции: их сбой не должен откатывать
        # уже выданный модуль.
        password_url = await _password_link(db, client_id) if is_new else None
        await _send_email(db, client_id=client_id, to_email=email,
                          feature_name=feature_name, months=months,
                          is_new=is_new, password_url=password_url)

        try:
            from app.services.channels import notify_organizer_all_channels
            who = name or email
            await notify_organizer_all_channels(
                owner_id,
                f"🎁 <b>Бонус ПЛЮСОНа выдан</b>\n\n"
                f"Кто: {who}\nПочта: {email}\n"
                f"Тариф: {order['tariff_title'] or '—'}\n"
                f"Доступ: {feature_name} на {months} мес.\n"
                f"Кабинет: {'создан' if is_new else 'уже был'}",
                db,
            )
        except Exception:
            logger.warning("bonus: уведомление владельцу %s не ушло", owner_id)

        logger.info("bonus: заказ %s → клиент %s (%s), модуль %s на %s мес.",
                    order_id, client_id, "новый" if is_new else "существующий",
                    order["feature_slug"], months)
        return {"ok": True, "client_id": client_id, "created": is_new}

    except Exception:
        logger.exception("bonus: выдача по заказу %s сорвалась", order_id)
        return {"ok": False, "error": True}
