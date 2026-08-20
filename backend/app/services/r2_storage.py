"""
Cloudflare R2 storage — общий клиент для загрузки/удаления файлов.

Структура ключей в R2:
    clients/{client_id}/events/{event_id}/posters/{horizontal|vertical|square}/{uuid}.{ext}
    clients/{client_id}/events/{event_id}/certificates/{uuid}.{ext}
    clients/{client_id}/events/{event_id}/referral_materials/{uuid}.{ext}
    clients/{client_id}/lead_magnets/{uuid}.{ext}
    clients/{client_id}/speakers/{collaborator_id}/{uuid}.{ext}
    clients/{client_id}/profile/brand_photo/{uuid}.{ext}
    clients/{client_id}/profile/brand_logo/{uuid}.{ext}
    clients/{client_id}/profile/owner_photo/{uuid}.{ext}
"""
import asyncio
import uuid
from typing import Optional
import boto3
from botocore.client import Config as BotoConfig
from app.config import settings


_client = None


def get_r2_client():
    global _client
    if _client is None:
        if not settings.cf_account_id or not settings.cf_r2_access_key_id:
            raise RuntimeError("R2 not configured (CF_ACCOUNT_ID / CF_R2_ACCESS_KEY_ID)")
        _client = boto3.client(
            "s3",
            endpoint_url=f"https://{settings.cf_account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=settings.cf_r2_access_key_id,
            aws_secret_access_key=settings.cf_r2_secret_access_key,
            region_name="auto",
            config=BotoConfig(signature_version="s3v4"),
        )
    return _client


def build_key(
    client_id: int,
    kind: str,
    ext: str,
    *,
    event_id: Optional[int] = None,
    collaborator_id: Optional[int] = None,
    poster_type: Optional[str] = None,
    contact_id: Optional[int] = None,
    message_id: Optional[int] = None,
) -> str:
    """Строит ключ R2 в зависимости от kind."""
    fname = f"{uuid.uuid4().hex}.{ext.lower().lstrip('.')}"
    base = f"clients/{client_id}"

    if kind == "dialog_media":
        # Медиа личных переписок. Структура «по клиенту → по контакту → по
        # сообщению» — папку контакта целиком легко перенести/удалить.
        if not contact_id:
            raise ValueError("dialog_media требует contact_id")
        sub = f"{message_id}/" if message_id else ""
        return f"{base}/dialogs/{contact_id}/{sub}{fname}"

    if kind == "event_poster":
        if not event_id or not poster_type:
            raise ValueError("event_poster требует event_id и poster_type")
        if poster_type not in ("horizontal", "vertical", "square"):
            raise ValueError(f"Неверный poster_type: {poster_type}")
        return f"{base}/events/{event_id}/posters/{poster_type}/{fname}"

    if kind == "certificate":
        if not event_id:
            raise ValueError("certificate требует event_id")
        return f"{base}/events/{event_id}/certificates/{fname}"

    if kind == "referral_material":
        if not event_id:
            raise ValueError("referral_material требует event_id")
        return f"{base}/events/{event_id}/referral_materials/{fname}"

    if kind == "referral_video":
        if not event_id:
            raise ValueError("referral_video требует event_id")
        return f"{base}/events/{event_id}/referral_videos/{fname}"

    if kind == "lead_magnet":
        return f"{base}/lead_magnets/{fname}"

    if kind == "speaker_photo":
        if not collaborator_id:
            raise ValueError("speaker_photo требует collaborator_id")
        return f"{base}/speakers/{collaborator_id}/{fname}"

    if kind == "speaker_poster":
        if not collaborator_id:
            raise ValueError("speaker_poster требует collaborator_id")
        return f"{base}/speakers/{collaborator_id}/posters/{fname}"

    if kind in ("brand_photo", "brand_logo", "owner_photo"):
        return f"{base}/profile/{kind}/{fname}"

    if kind == "funnel_media":
        return f"{base}/funnel_media/{fname}"

    if kind == "broadcast_photo":
        # Временные фото произвольных рассылок. Воркер cleanup_broadcast_photos
        # удаляет их через 24 часа после отправки рассылки (или через час, если
        # фото загружено и не использовано). ⚠️ Срок дублируется в подсказках
        # интерфейса — менять надо и там (BroadcastMediaPicker, очередь рассылок).
        return f"{base}/broadcast_photos/{fname}"

    if kind == "broadcast_video":
        # Видео рассылок. Тот же воркер cleanup_broadcast_photos чистит их после
        # отправки (но не трогает видео, на которое ссылается шаблон).
        return f"{base}/broadcast_videos/{fname}"

    # Конструктор лендинга (миграция 240): landing_bg — фоны страницы и секций,
    # landing_media — картинки галереи/отзывов. Разные папки, чтобы фоны и
    # контент галереи не смешивались.
    if kind == "landing_bg":
        if not event_id:
            raise ValueError("landing_bg требует event_id")
        return f"{base}/events/{event_id}/landing/bg/{fname}"

    # Анкеты общие (к событию не привязаны) — храним по клиенту.
    if kind == "survey_media":
        return f"{base}/surveys/media/{fname}"

    # Продукты (миграции 290, 293) живут вне событий — храним по клиенту.
    # product_media  — картинки лендинга продукта (фоны, галерея);
    # material_media — картинки и файлы внутри материалов.
    if kind == "product_media":
        return f"{base}/products/media/{fname}"
    if kind == "material_media":
        return f"{base}/materials/media/{fname}"

    if kind == "landing_media":
        if not event_id:
            raise ValueError("landing_media требует event_id")
        return f"{base}/events/{event_id}/landing/media/{fname}"

    if kind == "event_video":
        if not event_id:
            raise ValueError("event_video требует event_id")
        return f"{base}/events/{event_id}/videos/{fname}"

    if kind == "speaker_video":
        if not collaborator_id:
            raise ValueError("speaker_video требует collaborator_id")
        return f"{base}/speakers/{collaborator_id}/videos/{fname}"

    raise ValueError(f"Неизвестный kind: {kind}")


async def upload_bytes(key: str, data: bytes, content_type: str) -> str:
    """Загружает байты в R2, возвращает публичный URL."""
    client = get_r2_client()
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: client.put_object(
            Bucket=settings.cf_r2_bucket_name,
            Key=key,
            Body=data,
            ContentType=content_type,
        ),
    )
    return f"{settings.cf_r2_public_url}/{key}"


async def upload_file(path: str, key: str, content_type: str) -> str:
    """Загружает ФАЙЛ С ДИСКА в R2 потоком (multipart), не читая его в память.

    ⚠️ Для больших файлов (запись вебинара — гигабайты) обязательно использовать
    именно эту функцию, а не upload_bytes: чтение целиком в память кладёт процесс
    по OOM. Так молча не заливались записи эфиров.
    """
    from boto3.s3.transfer import TransferConfig

    client = get_r2_client()
    cfg = TransferConfig(
        multipart_threshold=64 * 1024 * 1024,
        multipart_chunksize=64 * 1024 * 1024,
        max_concurrency=2,
        use_threads=True,
    )
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: client.upload_file(
            path,
            settings.cf_r2_bucket_name,
            key,
            ExtraArgs={"ContentType": content_type},
            Config=cfg,
        ),
    )
    return f"{settings.cf_r2_public_url}/{key}"


async def delete_object(key: str) -> None:
    """Удаляет объект из R2."""
    client = get_r2_client()
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: client.delete_object(Bucket=settings.cf_r2_bucket_name, Key=key),
    )


def key_from_url(url: str) -> Optional[str]:
    """Извлекает R2-ключ из публичного URL."""
    prefix = settings.cf_r2_public_url.rstrip("/") + "/"
    if url.startswith(prefix):
        return url[len(prefix):]
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Учёт файлов в квоте клиента
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ ЕДИНАЯ ТОЧКА УЧЁТА. Любая заливка в R2, которая принадлежит клиенту,
# обязана пройти через register_file — иначе файл лежит в бакете, а в квоте
# его нет, и `clients.storage_used_bytes` расходится с реальностью.
# Так уже случилось: записи вебинаров (гигабайты) и картинки, скачанные по
# внешней ссылке, годами не попадали в счётчик — по учёту 233 МБ, в бакете 9,5 ГБ.
#
# Исключение ровно одно — служебные файлы САМОЙ платформы (бэкапы БД в
# deploy/r2_backup_upload.py): у них нет клиента-владельца, в его квоту они
# попадать не должны.

async def register_file(
    db,
    client_id: int,
    kind: str,
    key: str,
    url: str,
    size_bytes: int,
    content_type: Optional[str] = None,
    *,
    event_id: Optional[int] = None,
    collaborator_id: Optional[int] = None,
    lead_magnet_id: Optional[int] = None,
) -> Optional[int]:
    """Регистрирует уже залитый в R2 файл в client_files и увеличивает квоту.

    Идемпотентна: r2_key UNIQUE, повторная регистрация того же ключа ничего не
    задваивает (ON CONFLICT DO NOTHING) и квоту второй раз не двигает.

    ⚠️ Квоту НЕ проверяет — вызывается ПОСЛЕ успешной заливки. Проверять «влезет
    ли» нужно до неё (см. uploads.py). Для записи эфира отказ по квоте вообще
    неуместен: файл уже склеен, а сегменты вот-вот удалятся.

    Ошибку учёта не поднимаем наружу: сбой счётчика не должен рушить операцию,
    ради которой файл заливали (например, обработку записи вебинара).
    """
    try:
        async with db.transaction():
            file_id = await db.fetchval(
                """
                INSERT INTO client_files
                    (client_id, kind, r2_key, url, size_bytes, content_type,
                     event_id, collaborator_id, lead_magnet_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT (r2_key) DO NOTHING
                RETURNING id
                """,
                client_id, kind, key, url, int(size_bytes), content_type,
                event_id, collaborator_id, lead_magnet_id,
            )
            if file_id is not None:
                await db.execute(
                    "UPDATE clients SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2",
                    int(size_bytes), client_id,
                )
        return file_id
    except Exception:
        import logging
        logging.getLogger(__name__).exception(
            "register_file: не удалось учесть файл %s клиента %s", key, client_id
        )
        return None


async def unregister_file(db, key: str) -> None:
    """Снимает файл с учёта (при удалении из R2) и уменьшает квоту владельца."""
    try:
        async with db.transaction():
            row = await db.fetchrow(
                "SELECT id, client_id, size_bytes FROM client_files WHERE r2_key = $1",
                key,
            )
            if not row:
                return
            await db.execute("DELETE FROM client_files WHERE id = $1", row["id"])
            await db.execute(
                "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
                int(row["size_bytes"]), row["client_id"],
            )
    except Exception:
        import logging
        logging.getLogger(__name__).exception("unregister_file: %s", key)
