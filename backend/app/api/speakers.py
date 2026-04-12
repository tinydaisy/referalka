"""
Глобальная база спикеров — CRUD без привязки к конкретному событию.
Персональные данные (фото, регалии, контакты) хранятся здесь один раз
и переиспользуются в любом количестве событий через conf_speaker_events.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/api/v1/speakers", tags=["Спикеры (база)"])


class SpeakerCreate(BaseModel):
    name: str
    title: Optional[str] = None
    company: Optional[str] = None
    bio: Optional[str] = None
    achievements: Optional[str] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    telegram_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None


class SpeakerUpdate(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    company: Optional[str] = None
    bio: Optional[str] = None
    achievements: Optional[str] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    telegram_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None


@router.get("/", summary="Список всех спикеров в базе")
async def list_speakers(
    q: Optional[str] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    if q:
        rows = await db.fetch(
            "SELECT * FROM speakers WHERE name ILIKE $1 ORDER BY name",
            f"%{q}%"
        )
    else:
        rows = await db.fetch("SELECT * FROM speakers ORDER BY name")
    return {"speakers": [dict(r) for r in rows]}


@router.post("/", summary="Создать спикера в базе")
async def create_speaker(
    data: SpeakerCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """INSERT INTO speakers
           (name, title, company, bio, achievements,
            photo_url, photo_folder_url, video_folder_url,
            telegram_url, instagram_url, website_url, created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *""",
        data.name, data.title, data.company, data.bio, data.achievements,
        data.photo_url, data.photo_folder_url, data.video_folder_url,
        data.telegram_url, data.instagram_url, data.website_url,
        int(client["sub"])
    )
    return {"speaker": dict(row)}


@router.get("/{speaker_id}", summary="Спикер по ID")
async def get_speaker(
    speaker_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow("SELECT * FROM speakers WHERE id = $1", speaker_id)
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден")
    return {"speaker": dict(row)}


@router.patch("/{speaker_id}", summary="Обновить данные спикера в базе")
async def update_speaker(
    speaker_id: int,
    data: SpeakerUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    if not updates:
        row = await db.fetchrow("SELECT * FROM speakers WHERE id = $1", speaker_id)
    else:
        updates["updated_at"] = "NOW()"
        set_parts = []
        vals = []
        for i, (k, v) in enumerate(updates.items()):
            if k == "updated_at":
                set_parts.append("updated_at = NOW()")
            else:
                set_parts.append(f"{k} = ${i+2}")
                vals.append(v)
        row = await db.fetchrow(
            f"UPDATE speakers SET {', '.join(set_parts)} WHERE id = $1 RETURNING *",
            speaker_id, *vals
        )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден")
    return {"speaker": dict(row)}


@router.delete("/{speaker_id}", summary="Удалить спикера из базы")
async def delete_speaker(
    speaker_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    # Проверяем что спикер не участвует ни в каких событиях
    count = await db.fetchval(
        "SELECT COUNT(*) FROM conf_speaker_events WHERE speaker_id = $1", speaker_id
    )
    if count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Спикер участвует в {count} событиях. Сначала удалите его из всех событий."
        )
    await db.execute("DELETE FROM speakers WHERE id = $1", speaker_id)
    return {"message": "Спикер удалён из базы"}
