"""Личные переписки (Диалоги) — архив ЛС человека с ботом/сообществом клиента.

⚠️ ОТДЕЛЬНО от chat_archive.py (групповые чаты событий, подсчёт баллов).
   Здесь — личная переписка 1-на-1: клиент видит всю историю и отвечает сам.

Что пишем в `direct_messages`:
  • direction='in'  author_kind='contact'  — человек написал боту;
  • direction='out' author_kind='bot'      — авто-ответ бота;
  • direction='out' author_kind='operator' — клиент ответил вручную из дашборда.

Хранение медиа:
  • Голосовые НЕ качаем (media_kind='voice', media_url=NULL) — бот просит текст.
  • Остальные файлы качаем в R2 по ключу dialog_media (clients/{cid}/dialogs/{contact}/...),
    учитываем в квоте клиента (storage_used_bytes + client_files).

Сервис best-effort: ни одна ошибка архива не должна ронять бот/вебхук.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.database import get_pool

log = logging.getLogger(__name__)

# Лимит на скачиваемый в R2 файл переписки (как у funnel_media). Голос не качаем.
MAX_DIALOG_MEDIA_BYTES = 50 * 1024 * 1024


async def resolve_contact_id(
    db, client_id: int, platform: str, platform_user_id: str
) -> Optional[int]:
    """Сопоставить собеседника с существующим контактом клиента. НЕ создаёт."""
    return await db.fetchval(
        """
        SELECT pu.contact_id
          FROM platform_users pu
         WHERE pu.client_id = $1
           AND pu.platform_slug = $2
           AND pu.platform_user_id = $3
         LIMIT 1
        """,
        client_id, platform, str(platform_user_id),
    )


async def archive_direct_message(
    *,
    client_id: int,
    platform: str,
    channel_id: Optional[int],
    platform_user_id: str,
    direction: str,
    author_kind: str,
    text: Optional[str] = None,
    media_url: Optional[str] = None,
    media_kind: Optional[str] = None,
    platform_message_id: Optional[str] = None,
    contact_id: Optional[int] = None,
    error: Optional[str] = None,
    sent_at=None,
) -> Optional[int]:
    """Записать одно сообщение личной переписки. Возвращает id строки или None.

    contact_id можно передать заранее (если уже знаем); иначе резолвим по площадке.
    Дедуп по (client_id, platform, platform_user_id, direction, platform_message_id).
    """
    platform_user_id = str(platform_user_id)
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            if contact_id is None:
                contact_id = await resolve_contact_id(
                    db, client_id, platform, platform_user_id
                )
            row = await db.fetchrow(
                """
                INSERT INTO direct_messages
                    (client_id, contact_id, platform, channel_id, platform_user_id,
                     direction, author_kind, text, media_url, media_kind,
                     platform_message_id, error, sent_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13, now()))
                ON CONFLICT (client_id, platform, platform_user_id, direction, platform_message_id)
                    WHERE platform_message_id IS NOT NULL
                DO NOTHING
                RETURNING id
                """,
                client_id, contact_id, platform, channel_id, platform_user_id,
                direction, author_kind, text, media_url, media_kind,
                platform_message_id, error, sent_at,
            )
            return int(row["id"]) if row else None
    except Exception as e:  # noqa: BLE001 — архив не должен падать
        log.warning("archive_direct_message failed (%s %s): %s",
                    platform, platform_user_id, e)
        return None


async def _store_bytes_in_r2(
    *, client_id: int, contact_id: Optional[int], message_id: Optional[int],
    data: bytes, ext: str, content_type: str,
) -> Optional[str]:
    """Залить байты в R2 под ключ dialog_media + учесть в квоте клиента.

    Если contact_id нет (собеседник не привязан к контакту) — складываем в
    папку 0 (clients/{cid}/dialogs/0/...). Возвращает public URL или None.
    """
    from app.services.r2_storage import build_key, upload_bytes
    size = len(data)
    if size == 0 or size > MAX_DIALOG_MEDIA_BYTES:
        return None
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            # Проверка квоты — медиа переписок считается в storage клиента.
            q = await db.fetchrow(
                "SELECT storage_used_bytes, storage_quota_bytes FROM clients WHERE id = $1",
                client_id,
            )
            if q and int(q["storage_used_bytes"]) + size > int(q["storage_quota_bytes"]):
                log.info("dialog media skipped — quota exceeded (client %s)", client_id)
                return None

            key = build_key(client_id, "dialog_media", ext,
                            contact_id=contact_id or 0, message_id=message_id)
            url = await upload_bytes(key, data, content_type)

            await db.execute(
                """INSERT INTO client_files (client_id, kind, r2_key, url, size_bytes, content_type)
                   VALUES ($1, 'dialog_media', $2, $3, $4, $5)
                   ON CONFLICT (r2_key) DO NOTHING""",
                client_id, key, url, size, content_type,
            )
            await db.execute(
                "UPDATE clients SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2",
                size, client_id,
            )
            return url
    except Exception as e:  # noqa: BLE001
        log.warning("dialog media store failed (client %s): %s", client_id, e)
        return None


async def store_media_from_url(
    *, client_id: int, contact_id: Optional[int], message_id: Optional[int],
    file_url: str, media_kind: str, file_name: Optional[str] = None,
) -> Optional[str]:
    """Скачать файл по временному URL (TG getFile / VK / MAX) и положить в R2.

    Голосовые сюда не передаём (их не храним). Возвращает постоянный R2 URL.

    ⚠️ Запрещённые типы (п. 7.10 Оферты) НЕ скачиваем вовсе: файл присылает
    участник, и запретить ему выбрать .exe мы не можем — значит просто не
    кладём такое в хранилище. Само сообщение при этом сохраняется, теряется
    только вложение.
    """
    from app.services.file_safety import is_blocked_file
    _name = file_name or file_url.split("/")[-1].split("?")[0]
    if is_blocked_file(_name):
        log.info("dialog media skipped (blocked type): %s", _name)
        return None

    try:
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.get(file_url)
            if r.status_code != 200:
                return None
            data = r.content
            content_type = r.headers.get("content-type", "application/octet-stream")
    except Exception as e:  # noqa: BLE001
        log.warning("dialog media download failed: %s", e)
        return None

    # Расширение из content-type или из url
    ext = "bin"
    ct = content_type.split(";")[0].strip()
    ct_map = {
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
        "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov",
        "audio/mpeg": "mp3", "audio/ogg": "ogg",
        "application/pdf": "pdf",
    }
    if ct in ct_map:
        ext = ct_map[ct]
    elif "." in file_url.split("/")[-1].split("?")[0]:
        ext = file_url.split("/")[-1].split("?")[0].rsplit(".", 1)[-1][:8] or "bin"

    # Повторная проверка по фактическому типу и итоговому расширению: имя из
    # мессенджера могло прийти без расширения, и запрет по нему не сработал.
    if is_blocked_file(f"f.{ext}", ct):
        log.info("dialog media skipped after download (blocked): ext=%s ct=%s", ext, ct)
        return None

    return await _store_bytes_in_r2(
        client_id=client_id, contact_id=contact_id, message_id=message_id,
        data=data, ext=ext, content_type=ct,
    )


async def update_message_media(message_id: int, media_url: str) -> None:
    """Проставить media_url у уже записанной строки (после загрузки в R2)."""
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            await db.execute(
                "UPDATE direct_messages SET media_url = $1 WHERE id = $2",
                media_url, message_id,
            )
    except Exception as e:  # noqa: BLE001
        log.warning("update_message_media failed: %s", e)


# ─────────────────────────────────────────────────────────────────────────────
# Высокоуровневые хелперы для обработчиков ботов
# ─────────────────────────────────────────────────────────────────────────────

VOICE_REPLY = (
    "Голосовые сообщения мы не обрабатываем 🙏 "
    "Пожалуйста, напишите текстом — так быстрее ответим."
)


async def archive_incoming(
    *,
    client_id: int,
    platform: str,
    channel_id: Optional[int],
    platform_user_id: str,
    text: Optional[str],
    media_kind: Optional[str] = None,
    file_url: Optional[str] = None,
    platform_message_id: Optional[str] = None,
    contact_id: Optional[int] = None,
    sent_at=None,
) -> Optional[int]:
    """Записать входящее сообщение человека + (опц.) скачать медиа в R2.

    Голос (media_kind='voice') не качаем — только пометка.
    """
    row_id = await archive_direct_message(
        client_id=client_id, platform=platform, channel_id=channel_id,
        platform_user_id=platform_user_id, direction="in", author_kind="contact",
        text=text, media_kind=media_kind, platform_message_id=platform_message_id,
        contact_id=contact_id, sent_at=sent_at,
    )
    if row_id and file_url and media_kind and media_kind != "voice":
        url = await store_media_from_url(
            client_id=client_id, contact_id=contact_id, message_id=row_id,
            file_url=file_url, media_kind=media_kind,
        )
        if url:
            await update_message_media(row_id, url)
    return row_id


async def archive_outgoing_bot(
    *,
    client_id: int,
    platform: str,
    channel_id: Optional[int],
    platform_user_id: str,
    text: Optional[str],
    platform_message_id: Optional[str] = None,
    contact_id: Optional[int] = None,
) -> Optional[int]:
    """Записать авто-ответ бота (для полноты ленты)."""
    return await archive_direct_message(
        client_id=client_id, platform=platform, channel_id=channel_id,
        platform_user_id=platform_user_id, direction="out", author_kind="bot",
        text=text, platform_message_id=platform_message_id, contact_id=contact_id,
    )
