from typing import Optional, AsyncGenerator
import asyncpg
from app.config import settings

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None and settings.database_url:
        _pool = await asyncpg.create_pool(settings.database_url, min_size=2, max_size=10)
    return _pool


async def get_db() -> AsyncGenerator[asyncpg.Connection, None]:
    pool = await get_pool()
    if pool is None:
        raise RuntimeError("База данных не настроена. Укажите DATABASE_URL в .env")
    async with pool.acquire() as conn:
        yield conn


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
