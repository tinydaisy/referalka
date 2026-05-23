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
    # contact_id обязателен: коллаб = расширение существующего контакта (миграция 086)
    contact_id: int
    # name опционален — если не передан, берётся из contacts.name
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
    contact_id: Optional[int] = None


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


@router.post("/", summary="Добавить коллаборацию из существующего контакта")
async def create_collaborator(
    data: CollaboratorCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    # Проверяем что contact_id принадлежит этому клиенту и не помечен мерджем
    contact = await db.fetchrow(
        "SELECT id, name FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
        data.contact_id, client_id
    )
    if not contact:
        raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
    # Один коллаб на контакт — повторное добавление запрещаем
    existing = await db.fetchval(
        "SELECT id FROM collaborators WHERE contact_id = $1", data.contact_id
    )
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"У этого контакта уже есть коллаборатор (id={existing}). Откройте его карточку."
        )
    name = (data.name or contact["name"] or "").strip() or "Без имени"
    row = await db.fetchrow(
        """INSERT INTO collaborators
           (contact_id, name, title, achievements,
            photo_url, poster_url, photo_folder_url, video_folder_url,
            tg_channel_url, instagram_url, website_url,
            tg_channel_id, personal_tg_id, personal_tg_username, assistant_tg_username,
            created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *""",
        data.contact_id, name, data.title, data.achievements,
        data.photo_url, data.poster_url, data.photo_folder_url, data.video_folder_url,
        data.tg_channel_url, data.instagram_url, data.website_url,
        data.tg_channel_id, data.personal_tg_id, data.personal_tg_username, data.assistant_tg_username,
        client_id
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
    # Если меняется contact_id — проверяем, что он принадлежит этому клиенту
    if "contact_id" in updates:
        own = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
            updates["contact_id"], int(client["sub"])
        )
        if not own:
            raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
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


class CollaboratorQuickCreate(BaseModel):
    """
    Создать коллаба «с нуля» (без предварительного создания контакта в /clients).
    Дедупликация по имени: если у клиента есть контакт с таким же именем,
    эндпоинт без force_create возвращает needs_choice + варианты для UI.
    """
    name: str
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    force_create: bool = False
    existing_contact_id: Optional[int] = None


@router.post("/quick", summary="Создать коллаба + контакт одной транзакцией (с дедупом по имени)")
async def create_collaborator_quick(
    data: CollaboratorQuickCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Имя обязательно")

    contact_id: Optional[int] = data.existing_contact_id
    if contact_id is not None:
        own = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
            contact_id, client_id
        )
        if not own:
            raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")

    if contact_id is None and not data.force_create:
        matches = await db.fetch(
            """SELECT c.id, c.name, c.email, c.phone,
                      EXISTS(SELECT 1 FROM collaborators col WHERE col.contact_id = c.id) AS has_collab
                 FROM contacts c
                WHERE c.client_id = $1
                  AND c.merged_into IS NULL
                  AND LOWER(TRIM(c.name)) = LOWER($2)
                ORDER BY c.id
                LIMIT 10""",
            client_id, name
        )
        if matches:
            return {
                "needs_choice": True,
                "matches": [
                    {"id": m["id"], "name": m["name"], "email": m["email"],
                     "phone": m["phone"], "has_collab": m["has_collab"]}
                    for m in matches
                ],
            }

    async with db.transaction():
        if contact_id is None:
            contact_id = await db.fetchval(
                """INSERT INTO contacts (client_id, name, ref_code)
                   VALUES ($1, $2, SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8))
                   RETURNING id""",
                client_id, name
            )
        else:
            existing_coll = await db.fetchval(
                "SELECT id FROM collaborators WHERE contact_id = $1", contact_id
            )
            if existing_coll:
                raise HTTPException(
                    status_code=409,
                    detail=f"У этого контакта уже есть коллаборатор (id={existing_coll})."
                )

        row = await db.fetchrow(
            """INSERT INTO collaborators
               (contact_id, name, title, achievements,
                photo_url, poster_url,
                tg_channel_url, tg_channel_id,
                instagram_url, website_url,
                assistant_tg_username,
                created_by_client_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *""",
            contact_id, name, data.title, data.achievements,
            data.photo_url, data.poster_url,
            data.tg_channel_url, data.tg_channel_id,
            data.instagram_url, data.website_url,
            data.assistant_tg_username,
            client_id
        )

    d = row_to_dict(row)
    return {"collaborator": d, "speaker": d}


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
            # contact_id обязателен (миграция 086). Ищем контакт по имени,
            # если нет — создаём пустой (без email/phone) и привязываем.
            contact_row = await db.fetchrow(
                """SELECT id FROM contacts
                    WHERE client_id = $1 AND merged_into IS NULL
                      AND LOWER(name) = LOWER($2)
                    ORDER BY id LIMIT 1""",
                client_id, item.name
            )
            if contact_row:
                contact_id = contact_row["id"]
            else:
                new_contact = await db.fetchrow(
                    """INSERT INTO contacts (client_id, name)
                       VALUES ($1, $2)
                       RETURNING id""",
                    client_id, item.name
                )
                contact_id = new_contact["id"]
            row = await db.fetchrow(
                """INSERT INTO collaborators
                   (contact_id, name, title, achievements, photo_url, photo_folder_url, video_folder_url,
                    tg_channel_url, instagram_url, website_url,
                    tg_channel_id, personal_tg_id, personal_tg_username, assistant_tg_username,
                    created_by_client_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, name""",
                contact_id, item.name, item.title, item.achievements,
                item.photo_url, item.photo_folder_url, item.video_folder_url,
                item.tg_channel_url or None, item.instagram_url or None, item.website_url or None,
                item.tg_channel_id or None, item.personal_tg_id or None,
                item.personal_tg_username or None, item.assistant_tg_username or None,
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
        "SELECT COUNT(*) FROM event_collaborators WHERE speaker_id = $1", collaborator_id
    )
    if count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Коллаборация участвует в {count} событиях. Сначала удалите её из всех событий."
        )
    await db.execute("DELETE FROM collaborators WHERE id = $1", collaborator_id)
    return {"message": "Коллаборация удалена из базы"}
