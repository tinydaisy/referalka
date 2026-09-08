"""Новости платформы: лента клиенту, отметки прочтения, рассылка на почту и в бот.

⚠️ Адресат новости — САМ КЛИЕНТ ПЛЮСОНа (строка в `clients`), а не контакт в
его базе. Это тот же разговор платформы с клиентом, что уведомления об
истечении подписки и о лимите контактов, — поэтому и почта идёт через
СИСТЕМНЫЙ email-канал от имени «iViSiON: ПЛЮСОН», и бот только @pluson_bot.

⚠️ Одна точка сборки на все места показа (плашка, колокольчик, страница) и на
обе точки ведения (админка и кабинет сервисного клиента). Своих SELECT в
модулях-потребителях быть не должно: они разъедутся, и цифра в колокольчике
перестанет сходиться со списком — ровно та беда, что была с подсчётом
необработанных заявок.
"""
import asyncio
import logging
from typing import Optional

log = logging.getLogger(__name__)

# Сколько новостей отдаём в выпадашку колокольчика. Больше туда физически не
# помещается, а весь список открывается страницей.
BELL_LIMIT = 5

# Пауза между письмами, чтобы не выгрести SMTP залпом. Постфикс свой, но
# репутация домена общая с письмами клиентов — торопиться некуда.
_MAIL_PAUSE_SEC = 0.15


def news_public_columns(alias: str = "n") -> str:
    """Колонки новости, которые видит клиент. Служебное (кто создал, отметки
    отправки) наружу не отдаём."""
    return (
        f"{alias}.id, {alias}.title, {alias}.body, {alias}.image_url, "
        f"{alias}.published_at"
    )


async def list_for_client(db, client_id: int, *, limit: Optional[int] = None) -> list[dict]:
    """Опубликованные новости с отметкой «прочитана этим клиентом», свежие сверху."""
    rows = await db.fetch(
        f"""SELECT {news_public_columns()},
                   (r.client_id IS NOT NULL) AS is_read
              FROM platform_news n
              LEFT JOIN platform_news_reads r
                     ON r.news_id = n.id AND r.client_id = $1
             WHERE n.status = 'published'
             ORDER BY n.published_at DESC NULLS LAST, n.id DESC
             {'LIMIT ' + str(int(limit)) if limit else ''}""",
        client_id,
    )
    return [dict(r) for r in rows]


async def unread_count(db, client_id: int) -> int:
    """Сколько опубликованных новостей клиент ещё не прочитал."""
    return await db.fetchval(
        """SELECT COUNT(*)
             FROM platform_news n
             LEFT JOIN platform_news_reads r
                    ON r.news_id = n.id AND r.client_id = $1
            WHERE n.status = 'published' AND r.client_id IS NULL""",
        client_id,
    ) or 0


async def mark_read(db, client_id: int, news_id: int) -> None:
    """Отмечает одну новость прочитанной. Идемпотентно."""
    await db.execute(
        """INSERT INTO platform_news_reads (news_id, client_id)
                SELECT $2, $1
                  FROM platform_news
                 WHERE id = $2 AND status = 'published'
           ON CONFLICT DO NOTHING""",
        client_id, news_id,
    )


async def mark_all_read(db, client_id: int) -> int:
    """«Скрыть все» — гасит плашку целиком. Возвращает, сколько отметили."""
    result = await db.execute(
        """INSERT INTO platform_news_reads (news_id, client_id)
                SELECT n.id, $1
                  FROM platform_news n
                 WHERE n.status = 'published'
           ON CONFLICT DO NOTHING""",
        client_id,
    )
    try:
        return int(str(result).rsplit(" ", 1)[-1])
    except (ValueError, IndexError):
        return 0


# ─── Рассылка ────────────────────────────────────────────────────────────────

async def recipients_preview(db) -> dict:
    """Сколько кому уйдёт — показывается в админке ДО отправки.

    ⚠️ Считаем ровно тем же запросом, которым потом рассылаем: иначе админ
    увидит «уйдёт 84», а уйдёт другое число, и доверять цифре станет нельзя.
    """
    row = await db.fetchrow(
        """SELECT COUNT(*) FILTER (WHERE COALESCE(email,'') <> ''
                                     AND news_unsubscribed_at IS NULL) AS email_total,
                  COUNT(*) FILTER (WHERE COALESCE(email,'') <> ''
                                     AND news_unsubscribed_at IS NOT NULL) AS email_unsubscribed
             FROM clients
            WHERE is_active = TRUE"""
    )
    return {
        "email": row["email_total"] or 0,
        "email_unsubscribed": row["email_unsubscribed"] or 0,
    }


async def _mail_recipients(db) -> list[dict]:
    """Кому уходит письмо: активные кабинеты с почтой, кроме отписавшихся."""
    rows = await db.fetch(
        """SELECT id, email, name, brand_name
             FROM clients
            WHERE is_active = TRUE
              AND COALESCE(email, '') <> ''
              AND news_unsubscribed_at IS NULL
            ORDER BY id"""
    )
    return [dict(r) for r in rows]


async def _bot_recipients(db) -> list[int]:
    """Кому уходит сообщение в @pluson_bot — все активные кабинеты.

    ⚠️ Отписки от бота нет намеренно: там человек сам нажал «Старт», и если
    не хочет — блокирует бота, это и есть отписка. Дойдёт не всем: адресат
    ищется по нику из кабинета среди писавших боту (см. _notify_referrer).
    """
    rows = await db.fetch("SELECT id FROM clients WHERE is_active = TRUE ORDER BY id")
    return [r["id"] for r in rows]


def _escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def _system_email_channel(db, client_id: int) -> Optional[dict]:
    """Системный email-канал платформы, привязанный к кабинету клиента."""
    ch = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'email'
              AND ch.is_system = TRUE
            LIMIT 1""",
        client_id,
    )
    return dict(ch) if ch else None


async def send_news_email(db, news_id: int) -> dict:
    """Рассылает новость на почту клиентов. Возвращает {sent, failed, skipped}."""
    from app.services.email_sender import EmailSender
    from app.services.news_unsubscribe_token import make_news_unsubscribe_token

    news = await db.fetchrow(
        "SELECT id, title, body, image_url, mail_subject, mail_body, status "
        "FROM platform_news WHERE id = $1", news_id)
    if not news or news["status"] != "published":
        return {"sent": 0, "failed": 0, "skipped": 0, "error": "Новость не опубликована"}

    subject = (news["mail_subject"] or "").strip() or news["title"]
    body_html = (news["mail_body"] or "").strip() or news["body"]

    recipients = await _mail_recipients(db)

    # ⚠️ Отметку ставим ДО отправки: сбой на середине не должен разослать всё
    # заново по второму кругу (тот же приём, что в contact_limit_notify).
    await db.execute(
        """UPDATE platform_news
              SET email_sent_at = NOW(), email_sent_count = $2, updated_at = NOW()
            WHERE id = $1""",
        news_id, len(recipients),
    )

    sender = EmailSender()
    sent = failed = skipped = 0

    for client in recipients:
        try:
            channel = await _system_email_channel(db, client["id"])
            if not channel:
                skipped += 1
                continue
            channel["email_from_name"] = "iViSiON: ПЛЮСОН"

            # ⚠️ Отписку кладём В ТЕЛО письма, а не через unsubscribe_token
            # EmailSender: тот строит ссылку на /api/v1/email/unsubscribe —
            # эндпоинт отписки КОНТАКТА от рассылок клиента. Он наш токен не
            # разберёт и покажет человеку «Невалидная ссылка отписки».
            unsub_url = _news_unsub_url(
                make_news_unsubscribe_token(client_id=client["id"]))
            await asyncio.to_thread(
                sender.send,
                channel=channel,
                client_brand_name="iViSiON: ПЛЮСОН",
                to_email=client["email"],
                subject=subject,
                body_text=(_html_to_text(body_html)
                           + "\n\n— Команда iViSiON: ПЛЮСОН"
                           + f"\n\nНе хотите получать новости ПЛЮСОНа: {unsub_url}"),
                body_html=_email_html(news["title"], body_html, news["image_url"], unsub_url),
                unsubscribe_token="",
            )
            sent += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.warning("news email failed (news %s, client %s): %s", news_id, client["id"], e)
        await asyncio.sleep(_MAIL_PAUSE_SEC)

    await db.execute(
        "UPDATE platform_news SET email_sent_count = $2 WHERE id = $1", news_id, sent)

    log.info("news %s email: sent=%s failed=%s skipped=%s", news_id, sent, failed, skipped)
    return {"sent": sent, "failed": failed, "skipped": skipped}


async def send_news_bot(db, news_id: int) -> dict:
    """Рассылает новость в личку клиентам через @pluson_bot."""
    from app.services.plusson_referral_notify import _notify_referrer

    news = await db.fetchrow(
        "SELECT id, title, body, mail_body, status FROM platform_news WHERE id = $1", news_id)
    if not news or news["status"] != "published":
        return {"sent": 0, "failed": 0, "error": "Новость не опубликована"}

    body = (news["mail_body"] or "").strip() or news["body"]
    # Тело уже размечено HTML-тегами (b/i/a) — экранировать его целиком нельзя,
    # иначе теги приедут человеку текстом. Экранируем только заголовок.
    html = f"<b>{_escape_html(news['title'])}</b>\n\n{_tg_html(body)}"

    recipients = await _bot_recipients(db)

    await db.execute(
        """UPDATE platform_news
              SET bot_sent_at = NOW(), bot_sent_count = $2, updated_at = NOW()
            WHERE id = $1""",
        news_id, len(recipients),
    )

    sent = failed = 0
    for client_id in recipients:
        try:
            res = await _notify_referrer(db, client_id, html, kind="platform_news")
            if res.get("tg"):
                sent += 1
            else:
                failed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            log.info("news bot notify skipped (news %s, client %s): %s", news_id, client_id, e)
        await asyncio.sleep(0.05)

    await db.execute(
        "UPDATE platform_news SET bot_sent_count = $2 WHERE id = $1", news_id, sent)

    log.info("news %s bot: sent=%s failed=%s", news_id, sent, failed)
    return {"sent": sent, "failed": failed}


# ─── Тексты ──────────────────────────────────────────────────────────────────

def _html_to_text(html: str) -> str:
    """Плоский вариант для текстовой части письма.

    ⚠️ Перенос ставим и перед ОТКРЫВАЮЩИМ блочным тегом, не только после
    закрывающего: иначе «…текст</p><p>Абзац…» слипается в одну строку — текст
    предыдущего блока упирается в начало следующего.
    """
    import re
    out = html
    # Перенос строки
    out = re.sub(r"<br\s*/?>", "\n", out, flags=re.I)
    # Блочные: пустая строка и до, и после
    out = re.sub(r"</?(?:p|h[1-6]|div|blockquote|ul|ol)\b[^>]*>", "\n\n", out, flags=re.I)
    # Пункты списка — с новой строки и маркером
    out = re.sub(r"<li\b[^>]*>", "\n• ", out, flags=re.I)
    out = re.sub(r"</li\s*>", "", out, flags=re.I)
    # Ссылка — текст плюс адрес в скобках: в plain-части кликать нечего
    out = re.sub(r"<a\s[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", r"\2 (\1)", out, flags=re.S | re.I)
    out = re.sub(r"<[^>]+>", "", out)
    out = out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _tg_html(html: str) -> str:
    """HTML под Telegram: он понимает только inline-теги, блочные роняют отправку."""
    from app.services.message_builder import html_to_telegram
    return html_to_telegram(html)


def _news_unsub_url(token: str) -> str:
    """Ссылка отписки от новостей. ⚠️ Всегда на домене ПЛАТФОРМЫ, а не клиента:
    письмо приходит от ПЛЮСОНа, и отписка должна вести туда же."""
    from app.services.client_domains import platform_base_url
    return f"{platform_base_url().rstrip('/')}/api/v1/news/unsubscribe?token={token}"


def _email_html(title: str, body_html: str, image_url: Optional[str],
                unsub_url: Optional[str] = None) -> str:
    """Тело письма. Картинка — ссылкой на R2, не inline: новость не афиша,
    ради неё гонять вложение и сжимать JPEG незачем."""
    img = ""
    if image_url:
        img = (f'<p style="margin:0 0 16px"><img src="{image_url}" alt="" '
               f'style="max-width:100%;height:auto;border-radius:12px"></p>')
    unsub = ""
    if unsub_url:
        unsub = (
            '<p style="margin:20px 0 0;color:#9ca3af;font-size:12px">'
            f'<a href="{unsub_url}" style="color:#9ca3af">Не получать новости ПЛЮСОНа</a>'
            ' — в кабинете они всё равно останутся.</p>'
        )
    return (
        '<div style="font-family:Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#25455D">'
        f'<h2 style="margin:0 0 12px;font-size:20px;color:#25455D">{_escape_html(title)}</h2>'
        f'{img}'
        f'<div>{body_html}</div>'
        '<p style="margin:24px 0 0;color:#6b7280;font-size:13px">— Команда iViSiON: ПЛЮСОН</p>'
        f'{unsub}'
        '</div>'
    )
