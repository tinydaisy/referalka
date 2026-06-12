"""
Доступ к событию с учётом co-ownership (event_owners, миграция 134).

Совместное событие принадлежит нескольким клиентам (Организаторам).
До 134 событие принадлежало одному `events.client_id`. Теперь владельцы — в `event_owners`
(status='accepted'). `events.client_id` оставлен как «основной/инициатор» для совместимости.

Правило: клиент является владельцем события, если он либо `events.client_id`,
либо есть accepted-запись в `event_owners`.
"""
import asyncpg


async def is_event_owner(db: asyncpg.Connection, event_id: int, client_id: int) -> bool:
    """True если клиент — владелец события (старое client_id ИЛИ accepted co_owner)."""
    row = await db.fetchval(
        """SELECT 1 FROM events WHERE id=$1 AND client_id=$2
            UNION
           SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'
           LIMIT 1""",
        event_id, client_id
    )
    return bool(row)


async def assert_event_owner(db: asyncpg.Connection, event_id: int, client_id: int):
    """Бросает 403/404 если клиент не владелец события."""
    from fastapi import HTTPException
    if not await is_event_owner(db, event_id, client_id):
        raise HTTPException(404, "Событие не найдено или вы не его организатор")


# SQL-условие «события, которыми клиент владеет» (для списков). Подставляется в WHERE.
# Использование: f"WHERE e.id IN ({OWNED_EVENT_IDS_SQL})" с параметром client_id.
def owned_event_ids_sql(client_param: str = "$1") -> str:
    return (
        f"SELECT id FROM events WHERE client_id={client_param} "
        f"UNION "
        f"SELECT event_id FROM event_owners WHERE client_id={client_param} AND status='accepted'"
    )


async def is_collab_event(db: asyncpg.Connection, event_id: int) -> bool:
    """True если событие совместное (>1 accepted владельца) — для блокировки удаления участников/смены рефовода."""
    cnt = await db.fetchval(
        "SELECT count(*) FROM event_owners WHERE event_id=$1 AND status='accepted'", event_id
    )
    return (cnt or 0) > 1
