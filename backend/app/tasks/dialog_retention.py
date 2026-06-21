"""Архивирование старых личных переписок из Postgres в R2.

Зачем: сервер маленький по RAM, а direct_messages растёт неограниченно.
Чтобы «горячая» таблица не раздувалась — сообщения старше порога выгружаем
в R2 как JSONL (по клиенту и контакту) и удаляем из таблицы. Структура
R2-ключа повторяет хранение медиа — clients/{cid}/dialogs/{contact}/archive-*.jsonl,
поэтому переписку легко перенести/выгрузить целиком.

⚠️ Медиа-файлы (фото/видео) НЕ трогаем — они остаются в R2 как были, в jsonl
   сохраняется ссылка media_url. Удаляем только строки таблицы.

Порог хранения — DIALOG_RETENTION_DAYS (по умолчанию 365 дней). Запуск — раз в
сутки через celery beat. Идемпотентно: батчами, дозаписывает в архив текущего
месяца.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from app.celery_app import celery
from app.tasks.broadcast import run_async
from app.database import get_pool

log = logging.getLogger(__name__)

RETENTION_DAYS = 365          # старше этого — в архив
BATCH = 2000                  # сколько строк за один проход


@celery.task(name="app.tasks.dialog_retention.archive_old_dialogs")
def archive_old_dialogs():
    run_async(_archive_old_dialogs())


async def _archive_old_dialogs():
    from app.services.r2_storage import get_r2_client, build_key  # noqa: F401
    from app.config import settings
    import boto3  # noqa: F401

    pool = await get_pool()
    async with pool.acquire() as db:
        # Берём пачку старых сообщений, сгруппируем по (client_id, contact_id, месяц).
        rows = await db.fetch(
            """SELECT * FROM direct_messages
                WHERE sent_at < now() - ($1 || ' days')::interval
                ORDER BY client_id, contact_id, sent_at
                LIMIT $2""",
            str(RETENTION_DAYS), BATCH,
        )
        if not rows:
            log.info("dialog retention: нечего архивировать")
            return

        # Группируем по ключу архива.
        groups: dict[tuple, list] = {}
        for r in rows:
            d = dict(r)
            cid = d["client_id"]
            contact = d.get("contact_id") or 0
            month = d["sent_at"].astimezone(timezone.utc).strftime("%Y-%m")
            groups.setdefault((cid, contact, month), []).append(d)

        client = None
        try:
            client = get_r2_client()
        except Exception as e:  # noqa: BLE001 — нет R2 → не удаляем, ждём настройки
            log.warning("dialog retention: R2 not configured (%s) — пропуск", e)
            return

        archived_ids: list[int] = []
        for (cid, contact, month), items in groups.items():
            key = f"clients/{cid}/dialogs/{contact}/archive-{month}.jsonl"
            # Дозаписываем: читаем существующий объект (если есть) + добавляем.
            prev = b""
            try:
                obj = client.get_object(Bucket=settings.cf_r2_bucket_name, Key=key)
                prev = obj["Body"].read()
            except Exception:  # noqa: BLE001 — нет объекта, создадим новый
                prev = b""

            lines = []
            for d in items:
                rec = {
                    k: (v.isoformat() if isinstance(v, datetime) else v)
                    for k, v in d.items()
                }
                lines.append(json.dumps(rec, ensure_ascii=False))
            body = prev + ("\n".join(lines) + "\n").encode("utf-8")
            try:
                client.put_object(
                    Bucket=settings.cf_r2_bucket_name, Key=key,
                    Body=body, ContentType="application/x-ndjson",
                )
                archived_ids.extend(d["id"] for d in items)
            except Exception as e:  # noqa: BLE001
                log.warning("dialog retention: не записал %s: %s", key, e)

        if archived_ids:
            await db.execute(
                "DELETE FROM direct_messages WHERE id = ANY($1::bigint[])",
                archived_ids,
            )
            log.info("dialog retention: заархивировано и удалено %d сообщений", len(archived_ids))
