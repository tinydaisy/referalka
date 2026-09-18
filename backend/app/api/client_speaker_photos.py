"""
Библиотека фото спикера в профиле клиента (миграция 323).

Зачем. Организатор постоянно просит у спикера фото для афиши и анонсов.
Одного снимка мало: у человека их несколько, и пусть организатор выберет
подходящий сам — на публичной странице профиля.

Устроено ТАК ЖЕ, как библиотека афиш коллаба ([collaborator_posters.py]) —
отдельная таблица с подписью и порядком. Причина в жизненном цикле картинок:
загрузка в хранилище, переименование, удаление с чисткой файла, перетаскивание.

⚠️ Старое поле `clients.owner_photo_url` не заменяется — на него завязаны
Mini App, лендинги и карточка основателя. Библиотека дополняет его, а галочка
`is_primary` отмечает, какое фото показывается в самом профиле.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import asyncpg

from app.auth import get_current_client
from app.database import get_db
from app.services import r2_storage


router = APIRouter(prefix="/api/v1/clients/me/speaker-photos", tags=["Фото спикера"])

_SELECT = "id, url, label, is_primary, sort_order, focal, created_at"


class PhotoCreate(BaseModel):
    url: str
    label: Optional[str] = None


class PhotoUpdate(BaseModel):
    label: Optional[str] = None
    sort_order: Optional[int] = None
    is_primary: Optional[bool] = None
    # ⚠️ Точка лица (миграция 434) в формате CSS object-position. Колонка была
    # заведена и читалась фронтом, но ни отдавалась, ни записывалась — отмеченная
    # точка никуда не доезжала, и кадрирование всегда шло по умолчанию.
    focal: Optional[str] = None


class ReorderRequest(BaseModel):
    ids: List[int]


@router.get("", summary="Библиотека фото спикера")
async def list_photos(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        f"""SELECT {_SELECT} FROM client_speaker_photos
             WHERE client_id = $1
             ORDER BY sort_order, id""",
        int(client["sub"]),
    )
    return {"photos": [dict(r) for r in rows]}


@router.post("", summary="Добавить фото")
async def add_photo(
    data: PhotoCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    url = (data.url or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="Не хватает ссылки на файл")

    next_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM client_speaker_photos WHERE client_id = $1",
        client_id,
    )
    # Первое загруженное фото сразу становится главным — иначе в профиле
    # не показалось бы ничего, пока человек не поставит галочку руками.
    is_first = not await db.fetchval(
        "SELECT 1 FROM client_speaker_photos WHERE client_id = $1 LIMIT 1", client_id
    )
    row = await db.fetchrow(
        f"""INSERT INTO client_speaker_photos (client_id, url, label, sort_order, is_primary)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING {_SELECT}""",
        client_id, url, (data.label or None), int(next_sort), is_first,
    )
    return {"photo": dict(row)}


@router.patch("/{photo_id}", summary="Переименовать, переставить, сделать главным")
async def update_photo(
    photo_id: int,
    data: PhotoUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    fs = data.model_fields_set
    if not fs:
        raise HTTPException(status_code=422, detail="Нечего менять")

    async with db.transaction():
        # Главное фото одно — снимаем галочку с прежнего, иначе частичный
        # UNIQUE-индекс отклонит вставку второго.
        if "is_primary" in fs and data.is_primary:
            await db.execute(
                "UPDATE client_speaker_photos SET is_primary = FALSE WHERE client_id = $1 AND is_primary",
                client_id,
            )

        updates = {k: getattr(data, k) for k in fs
                   if k in ("label", "sort_order", "is_primary", "focal")}
        if not updates:
            raise HTTPException(status_code=422, detail="Нечего менять")
        parts = [f"{k} = ${i + 3}" for i, k in enumerate(updates.keys())]
        row = await db.fetchrow(
            f"""UPDATE client_speaker_photos
                   SET {', '.join(parts)}
                 WHERE id = $1 AND client_id = $2
                 RETURNING {_SELECT}""",
            photo_id, client_id, *updates.values(),
        )
    if not row:
        raise HTTPException(status_code=404, detail="Фото не найдено")
    return {"photo": dict(row)}


@router.post("/reorder", summary="Изменить порядок")
async def reorder_photos(
    data: ReorderRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    async with db.transaction():
        for i, pid in enumerate(data.ids):
            await db.execute(
                "UPDATE client_speaker_photos SET sort_order = $1 WHERE id = $2 AND client_id = $3",
                i, int(pid), client_id,
            )
    return {"ok": True}


@router.delete("/{photo_id}", summary="Удалить фото")
async def delete_photo(
    photo_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Удаляет запись и сам файл из хранилища."""
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT id, url, is_primary FROM client_speaker_photos WHERE id = $1 AND client_id = $2",
        photo_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Фото не найдено")

    key = r2_storage.key_from_url(row["url"])
    if key:
        file_row = await db.fetchrow(
            "SELECT id, size_bytes FROM client_files WHERE r2_key = $1 AND client_id = $2",
            key, client_id,
        )
        try:
            r2_storage.delete_object(key)
        except Exception:
            # Файл мог быть уже удалён — запись из библиотеки всё равно убираем,
            # иначе в списке навсегда останется битая картинка.
            pass
        if file_row:
            await db.execute("DELETE FROM client_files WHERE id = $1", file_row["id"])
            await db.execute(
                "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
                int(file_row["size_bytes"] or 0), client_id,
            )

    await db.execute("DELETE FROM client_speaker_photos WHERE id = $1", photo_id)

    # Удалили главное — назначаем главным первое из оставшихся, чтобы
    # профиль не остался без фото.
    if row["is_primary"]:
        await db.execute(
            """UPDATE client_speaker_photos SET is_primary = TRUE
                WHERE id = (SELECT id FROM client_speaker_photos
                             WHERE client_id = $1 ORDER BY sort_order, id LIMIT 1)""",
            client_id,
        )
    return {"ok": True}
