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
from app.services.features import client_has_feature

router = APIRouter(prefix="/clients/me/storage", tags=["Файловое хранилище"])


class StorageSettings(BaseModel):
    endpoint: Optional[str] = None
    tenant_id: Optional[str] = None
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




async def _assert_feature(db, client_id: int):
    """Гейт по фиче own_storage.

    ⚠️ Гейтим только ЗАПИСЬ — правило проекта «смотреть можно, менять нельзя».
    Чтение настроек оставляем всем: если фичу когда-то выключат, клиент должен
    видеть, куда подключено его хранилище, а не пустой экран.
    """
    if not await client_has_feature(db, client_id, "own_storage"):
        raise HTTPException(403, detail="Подключение своего хранилища пока недоступно на вашем тарифе.")


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
        "feature": await client_has_feature(db, cid, "own_storage"),
        "client_id": cid,
        "suggested_global_name": f"pluson-media-{cid}-{tail}",
        "connected": bool(row["storage_provider"]),
        "provider": row["storage_provider"],
        "endpoint": row["storage_endpoint"],
        "region": row["storage_region"],
        "bucket": row["storage_bucket"],
        # ⚠️ В базе ключ лежит склеенным (`тенант:ключ`) — в форму отдаём частями,
        # иначе клиент увидит непонятную строку с двоеточием и решит, что ошибся.
        "tenant_id": (row["storage_access_key"] or "").split(":")[0] if ":" in (row["storage_access_key"] or "") else None,
        "access_key": (row["storage_access_key"] or "").split(":", 1)[-1] or None,
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
    await _assert_feature(db, int(client["sub"]))
    await _assert_feature(db, int(client["sub"]))
    await _assert_feature(db, int(client["sub"]))

    client_id = int(client["sub"])
    bucket = (data.bucket or "").strip() or None
    endpoint = _norm_url(data.endpoint)
    if endpoint:
        endpoint = _strip_bucket_from_endpoint(endpoint, bucket)
    region = (data.region or "").strip() or None
    access_key = (data.access_key or "").strip() or None
    tenant_id = (data.tenant_id or "").strip() or None

    # ⚠️ Особенность Cloud.ru Evolution: ключ доступа передаётся в виде
    # `<ID тенанта>:<ключ>`. У обычного S3 такого нет, и человек об этом знать
    # не обязан — склеиваем сами. Если он уже вставил склеенное (в ключе есть
    # двоеточие), второй раз не клеим.
    if access_key and tenant_id and ":" not in access_key:
        access_key = f"{tenant_id}:{access_key}"
    public_url = _norm_url(data.public_url)

    missing = [n for n, v in (("адрес хранилища", endpoint), ("имя бакета", bucket),
                              ("ID тенанта", tenant_id or (":" in (access_key or ""))),
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
        if "NoSuchTenant" in text:
            return False, ("ID тенанта не найден в Cloud.ru. Проверьте первое поле: ID пользователя "
                           "из профиля и ID проекта с главной страницы не подойдут — нужный ID лежит "
                           "в разделе «Object Storage». Ключи пересоздавать не нужно.")
        if "InvalidAccessKeyId" in text or "SignatureDoesNotMatch" in text:
            return False, "Ключ доступа или секретный ключ неверный — проверьте, что скопировали целиком."
        if "NoSuchBucket" in text:
            return False, f"Хранилище «{bucket}» не найдено — проверьте имя (оно чувствительно к регистру)."
        if "AccessDenied" in text:
            return False, "Ключ не имеет прав на запись в это хранилище."
        if "Could not connect" in text or "EndpointConnectionError" in text or "timed out" in text.lower():
            return False, "Не удалось связаться с хранилищем — проверьте адрес (Endpoint)."
        return False, f"Хранилище ответило ошибкой: {text[:200]}"


# ─────────────────────────────────────────────────────────────────────────────
# Быстрое подключение: бакет создаём сами
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ Зачем отдельный режим. Полный путь — семь экранов Cloud.ru: создать бакет,
# не забыть глобальное имя, включить Bucket Policy, сохранить. На каждом шаге
# человек может ошибиться, и ошибка всплывёт потом — картинками, которые не
# открылись у посетителей.
#
# Здесь клиент даёт только то, что нельзя получить программно — S3-ключи
# (Cloud.ru их через API не выдаёт) — а бакет, публичный доступ и глобальное имя
# создаём сами. Ошибиться негде.


class QuickConnect(BaseModel):
    tenant_id: str
    access_key: str
    secret_key: str
    region: Optional[str] = "ru-central-1"
    endpoint: Optional[str] = "https://s3.cloud.ru"


@router.post("/quick-connect", summary="Подключить хранилище автоматически")
async def quick_connect(data: QuickConnect,
                        client=Depends(get_current_client),
                        db: asyncpg.Connection = Depends(get_db)):
    if await assistant_is_restricted(client):
        raise HTTPException(403, detail="Настройка хранилища доступна только владельцу кабинета.")

    client_id = int(client["sub"])
    tenant = data.tenant_id.strip()
    key = data.access_key.strip()
    secret = data.secret_key.strip()
    endpoint = _norm_url(data.endpoint) or "https://s3.cloud.ru"
    region = (data.region or "ru-central-1").strip()

    if not (tenant and key and secret):
        raise HTTPException(400, detail="Заполните ID тенанта, ключ доступа и секретный ключ.")

    access_key = key if ":" in key else f"{tenant}:{key}"

    # Имя и глобальное имя генерим сами — детерминированно от id клиента, чтобы
    # повторный запуск не плодил новые бакеты.
    import hashlib
    tail = hashlib.sha256(f"pluson-storage-{client_id}".encode()).hexdigest()[:4]
    bucket = f"pluson-{client_id}"
    global_name = f"pluson-media-{client_id}-{tail}"

    ok, err = await _provision_bucket(endpoint, region, bucket, access_key, secret, global_name)
    if not ok:
        raise HTTPException(400, detail=err)

    # ⚠️ Глобальное имя через API задать НЕЛЬЗЯ — только руками в кабинете
    # Cloud.ru (проверено в их документации). Поэтому бакет и доступ создаём сами,
    # а имя клиент вписывает одним полем, и до этого момента файлы публично не
    # видны. Записываем предполагаемый адрес заранее, чтобы показать его в подсказке.
    public_url = f"https://global.s3.cloud.ru/{global_name}"
    await db.execute(
        """UPDATE clients SET storage_provider='cloudru', storage_endpoint=$2,
                  storage_region=$3, storage_bucket=$4, storage_access_key=$5,
                  storage_secret_key=$6, storage_public_url=$7,
                  storage_checked_at=NOW(), storage_error=NULL
            WHERE id=$1""",
        client_id, endpoint, region, bucket, access_key, secret, public_url)

    return {"ok": True, "bucket": bucket, "global_name": global_name, "public_url": public_url,
            "needs_global_name": True,
            "message": "Хранилище создано. Остался один шаг — вписать глобальное имя в Cloud.ru."}


async def _provision_bucket(endpoint: str, region: str, bucket: str,
                            access_key: str, secret_key: str, global_name: str):
    """Создаёт бакет и открывает публичное чтение. Идемпотентно."""
    import json as _json
    import boto3
    from botocore.client import Config as BotoConfig

    def _run():
        s3 = boto3.client("s3", endpoint_url=endpoint,
                          aws_access_key_id=access_key, aws_secret_access_key=secret_key,
                          region_name=region,
                          config=BotoConfig(signature_version="s3v4", connect_timeout=10,
                                            read_timeout=30, retries={"max_attempts": 1}))
        try:
            s3.head_bucket(Bucket=bucket)     # уже создан — повторный запуск, это норма
        except Exception:
            s3.create_bucket(Bucket=bucket)

        # Публичное чтение: без него посетитель не скачает картинку.
        s3.put_bucket_policy(Bucket=bucket, Policy=_json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject",
                "Resource": f"arn:aws:s3:::{bucket}/*",
            }],
        }))
        # Пробная запись — убеждаемся, что ключ умеет писать, а не только читать.
        s3.put_object(Bucket=bucket, Key="_pluson_check.txt", Body=b"pluson",
                      ContentType="text/plain")
        s3.delete_object(Bucket=bucket, Key="_pluson_check.txt")

    try:
        await asyncio.get_event_loop().run_in_executor(None, _run)
        return True, None
    except Exception as e:
        text = str(e)
        # ⚠️ NoSuchTenant разбираем ОТДЕЛЬНО и первым. Сырой английский текст
        # заставляет человека чинить не то: клиент трижды пересоздавал ключи,
        # хотя ключи были исправны, а неверной была первая половина — ID тенанта
        # (взял ID пользователя из профиля, они похожи). Случай 18.09.2026.
        if "NoSuchTenant" in text:
            return False, ("ID тенанта не найден в Cloud.ru. Скорее всего скопирован не тот "
                           "длинный номер: ID пользователя из профиля или ID проекта с главной "
                           "страницы не подойдут. Нужный ID — в разделе «Object Storage», строкой "
                           "под заголовком (или в хранилище → «Object Storage API»). "
                           "Ключи доступа пересоздавать не нужно — дело не в них.")
        if "InvalidAccessKeyId" in text or "SignatureDoesNotMatch" in text:
            return False, "Ключ доступа или секретный ключ неверный — проверьте, что скопировали целиком."
        if "AccessDenied" in text:
            return False, ("Ключ не имеет прав на создание хранилища. Проверьте, что ключ создан "
                           "в вашем аккаунте и его срок — «Бессрочно».")
        if "BucketAlreadyExists" in text:
            return False, "Такое хранилище уже занято в Cloud.ru — напишите нам, подберём другое имя."
        if "timed out" in text.lower() or "Could not connect" in text:
            return False, "Не удалось связаться с Cloud.ru — попробуйте ещё раз через минуту."
        return False, f"Cloud.ru ответил ошибкой: {text[:200]}"


@router.post("/test-image", summary="Залить тестовую картинку и проверить, что она видна")
async def test_image(client=Depends(get_current_client),
                     db: asyncpg.Connection = Depends(get_db)):
    """Кладёт в хранилище картинку и возвращает публичную ссылку на неё.

    ⚠️ Это единственная честная проверка. Связь по ключам может быть в порядке,
    а публичный доступ настроен неверно — тогда ошибки не будет, но у посетителей
    вместо афиш окажутся пустые места. Увидеть это можно только глазами.
    """
    row = await db.fetchrow(
        """SELECT storage_endpoint, storage_region, storage_bucket, storage_access_key,
                  storage_secret_key, storage_public_url
             FROM clients WHERE id=$1""", int(client["sub"]))
    if not row or not row["storage_bucket"]:
        raise HTTPException(400, detail="Хранилище не подключено")

    import io
    import boto3
    from botocore.client import Config as BotoConfig
    from PIL import Image, ImageDraw

    def _run():
        img = Image.new("RGB", (800, 400), (37, 69, 93))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, 800, 10], fill=(255, 207, 164))
        d.text((40, 180), "PLUSON: storage works", fill=(255, 207, 164))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        s3 = boto3.client("s3", endpoint_url=row["storage_endpoint"],
                          aws_access_key_id=row["storage_access_key"],
                          aws_secret_access_key=row["storage_secret_key"],
                          region_name=row["storage_region"] or "ru-central-1",
                          config=BotoConfig(signature_version="s3v4"))
        s3.put_object(Bucket=row["storage_bucket"], Key="test/pluson-test.jpg",
                      Body=buf.getvalue(), ContentType="image/jpeg")

    try:
        await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(400, detail=f"Не удалось загрузить файл: {str(e)[:200]}")

    return {"ok": True, "url": f"{(row['storage_public_url'] or '').rstrip('/')}/test/pluson-test.jpg"}


@router.post("/verify-public", summary="Проверить, что файлы видны посетителям")
async def verify_public(client=Depends(get_current_client),
                        db: asyncpg.Connection = Depends(get_db)):
    """Скачивает тестовую картинку по ПУБЛИЧНОЙ ссылке, без ключей.

    ⚠️ Именно так это увидит посетитель лендинга. Проверка по S3 API тут не
    годится: она ходит с ключами и пройдёт даже тогда, когда публичный доступ
    или глобальное имя не настроены — а у людей вместо афиш будут пустые места.
    """
    import httpx

    row = await db.fetchrow(
        "SELECT storage_public_url FROM clients WHERE id=$1", int(client["sub"]))
    if not row or not row["storage_public_url"]:
        raise HTTPException(400, detail="Хранилище не подключено")

    url = f"{row['storage_public_url'].rstrip('/')}/test/pluson-test.jpg"
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as http:
            r = await http.get(url)
    except Exception:
        return {"ok": False, "url": url,
                "message": "Не удалось открыть файл — проверьте, что вписали глобальное имя в Cloud.ru."}

    if r.status_code == 200 and r.headers.get("content-type", "").startswith("image/"):
        await db.execute("UPDATE clients SET storage_checked_at=NOW(), storage_error=NULL WHERE id=$1",
                         int(client["sub"]))
        return {"ok": True, "url": url, "message": "Готово — файлы открываются у посетителей."}

    return {"ok": False, "url": url,
            "message": ("Файл пока не открывается. Проверьте в Cloud.ru, что у бакета задано "
                        "глобальное название и включён публичный доступ.")}
