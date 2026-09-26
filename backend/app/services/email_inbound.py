"""Входящие письма на support@pluson.ru → «Диалоги» сервисного кабинета (миграция 521).

Путь письма: интернет → Postfix на mail.pluson.ru (порт 25) → pipe-скрипт
`deploy/mail_inbound.sh` → `POST /api/v1/internal/inbound-email` (сырое письмо)
→ сюда.

⚠️⚠️ ПРИНИМАЕМ ТОЛЬКО support@pluson.ru. Остальные адреса Postfix отбивает ещё
на входе (relay_recipient_maps): иначе на сервер полился бы спам на любые
выдуманные ящики, а поддомены клиентов (*.pluson.ru) — чужие адреса.

⚠️ Человек опознаётся ТОЛЬКО через `upsert_contact_with_identity` (единая
точка, правило проекта) по email-идентичности. Дальше всё как у мессенджеров:
`archive_incoming` пишет сообщение и сам зовёт уведомление внедренцу.

⚠️ Автоответы и отбойники («я в отпуске», MAILER-DAEMON) в переписку НЕ кладём:
на них нельзя ответить, а внедренцу прилетало бы уведомление «клиент написал».
"""
from __future__ import annotations

import html as _html
import logging
import re
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parseaddr
from typing import Optional

from app.database import get_pool

log = logging.getLogger(__name__)

SUPPORT_LOCAL = "support"

# Сколько вложений одного письма сохраняем — страховка от письма на сотню файлов.
MAX_ATTACHMENTS = 10

# Где начинается цитата предыдущего письма. Отрезаем её: в переписке нужен
# ответ человека, а не вся история, которая и так видна выше.
_QUOTE_START = re.compile(
    r"^\s*(>|-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение)"
    r"|On .{3,200} wrote:\s*$"
    r"|.{0,200}(пишет|написал\(а\)|написала|написал):\s*$"
    r"|From:\s|От кого:\s|От:\s.+<)",
    re.IGNORECASE,
)


def _html_to_text(h: str) -> str:
    h = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", h)
    h = re.sub(r"(?is)<blockquote.*?</blockquote>", "\n", h)   # цитата в HTML
    h = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>", "\n", h)
    h = re.sub(r"(?s)<[^>]+>", "", h)
    return _html.unescape(h)


def _strip_quote(text: str) -> str:
    out = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if _QUOTE_START.match(line):
            break
        out.append(line.rstrip())
    body = "\n".join(out).strip()
    body = re.sub(r"\n{3,}", "\n\n", body)
    # Всё письмо оказалось «цитатой» (например, переслали) — лучше показать
    # целиком, чем пустое сообщение.
    return body or text.strip()


def _is_automatic(msg) -> bool:
    auto = (msg.get("Auto-Submitted") or "").strip().lower()
    if auto and auto != "no":
        return True
    if (msg.get("Precedence") or "").strip().lower() in ("bulk", "junk", "auto_reply", "list"):
        return True
    if msg.get("X-Autoreply") or msg.get("X-Autorespond"):
        return True
    ct = (msg.get_content_type() or "").lower()
    if ct == "multipart/report":          # отбойник о недоставке
        return True
    frm = (parseaddr(msg.get("From") or "")[1] or "").lower()
    return frm.startswith(("mailer-daemon@", "postmaster@", "no-reply@", "noreply@"))


def parse_email(raw: bytes) -> dict:
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    name, addr = parseaddr(str(msg.get("Reply-To") or msg.get("From") or ""))
    if not addr:
        name, addr = parseaddr(str(msg.get("From") or ""))
    frm_name = parseaddr(str(msg.get("From") or ""))[0] or name

    plain = html = None
    attachments: list[dict] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get_content_disposition() or "").lower()
        ctype = part.get_content_type()
        fname = part.get_filename()
        if disp == "attachment" or (fname and disp != "inline") or (
                fname and ctype.startswith("image/")):
            if len(attachments) < MAX_ATTACHMENTS:
                try:
                    data = part.get_payload(decode=True) or b""
                except Exception:  # noqa: BLE001
                    data = b""
                if data:
                    attachments.append({"name": fname or "файл", "type": ctype, "data": data})
            continue
        try:
            content = part.get_content()
        except Exception:  # noqa: BLE001 — битая кодировка у части письма
            continue
        if ctype == "text/plain" and plain is None:
            plain = content
        elif ctype == "text/html" and html is None:
            html = content

    text = plain if plain and plain.strip() else (_html_to_text(html) if html else "")
    return {
        "from_email": (addr or "").strip().lower(),
        "from_name": (frm_name or "").strip() or None,
        "subject": str(msg.get("Subject") or "").strip() or None,
        "message_id": str(msg.get("Message-ID") or "").strip() or None,
        "text": _strip_quote(text or ""),
        "attachments": attachments,
        "automatic": _is_automatic(msg),
        "to": [a.lower() for _, a in getaddresses(
            [str(msg.get("To") or ""), str(msg.get("Cc") or "")]) if a],
    }


def _media_kind(ctype: str) -> tuple[str, str]:
    """(media_kind для ленты, расширение файла)."""
    ctype = (ctype or "").lower()
    if ctype.startswith("image/"):
        ext = ctype.split("/", 1)[1].replace("jpeg", "jpg").split(";")[0] or "jpg"
        return "photo", ext
    if ctype.startswith("video/"):
        return "video", ctype.split("/", 1)[1] or "mp4"
    if ctype.startswith("audio/"):
        return "audio", ctype.split("/", 1)[1] or "mp3"
    return "document", "bin"


async def process_inbound(raw: bytes) -> dict:
    """Разобрать письмо и положить в «Диалоги» сервисного кабинета."""
    from app.services.contact_merge import upsert_contact_with_identity
    from app.services.dialog_archive import (
        _store_bytes_in_r2, archive_direct_message, archive_incoming,
        update_message_media,
    )

    m = parse_email(raw)
    if not m["from_email"] or "@" not in m["from_email"]:
        return {"ok": True, "skipped": "no_sender"}
    if m["automatic"]:
        log.info("inbound email: автоответ/отбойник от %s — пропускаем", m["from_email"])
        return {"ok": True, "skipped": "automatic"}

    pool = await get_pool()
    async with pool.acquire() as db:
        row = await db.fetchrow(
            """SELECT c.id AS client_id, ch.id AS channel_id
                 FROM clients c
                 LEFT JOIN client_channels cc ON cc.client_id = c.id
                 LEFT JOIN channels ch ON ch.id = cc.channel_id AND ch.platform_slug = 'email'
                WHERE c.is_system_service
                ORDER BY (ch.id IS NULL), cc.is_active DESC LIMIT 1""")
        if not row:
            raise RuntimeError("Сервисный кабинет не найден")
        client_id, channel_id = row["client_id"], row["channel_id"]
        contact_id, _pu, _new = await upsert_contact_with_identity(
            db, client_id=client_id, platform_slug="email",
            platform_user_id=m["from_email"], email=m["from_email"],
            first_name=m["from_name"],
        )

    text = m["text"]
    if not text and not m["attachments"]:
        text = "(пустое письмо)"
    msg_key = m["message_id"] or None

    row_id = await archive_incoming(
        client_id=client_id, platform="email", channel_id=channel_id,
        platform_user_id=m["from_email"], text=text or None,
        platform_message_id=msg_key, contact_id=contact_id,
    )
    if row_id and m["subject"]:
        async with pool.acquire() as db:
            await db.execute("UPDATE direct_messages SET email_subject = $1 WHERE id = $2",
                             m["subject"], row_id)

    # ⚠️ Вложения — отдельными сообщениями в той же ленте: у строки переписки
    # одно место под файл, а в письме их бывает несколько. Подпись — имя файла.
    for i, a in enumerate(m["attachments"]):
        kind, ext = _media_kind(a["type"])
        att_id = await archive_direct_message(
            client_id=client_id, platform="email", channel_id=channel_id,
            platform_user_id=m["from_email"], direction="in", author_kind="contact",
            text=a["name"], media_kind=kind, contact_id=contact_id,
            platform_message_id=f"{msg_key}#att{i}" if msg_key else None,
        )
        if att_id:
            url = await _store_bytes_in_r2(
                client_id=client_id, contact_id=contact_id, message_id=att_id,
                data=a["data"], ext=ext, content_type=a["type"])
            if url:
                await update_message_media(att_id, url)

    return {"ok": True, "message_id": row_id, "contact_id": contact_id,
            "attachments": len(m["attachments"])}
