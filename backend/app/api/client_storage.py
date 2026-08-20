"""
Своё файловое хранилище клиента (S3-совместимое: Cloud.ru и подобные).

Зачем. Встроенного места хватает надолго на афиши и фото, но одна запись эфира —
это гигабайты. Клиент подключает своё бесплатное хранилище и перестаёт упираться
в квоту.

⚠️ Ключи вводит САМ КЛИЕНТ здесь, а не присылает в поддержку: секретный ключ
даёт полный доступ к хранилищу, пересылать его перепиской нельзя.

⚠️ Секретный ключ наружу НЕ отдаём никогда — только признак «задан».
Иначе он утечёт в браузер, а оттуда в логи и историю.
"""
import asyncio
import re
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.assistant_access import assistant_is_restricted

router = APIRouter(prefix="/clients/me/storage", tags=["Файловое хранилище"])


class StorageSettings(BaseModel):
    endpoint: Optional[str] = None
    region: Optional[str] = None
    bucket: Optional[str] = None
    access_key: Optional[str] = None
    secret_key: Optional[str] = None
    public_url: Optional[str] = None


def _norm_url(v: Optional[str]) -> Optional[str]:
    """Приводит адрес к виду https://host без хвостового слэша.

    ⚠️ Клиент копирует Endpoint из Cloud.ru вместе с именем бакета
    (`https://s3.cloud.ru/pluson`) — это нормальный человеческий поступок,
    но boto3 такой адрес не примет. Имя бакета отрезаем сами, а не ругаемся.
    """
    if not v:
        return None
    v = v.strip().rstrip("/")
    if not v:
        return None
    if not v.startswith(("http://", "https://")):
        v = "https://" + v
    return v


def _strip_bucket_from_endpoint(endpoint: str, bucket: Optional[str]) -> str:
    if bucket and endpoint.endswith("/" + bucket):
        return endpoint[: -(len(bucket) + 1)]
    return endpoint


@router.get("", summary="Настройки своего хранилища")
async def get_storage(client=Depends(get_current_client),
                      db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """SELECT storage_provider, storage_endpoint, storage_region, storage_bucket,
                  storage_access_key, storage_public_url, storage_checked_at, storage_error,
                  (storage_secret_key IS NOT NULL AND storage_secret_key <> '') AS has_secret
             FROM clients WHERE id = $1""",
        int(client["sub"]),
    )
    if not row:
        raise HTTPException(404, detail="Клиент не найден")
    # Подсказка глобального имени бакета: номер кабинета + случайный хвост.
    # ⚠️ Имя уникально на ВСЮ платформу Cloud.ru, а её клиенты — не только
    # ПЛЮСОН: короткое `pluson-media-1` вполне может быть занято посторонним.
    # Хвост берём от id клиента детерминированно — чтобы подсказка не менялась
    # при каждом открытии страницы и её можно было спокойно скопировать.
    import hashlib
    cid = int(client["sub"])
    tail = hashlib.sha256(f"pluson-storage-{cid}".encode()).hexdigest()[:4]

    return {
        "client_id": cid,
        "suggested_global_name": f"pluson-media-{cid}-{tail}",
        "connected": bool(row["storage_provider"]),
        "provider": row["storage_provider"],
        "endpoint": row["storage_endpoint"],
        "region": row["storage_region"],
        "bucket": row["storage_bucket"],
        "access_key": row["storage_access_key"],
        "public_url": row["storage_public_url"],
        # Сам ключ не отдаём — только признак, что он сохранён.
        "has_secret": bool(row["has_secret"]),
        "checked_at": row["storage_checked_at"].isoformat() if row["storage_checked_at"] else None,
        "error": row["storage_error"],
    }


@router.put("", summary="Сохранить настройки своего хранилища")
async def save_storage(data: StorageSettings,
                       client=Depends(get_current_client),
                       db: asyncpg.Connection = Depends(get_db)):
    # Ошибка тут кладёт загрузку файлов всему кабинету — ассистенту не даём.
    if await assistant_is_restricted(client):
        raise HTTPException(403, detail="Настройка хранилища доступна только владельцу кабинета.")

    client_id = int(client["sub"])
    bucket = (data.bucket or "").strip() or None
    endpoint = _norm_url(data.endpoint)
    if endpoint:
        endpoint = _strip_bucket_from_endpoint(endpoint, bucket)
    region = (data.region or "").strip() or None
    access_key = (data.access_key or "").strip() or None
    public_url = _norm_url(data.public_url)

    missing = [n for n, v in (("адрес хранилища", endpoint), ("имя бакета", bucket),
                              ("ключ доступа", access_key), ("публичный адрес", public_url))
               if not v]
    if missing:
        raise HTTPException(400, detail="Заполните: " + ", ".join(missing))

    # Секретный ключ мог не прийти — значит клиент его не менял, оставляем прежний.
    secret = (data.secret_key or "").strip() or None
    if secret is None:
        cur = await db.fetchval("SELECT storage_secret_key FROM clients WHERE id=$1", client_id)
        if not cur:
            raise HTTPException(400, detail="Заполните: секретный ключ")
        secret = cur

    ok, err = await _check_connection(endpoint, region, bucket, access_key, secret)
    if not ok:
        raise HTTPException(400, detail=err)

    await db.execute(
        """UPDATE clients SET storage_provider='cloudru', storage_endpoint=$2,
                  storage_region=$3, storage_bucket=$4, storage_access_key=$5,
                  storage_secret_key=$6, storage_public_url=$7,
                  storage_checked_at=NOW(), storage_error=NULL
            WHERE id=$1""",
        client_id, endpoint, region, bucket, access_key, secret, public_url,
    )
    return {"ok": True, "message": "Хранилище подключено — связь проверена."}


@router.post("/check", summary="Проверить связь с хранилищем")
async def check_storage(client=Depends(get_current_client),
                        db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """SELECT storage_endpoint, storage_region, storage_bucket,
                  storage_access_key, storage_secret_key
             FROM clients WHERE id=$1""", int(client["sub"]))
    if not row or not row["storage_endpoint"]:
        raise HTTPException(400, detail="Хранилище не подключено")

    ok, err = await _check_connection(row["storage_endpoint"], row["storage_region"],
                                      row["storage_bucket"], row["storage_access_key"],
                                      row["storage_secret_key"])
    await db.execute("UPDATE clients SET storage_checked_at=NOW(), storage_error=$2 WHERE id=$1",
                     int(client["sub"]), None if ok else err)
    return {"ok": ok, "message": "Связь есть, хранилище отвечает." if ok else err}


@router.delete("", summary="Отключить своё хранилище")
async def disconnect_storage(client=Depends(get_current_client),
                             db: asyncpg.Connection = Depends(get_db)):
    if await assistant_is_restricted(client):
        raise HTTPException(403, detail="Настройка хранилища доступна только владельцу кабинета.")
    # ⚠️ Уже загруженные файлы остаются в хранилище клиента и продолжают
    # открываться по своим ссылкам — стирать их отсюда нельзя.
    await db.execute(
        """UPDATE clients SET storage_provider=NULL, storage_error=NULL WHERE id=$1""",
        int(client["sub"]))
    return {"ok": True, "message": "Хранилище отключено. Новые файлы пойдут в хранилище ПЛЮСОНа, "
                                   "а уже загруженные останутся на месте и продолжат открываться."}


async def _check_connection(endpoint: str, region: Optional[str], bucket: str,
                            access_key: str, secret_key: str):
    """Реально ходит в хранилище: пишет пробный файл, читает и удаляет.

    ⚠️ Проверяем именно ЗАПИСЬ, а не просто «бакет существует»: ключ с правами
    только на чтение пройдёт лёгкую проверку, а потом молча сломает все загрузки.
    """
    import boto3
    from botocore.client import Config as BotoConfig

    def _run():
        s3 = boto3.client(
            "s3", endpoint_url=endpoint,
            aws_access_key_id=access_key, aws_secret_access_key=secret_key,
            region_name=region or "ru-central-1",
            config=BotoConfig(signature_version="s3v4", connect_timeout=10, read_timeout=20,
                              retries={"max_attempts": 1}),
        )
        key = "_pluson_check.txt"
        s3.put_object(Bucket=bucket, Key=key, Body=b"pluson", ContentType="text/plain")
        s3.get_object(Bucket=bucket, Key=key)
        s3.delete_object(Bucket=bucket, Key=key)

    try:
        await asyncio.get_event_loop().run_in_executor(None, _run)
        return True, None
    except Exception as e:
        text = str(e)
        # Переводим типовые ответы S3 на человеческий: клиент не программист,
        # «AccessDenied» ему ничего не говорит.
        if "InvalidAccessKeyId" in text or "SignatureDoesNotMatch" in text:
            return False, "Ключ доступа или секретный ключ неверный — проверьте, что скопировали целиком."
        if "NoSuchBucket" in text:
            return False, f"Хранилище «{bucket}» не найдено — проверьте имя (оно чувствительно к регистру)."
        if "AccessDenied" in text:
            return False, "Ключ не имеет прав на запись в это хранилище."
        if "Could not connect" in text or "EndpointConnectionError" in text or "timed out" in text.lower():
            return False, "Не удалось связаться с хранилищем — проверьте адрес (Endpoint)."
        return False, f"Хранилище ответило ошибкой: {text[:200]}"
