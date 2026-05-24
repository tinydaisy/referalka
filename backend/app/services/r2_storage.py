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
) -> str:
    """Строит ключ R2 в зависимости от kind."""
    fname = f"{uuid.uuid4().hex}.{ext.lower().lstrip('.')}"
    base = f"clients/{client_id}"

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
        # удаляет их через 10 мин после отправки рассылки (или через час, если
        # фото загружено и не использовано).
        return f"{base}/broadcast_photos/{fname}"

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
