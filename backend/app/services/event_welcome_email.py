"""
Welcome-email при регистрации на событие.

Шлётся ОДИН раз каждому контакту при первом is_registered=true для события.
Использует welcome_text + welcome_email_subject из events (миграция 099).
Если welcome_enabled=FALSE или welcome_text пустой — ничего не шлёт.

Плейсхолдеры:
    {name}              — имя контакта
    {event_title}       — название события
    {event_date}        — дата старта события (МСК)
    {event_landing_url} — публичный лендинг pluson.ru/l/{slug}
    {tg_url}            — t.me/{client_bot или pluson_bot}?startapp=ref_pg{slug}
    {vk_url}            — vk.me/{client_handle} (если у клиента есть VK-сообщество)
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def _format_dt(dt) -> str:
    if not dt:
        return ""
    try:
        return dt.strftime("%d.%m.%Y в %H:%M МСК")
    except Exception:
        return str(dt)


async def send_welcome_email_if_needed(
    db,
    *,
    event_id: int,
    contact_id: int,
) -> bool:
    """
    Возвращает True если письмо успешно отправлено или уже было отправлено.

    Проверки:
    - event.welcome_enabled = TRUE
    - event.welcome_text не пустой
    - event_participants.welcome_email_sent_at IS NULL (дедуп)
    - У контакта есть email-идентичность
    - У контакта подписка на email-канал клиента НЕ помечена is_unsubscribed
    """
    event = await db.fetchrow(
        """SELECT e.id, e.title, e.slug, e.start_at, e.client_id,
                  e.welcome_enabled, e.welcome_text, e.welcome_email_subject
             FROM events e WHERE e.id = $1""",
        event_id,
    )
    if not event or not event["welcome_enabled"] or not (event["welcome_text"] or "").strip():
        return False

    # event_participants для контакта
    ep_id = await db.fetchval(
        """SELECT id FROM event_participants
            WHERE event_id = $1 AND contact_id = $2
              AND welcome_email_sent_at IS NULL
            LIMIT 1""",
        event_id, contact_id,
    )
    if not ep_id:
        return False

    # Email + имя
    contact = await db.fetchrow(
        """SELECT c.name,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  cl.brand_name, cl.name AS client_name
             FROM contacts c
             JOIN clients cl ON cl.id = c.client_id
            WHERE c.id = $1""",
        contact_id,
    )
    if not contact or not contact["email"]:
        return False

    # Email-канал клиента (главный)
    channel = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local, ch.email_from_name
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'email'
            LIMIT 1""",
        event["client_id"],
    )
    if not channel:
        return False

    # Проверка подписки на email-канал
    pu = await db.fetchrow(
        """SELECT pu.id AS pu_id, puc.is_unsubscribed
             FROM platform_users pu
             LEFT JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                AND puc.client_channel_id = $2
            WHERE pu.contact_id = $1 AND pu.platform_slug = 'email'
            LIMIT 1""",
        contact_id, channel["client_channel_id"],
    )
    # Welcome — это транзакционное письмо (подтверждение регистрации),
    # шлём даже если человек отписан от маркетинга. Но если email_is_dead —
    # пропускаем.
    if pu:
        is_dead = await db.fetchval(
            "SELECT email_is_dead FROM platform_users WHERE id = $1",
            pu["pu_id"],
        )
        if is_dead:
            return False

    # Линки на доступ
    tg_bot_handle = await db.fetchval(
        """SELECT REGEXP_REPLACE(ch.handle, '^@', '')
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
            LIMIT 1""",
        event["client_id"],
    )
    tg_url = (
        f"https://t.me/{tg_bot_handle}?startapp=ref_pg{event['slug']}"
        if tg_bot_handle
        else f"https://t.me/pluson_bot/pluson?startapp=ref_pg{event['slug']}"
    )

    vk_handle = await db.fetchval(
        """SELECT ch.handle FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk' AND ch.is_system = FALSE
            LIMIT 1""",
        event["client_id"],
    )
    vk_url = f"https://vk.me/{vk_handle}" if vk_handle else ""

    landing_url = f"https://pluson.ru/l/{event['slug']}"

    # Подставляем плейсхолдеры в шаблон
    body = (event["welcome_text"] or "")
    body = (
        body
        .replace("{name}", contact["name"] or "друг")
        .replace("{event_title}", event["title"] or "")
        .replace("{event_date}", _format_dt(event["start_at"]))
        .replace("{event_landing_url}", landing_url)
        .replace("{tg_url}", tg_url)
        .replace("{vk_url}", vk_url)
    )

    subject = event["welcome_email_subject"] or f"Добро пожаловать на «{event['title']}»"

    # Token отписки — на этот email-канал клиента (если человек захочет уйти)
    from app.services.unsubscribe_token import make_email_unsubscribe_token
    unsub_token = make_email_unsubscribe_token(
        client_id=event["client_id"],
        contact_id=contact_id,
        client_channel_id=channel["client_channel_id"],
    )

    # Отправка
    try:
        from app.services.email_sender import EmailSender, EmailSendError
        sender = EmailSender()
        sender.send(
            channel=dict(channel),
            client_brand_name=contact.get("brand_name") or contact.get("client_name"),
            to_email=contact["email"],
            subject=subject,
            body_text=body,
            unsubscribe_token=unsub_token,
        )
        await db.execute(
            "UPDATE event_participants SET welcome_email_sent_at = NOW() WHERE id = $1",
            ep_id,
        )
        logger.info(f"welcome_email: sent for event={event_id} contact={contact_id}")
        return True
    except Exception as e:
        logger.warning(f"welcome_email failed for event={event_id} contact={contact_id}: {e}")
        return False
