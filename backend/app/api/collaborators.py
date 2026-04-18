"""
База коллабораций — per-client CRM людей и организаций, с которыми работает клиент.
Используется в конференциях (спикеры, организаторы, партнёры), премиях, турнирах.
Данные хранятся один раз и переиспользуются в любых событиях через junction-таблицы.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/api/v1/collaborators", tags=["Коллаборации (база)"])


class CollaboratorCreate(BaseModel):
    name: str
    title: Optional[str] = None
    achievements: Optional[str] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    telegram_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    channel_id: Optional[str] = None
    personal_account_id: Optional[str] = None
    personal_account_username: Optional[str] = None
    assistant_account: Optional[str] = None


class CollaboratorUpdate(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[str] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    telegram_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    channel_id: Optional[str] = None
    personal_account_id: Optional[str] = None
    personal_account_username: Optional[str] = None
    assistant_account: Optional[str] = None


@router.get("/", summary="Список коллабораций клиента")
async def list_collaborators(
    q: Optional[str] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    if q:
        rows = await db.fetch(
            "SELECT * FROM collaborators WHERE created_by_client_id = $1 AND name ILIKE $2 ORDER BY name",
            client_id, f"%{q}%"
        )
    else:
        rows = await db.fetch(
            "SELECT * FROM collaborators WHERE created_by_client_id = $1 ORDER BY name",
            client_id
        )
    return {"collaborators": [dict(r) for r in rows]}


@router.post("/", summary="Добавить коллаборацию в базу")
async def create_collaborator(
    data: CollaboratorCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """INSERT INTO collaborators
           (name, title, achievements,
            photo_url, photo_folder_url, video_folder_url,
            telegram_url, instagram_url, website_url,
            channel_id, personal_account_id, personal_account_username, assistant_account,
            created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *""",
        data.name, data.title, data.achievements,
        data.photo_url, data.photo_folder_url, data.video_folder_url,
        data.telegram_url, data.instagram_url, data.website_url,
        data.channel_id, data.personal_account_id, data.personal_account_username, data.assistant_account,
        int(client["sub"])
    )
    # Возвращаем с ключом speaker для совместимости с conference module
    return {"speaker": dict(row), "collaborator": dict(row)}


@router.get("/{collaborator_id}", summary="Коллаборация по ID")
async def get_collaborator(
    collaborator_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT * FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    return {"speaker": dict(row), "collaborator": dict(row)}


@router.patch("/{collaborator_id}", summary="Обновить данные коллаборации")
async def update_collaborator(
    collaborator_id: int,
    data: CollaboratorUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    if not updates:
        row = await db.fetchrow("SELECT * FROM collaborators WHERE id = $1", collaborator_id)
    else:
        set_parts = []
        vals = []
        for i, (k, v) in enumerate(updates.items()):
            set_parts.append(f"{k} = ${i+2}")
            vals.append(v)
        set_parts.append("updated_at = NOW()")
        row = await db.fetchrow(
            f"UPDATE collaborators SET {', '.join(set_parts)} WHERE id = $1 AND created_by_client_id = ${len(vals)+2} RETURNING *",
            collaborator_id, *vals, int(client["sub"])
        )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    return {"speaker": dict(row), "collaborator": dict(row)}


@router.delete("/{collaborator_id}", summary="Удалить коллаборацию из базы")
async def delete_collaborator(
    collaborator_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT id FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    count = await db.fetchval(
        "SELECT COUNT(*) FROM conf_speaker_events WHERE speaker_id = $1", collaborator_id
    )
    if count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Коллаборация участвует в {count} событиях. Сначала удалите её из всех событий."
        )
    await db.execute("DELETE FROM collaborators WHERE id = $1", collaborator_id)
    return {"message": "Коллаборация удалена из базы"}
