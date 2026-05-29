"""
Библиотека афиш коллаборатора (миграция 121).

Один коллаб = библиотека из множества афиш. В конкретной конференции
используется одна из библиотеки — выбор через
`event_collaborators.poster_id`. Везде fallback на первую из библиотеки
(`sort_order, id`).

В кабинете спикера (/speaker/<slug>) видна вся библиотека — спикер
скачивает любую афишу для своих анонсов.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import asyncpg

from app.auth import get_current_client
from app.database import get_db
from app.services import r2_storage


router = APIRouter(prefix="/api/v1/collaborators", tags=["Афиши коллаборатора"])


class PosterCreate(BaseModel):
    url: str
    label: Optional[str] = None


class PosterUpdate(BaseModel):
    label: Optional[str] = None
    sort_order: Optional[int] = None


async def _check_owns(collaborator_id: int, client_id: int, db: asyncpg.Connection) -> None:
    row = await db.fetchval(
        "SELECT 1 FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
        collaborator_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")


@router.get("/{collaborator_id}/posters", summary="Библиотека афиш коллаба")
async def list_posters(
    collaborator_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_owns(collaborator_id, client_id, db)
    rows = await db.fetch(
        """SELECT id, url, label, sort_order, created_at
             FROM collaborator_posters
            WHERE collaborator_id = $1
            ORDER BY sort_order, id""",
        collaborator_id,
    )
    return {"posters": [dict(r) for r in rows]}


@router.post("/{collaborator_id}/posters", summary="Добавить афишу в библиотеку")
async def add_poster(
    collaborator_id: int,
    data: PosterCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_owns(collaborator_id, client_id, db)
    url = (data.url or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="URL обязателен")
    next_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collaborator_posters WHERE collaborator_id = $1",
        collaborator_id,
    )
    row = await db.fetchrow(
        """INSERT INTO collaborator_posters (collaborator_id, url, label, sort_order)
           VALUES ($1, $2, $3, $4)
           RETURNING id, url, label, sort_order, created_at""",
        collaborator_id, url, (data.label or None), int(next_sort),
    )
    return {"poster": dict(row)}


@router.patch("/{collaborator_id}/posters/{poster_id}", summary="Переименовать / переупорядочить")
async def update_poster(
    collaborator_id: int,
    poster_id: int,
    data: PosterUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_owns(collaborator_id, client_id, db)
    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=422, detail="Нет полей для обновления")
    parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
    row = await db.fetchrow(
        f"""UPDATE collaborator_posters
              SET {', '.join(parts)}
            WHERE id = $1 AND collaborator_id = $2
            RETURNING id, url, label, sort_order, created_at""",
        poster_id, collaborator_id, *updates.values(),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Афиша не найдена")
    return {"poster": dict(row)}


@router.delete("/{collaborator_id}/posters/{poster_id}", summary="Удалить афишу из библиотеки")
async def delete_poster(
    collaborator_id: int,
    poster_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Удаляет запись из библиотеки и сам файл из R2. FK на
    `event_collaborators.poster_id` имеет ON DELETE SET NULL — все
    события, где использовалась эта афиша, автоматически переходят
    на fallback (первая из библиотеки)."""
    client_id = int(client["sub"])
    await _check_owns(collaborator_id, client_id, db)
    row = await db.fetchrow(
        """SELECT id, url FROM collaborator_posters
            WHERE id = $1 AND collaborator_id = $2""",
        poster_id, collaborator_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Афиша не найдена")
    # Чистим R2 + client_files (по url). Если файл внешний — пропустится.
    key = r2_storage.key_from_url(row["url"])
    if key:
        file_row = await db.fetchrow(
            "SELECT id, size_bytes FROM client_files WHERE r2_key = $1 AND client_id = $2",
            key, client_id,
        )
        try:
            await r2_storage.delete_object(key)
        except Exception:
            pass
        if file_row:
            async with db.transaction():
                await db.execute("DELETE FROM client_files WHERE id = $1", file_row["id"])
                await db.execute(
                    "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
                    int(file_row["size_bytes"]), client_id,
                )
    await db.execute("DELETE FROM collaborator_posters WHERE id = $1", poster_id)
    return {"ok": True}


class ReorderRequest(BaseModel):
    ids: List[int]


@router.post("/{collaborator_id}/posters/reorder", summary="Переставить порядок афиш")
async def reorder_posters(
    collaborator_id: int,
    data: ReorderRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_owns(collaborator_id, client_id, db)
    if not data.ids:
        return {"ok": True}
    async with db.transaction():
        for sort_order, poster_id in enumerate(data.ids):
            await db.execute(
                """UPDATE collaborator_posters
                      SET sort_order = $3
                    WHERE id = $1 AND collaborator_id = $2""",
                int(poster_id), collaborator_id, sort_order,
            )
    return {"ok": True}
