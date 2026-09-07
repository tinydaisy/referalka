"""
Фоновые задачи Instagram: напоминание молчащему и продление токенов.

⚠️⚠️ `asyncio.set_event_loop(loop)` ОБЯЗАТЕЛЕН в каждой задаче. `new_event_loop()`
создаёт цикл, но НЕ делает его текущим: библиотеки внутри зовут
`asyncio.get_event_loop()` и получают ЗАКРЫТЫЙ цикл предыдущей задачи того же
воркера → RuntimeError('Event loop is closed'). На этом уже молча терялись
записи эфиров и Текст 3 воронок — правило проекта, не убирать.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import asyncpg

from ..celery_app import celery_app
from ..config import settings

log = logging.getLogger(__name__)


def _run(coro):
    """Запустить корутину в задаче Celery — с правильным циклом событий."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@celery_app.task(name="app.tasks.instagram.send_reminder")
def send_reminder(run_id: int):
    """Напоминание человеку, который не забрал материал.

    ⚠️ Внутри ЗАНОВО сверяется 24-часовое окно: задача ставится заранее, и к
    моменту исполнения срок мог выйти. Вне окна Meta отклонит отправку, а серия
    отказов портит репутацию приложения.
    """
    async def _go():
        from ..services.instagram_funnel import send_reminder as do
        conn = await asyncpg.connect(settings.database_url)
        try:
            return await do(conn, run_id)
        finally:
            await conn.close()

    try:
        return _run(_go())
    except Exception:
        log.exception("Instagram: напоминание run=%s сорвалось", run_id)
        return False


@celery_app.task(name="app.tasks.instagram.refresh_tokens")
def refresh_tokens():
    """Продлить токены, которым осталось меньше 10 дней.

    ⚠️⚠️ Токен живёт 60 дней. Без этой задачи воронка через два месяца молча
    перестаёт отвечать людям: не ломается заметно, а просто затихает — и клиент
    узнаёт об этом от подписчиков, а не от нас.

    ⚠️ Продлеваем ЗАРАНЕЕ, за 10 дней: если продление не удалось (клиент сменил
    пароль, отозвал доступ), остаётся время предупредить и переподключить.
    """
    async def _go():
        import json
        from ..services import instagram_api as ig

        conn = await asyncpg.connect(settings.database_url)
        ok = failed = 0
        try:
            rows = await conn.fetch(
                "SELECT id, bot_token, platform_meta FROM channels "
                " WHERE platform_slug='instagram' AND COALESCE(bot_token,'') <> ''"
            )
            soon = int((datetime.now(timezone.utc) + timedelta(days=10)).timestamp())
            for r in rows:
                meta = r["platform_meta"] or {}
                if isinstance(meta, str):
                    meta = json.loads(meta)
                exp = int(meta.get("token_expires_at") or 0)
                if exp and exp > soon:
                    continue
                try:
                    tok, ttl = await ig.refresh_long_lived(r["bot_token"])
                except Exception as e:
                    failed += 1
                    log.warning("Instagram: токен канала %s не продлён — %s", r["id"], e)
                    # ⚠️ Отметку об ошибке кладём в сам канал: по ней кабинет
                    # покажет клиенту, что доступ пора обновить, не дожидаясь,
                    # пока воронка замолчит.
                    meta["token_refresh_failed_at"] = int(datetime.now(timezone.utc).timestamp())
                    await conn.execute(
                        "UPDATE channels SET platform_meta=$2::jsonb WHERE id=$1",
                        r["id"], json.dumps(meta),
                    )
                    continue
                meta["token_expires_at"] = int(datetime.now(timezone.utc).timestamp()) + ttl
                meta.pop("token_refresh_failed_at", None)
                await conn.execute(
                    "UPDATE channels SET bot_token=$2, platform_meta=$3::jsonb, updated_at=now() WHERE id=$1",
                    r["id"], tok, json.dumps(meta),
                )
                ok += 1
        finally:
            await conn.close()
        return {"refreshed": ok, "failed": failed}

    try:
        return _run(_go())
    except Exception:
        log.exception("Instagram: продление токенов сорвалось")
        return {"refreshed": 0, "failed": 0}
