"""
Рассылки v1 для коллаб-события — копии на подтверждение соорганизаторам.

Модель (см. [[project_collab_broadcasts_v1]]):
- Организаторы коллаб-события равноправны. Каждый ставит рассылку по СВОЕЙ базе
  (schedule.client_id = создатель → движок сам подставит его VIP-бот/базу).
- Если создатель включил галочку «запросить подтверждение по базам соорганизаторов»,
  для каждого ДРУГОГО организатора создаётся КОПИЯ рассылки со статусом
  'awaiting_confirm' + общий confirm_batch_id (пакет = 1 подтверждение) + origin_client_id.
- Соорганизатор подтверждает пакет → его копии → 'pending' (уходят по ЕГО базе).
  Отклоняет → 'cancelled'.

Движок отправки НЕ трогается — только копирование строк broadcast_schedules
на других client_id. Всё платформо-независимо: движок берёт бота по client_id копии.
"""
import uuid
import logging

logger = logging.getLogger(__name__)

# Колонки контента рассылки, которые копируются 1:1 (без статуса/времени владельца).
_COPY_COLS = [
    "event_id", "template_id", "type", "session_id", "fire_at", "is_test",
    "audience_include", "audience_exclude",
    "snapshot_text", "snapshot_photo", "snapshot_buttons",
    "snapshot_video", "snapshot_media_type", "snapshot_btn_text", "snapshot_btn_url",
    "snapshot_subject", "target_channel_ids",
    "send_to_event_chats", "send_to_client_chats",
]


async def other_owner_ids(db, event_id: int, origin_client_id: int) -> list[int]:
    """ID организаторов коллаб-события, КРОМЕ поставившего. Пусто, если не коллаб-событие."""
    ev = await db.fetchval("SELECT is_collab FROM events WHERE id=$1", event_id)
    if not ev:
        return []
    rows = await db.fetch(
        """SELECT client_id FROM event_owners
            WHERE event_id=$1 AND status='accepted' AND client_id<>$2""",
        event_id, origin_client_id)
    return [r["client_id"] for r in rows]


async def _consenting_owner_ids(db, event_id: int, exclude_client_id: int) -> set[int]:
    """Организаторы, заранее РАЗРЕШИВШИЕ рассылки по своей базе (галочка на событии).
    Их копии уходят СРАЗУ (pending), без запроса подтверждения."""
    rows = await db.fetch(
        """SELECT client_id FROM event_owners
            WHERE event_id=$1 AND status='accepted' AND client_id<>$2
              AND allow_collab_broadcasts = TRUE""",
        event_id, exclude_client_id)
    return {r["client_id"] for r in rows}


async def fanout_confirmations(db, event_id: int, origin_client_id: int,
                               source_schedule_ids: list[int]) -> str | None:
    """Создать копии переданных рассылок для КАЖДОГО соорганизатора в статусе
    'awaiting_confirm' под одним confirm_batch_id (пакет = 1 подтверждение).

    Возвращает confirm_batch_id (UUID-строку) или None, если копировать некому /
    нет исходных рассылок. Зовётся ТОЛЬКО когда создатель включил галочку.
    """
    others = await other_owner_ids(db, event_id, origin_client_id)
    if not others or not source_schedule_ids:
        return None

    # Кто заранее разрешил рассылки по своей базе (галочка на событии) → его копия
    # уходит СРАЗУ (pending). Остальным — 'awaiting_confirm' (ждёт подтверждения).
    consenting = await _consenting_owner_ids(db, event_id, origin_client_id)

    batch_id = str(uuid.uuid4())
    cols = ", ".join(_COPY_COLS)
    for sid in source_schedule_ids:
        src = await db.fetchrow(
            f"SELECT {cols} FROM broadcast_schedules WHERE id=$1", sid)
        if not src:
            continue
        values = [src[c] for c in _COPY_COLS]
        placeholders = ", ".join(f"${i+1}" for i in range(len(_COPY_COLS)))
        base_n = len(_COPY_COLS)
        for target_cid in others:
            status = "pending" if target_cid in consenting else "awaiting_confirm"
            await db.execute(
                f"""INSERT INTO broadcast_schedules
                       ({cols}, client_id, status, confirm_batch_id, origin_client_id)
                   VALUES ({placeholders}, ${base_n+1}, ${base_n+2}, ${base_n+3}, ${base_n+4})""",
                *values, target_cid, status, batch_id, origin_client_id)
    logger.info("collab_broadcast: fanout batch %s → %s owners (%s pre-approved), %s src rows",
                batch_id, len(others), len(consenting), len(source_schedule_ids))
    return batch_id
