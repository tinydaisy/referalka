"""
Универсальный endpoint загрузки файлов в R2.

POST   /api/v1/uploads    — загрузить файл (multipart/form-data)
DELETE /api/v1/uploads/{file_id} — удалить файл (по client_files.id)
GET    /api/v1/storage/usage     — текущее использование квоты

Поддерживаемые kind:
    event_poster      (требует event_id, poster_type=horizontal|vertical|square)
    certificate       (требует event_id)
    referral_material (требует event_id)
    lead_magnet
    speaker_photo     (требует collaborator_id)
    brand_photo       (профиль клиента: фото бренда)
    brand_logo        (профиль клиента: логотип в углу страниц Mini App)
    owner_photo       (профиль клиента: фото основателя)
    funnel_media      (фото/видео для текстов воронки лид-магнитов)
    broadcast_photo   (фото для произвольной рассылки; авто-удаляется через 10 мин
                       после отправки воркером cleanup_broadcast_photos)

Картинки автоматически ресайзятся под kind (см. image_processor.MAX_DIM_BY_KIND).
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from typing import Optional
import asyncpg
from app.auth import get_current_client
from app.database import get_db
from app.services import r2_storage
from app.services.image_processor import process_image, is_image


router = APIRouter(tags=["Загрузка файлов"])


MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 МБ — жёсткий лимит на один файл


def _human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} Б"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} КБ"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} МБ"
    return f"{n / (1024 * 1024 * 1024):.2f} ГБ"


async def _check_event_belongs(event_id: int, client_id: int, db: asyncpg.Connection):
    row = await db.fetchrow("SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id)
    if not row:
        raise HTTPException(status_code=403, detail="Событие не принадлежит клиенту")


async def _check_collaborator_belongs(collaborator_id: int, client_id: int, db: asyncpg.Connection):
    row = await db.fetchrow(
        "SELECT id FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=403, detail="Коллаборатор не принадлежит клиенту")


@router.post("/uploads", summary="Загрузить файл в R2")
async def upload_file(
    file: UploadFile = File(...),
    kind: str = Form(...),
    event_id: Optional[int] = Form(None),
    collaborator_id: Optional[int] = Form(None),
    poster_type: Optional[str] = Form(None),
    lead_magnet_id: Optional[int] = Form(None),
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])

    # 1. Валидация kind и обязательных параметров
    if kind not in {
        "event_poster", "certificate", "referral_material", "lead_magnet", "speaker_photo",
        "brand_photo", "brand_logo", "owner_photo", "funnel_media", "broadcast_photo",
    }:
        raise HTTPException(400, detail=f"Неизвестный kind: {kind}")

    if kind in ("event_poster", "certificate", "referral_material"):
        if not event_id:
            raise HTTPException(400, detail=f"{kind} требует event_id")
        await _check_event_belongs(event_id, client_id, db)
    if kind == "event_poster" and poster_type not in ("horizontal", "vertical", "square"):
        raise HTTPException(400, detail="event_poster требует poster_type=horizontal|vertical|square")
    if kind == "speaker_photo":
        if not collaborator_id:
            raise HTTPException(400, detail="speaker_photo требует collaborator_id")
        await _check_collaborator_belongs(collaborator_id, client_id, db)

    # 2. Читаем содержимое
    raw = await file.read()
    if len(raw) == 0:
        raise HTTPException(400, detail="Пустой файл")
    if len(raw) > MAX_FILE_SIZE:
        raise HTTPException(413, detail=f"Файл больше {_human_bytes(MAX_FILE_SIZE)}")

    # 3. Ресайз картинок (если применимо)
    content_type = file.content_type or "application/octet-stream"
    if is_image(content_type):
        processed, new_ct, new_ext = process_image(raw, kind, content_type)
        raw, content_type, ext = processed, new_ct, new_ext
    else:
        # для PDF и др. — оставляем как есть, расширение из имени
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "bin"

    size = len(raw)

    # 4. Проверка квоты
    quota_row = await db.fetchrow(
        "SELECT storage_used_bytes, storage_quota_bytes FROM clients WHERE id = $1",
        client_id,
    )
    if not quota_row:
        raise HTTPException(404, detail="Клиент не найден")
    used = int(quota_row["storage_used_bytes"])
    quota = int(quota_row["storage_quota_bytes"])
    if used + size > quota:
        raise HTTPException(
            413,
            detail=f"Превышена квота. Использовано {_human_bytes(used)} из {_human_bytes(quota)}, файл {_human_bytes(size)}.",
        )

    # 5. Строим key и грузим в R2
    key = r2_storage.build_key(
        client_id, kind, ext,
        event_id=event_id, collaborator_id=collaborator_id, poster_type=poster_type,
    )
    url = await r2_storage.upload_bytes(key, raw, content_type)

    # 6. Запись в client_files + обновление used_bytes (одной транзакцией)
    async with db.transaction():
        row = await db.fetchrow(
            """
            INSERT INTO client_files
                (client_id, kind, r2_key, url, size_bytes, content_type,
                 event_id, collaborator_id, lead_magnet_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id
            """,
            client_id, kind, key, url, size, content_type,
            event_id, collaborator_id, lead_magnet_id,
        )
        await db.execute(
            "UPDATE clients SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2",
            size, client_id,
        )

    return {
        "id": row["id"],
        "url": url,
        "key": key,
        "size_bytes": size,
        "content_type": content_type,
    }


@router.delete("/uploads/{file_id}", summary="Удалить файл из R2 и БД")
async def delete_file(
    file_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT id, r2_key, size_bytes FROM client_files WHERE id = $1 AND client_id = $2",
        file_id, client_id,
    )
    if not row:
        raise HTTPException(404, detail="Файл не найден")

    try:
        await r2_storage.delete_object(row["r2_key"])
    except Exception:
        pass  # даже если R2 не отвечает, чистим запись в БД

    async with db.transaction():
        await db.execute("DELETE FROM client_files WHERE id = $1", file_id)
        await db.execute(
            "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
            int(row["size_bytes"]), client_id,
        )
    return {"ok": True}


@router.delete("/uploads/by-url", summary="Удалить файл по URL (для совместимости со старыми компонентами)")
async def delete_by_url(
    url: str,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Если файл был загружен через новую систему — удалит из R2 и БД.
    Если URL внешний (не наш R2) — просто 200 без действий."""
    client_id = int(client["sub"])
    key = r2_storage.key_from_url(url)
    if not key:
        return {"ok": True, "skipped": "external_url"}

    row = await db.fetchrow(
        "SELECT id, size_bytes FROM client_files WHERE r2_key = $1 AND client_id = $2",
        key, client_id,
    )
    if row:
        try:
            await r2_storage.delete_object(key)
        except Exception:
            pass
        async with db.transaction():
            await db.execute("DELETE FROM client_files WHERE id = $1", row["id"])
            await db.execute(
                "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
                int(row["size_bytes"]), client_id,
            )
        return {"ok": True}

    # Файл в R2 но не в client_files (например, до миграции 037) — просто удалим из R2
    try:
        await r2_storage.delete_object(key)
    except Exception:
        pass
    return {"ok": True, "legacy": True}


@router.get("/storage/usage", summary="Использование файлового хранилища клиентом")
async def storage_usage(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT storage_used_bytes, storage_quota_bytes FROM clients WHERE id = $1",
        client_id,
    )
    if not row:
        raise HTTPException(404, detail="Клиент не найден")
    used = int(row["storage_used_bytes"])
    quota = int(row["storage_quota_bytes"])
    return {
        "used_bytes": used,
        "quota_bytes": quota,
        "used_percent": round((used / quota) * 100, 1) if quota else 0,
        "used_human": _human_bytes(used),
        "quota_human": _human_bytes(quota),
    }
