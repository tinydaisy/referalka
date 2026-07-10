"""
Уровень доступа ассистента клиента (миграция 208).

'full'    — те же права, что у владельца кабинета. Единственное исключение —
            раздел управления ассистентом (/clients/me/assistant/*): полный
            ассистент не может сменить себе пароль или удалить себя.
'limited' — историческое поведение (см. middleware/assistant_permission_guard.py).

Уровень читается ИЗ БД, а не из JWT: владелец переключает тумблер — права
меняются сразу, ассистенту не нужно перелогиниваться.
"""
from typing import Optional

import asyncpg

from app.database import get_pool


async def get_assistant_access_level(assistant_id: Optional[int]) -> str:
    """Возвращает 'full' | 'limited'. Неизвестный/удалённый ассистент → 'limited'."""
    if not assistant_id:
        return "limited"
    pool = await get_pool()
    if pool is None:
        return "limited"
    async with pool.acquire() as conn:
        lvl = await conn.fetchval(
            "SELECT access_level FROM client_assistants WHERE id = $1", int(assistant_id)
        )
    return "full" if lvl == "full" else "limited"


async def is_full_assistant_row(db: asyncpg.Connection, assistant_id: Optional[int]) -> bool:
    """То же самое, но на уже открытом соединении (для эндпоинтов)."""
    if not assistant_id:
        return False
    lvl = await db.fetchval(
        "SELECT access_level FROM client_assistants WHERE id = $1", int(assistant_id)
    )
    return lvl == "full"


async def assistant_is_restricted(user: dict) -> bool:
    """
    True — если это ассистент с ограниченными правами (нужно резать доступ).
    False — владелец, админ или ассистент с полным доступом.

    `user` — payload JWT (то, что отдаёт get_current_client / get_current_user).
    """
    if user.get("role") != "assistant":
        return False
    lvl = await get_assistant_access_level(user.get("assistant_id"))
    return lvl != "full"
