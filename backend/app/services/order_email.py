"""
Письма о заказе тарифа события (миграция 257).

Два письма:
  • «Заказ оформлен» — сразу после оформления, со ссылкой на оплату. Нужно,
    потому что человек часто уходит подумать, закрывает вкладку и теряет
    ссылку; из письма он вернётся к оплате в любой момент.
  • «Оплата получена» — после вебхука, с чатами события.

⚠️ Это ТРАНЗАКЦИОННЫЕ письма (подтверждение действия самого человека), а не
маркетинг: шлём даже тем, кто отписан от рассылок. Не шлём только на мёртвые
адреса (email_is_dead) — там письмо всё равно не дойдёт.

Ошибка отправки НЕ роняет заказ: деньги важнее письма.
"""
import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def _load_context(db, order_id: int) -> Optional[dict]:
    """Заказ + контакт + email-канал клиента. None → письмо слать некому."""
    row = await db.fetchrow(
        """SELECT o.id, o.status, o.amount, o.payment_url, o.contact_id,
                  t.title AS tariff_title,
                  e.id AS event_id, e.slug AS event_slug, e.title AS event_title,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS tg_chat_url,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS vk_chat_url,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS max_chat_url,
                  c.name AS contact_name,
                  cl.id AS client_id, cl.name AS client_name, cl.brand_name,
                  cl.work_tg_username, cl.work_vk, cl.work_max,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    LIMIT 1) AS email
             FROM event_participant_tariffs o
             JOIN event_tariffs t ON t.id = o.tariff_id
             JOIN events e ON e.id = o.event_id
             JOIN contacts c ON c.id = o.contact_id
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
             JOIN clients cl ON cl.id = eo.client_id
            WHERE o.id = $1
            ORDER BY eo.id LIMIT 1""",
        order_id,
    )
    if not row or not row["email"]:
        return None

    channel = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local, ch.email_from_name
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'email'
            LIMIT 1""",
        row["client_id"],
    )
    if not channel:
        return None

    # Мёртвый адрес — не тратим попытку и репутацию домена.
    is_dead = await db.fetchval(
        """SELECT pu.email_is_dead FROM platform_users pu
            WHERE pu.contact_id = $1 AND pu.platform_slug = 'email' LIMIT 1""",
        row["contact_id"],
    )
    if is_dead:
        return None

    return {"order": dict(row), "channel": dict(channel)}


async def _send(db, ctx: dict, subject: str, body: str) -> bool:
    from app.services.unsubscribe_token import make_email_unsubscribe_token
    o, channel = ctx["order"], ctx["channel"]
    try:
        from app.services.email_sender import EmailSender
        token = make_email_unsubscribe_token(
            client_id=o["client_id"],
            contact_id=o["contact_id"],
            client_channel_id=channel["client_channel_id"],
        )
        EmailSender().send(
            channel=channel,
            client_brand_name=o["brand_name"] or o["client_name"],
            to_email=o["email"],
            subject=subject,
            body_text=body,
            unsubscribe_token=token,
        )
        return True
    except Exception as e:
        logger.warning("Письмо по заказу %s не ушло: %s", o["id"], e)
        return False


async def send_order_created_email(db, order_id: int) -> bool:
    """«Заказ оформлен» со ссылкой на оплату — чтобы человек мог вернуться."""
    ctx = await _load_context(db, order_id)
    if not ctx:
        return False
    o = ctx["order"]
    if not o["payment_url"]:
        return False

    name = (o["contact_name"] or "").strip()
    amount = f"{int(o['amount'] or 0):,}".replace(",", " ")
    body = (
        f"{'Здравствуйте, ' + name + '!' if name else 'Здравствуйте!'}\n\n"
        f"Вы оформили заказ на «{o['event_title']}».\n\n"
        f"Тариф: {o['tariff_title']}\n"
        f"К оплате: {amount} ₽\n\n"
        f"Оплатить можно по ссылке:\n{o['payment_url']}\n\n"
        f"Ссылка остаётся рабочей — если сейчас неудобно, вернётесь к ней позже.\n"
        f"После оплаты откроется страница с чатами события: заходите туда, "
        f"там всё самое важное.\n\n"
        f"Если оплата уже прошла — просто не обращайте внимания на это письмо."
    )
    ok = await _send(db, ctx, f"Заказ на «{o['event_title']}» — осталось оплатить", body)
    if ok:
        logger.info("Письмо о заказе %s отправлено", order_id)
    return ok


async def send_order_paid_email(db, order_id: int) -> bool:
    """«Оплата получена» — чаты события, боты клиента и поддержка."""
    ctx = await _load_context(db, order_id)
    if not ctx:
        return False
    o = ctx["order"]

    # ⚠️ Ни чатов, ни страницы события в письме НЕТ — только бот со слагом
    # события (ref_pg{slug}): он открывает МЕНЮ события, где и чат, и
    # программа, и подарки. Одна кнопка вместо россыпи ссылок.
    bots = await db.fetch(
        """SELECT ch.platform_slug, ch.handle, ch.display_name
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.handle IS NOT NULL AND ch.handle <> ''
              AND ch.platform_slug IN ('telegram', 'vk', 'max')""",
        o["client_id"],
    )
    bot_lines = []
    for b in bots:
        h = b["handle"].lstrip("@")
        url = {
            "telegram": f"https://telegram.me/{h}?start=ref_pg{o['event_slug']}",
            "vk": f"https://vk.me/{h}",
            "max": f"https://max.ru/{h}?start=ref_pg{o['event_slug']}",
        }.get(b["platform_slug"])
        label = {"telegram": "Telegram", "vk": "ВКонтакте", "max": "MAX"}.get(
            b["platform_slug"], b["platform_slug"])
        if url:
            bot_lines.append(f"• {label}: {url}")
    bots_block = "\n".join(bot_lines)

    # Поддержка — рабочие аккаунты клиента из настроек.
    sup = []
    if o["work_tg_username"]:
        sup.append(f"• Telegram: https://t.me/{str(o['work_tg_username']).lstrip('@')}")
    if o["work_vk"]:
        sup.append(f"• ВКонтакте: {o['work_vk']}")
    if o["work_max"]:
        sup.append(f"• MAX: {o['work_max']}")
    support_block = "\n".join(sup)

    name = (o["contact_name"] or "").strip()
    body = (
        f"{'Здравствуйте, ' + name + '!' if name else 'Здравствуйте!'}\n\n"
        f"Оплата получена — вы участник «{o['event_title']}».\n"
        f"Тариф: {o['tariff_title']}\n\n"
        f"По условиям опций вашего тарифа с вами свяжется менеджер.\n\n"
        + (f"Откройте нашего бота — там меню события: чат, программа, подарки "
           f"и ссылка на эфир. Выберите удобную площадку:\n{bots_block}\n\n"
           if bots_block else "")
        + (f"Если что-то не открылось или есть вопросы — напишите нам:\n"
           f"{support_block}\n\n" if support_block else "")
        + f"До встречи!"
    )
    ok = await _send(db, ctx, f"Оплата получена — «{o['event_title']}»", body)
    if ok:
        logger.info("Письмо об оплате заказа %s отправлено", order_id)
    return ok


async def notify_organizer_new_order(db, order_id: int, *, paid: bool = False) -> None:
    """Уведомление организатору о заказе — в канал оплат его же ботом.

    Шлём и при оформлении (видно, кто собрался платить), и при оплате.
    Внутри — всё, что нужно, чтобы связаться с человеком, не заходя в
    кабинет: имя, email, телефон, ник, ссылка на карточку контакта.

    Ошибка отправки не должна ронять заказ — оборачиваем целиком.
    """
    row = await db.fetchrow(
        """SELECT o.id, o.status, o.amount, o.contact_id,
                  t.title AS tariff_title,
                  e.title AS event_title,
                  c.name AS contact_name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    LIMIT 1) AS email,
                  (SELECT pt.username FROM platform_users pt
                    WHERE pt.contact_id = c.id AND pt.platform_slug = 'telegram'
                      AND pt.username IS NOT NULL LIMIT 1) AS tg_username,
                  eo.client_id
             FROM event_participant_tariffs o
             JOIN event_tariffs t ON t.id = o.tariff_id
             JOIN events e ON e.id = o.event_id
             JOIN contacts c ON c.id = o.contact_id
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
            WHERE o.id = $1
            ORDER BY eo.id LIMIT 1""",
        order_id,
    )
    if not row:
        return

    amount = f"{int(row['amount'] or 0):,}".replace(",", " ")
    head = "💰 ОПЛАЧЕНО" if paid else "🧾 Новый заказ"
    tg_nick = (row["tg_username"] or "").lstrip("@")

    lines = [
        f"<b>{head}</b> · {amount} ₽",
        "",
        f"Событие: {row['event_title']}",
        f"Тариф: {row['tariff_title']}",
        "",
        f"Имя: {row['contact_name'] or '—'}",
        f"Email: {row['email'] or '—'}",
        f"Телефон: {row['phone'] or '—'}",
    ]
    if tg_nick:
        lines.append(f'Telegram: <a href="https://t.me/{tg_nick}">@{tg_nick}</a>')
    lines += [
        "",
        f'<a href="https://pluson.ru/dashboard/clients?contact_id={row["contact_id"]}">'
        f'Карточка контакта #{row["contact_id"]}</a>',
        f"Заказ №{row['id']}",
    ]
    text = "\n".join(lines)

    try:
        from app.services.channels import notify_organizer_all_channels
        await notify_organizer_all_channels(
            row["client_id"], text, db, kind="payments")
    except Exception as e:
        logger.warning("Уведомление о заказе %s не ушло: %s", order_id, e)
