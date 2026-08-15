"""
Бонус ПЛЮСОНа: выдача ПО ССЫЛКЕ, а не в момент оплаты (миграции 308, 309).

Как работает:
  1. Оплата подтверждена → `issue_bonus_coupon` создаёт КУПОН (запись «этому
     человеку положен доступ») и отправляет письмо со ссылкой.
  2. Человек переходит по ссылке → `activate_coupon` заводит кабинет (если
     его нет), включает подписку и модуль. Отсчёт дней идёт С ЭТОГО МОМЕНТА.

⚠️ ПОЧЕМУ НЕ ВЫДАЁМ СРАЗУ. Раньше доступ включался по вебхуку оплаты, и дни
горели, пока письмо лежало непрочитанным: человек открывал его через две
недели и обнаруживал, что от 30 дней осталось 16. Плюс копились кабинеты
тех, кто так и не пришёл.

⚠️ ПРАВИЛО ВЫДАЧИ ОДНО НА ВСЕ СЛУЧАИ (решение владельца):
  • кабинета нет   → полный бесплатный период (база + бонус за реферала);
  • кабинет есть   → 3 дня продления ТЕКУЩЕГО тарифа (Профи→Профи,
                     Экстра→Экстра, триал→триал). Полный период — только
                     для новых, иначе им пользовались бы по кругу.
  • модуль (если задан) выдаётся в обоих случаях на свои дни.

⚠️ Ссылка ОДНОРАЗОВАЯ и живёт 90 дней: вечная всплыла бы через год, когда
цены и состав модулей уже другие.

⚠️ Никаких промокодов человек не вводит — просто переходит по ссылке.
"""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

import asyncpg

from app.services.plusson_bonus_days import bonus_day_numbers
from app.services import plusson_bonus_texts as T

logger = logging.getLogger(__name__)

COUPON_TTL_DAYS = 90


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _link(token: str) -> str:
    from app.services.client_domains import platform_base_url
    return f"{platform_base_url().rstrip('/')}/bonus/{token}"


async def _owner(db, event_id: int):
    """Владелец события: он дарит бонус и становится рефералом покупателя."""
    return await db.fetchrow(
        """SELECT cl.id, cl.name, cl.brand_name
             FROM event_owners eo JOIN clients cl ON cl.id = eo.client_id
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY eo.id LIMIT 1""",
        event_id,
    )


async def _buyer(db, contact_id):
    """Почта, имя, телефон покупателя.

    ⚠️ Почта — ИДЕНТИЧНОСТЬ (`platform_users`), колонки `contacts.email` нет.
    """
    if not contact_id:
        return None, None, None
    r = await db.fetchrow(
        """SELECT c.name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email
             FROM contacts c WHERE c.id = $1""",
        contact_id,
    )
    if not r:
        return None, None, None
    return ((r["email"] or "").strip().lower() or None,
            r["name"] or None, r["phone"] or None)


# ───────────────────────────── 1. Выдача купона ──────────────────────────
async def issue_bonus_coupon(db: asyncpg.Connection, order_id: int) -> dict:
    """Создаёт купон по оплаченному заказу и шлёт письмо со ссылкой.

    Зовётся из вебхука оплаты. Исключений не бросает: деньги уже приняты,
    и сбой бонуса не должен превращаться в ошибку вебхука (платёжка сочтёт
    оповещение недоставленным и начнёт слать повторы).
    """
    try:
        o = await db.fetchrow(
            """SELECT o.id, o.event_id, o.contact_id, o.tariff_id,
                      t.title AS tariff_title, t.bonus_feature_id,
                      COALESCE(t.bonus_days, 30) AS bonus_days,
                      t.bonus_trial, t.bonus_tariff_slug,
                      f.name AS feature_name
                 FROM event_participant_tariffs o
                 LEFT JOIN event_tariffs t ON t.id = o.tariff_id
                 LEFT JOIN features f ON f.id = t.bonus_feature_id
                WHERE o.id = $1""",
            order_id,
        )
        if not o or not (o["bonus_feature_id"] or o["bonus_trial"]):
            return {"ok": True, "skipped": "no_bonus"}

        # Повторный вебхук — норма у платёжек.
        if await db.fetchval(
                "SELECT 1 FROM plusson_bonus_coupons WHERE order_id = $1", order_id):
            return {"ok": True, "already": True}

        owner = await _owner(db, o["event_id"])
        if not owner:
            return {"ok": False, "skipped": "no_owner"}

        # ⚠️ Гейт по фиче — только на ПЛАТНЫЙ модуль. Триал раздают все.
        feature_id = o["bonus_feature_id"]
        if feature_id:
            from app.services.features import client_has_feature
            if not await client_has_feature(db, owner["id"], "tariff_plusson_bonus"):
                logger.warning("bonus: заказ %s — у клиента %s нет фичи на модуль",
                               order_id, owner["id"])
                feature_id = None

        email, name, phone = await _buyer(db, o["contact_id"])
        if not email:
            # Без почты кабинет не завести и письмо не отправить.
            logger.error("bonus: заказ %s оплачен, но у покупателя нет почты", order_id)
            return {"ok": False, "skipped": "no_email"}

        token = secrets.token_urlsafe(32)
        await db.execute(
            """INSERT INTO plusson_bonus_coupons
                 (order_id, event_tariff_id, issuer_client_id, email, contact_id,
                  name, phone, feature_id, days, token_hash, token, expires_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + ($12 || ' days')::interval)
               ON CONFLICT (order_id) DO NOTHING""",
            order_id, o["tariff_id"], owner["id"], email, o["contact_id"],
            name, phone, feature_id, int(o["bonus_days"] or 30),
            _hash(token), token, str(COUPON_TTL_DAYS),
        )

        trial_days, extra_days = await bonus_day_numbers(db)
        existing = await db.fetchval(
            "SELECT id FROM clients WHERE LOWER(email) = $1", email)
        link = _link(token)

        if existing:
            had_module = bool(feature_id) and bool(await db.fetchval(
                """SELECT 1 FROM client_addons
                    WHERE client_id = $1 AND feature_id = $2
                      AND status = 'active' AND expires_at > NOW()""",
                existing, feature_id))
            subject, body = T.purchase_existing(
                tariff_title=o["tariff_title"] or "тариф",
                owner_name=owner["name"], brand_name=owner["brand_name"],
                feature_name=o["feature_name"] if feature_id else None,
                days=int(o["bonus_days"] or 30), had_module=had_module,
                extra_days=extra_days, link=link,
            )
        else:
            subject, body = T.purchase_new(
                tariff_title=o["tariff_title"] or "тариф",
                owner_name=owner["name"], brand_name=owner["brand_name"],
                feature_name=o["feature_name"] if feature_id else None,
                days=int(o["bonus_days"] or 30),
                trial_days=trial_days, link=link,
            )

        await _notify(db, email=email, contact_id=o["contact_id"],
                      client_id=owner["id"], subject=subject, body=body, link=link)
        logger.info("bonus: купон по заказу %s выдан на %s", order_id, email)
        return {"ok": True, "email": email}
    except Exception as e:
        logger.exception("bonus: купон по заказу %s не выдан: %s", order_id, e)
        return {"ok": False, "error": str(e)}


# ───────────────────────────── 2. Активация ──────────────────────────────
async def activate_coupon(db: asyncpg.Connection, token: str) -> dict:
    """Переход по ссылке из письма: заводим доступ, отсчёт с этого момента.

    Возвращает словарь для страницы: что получилось и куда вести человека.
    """
    row = await db.fetchrow(
        """SELECT * FROM plusson_bonus_coupons WHERE token_hash = $1""", _hash(token))
    if not row:
        return {"ok": False, "reason": "not_found"}
    if row["activated_at"]:
        return {"ok": False, "reason": "used", "client_id": row["client_id"]}
    if row["expires_at"] and row["expires_at"] < datetime.now(timezone.utc):
        return {"ok": False, "reason": "expired"}

    trial_days, extra_days = await bonus_day_numbers(db)
    email = row["email"]

    async with db.transaction():
        client = await db.fetchrow(
            "SELECT id FROM clients WHERE LOWER(email) = $1", email)
        is_new = client is None

        if is_new:
            from app.services.tariff_plusson_bonus import _create_client
            client_id = await _create_client(
                db, email=email, name=row["name"], phone=row["phone"],
                referrer_client_id=row["issuer_client_id"])
            # _create_client уже дал базовый триал; доводим до полного срока.
            await _set_subscription(db, client_id, slug="trial", days=trial_days)
        else:
            client_id = client["id"]
            # ⚠️ Действующему — 3 дня к ЕГО тарифу, а не триал: полный период
            # рассчитан на новых, иначе им пользовались бы по кругу.
            await _extend_subscription(db, client_id, days=extra_days)

        if row["feature_id"]:
            from app.services.tariff_plusson_bonus import _grant_module
            # _grant_module считает в месяцах — передаём дни напрямую.
            await _grant_module_days(db, client_id=client_id,
                                     feature_id=row["feature_id"],
                                     days=int(row["days"] or 30))

        await db.execute(
            """UPDATE plusson_bonus_coupons
                  SET activated_at = NOW(), client_id = $2, client_created = $3,
                      outcome = $4
                WHERE id = $1""",
            row["id"], client_id, is_new,
            "new" if is_new else "extended",
        )

    # Ссылка на установку пароля — вне транзакции: её сбой не должен
    # откатывать уже выданный доступ.
    password_url = None
    if is_new:
        from app.services.tariff_plusson_bonus import _password_link
        password_url = await _password_link(db, client_id)

    return {"ok": True, "is_new": is_new, "client_id": client_id,
            "password_url": password_url,
            "days": trial_days if is_new else extra_days}


async def _set_subscription(db, client_id: int, *, slug: str, days: int) -> None:
    """Ставит подписку нужного тарифа на N дней (для нового кабинета)."""
    t = await db.fetchrow("SELECT id FROM tariffs WHERE slug = $1", slug)
    if not t:
        return
    sub_id = await db.fetchval(
        """INSERT INTO client_subscriptions
             (client_id, tariff_id, started_at, expires_at, status, source)
           VALUES ($1,$2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'promo')
           RETURNING id""",
        client_id, t["id"], str(days))
    await db.execute(
        "UPDATE clients SET current_subscription_id = $2 WHERE id = $1",
        client_id, sub_id)


async def _extend_subscription(db, client_id: int, *, days: int) -> None:
    """Продлевает ТЕКУЩУЮ подписку на N дней.

    ⚠️ Тариф не меняем: у кого Профи — продлеваем Профи, у кого триал —
    триал. Понижать оплаченный тариф нельзя, повышать — дарить лишнее.
    Активной подписки нет вовсе → ставим триал на эти же дни, иначе кабинет
    останется нерабочим (middleware блокирует запись).
    """
    cur = await db.fetchrow(
        """SELECT id, expires_at FROM client_subscriptions
            WHERE client_id = $1 AND status = 'active' AND expires_at > NOW()
            ORDER BY expires_at DESC LIMIT 1""",
        client_id)
    if cur:
        await db.execute(
            "UPDATE client_subscriptions SET expires_at = $2 WHERE id = $1",
            cur["id"], cur["expires_at"] + timedelta(days=days))
    else:
        await _set_subscription(db, client_id, slug="trial", days=days)


async def _grant_module_days(db, *, client_id: int, feature_id: int, days: int) -> None:
    """Выдаёт/продлевает модуль на N ДНЕЙ (не месяцев).

    Модуль уже активен → срок прибавляется к текущему, чтобы оплаченные дни
    не сгорали. Флаги предупреждений сбрасываем, иначе таск решит, что уже
    уведомлял об истечении.
    """
    existing = await db.fetchrow(
        """SELECT id, expires_at FROM client_addons
            WHERE client_id = $1 AND feature_id = $2
              AND status = 'active' AND expires_at > NOW()
            ORDER BY expires_at DESC LIMIT 1""",
        client_id, feature_id)
    if existing:
        await db.execute(
            """UPDATE client_addons
                  SET expires_at = $2, notified_7d = FALSE, notified_3d = FALSE,
                      notified_1d = FALSE, updated_at = NOW()
                WHERE id = $1""",
            existing["id"], existing["expires_at"] + timedelta(days=days))
    else:
        await db.execute(
            """INSERT INTO client_addons
                 (client_id, feature_id, started_at, expires_at, status, source, months)
               VALUES ($1,$2, NOW(), NOW() + ($3 || ' days')::interval,
                       'active', 'paid', 1)""",
            client_id, feature_id, str(days))


# ───────────────────────── Доставка сообщения ────────────────────────────
async def _notify(db, *, email: str, contact_id, client_id: int,
                  subject: str, body: str, link: str) -> None:
    """Письмо + сообщение в боты.

    ⚠️ Текст ОДИН на все каналы (plusson_bonus_texts) — в боте ссылка идёт
    кнопкой, в письме кликается сама.
    """
    # 1. Почта — всегда: это единственный канал, который есть у каждого.
    try:
        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token
        ch = await db.fetchrow(
            """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                      ch.email_subdomain, ch.email_from_local
                 FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
                WHERE ch.platform_slug = 'email' AND ch.is_system = TRUE
                LIMIT 1""")
        if ch:
            channel = dict(ch)
            channel["email_from_name"] = "iViSiON: ПЛЮСОН"
            EmailSender().send(
                channel=channel, client_brand_name="iViSiON: ПЛЮСОН",
                to_email=email, subject=subject, body_text=body,
                unsubscribe_token=make_email_unsubscribe_token(
                    client_id=client_id, contact_id=contact_id or 0,
                    client_channel_id=ch["client_channel_id"] or 0),
            )
    except Exception:
        logger.exception("bonus: письмо на %s не отправлено", email)

    # 2. Боты: ПЛЮСОНа и клиента, у кого человек есть. Текст называет, от
    #    кого и за что подарок, — иначе в боте клиента это выглядит как
    #    посторонняя реклама платформы, и жалобы пойдут клиенту.
    if not contact_id:
        return
    try:
        from app.services.bonus_bot_delivery import send_bonus_to_bots
        await send_bonus_to_bots(db, contact_id=contact_id, client_id=client_id,
                                 text=body, link=link)
    except Exception:
        logger.warning("bonus: сообщение в бот для контакта %s не ушло", contact_id)
