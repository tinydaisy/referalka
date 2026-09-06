"""Какое хранилище у клиента — служебное или своё.

⚠️ Развилка нужна В ТРЁХ местах сразу: нарезка записи, сжатие записи и выдача
ссылки на скачивание. Раньше она была скопирована в каждое, и копии начали
расходиться. Здесь — одна функция на всех.

⚠️ Клиент может подключить своё облако (Cloud.ru, фича `own_storage`). Тогда
файл лежит там, и запрос в служебное хранилище вернёт 404 — то есть «файл
пропал», хотя он на месте.
"""
from __future__ import annotations

from app.config import settings
from app.services import r2_storage


async def storage_for(db, client_id: int | None):
    """Возвращает (клиент S3, имя бакета, публичный адрес) ТОГО хранилища,
    где реально лежат файлы этого клиента."""
    own = None
    if client_id:
        own = await db.fetchrow(
            """SELECT storage_endpoint, storage_region, storage_bucket,
                      storage_access_key, storage_secret_key, storage_public_url
                 FROM clients WHERE id = $1 AND storage_provider IS NOT NULL""",
            client_id)
    if not own:
        return (r2_storage.get_r2_client(), settings.cf_r2_bucket_name,
                (settings.cf_r2_public_url or "").rstrip("/"))

    import boto3
    from botocore.client import Config as _Cfg
    cl = boto3.client(
        "s3", endpoint_url=own["storage_endpoint"],
        aws_access_key_id=own["storage_access_key"],
        aws_secret_access_key=own["storage_secret_key"],
        region_name=own["storage_region"] or "ru-central-1",
        config=_Cfg(signature_version="s3v4"))
    return cl, own["storage_bucket"], (own["storage_public_url"] or "").rstrip("/")
