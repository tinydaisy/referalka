"""
Автообзвоны — фоновая отправка в Звонопёс (миграция 359).

Поллер раз в минуту берёт кампании со `status='pending'` и `fire_at <= NOW()`,
собирает аудиторию и отдаёт номера сервису пачками.

⚠️ Почему в фоне, а не в HTTP-запросе: база в тысячи номеров режется на пачки и
уходит несколькими запросами к их API — это минуты. Запрос из браузера отвалился
бы по таймауту, оставив кампанию наполовину отправленной.

⚠️ Результат звонка приходит ОТЛОЖЕННО, вебхуком (у рассылок такого нет вовсе):
наш запрос → сервис звонит когда дойдёт очередь → результат прилетает потом.
Поэтому строки call_log рождаются здесь со статусом 'queued', а финальный статус
проставляет обработчик вебхука в api/call_campaigns.py.
"""
import asyncio
import logging
from datetime import datetime, timezone

import asyncpg

from app.celery_app import celery
from app.config import settings
from app.services import calldog
from app.services.call_audience import collect_call_targets, chunked
from app.services.features import client_has_feature

logger = logging.getLogger(__name__)


def run_async(coro):
    """⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но не делает
    его текущим. Библиотеки внутри зовут get_event_loop() и получают ЗАКРЫТЫЙ
    цикл предыдущей задачи этого же воркера → RuntimeError('Event loop is
    closed'). На этом уже молча терялись записи эфиров и тексты воронок."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


async def _get_conn():
    return await asyncpg.connect(settings.database_url)


@celery.task(name="app.tasks.calls.check_and_run_campaigns")
def check_and_run_campaigns():
    run_async(_check_and_run())


async def _check_and_run():
    conn = await _get_conn()
    try:
        # Watchdog: кампания, зависшая в running (упал воркер) — вернуть в очередь.
        stale = await conn.fetch(
            """SELECT id FROM call_campaigns
                WHERE status = 'running' AND started_at < NOW() - INTERVAL '15 minutes'"""
        )
        for s in stale:
            logger.warning("Watchdog: обзвон %s завис в running, возвращаем в очередь", s["id"])
            await conn.execute(
                "UPDATE call_campaigns SET status='pending', started_at=NULL WHERE id=$1",
                s["id"],
            )

        rows = await conn.fetch(
            """SELECT id FROM call_campaigns
                WHERE status = 'pending' AND fire_at <= NOW()
                ORDER BY fire_at"""
        )
        for r in rows:
            await conn.execute(
                "UPDATE call_campaigns SET status='running', started_at=NOW() WHERE id=$1",
                r["id"],
            )
            run_campaign.delay(r["id"])
    finally:
        await conn.close()


@celery.task(name="app.tasks.calls.run_campaign")
def run_campaign(campaign_id: int):
    run_async(_run_campaign(campaign_id))


async def _run_campaign(campaign_id: int):
    conn = await _get_conn()
    try:
        camp = await conn.fetchrow("SELECT * FROM call_campaigns WHERE id = $1", campaign_id)
        if not camp:
            return
        client_id = camp["client_id"]

        # ⚠️ Гейт по фиче ВНУТРИ задачи, а не только в API: иначе он обходится
        # прямым запросом или старой записью, созданной когда фича была.
        if not await client_has_feature(conn, client_id, "calls"):
            await _fail(conn, campaign_id, "Автообзвоны недоступны на вашем тарифе.")
            return

        # Подписка клиента — как у рассылок: истекла, значит платформа заморожена.
        sub = await conn.fetchrow(
            """SELECT cs.id FROM client_subscriptions cs
                WHERE cs.client_id = $1 AND cs.status = 'active'
                  AND cs.expires_at > NOW() LIMIT 1""",
            client_id,
        )
        if not sub:
            await _fail(conn, campaign_id, "Подписка на платформу истекла.")
            return

        st = await conn.fetchrow(
            "SELECT calls_calldog_api_key FROM clients WHERE id = $1", client_id
        )
        st = dict(st or {})
        if not calldog.is_configured(st):
            await _fail(conn, campaign_id, "Звонопёс не подключён: не указан API-ключ.")
            return
        api_key = (st["calls_calldog_api_key"] or "").strip()

        res = await collect_call_targets(
            conn,
            client_id=client_id,
            event_id=camp["event_id"],
            audience_include=camp["audience_include"],
            audience_exclude=camp["audience_exclude"],
            tags_include=camp["audience_tags_include"],
            tags_exclude=camp["audience_tags_exclude"],
        )
        targets = res["targets"]
        if not targets:
            await _fail(conn, campaign_id, "Некому звонить: ни у кого нет телефона.")
            return

        await conn.execute(
            """UPDATE call_campaigns
                  SET targets_total = $2, skipped_no_phone = $3, skipped_unsub = $4
                WHERE id = $1""",
            campaign_id, len(targets), res["skipped_no_phone"], res["skipped_unsub"],
        )

        # ⚠️ Идемпотентность: если задача перезапустилась (упал воркер после
        # части пачек), уже отправленные номера пропускаем — иначе человек
        # получит второй звонок, а клиент заплатит дважды.
        already = {
            r["phone"] for r in await conn.fetch(
                "SELECT phone FROM call_log WHERE campaign_id = $1", campaign_id
            )
        }
        targets = [t for t in targets if t["phone"] not in already]

        webhook_url = _webhook_url()
        by_phone = {t["phone"]: t for t in targets}
        sent, failed = 0, 0
        errors: list[str] = []

        for pack in chunked(targets, calldog.MAX_PHONES_PER_REQUEST):
            phones = [t["phone"] for t in pack]
            # Имя в озвучке: сервис подставляет переменные пофамильно на номер.
            variables = {
                t["phone"]: {t["name"]: "{name}"} for t in pack if t["name"]
            }
            try:
                created = await calldog.create_calls_with_template(
                    api_key,
                    template_id=camp["template_id"],
                    phones=phones,
                    # ⚠️ Всегда карусель (dutyPhone=1): свой номер при обзвоне
                    # тысяч человек показывать нельзя — на него начнут
                    # перезванивать и жаловаться. Плюс по их тарифам карусель
                    # дешевле: платится только за прослушанные секунды.
                    duty_phone=True,
                    smart_delay=camp["smart_delay"],
                    start_time=camp["start_time"],
                    end_time=camp["end_time"],
                    weekdays=list(camp["weekdays"]) if camp["weekdays"] else None,
                    webhook_url=webhook_url,
                    webhook_parameters={"campaign_id": campaign_id},
                    variables=variables or None,
                )
            except calldog.CalldogError as e:
                failed += len(phones)
                errors.append(str(e))
                logger.warning("обзвон %s: пачка не ушла — %s", campaign_id, e)
                # Пачка не ушла — записываем её как неудачу, чтобы клиент видел,
                # до кого не дозвонились, а не гадал по разнице чисел.
                await _log_failed(conn, campaign_id, pack, str(e))
                continue

            # Их ответ: список созданных звонков с id и номером.
            rows = []
            for item in created:
                ph = str(item.get("phone") or "").strip()
                t = by_phone.get(ph)
                rows.append((
                    campaign_id,
                    t["contact_id"] if t else None,
                    ph or (t["phone"] if t else ""),
                    str(item.get("id")) if item.get("id") is not None else None,
                ))
            if rows:
                await conn.executemany(
                    """INSERT INTO call_log (campaign_id, contact_id, phone,
                                             external_call_id, status)
                       VALUES ($1, $2, $3, $4, 'queued')""",
                    rows,
                )
                sent += len(rows)

            # Их ответ может не содержать часть номеров — отметим как неудачу.
            returned = {str(i.get("phone") or "").strip() for i in created}
            missing = [t for t in pack if t["phone"] not in returned]
            if missing:
                await _log_failed(conn, campaign_id, missing, "Сервис не принял номер.")
                failed += len(missing)

        status = "done" if sent else "failed"
        await conn.execute(
            """UPDATE call_campaigns
                  SET status = $2, finished_at = NOW(), updated_at = NOW(),
                      error_log = $3
                WHERE id = $1""",
            campaign_id, status,
            ("; ".join(errors)[:2000] or None) if errors else None,
        )
        logger.info("обзвон %s завершён: отправлено %s, не ушло %s", campaign_id, sent, failed)
    except Exception as e:  # noqa: BLE001
        logger.exception("обзвон %s упал: %s", campaign_id, e)
        try:
            await _fail(conn, campaign_id, f"Внутренняя ошибка: {e}")
        except Exception:
            pass
    finally:
        await conn.close()


async def _log_failed(conn, campaign_id: int, targets: list, error: str) -> None:
    if not targets:
        return
    await conn.executemany(
        """INSERT INTO call_log (campaign_id, contact_id, phone, status, error)
           VALUES ($1, $2, $3, 'failed', $4)""",
        [(campaign_id, t["contact_id"], t["phone"], error[:500]) for t in targets],
    )


async def _fail(conn, campaign_id: int, message: str) -> None:
    await conn.execute(
        """UPDATE call_campaigns
              SET status = 'failed', error_log = $2, finished_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1""",
        campaign_id, message[:2000],
    )


def _webhook_url() -> str:
    """Куда сервис пришлёт результат звонка.

    ⚠️ Адрес ПЛАТФОРМЫ (`platform_base_url`), а не домен клиента: вебхук — это
    приём данных, и на клиентском домене он бы не обслуживался. Литералов
    `pluson.ru` в коде быть не должно — только через хелпер.
    """
    from app.services.client_domains import platform_base_url
    return f"{platform_base_url()}/api/v1/public/calls/webhook"
