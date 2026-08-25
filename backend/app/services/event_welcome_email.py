"""
Welcome-email при регистрации на событие.

Шлётся ОДИН раз каждому контакту при первом is_registered=true для события.
Использует welcome_text + welcome_email_subject из events (миграция 099).
Если welcome_enabled=FALSE или welcome_text пустой — ничего не шлёт.

Плейсхолдеры:
    {name}              — имя контакта
    {event_title}       — название события
    {event_date}        — дата старта события (МСК)
    {event_landing_url} — публичный лендинг {домен клиента}/l/{slug}
    {tg_url}            — t.me/{client_bot или pluson_bot}?startapp=ref_pg{slug}
    {vk_url}            — vk.me/{client_handle} (если у клиента есть VK-сообщество)
"""
import logging
from typing import Optional
from app.services.share_links import TG_DOMAIN

logger = logging.getLogger(__name__)


def _drop_empty_lines(text: str) -> str:
    """Убирает строки, где плейсхолдер не раскрылся и осталась одна подпись.

    ⚠️ Нужно потому, что часть ссылок опциональна: реф-программа выключена,
    чатов у события нет, у клиента не подключён бот. Без этого в письме
    оставались бы обрубки вроде «🎁 Заберите подарки:» без самой ссылки —
    хуже, чем отсутствие строки.
    """
    lines = (text or "").split("\n")
    res: list[str] = []
    for i, line in enumerate(lines):
        s = line.strip()
        # Подпись к ссылке («🎁 Заберите подарки:»), за которой пусто или
        # конец письма → плейсхолдер не раскрылся, строку убираем.
        if s.endswith(":") and "http" not in s and len(s) < 60:
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if not nxt:
                continue
        res.append(line)
    # ⚠️ Схлопываем только ЧЕТЫРЕ и более переносов подряд — они остаются на
    # месте удалённых строк. Тройной перенос НЕ трогаем: это осознанный отступ
    # между пунктами письма (просьба владельца — «каждый пункт через 2 пустые
    # строки»), схлопывание ломало бы вёрстку.
    txt = "\n".join(res)
    while "\n\n\n\n" in txt:
        txt = txt.replace("\n\n\n\n", "\n\n\n")
    return txt.strip()


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
        """SELECT e.id, e.title, e.slug, e.start_at, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id,
                  e.welcome_enabled, e.welcome_text, e.welcome_email_subject
             FROM events e WHERE e.id = $1""",
        event_id,
    )
    if not event or not event["welcome_enabled"] or not (event["welcome_text"] or "").strip():
        return False

    # ⚠️ КОЛЛАБА: письмо уходит КОНКРЕТНОМУ человеку — почтовый канал, боты в
    # кнопках и домен ссылок берём у ТОГО организатора, в чьей базе его контакт.
    # У «первого владельца» может не быть ни почтового канала (письмо молча не
    # ушло бы), ни подписки этого человека.
    from app.services.event_client import resolve_event_client
    client_id = await resolve_event_client(
        db, event_id=event_id, client_id=event["client_id"], contact_id=contact_id)

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
        client_id,
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
        client_id,
    )
    # Только свой бот клиента. Системный @pluson_bot убран — нет своего бота → нет TG-кнопки.
    tg_url = (
        f"https://{TG_DOMAIN}/{tg_bot_handle}?startapp=ref_pg{event['slug']}"
        if tg_bot_handle else ""
    )

    vk_handle = await db.fetchval(
        """SELECT ch.handle FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk' AND ch.is_system = FALSE
            LIMIT 1""",
        client_id,
    )
    vk_url = f"https://vk.me/{vk_handle}" if vk_handle else ""

    # Письмо уходит участнику клиента → лендинг и ссылка отписки на ЕГО домене,
    # а не на pluson.ru. Базу резолвим один раз и переиспользуем ниже.
    from app.services.client_domains import client_public_url, public_url_for
    _public_base = await client_public_url(db, client_id)
    landing_url = public_url_for(_public_base, f"l/{event['slug']}")

    # ⚠️ Ссылки в письме — ВЕБ-версия события и обязательно с `?c={contact_id}`.
    # Письмо читают в почте, а не в мессенджере: ссылка на Mini App там просто
    # не откроется. А без contact_id страница не знает, кто пришёл, — человек
    # видит форму регистрации вместо своего кабинета с подарками.
    _c = f"?c={contact_id}"
    cabinet_url = public_url_for(_public_base, f"event/{event['slug']}{_c}#cabinet")
    program_url = public_url_for(_public_base, f"event/{event['slug']}{_c}#program")

    # Подарки — только если реф-программа события включена: иначе ссылка вела бы
    # на пустой раздел, и обещание в письме оказалось бы ложным.
    gifts_on = await db.fetchval(
        """SELECT 1 FROM event_referral_settings
            WHERE event_id = $1 AND is_enabled = TRUE LIMIT 1""",
        event_id,
    )
    gifts_url = public_url_for(_public_base, f"event/{event['slug']}{_c}#game") if gifts_on else ""

    # ⚠️ Чаты — ссылкой В БОТА, а не прямыми ссылками на чаты. У события может
    # быть включена обязательная подписка на каналы организаторов: бот её
    # проверит и сам выдаст ссылки (тот же путь, что у кнопки «Вступить в Чат»
    # в боте и на веб-странице). Прямые ссылки обходили бы эту проверку.
    # Подписка не требуется → отдаём чаты списком, лишний шаг ни к чему.
    chats_block = ""
    try:
        sub_mode = await db.fetchval(
            "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id)
        needs_sub = ((sub_mode or "all_speakers") != "none") if sub_mode is not None else bool(
            await db.fetchval("SELECT require_subscription FROM events WHERE id = $1", event_id))
        if needs_sub:
            from app.services.share_links import build_event_chat_bot_links
            # ⚠️ Бот — того организатора, в чьей базе ЧЕЛОВЕК (в коллабе у
            # каждого свой): в чужом боте его нет, подписку он не пройдёт.
            links = await build_event_chat_bot_links(db, client_id, event_id)
            # ⚠️ Показываем ТОЛЬКО те площадки, где человек РЕАЛЬНО есть —
            # где у контакта заведена идентичность. Иначе ему предложат,
            # например, МАКС, которым он не пользуется: ссылка откроет
            # пустого бота, и в чат он так и не попадёт.
            _plats = {r["platform_slug"] for r in await db.fetch(
                """SELECT platform_slug FROM platform_users
                    WHERE contact_id = $1 AND platform_slug IN ('telegram','vk','max')""",
                contact_id,
            )}
            _order = [("telegram", "Телеграм"), ("vk", "ВКонтакте"), ("max", "МАХ")]
            chats_block = "\n".join(
                f"{label}: {links[k]}" for k, label in _order
                if links.get(k) and k in _plats)
        if not chats_block:
            from app.tasks.nurture_reg import build_chats_block
            chats_block = await build_chats_block(db, event_id=event_id, html=False)
    except Exception:
        chats_block = ""

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
        .replace("{gifts_url}", gifts_url)
        .replace("{cabinet_url}", cabinet_url)
        .replace("{program_url}", program_url)
        .replace("{chats}", chats_block)
    )
    # Пустой плейсхолдер оставляет висящую строку («Подарки: ») — убираем
    # строки, где после подстановки не осталось ничего, кроме подписи.
    body = _drop_empty_lines(body)

    # ⚠️ В ТЕМЕ тоже раскрываем плейсхолдеры — иначе «{event_title}» уезжает
    # человеку сырым, и письмо приходит без названия события (прод, 2026-08-18).
    subject = (event["welcome_email_subject"] or "").strip() or f"Добро пожаловать на «{event['title']}»"
    subject = (
        subject
        .replace("{event_title}", event["title"] or "")
        .replace("{name}", contact["name"] or "друг")
        .replace("{event_date}", _format_dt(event["start_at"]))
    )

    # Token отписки — на этот email-канал клиента (если человек захочет уйти)
    from app.services.unsubscribe_token import make_email_unsubscribe_token
    unsub_token = make_email_unsubscribe_token(
        client_id=client_id,
        contact_id=contact_id,
        client_channel_id=channel["client_channel_id"],
    )

    # Отправка
    try:
        from app.services.email_sender import EmailSender, EmailSendError
        from app.services.client_domains import client_mail_domain

        # Свой почтовый домен клиента (миграция 270): письмо уходит от него,
        # и отписка ведёт туда же — ссылка на посторонний домен в письме от
        # его бренда выглядит подозрительно и для человека, и для спам-фильтра.
        channel_dict = dict(channel)
        _mail = await client_mail_domain(db, client_id)
        if _mail:
            channel_dict["email_domain"] = _mail["domain"]
            channel_dict["email_from_local"] = _mail["local"]
            if _mail["from_name"]:
                channel_dict["email_from_name"] = _mail["from_name"]

        sender = EmailSender()
        sender.send(
            channel=channel_dict,
            client_brand_name=contact.get("brand_name") or contact.get("client_name"),
            to_email=contact["email"],
            subject=subject,
            body_text=body,
            unsubscribe_token=unsub_token,
            public_base_url=_public_base,
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
