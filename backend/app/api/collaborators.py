"""
База коллабораций — per-client CRM людей и организаций, с которыми работает клиент.
Используется в конференциях (спикеры, организаторы, партнёры), премиях, турнирах.
Данные хранятся один раз и переиспользуются в любых событиях через junction-таблицы.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/api/v1/collaborators", tags=["Коллаборации (база)"])


class CollaboratorCreate(BaseModel):
    name: str
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    external_ref_param: Optional[str] = None


class CollaboratorUpdate(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    external_ref_param: Optional[str] = None


def row_to_dict(row):
    d = dict(row)
    if d.get("achievements") is None:
        d["achievements"] = []
    return d


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
    return {"collaborators": [row_to_dict(r) for r in rows]}


@router.post("/", summary="Добавить коллаборацию в базу")
async def create_collaborator(
    data: CollaboratorCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """INSERT INTO collaborators
           (name, title, achievements,
            photo_url, poster_url, photo_folder_url, video_folder_url,
            tg_channel_url, instagram_url, website_url,
            tg_channel_id, personal_tg_id, personal_tg_username, assistant_tg_username,
            external_ref_param,
            created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *""",
        data.name, data.title, data.achievements,
        data.photo_url, data.poster_url, data.photo_folder_url, data.video_folder_url,
        data.tg_channel_url, data.instagram_url, data.website_url,
        data.tg_channel_id, data.personal_tg_id, data.personal_tg_username, data.assistant_tg_username,
        data.external_ref_param,
        int(client["sub"])
    )
    d = row_to_dict(row)
    return {"speaker": d, "collaborator": d}


@router.get("/{collaborator_id}", summary="Коллаборация по ID")
async def get_collaborator(
    collaborator_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT col.*,
                  c.name  AS contact_name,
                  c.email AS contact_email,
                  c.phone AS contact_phone
             FROM collaborators col
             LEFT JOIN contacts c ON c.id = col.contact_id
            WHERE col.id = $1 AND col.created_by_client_id = $2""",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    d = row_to_dict(row)
    return {"speaker": d, "collaborator": d}


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
    d = row_to_dict(row)
    return {"speaker": d, "collaborator": d}


class CollaboratorImportItem(BaseModel):
    name: str
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    external_ref_param: Optional[str] = None


class CollaboratorImportRequest(BaseModel):
    collaborations: List[CollaboratorImportItem]
    skip_duplicates: bool = True


@router.post("/import", summary="Пакетный импорт коллабораций из JSON")
async def import_collaborators(
    data: CollaboratorImportRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    created, skipped, errors = [], [], []

    for item in data.collaborations:
        try:
            existing = await db.fetchrow(
                "SELECT id FROM collaborators WHERE name = $1 AND created_by_client_id = $2",
                item.name, client_id
            )
            if existing:
                if data.skip_duplicates:
                    skipped.append(item.name)
                    continue
            row = await db.fetchrow(
                """INSERT INTO collaborators
                   (name, title, achievements, photo_url, photo_folder_url, video_folder_url,
                    tg_channel_url, instagram_url, website_url,
                    tg_channel_id, personal_tg_id, personal_tg_username, assistant_tg_username,
                    external_ref_param,
                    created_by_client_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, name""",
                item.name, item.title, item.achievements,
                item.photo_url, item.photo_folder_url, item.video_folder_url,
                item.tg_channel_url or None, item.instagram_url or None, item.website_url or None,
                item.tg_channel_id or None, item.personal_tg_id or None,
                item.personal_tg_username or None, item.assistant_tg_username or None,
                item.external_ref_param or None,
                client_id
            )
            created.append({"id": row["id"], "name": row["name"]})
        except Exception as e:
            errors.append({"name": item.name, "error": str(e)})

    return {
        "created": created,
        "skipped": skipped,
        "errors": errors,
        "summary": f"Создано: {len(created)}, пропущено: {len(skipped)}, ошибок: {len(errors)}"
    }


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
