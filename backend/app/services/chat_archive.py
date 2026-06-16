"""Слушалка чатов событий — архив сообщений для подсчёта заданий.

⚠️ ОТДЕЛЬНО от слушалки ботов (личка). Эта слушалка ничего не отвечает
   и не шлёт уведомлений организатору — только тихо складывает каждое
   сообщение чата события в `event_chat_messages`, чтобы потом считать
   баллы по ключевым словам.

⚠️ Контакты НЕ создаёт. Автора сообщения только СОПОСТАВЛЯЕТ с уже
   существующим контактом клиента по платформенному id (tg_id/vk_id/max).
   Не нашёл — пишет contact_id=NULL (привязка вручную позже).

Что слушаем:
  - chat_id чата события хранится в events.tg_chat_id / vk_chat_id / max_chat_id.
  - Сообщение пишем в архив ТОЛЬКО если его chat_id совпал с одним из этих полей.

Что запоминаем для кнопки «Определить ID»:
  - Каждый чат, где бот админ (поймал сообщение или своё добавление),
    апсертим в bot_known_chats. Кнопка в дашборде читает эту таблицу.
"""
from __future__ import annotations

import logging
from typing import Optional

from app.database import get_pool

log = logging.getLogger(__name__)


async def remember_known_chat(
    *,
    platform: str,
    chat_id: str,
    title: Optional[str],
    bot_id: Optional[str],
    client_id: Optional[int],
    can_read: bool = True,
) -> None:
    """Апсерт чата, где бот админ — для кнопки «Определить ID» в дашборде.

    НЕ контакты. Отдельная служебная таблица bot_known_chats.
    """
    chat_id = str(chat_id)
    bot_id = str(bot_id) if bot_id is not None else None
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            await db.execute(
                """
                INSERT INTO bot_known_chats
                    (client_id, platform, chat_id, title, bot_id, can_read, last_seen_at)
                VALUES ($1, $2, $3, $4, $5, $6, now())
                ON CONFLICT (platform, chat_id, bot_id) DO UPDATE
                   SET title        = COALESCE(EXCLUDED.title, bot_known_chats.title),
                       can_read     = EXCLUDED.can_read,
                       client_id    = COALESCE(EXCLUDED.client_id, bot_known_chats.client_id),
                       last_seen_at = now()
                """,
                client_id, platform, chat_id, title, bot_id, can_read,
            )
    except Exception as e:  # noqa: BLE001 — слушалка не должна падать
        log.warning("remember_known_chat failed (%s chat=%s): %s", platform, chat_id, e)


async def _resolve_event_for_chat(db, platform: str, chat_id: str) -> Optional[tuple[int, int]]:
    """По (платформа, chat_id) найти событие, чей чат это. Возвращает (event_id, client_id) или None.

    Резолв через event_owners (новая co-ownership-архитектура): берём первого
    владельца события (accepted) как client_id для резолва автора.
    """
    col = {
        "telegram": "tg_chat_id",
        "vk": "vk_chat_id",
        "max": "max_chat_id",
    }.get(platform)
    if not col:
        return None
    row = await db.fetchrow(
        f"""
        SELECT e.id AS event_id,
               (SELECT eo.client_id FROM event_owners eo
                  WHERE eo.event_id = e.id AND eo.status = 'accepted'
                  ORDER BY eo.id LIMIT 1) AS client_id
          FROM events e
         WHERE e.{col} = $1
         LIMIT 1
        """,
        str(chat_id),
    )
    if not row or row["client_id"] is None:
        return None
    return int(row["event_id"]), int(row["client_id"])


async def _resolve_contact_id(db, client_id: int, platform: str, platform_user_id: str) -> Optional[int]:
    """Сопоставить автора сообщения с существующим контактом клиента по id площадки.

    НЕ создаёт контакт. Не нашёл → None.
    """
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


async def archive_chat_message(
    *,
    platform: str,
    chat_id: str,
    platform_user_id: str,
    username: Optional[str],
    author_name: Optional[str],
    text: Optional[str],
    has_attachment: bool,
    attachment_kind: Optional[str],
    message_ref: Optional[str],
    sent_at=None,
) -> bool:
    """Записать сообщение чата в архив, ЕСЛИ этот чат привязан к событию.

    Возвращает True если записали (чат события), False если чат не наш.
    Дедуп по (event_id, platform, chat_id, message_ref).
    """
    chat_id = str(chat_id)
    platform_user_id = str(platform_user_id)
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            resolved = await _resolve_event_for_chat(db, platform, chat_id)
            if not resolved:
                return False  # чат не привязан ни к одному событию — не наше дело
            event_id, client_id = resolved

            contact_id = await _resolve_contact_id(db, client_id, platform, platform_user_id)

            await db.execute(
                """
                INSERT INTO event_chat_messages
                    (event_id, platform, chat_id, platform_user_id, username,
                     author_name, contact_id, text, has_attachment, attachment_kind,
                     message_ref, sent_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, now()))
                ON CONFLICT (event_id, platform, chat_id, message_ref)
                    WHERE message_ref IS NOT NULL DO NOTHING
                """,
                event_id, platform, chat_id, platform_user_id, username,
                author_name, contact_id, text, has_attachment, attachment_kind,
                message_ref, sent_at,
            )
            return True
    except Exception as e:  # noqa: BLE001 — слушалка не должна падать
        log.warning("archive_chat_message failed (%s chat=%s): %s", platform, chat_id, e)
        return False
