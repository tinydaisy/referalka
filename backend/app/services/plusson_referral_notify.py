"""Уведомления рефоводу по реф-программе САМОГО ПЛЮСОНа.

Две точки, обе адресованы РЕФОВОДУ (тому, чей код в ссылке), а не владельцу
бота, куда человек зашёл. Это разные клиенты: человек может прийти по ссылке
Марго в бот Марго, а может — по её же ссылке в чужой VIP-бот. Партнёрская
программа принадлежит рефоводу, поэтому и уведомление идёт ему.

  1. `notify_referrer_new_interest` — «новый интерес»: человек ТОЛЬКО зашёл в
     бота по реф-ссылке ПЛЮСОНа. Он ещё не клиент — не зарегистрировался, ничего
     не купил.

  2. `notify_referrer_about_purchase` — приведённый КУПИЛ. Плюс письмом на почту:
     оплата — событие с деньгами, его нельзя терять среди сообщений в мессенджере.

  3. `notify_founder_new_client` — ОСНОВАТЕЛЮ ПЛЮСОНа о КАЖДОЙ регистрации
     нового клиента платформы, в том числе пришедшего без чьей-либо ссылки.

⚠️ ВСЁ уходит В ЛИЧКУ от @pluson_bot — бота самой платформы. Каналы уведомлений
клиента НЕ используются, и бот клиента (@ivision_conf_bot и подобные) — тоже:
они про события клиента, а реф-программа ПЛЮСОНа — разговор платформы со своим
клиентом. Плюс канал надо заводить руками и добавлять туда бота, а реф-программа
обязана работать у каждого сразу.

⚠️ Обе функции НИКОГДА не бросают исключение. Уведомление — вспомогательный
шаг: сорванная отправка не должна ронять ни обработку /start, ни — тем более —
проведение оплаты.
"""
from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

# Человекочитаемое имя площадки, откуда пришёл человек.
PLATFORM_LABEL = {
    "telegram": "Telegram",
    "max": "MAX",
    "vk": "ВКонтакте",
}


def _msk_now_str() -> str:
    return datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M МСК")


# Бот реф-программы ПЛЮСОНа. Уведомление приходит ИЗ ТОГО ЖЕ бота, в который
# человек зашёл по ссылке, — из @pluson_bot.
PLUSSON_BOT_HANDLE = "pluson_bot"


async def _send_via_plusson_bot(db, chat_id, text_html: str) -> bool:
    """Отправить уведомление в TG-канал клиента ботом @pluson_bot.

    ⚠️ Почему не общая `send_to_notifications_channel`: она берёт СВОЙ VIP-бот
    клиента (`is_system=FALSE`, первый по id). У Марго таких четыре, и первым
    оказывается @ivision_conf_bot — уведомление по реф-программе ПЛЮСОНа
    приходило от бота конференций, хотя человек заходил в @pluson_bot. Реф-
    программа принадлежит платформе, поэтому и говорить о ней должен её бот.

    ⚠️ @pluson_bot ищется ПО HANDLE, а не по `is_system`: в БД у него
    `is_system = FALSE` — это обычный бот сервисного клиента.
    """
    import httpx

    if not chat_id or not text_html:
        return False
    token = await db.fetchval(
        """SELECT bot_token FROM channels
            WHERE platform_slug = 'telegram'
              AND lower(replace(handle, '@', '')) = $1
              AND bot_token IS NOT NULL AND bot_token <> ''
            ORDER BY id LIMIT 1""",
        PLUSSON_BOT_HANDLE,
    )
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": chat_id, "text": text_html,
                    "parse_mode": "HTML", "disable_web_page_preview": True,
                },
            )
        if r.status_code == 200 and r.json().get("ok"):
            return True
        log.warning("plusson bot notify failed: %s %s", r.status_code, r.text[:300])
    except Exception as e:  # noqa: BLE001
        log.warning("plusson bot notify error: %s", e)
    return False


async def _client_telegram_id(db, client_id: int) -> str | None:
    """TG-id САМОГО клиента ПЛЮСОНа — чтобы написать ему в личку.

    Клиент ПЛЮСОНа живёт в базах разных клиентов обычным контактом; ищем его
    идентичность по нику из `clients.telegram_username`. Берём ЧИСЛОВОЙ id —
    псевдо-запись `@ник` (человек ещё не заходил в бота) для отправки не годится.
    """
    uname = await db.fetchval(
        "SELECT lower(replace(coalesce(telegram_username, work_tg_username, ''),'@','')) "
        "FROM clients WHERE id = $1", client_id
    )
    if not uname:
        return None
    return await db.fetchval(
        """SELECT platform_user_id FROM platform_users
            WHERE platform_slug = 'telegram'
              AND lower(replace(coalesce(username,''),'@','')) = $1
              AND platform_user_id ~ '^[0-9]+$'
            ORDER BY id LIMIT 1""",
        uname,
    )


async def _notify_referrer(db, referrer_client_id: int, text_html: str,
                           *, kind: str = "general") -> dict:
    """Уведомление клиенту ПЛЮСОНа — В ЛИЧКУ от @pluson_bot.

    ⚠️ Это уведомление САМОЙ ПЛАТФОРМЫ своему клиенту, а не уведомление
    организатора по его событию. Поэтому оно НЕ идёт через каналы уведомлений
    клиента (`notifications_telegram_chat_id`): тот канал клиент заводит сам и
    сам добавляет туда бота — проверка показала, что @pluson_bot в канал
    клиента 1 не добавлен и отправка падала `chat not found`. Реф-программа
    обязана работать у КАЖДОГО клиента сразу, без настройки.

    ⚠️ Бот клиента (у Марго это @ivision_conf_bot) здесь НЕ участвует вовсе:
    он про события клиента, а не про платформу. Реф-программа ПЛЮСОНа — это
    разговор платформы со своим клиентом, и ведёт его бот платформы.
    """
    result = {"tg": False, "max": False, "vk": False}

    tg_id = await _client_telegram_id(db, referrer_client_id)
    if tg_id:
        result["tg"] = await _send_via_plusson_bot(db, tg_id, text_html)
    else:
        log.warning(
            "referral notify: у клиента %s нет числового TG-id — "
            "уведомление по реф-программе не отправлено", referrer_client_id,
        )
    return result


def _rub(kopecks: int) -> str:
    """Копейки → «1 990 ₽». Дробную часть показываем, только если она есть."""
    rub = (kopecks or 0) / 100
    s = f"{rub:,.2f}".replace(",", " ").replace(".", ",")
    return (s[:-3] if s.endswith(",00") else s) + " ₽"


async def notify_referrer_new_interest(
    db,
    *,
    referrer_client_id: int,
    platform: str,
    user_id: str | int | None,
    username: str | None,
    first_name: str | None = None,
    last_name: str | None = None,
) -> dict:
    """«По вашей ссылке зашёл человек» — рефоводу во все его каналы.

    ⚠️ Это ещё НЕ регистрация. Формулировка намеренно говорит «заинтересовался»,
    а не «зарегистрировался»: человек только открыл бота, до создания аккаунта
    может не дойти. Обещать рефоводу нового клиента раньше времени нельзя.

    Ника у человека может не быть вовсе (в Telegram username необязателен) —
    тогда `profile_links` отдаёт deep-link по числовому id, и написать ему всё
    равно можно в один клик.
    """
    try:
        from app.services.profile_links import nick_html, link_html

        name = " ".join(p for p in [(first_name or "").strip(),
                                    (last_name or "").strip()] if p).strip()
        nick = nick_html(platform, user_id=user_id, username=username)
        link = link_html(platform, user_id=user_id, username=username)
        label = PLATFORM_LABEL.get((platform or "").lower(), platform or "—")

        parts = [
            "🆕 <b>ПЛЮСОН · новый интерес по вашей партнёрской ссылке</b>",
            "",
            f"<b>Имя:</b> {name or '—'}",
            f"<b>Никнейм:</b> {nick or '—'}",
            f"<b>Площадка:</b> {label}",
            f"<b>Когда:</b> {_msk_now_str()}",
        ]
        if link:
            parts.append(f"<b>Ссылка:</b> {link}")
        parts += [
            "",
            "Человек перешёл по вашей партнёрской ссылке на <b>iViSiON: ПЛЮСОН</b> "
            "и открыл бота платформы. Аккаунт он ещё не создал — если создаст, "
            "закрепится за вами автоматически, и вы будете получать процент с его оплат.",
        ]

        return await _notify_referrer(db, referrer_client_id, "\n".join(parts))
    except Exception as e:  # noqa: BLE001 — уведомление не роняет /start
        log.warning("notify_referrer_new_interest failed: %s", e)
        return {"tg": False, "max": False, "vk": False}


async def notify_founder_new_client(
    db,
    *,
    new_client_id: int,
    name: str | None,
    email: str | None,
    phone: str | None = None,
    telegram_username: str | None = None,
    referrer_client_id: int | None = None,
) -> dict:
    """ОСНОВАТЕЛЮ ПЛЮСОНа: «зарегистрировался новый клиент платформы».

    Адресат — СИСТЕМНЫЙ сервисный клиент (`clients.is_system_service`), это
    аккаунт самого ПЛЮСОНа. Отдельно от уведомления рефоводу: рефовод узнаёт
    про СВОЕГО приведённого, а основатель — про КАЖДУЮ регистрацию, включая
    тех, кто пришёл сам, без чьей-либо ссылки.

    ⚠️ Не бросает исключение: уведомление не должно ронять регистрацию.
    """
    try:
        founder_id = await db.fetchval(
            "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1"
        )
        if not founder_id:
            return {"tg": False, "max": False, "vk": False}

        parts = [
            "🚀 <b>ПЛЮСОН · новый клиент платформы</b>",
            "",
            f"<b>Имя:</b> {name or '—'}",
            f"<b>Email:</b> {email or '—'}",
        ]
        if phone:
            parts.append(f"<b>Телефон:</b> {phone}")
        if telegram_username:
            uname = telegram_username.lstrip("@").strip()
            parts.append(
                f"<b>Telegram:</b> <a href=\"https://telegram.me/{uname}\">@{uname}</a>"
            )

        if referrer_client_id:
            ref_name = await db.fetchval(
                "SELECT name FROM clients WHERE id = $1", referrer_client_id
            )
            parts.append(f"<b>Кто привёл:</b> {ref_name or '—'} (#{referrer_client_id})")
        else:
            parts.append("<b>Кто привёл:</b> пришёл сам (без реф-ссылки)")

        parts += [
            f"<b>Когда:</b> {_msk_now_str()}",
            "",
            f"<b>Карточка:</b> {_dashboard_base()}/admin/clients?id={new_client_id}",
        ]

        text = "\n".join(parts)
        res = await _notify_referrer(db, founder_id, text)
        if res.get("tg"):
            return res

        # ⚠️ У системного аккаунта (клиент 3) поля telegram_username /
        # work_tg_username ПУСТЫЕ — писать некуда, и уведомление о новом клиенте
        # платформы терялось бы совсем. Фолбэк: личка владельцев платформы по
        # тем же аккаунтам, которым разрешены админские команды бота (/clients,
        # /collabs) — это и есть «основатель ПЛЮСОНа».
        from app.services.admin_export import ALLOWED_USERNAMES
        sent = False
        for uname in ALLOWED_USERNAMES:
            tg_id = await db.fetchval(
                """SELECT platform_user_id FROM platform_users
                    WHERE platform_slug = 'telegram'
                      AND lower(replace(coalesce(username,''),'@','')) = $1
                      AND platform_user_id ~ '^[0-9]+$'
                    ORDER BY id LIMIT 1""",
                uname.lower().lstrip("@"),
            )
            if tg_id and await _send_via_plusson_bot(db, tg_id, text):
                sent = True
                break  # один владелец — одно уведомление, дубли не нужны
        res["tg"] = sent
        return res
    except Exception as e:  # noqa: BLE001 — не роняем регистрацию
        log.warning("notify_founder_new_client failed: %s", e)
        return {"tg": False, "max": False, "vk": False}


def _dashboard_base() -> str:
    from app.config import settings as _s
    return _s.frontend_url.rstrip("/")


async def notify_referrer_about_purchase(
    db,
    *,
    referrer_client_id: int,
    payer_name: str | None,
    what_paid: str,
    amount_kopecks: int,
    percent: int,
    cashback_kopecks: int,
    balance_kopecks: int,
) -> dict:
    """«Ваш реферал купил» — в каналы уведомлений И письмом на почту.

    Показываем ЧЕТЫРЕ цифры, а не только начисленную: сумму покупки, процент,
    начисление и новый баланс. Без процента и суммы уведомление не проверяемо —
    рефовод видит «+199 ₽» и не может сойтись, правильно ли ему посчитали.

    Почта обязательна: оплата — событие с деньгами, а сообщение в мессенджере
    легко теряется среди прочих уведомлений.
    """
    result = {"tg": False, "max": False, "vk": False, "email": False}
    payer = (payer_name or "").strip() or "Клиент"

    lines = [
        "💰 <b>ПЛЮСОН · покупка по вашей партнёрской ссылке</b>",
        "",
        f"<b>Кто купил:</b> {payer}",
        f"<b>Что купил:</b> {what_paid}",
        f"<b>Сумма покупки:</b> {_rub(amount_kopecks)}",
        "",
        f"<b>Ваш процент:</b> {percent}%",
        f"<b>Начислено вам:</b> {_rub(cashback_kopecks)}",
        f"<b>Баланс:</b> {_rub(balance_kopecks)}",
        "",
        f"<b>Когда:</b> {_msk_now_str()}",
    ]
    text_html = "\n".join(lines)

    # ── Мессенджеры ──
    # kind='payments' — у оплат может быть отдельный канал (миграция 259); если
    # он не задан, падаем на общий, чтобы уведомление не пропало.
    try:
        res = await _notify_referrer(db, referrer_client_id, text_html,
                                     kind="payments")
        result.update(res)
    except Exception as e:  # noqa: BLE001 — не роняем оплату
        log.warning("notify purchase (messengers) failed: %s", e)

    # ── Почта ──
    try:
        result["email"] = await _send_purchase_email(
            db,
            referrer_client_id=referrer_client_id,
            payer=payer,
            what_paid=what_paid,
            amount_kopecks=amount_kopecks,
            percent=percent,
            cashback_kopecks=cashback_kopecks,
            balance_kopecks=balance_kopecks,
        )
    except Exception as e:  # noqa: BLE001 — не роняем оплату
        log.warning("notify purchase (email) failed: %s", e)

    return result


async def _send_purchase_email(
    db,
    *,
    referrer_client_id: int,
    payer: str,
    what_paid: str,
    amount_kopecks: int,
    percent: int,
    cashback_kopecks: int,
    balance_kopecks: int,
) -> bool:
    """Письмо рефоводу о покупке. Шлём через СИСТЕМНЫЙ email-канал ПЛЮСОНа —
    это письмо от платформы самому клиенту, а не рассылка по его базе.
    """
    client = await db.fetchrow(
        "SELECT email, name FROM clients WHERE id = $1", referrer_client_id
    )
    if not client or not client["email"]:
        return False

    ch = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'email'
              AND ch.is_system = TRUE
            LIMIT 1""",
        referrer_client_id,
    )
    if not ch:
        return False

    from app.config import settings as _s
    from app.services.email_sender import EmailSender
    from app.services.unsubscribe_token import make_email_unsubscribe_token

    channel_dict = dict(ch)
    channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"

    # Токен отписки нужен формально (подвал письма). Это транзакционное письмо
    # об оплате, а не рассылка — contact_id=0, как в письме подтверждения email.
    unsub = make_email_unsubscribe_token(
        client_id=referrer_client_id, contact_id=0,
        client_channel_id=ch["client_channel_id"],
    )

    name = (client["name"] or "").strip()
    greeting = f"Здравствуйте, {name}!" if name else "Здравствуйте!"
    dash_url = f"{_s.frontend_url.rstrip('/')}/dashboard/partner-program"

    body_text = (
        f"{greeting}\n\n"
        f"По вашей реферальной ссылке совершена покупка.\n\n"
        f"Кто купил: {payer}\n"
        f"Что купил: {what_paid}\n"
        f"Сумма покупки: {_rub(amount_kopecks)}\n\n"
        f"Ваш процент: {percent}%\n"
        f"Начислено вам: {_rub(cashback_kopecks)}\n"
        f"Текущий баланс: {_rub(balance_kopecks)}\n\n"
        f"Бонусы можно потратить на подписку или вывести — "
        f"всё в вашем кабинете:\n{dash_url}\n\n"
        f"— Команда iViSiON: ПЛЮСОН"
    )

    EmailSender().send(
        channel=channel_dict,
        client_brand_name="iViSiON: ПЛЮСОН",
        to_email=client["email"],
        subject=f"Начислено {_rub(cashback_kopecks)} — покупка по вашей ссылке",
        body_text=body_text,
        unsubscribe_token=unsub,
    )
    return True
