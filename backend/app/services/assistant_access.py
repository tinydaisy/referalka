"""
Уровень доступа помощника кабинета (миграции 208, 209).

Помощник ведёт несколько кабинетов, и в каждом у него свой уровень доступа,
поэтому уровень живёт в ПРОПУСКЕ (`assistant_grants`), а не в самом человеке.
Номер пропуска (`grant_id`) кладётся в JWT при входе — по нему и спрашиваем.

'full'    — те же права, что у владельца кабинета. Исключения: раздел управления
            помощниками (иначе он отзовёт себе доступ), админка, а также пароль
            владельца и письмо на его email.
'limited' — исторический набор прав (см. middleware/assistant_permission_guard.py).

Уровень читается ИЗ БД, а не из JWT: владелец переключает тумблер — права
меняются сразу, помощнику не нужно перелогиниваться.
"""
from typing import Optional

import asyncpg

from app.database import get_pool


async def get_grant_access_level(grant_id: Optional[int]) -> str:
    """Возвращает 'full' | 'limited'. Отозванный/неизвестный пропуск → 'limited'."""
    if not grant_id:
        return "limited"
    pool = await get_pool()
    if pool is None:
        return "limited"
    async with pool.acquire() as conn:
        lvl = await conn.fetchval(
            "SELECT access_level FROM assistant_grants WHERE id = $1", int(grant_id)
        )
    return "full" if lvl == "full" else "limited"


async def is_full_grant_row(db: asyncpg.Connection, grant_id: Optional[int]) -> bool:
    """То же самое, но на уже открытом соединении (для эндпоинтов)."""
    if not grant_id:
        return False
    lvl = await db.fetchval(
        "SELECT access_level FROM assistant_grants WHERE id = $1", int(grant_id)
    )
    return lvl == "full"


async def assistant_is_restricted(user: dict) -> bool:
    """
    True — если это помощник с ограниченными правами (нужно резать доступ).
    False — владелец, админ или помощник с полным доступом.

    `user` — payload JWT (то, что отдаёт get_current_client / get_current_user).
    """
    if user.get("role") != "assistant":
        return False
    lvl = await get_grant_access_level(user.get("grant_id"))
    return lvl != "full"
