"""
Библиотека фото коллаборатора (миграция 472).

Один человек = несколько вариантов фото: обычный портрет, карикатура,
снимок с предметом. В конкретном событии используется один из них — выбор
через `event_collaborators.photo_id`. Не выбран — берётся профильное
`collaborators.photo_url`.

⚠️ У КАЖДОГО ВАРИАНТА СВОЙ КАДР. Снимки кадрированы по-разному: на портрете
лицо в центре, на карикатуре сбоку. Точка лица и приближение хранятся в
строке фото, а не у человека — иначе при переключении варианта кадр
разъезжался бы.

⚠️ Профильное фото НЕ ТРОГАЕМ: оно показывается в карточке спикера, в
программе, в Mini App и на витрине. Библиотека дополняет его для афиш
конкретного события.

Устроено как библиотека афиш (`collaborator_posters`, мигр. 121) — та же
форма проверена и ведёт себя предсказуемо.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.auth import get_current_client
from app.database import get_db
from app.services import r2_storage
from app.services.event_access import assert_event_owner


router = APIRouter(prefix="/api/v1/collaborators", tags=["Фото коллаборатора"])

# Поля кадра — те же имена, что у человека (мигр. 434, 451).
_CROP_FIELDS = (
    "photo_focal", "cutout_photo_focal",
    "crop_zoom_circle", "crop_zoom_square", "crop_zoom_portrait",
    "crop_dx_circle", "crop_dy_circle",
    "crop_dx_square", "crop_dy_square",
    "crop_dx_portrait", "crop_dy_portrait",
)
_RETURNING = (
    "id, url, cutout_url, label, sort_order, created_at, "
    + ", ".join(_CROP_FIELDS)
)


class PhotoCreate(BaseModel):
    url: str
    cutout_url: Optional[str] = None
    label: Optional[str] = None


class PhotoUpdate(BaseModel):
    """⚠️ Отдельная модель от Create: у PATCH все поля необязательны, и
    отличать «не прислали» от «прислали пусто» обязательно — иначе каждое
    сохранение затирало бы кадр умолчаниями."""
    url: Optional[str] = None
    cutout_url: Optional[str] = None
    label: Optional[str] = None
    sort_order: Optional[int] = None
    photo_focal: Optional[str] = None
    cutout_photo_focal: Optional[str] = None
    crop_zoom_circle: Optional[float] = None
    crop_zoom_square: Optional[float] = None
    crop_zoom_portrait: Optional[float] = None
    crop_dx_circle: Optional[float] = None
    crop_dy_circle: Optional[float] = None
    crop_dx_square: Optional[float] = None
    crop_dy_square: Optional[float] = None
    crop_dx_portrait: Optional[float] = None
    crop_dy_portrait: Optional[float] = None


def _num(row) -> dict:
    """NUMERIC → float.

    ⚠️ asyncpg отдаёт NUMERIC как Decimal, а тот уезжает в JSON СТРОКОЙ. Фронт
    умножает приближение на размер маски — на строке выходит NaN, и фото
    пропадает. Та же ловушка уже ломала афиши.
    """
    from decimal import Decimal
    out = dict(row)
    for k, v in out.items():
        if isinstance(v, Decimal):
            out[k] = float(v)
    return out


async def _check_owns(collaborator_id: int, client_id: int, db: asyncpg.Connection) -> None:
    row = await db.fetchval(
        "SELECT 1 FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
        collaborator_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")


@router.get("/{collaborator_id}/photos", summary="Библиотека фото коллаба")
async def list_photos(
    collaborator_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_owns(collaborator_id, int(client["sub"]), db)
    rows = await db.fetch(
        f"SELECT {_RETURNING} FROM collaborator_photos"
        " WHERE collaborator_id = $1 ORDER BY sort_order, id",
        collaborator_id,
    )
    return {"photos": [_num(r) for r in rows]}


@router.post("/{collaborator_id}/photos", summary="Добавить фото в библиотеку")
async def add_photo(
    collaborator_id: int,
    data: PhotoCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_owns(collaborator_id, int(client["sub"]), db)
    url = (data.url or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="Не выбран файл фото")
    next_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collaborator_photos"
        " WHERE collaborator_id = $1",
        collaborator_id,
    )
    row = await db.fetchrow(
        f"""INSERT INTO collaborator_photos (collaborator_id, url, cutout_url, label, sort_order)
            VALUES ($1, $2, $3, $4, $5) RETURNING {_RETURNING}""",
        collaborator_id, url, (data.cutout_url or None),
        (data.label or None), int(next_sort),
    )
    return {"photo": _num(row)}


@router.patch("/{collaborator_id}/photos/{photo_id}", summary="Правка фото и его кадра")
async def update_photo(
    collaborator_id: int,
    photo_id: int,
    data: PhotoUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_owns(collaborator_id, int(client["sub"]), db)
    # ⚠️ `exclude_unset` — присланные поля отличаем от неприсланных: без него
    # правка подписи стирала бы настроенный кадр.
    updates = data.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=422, detail="Нет полей для обновления")
    parts = [f"{k} = ${i + 3}" for i, k in enumerate(updates.keys())]
    row = await db.fetchrow(
        f"""UPDATE collaborator_photos SET {', '.join(parts)}
             WHERE id = $1 AND collaborator_id = $2 RETURNING {_RETURNING}""",
        photo_id, collaborator_id, *updates.values(),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Фото не найдено")
    return {"photo": _num(row)}


@router.delete("/{collaborator_id}/photos/{photo_id}", summary="Удалить фото из библиотеки")
async def delete_photo(
    collaborator_id: int,
    photo_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_owns(collaborator_id, client_id, db)
    row = await db.fetchrow(
        "SELECT url, cutout_url FROM collaborator_photos"
        " WHERE id = $1 AND collaborator_id = $2",
        photo_id, collaborator_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Фото не найдено")

    # ⚠️ Чистим R2 И КВОТУ КЛИЕНТА — как в библиотеке афиш. Удалив только
    # строку, мы бы оставили файл в хранилище и занятое место в квоте: у
    # клиента «место кончилось», хотя картинок он не видит.
    for u in (row["url"], row["cutout_url"]):
        if not u:
            continue
        key = r2_storage.key_from_url(u)
        if not key:
            continue  # внешний файл — не наш, не трогаем
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
                    "UPDATE clients SET storage_used_bytes ="
                    " GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
                    int(file_row["size_bytes"]), client_id,
                )

    # ⚠️ Строку удаляем ПОСЛЕ файлов: события, где это фото выбрано, вернутся
    # к профильному сами (photo_id → NULL, ON DELETE SET NULL, мигр. 472).
    await db.execute(
        "DELETE FROM collaborator_photos WHERE id = $1 AND collaborator_id = $2",
        photo_id, collaborator_id,
    )
    return {"ok": True}


@router.put("/events/{event_id}/speakers/{collaborator_id}/photo",
            summary="Какое фото взять в этом событии")
async def set_event_photo(
    event_id: int,
    collaborator_id: int,
    photo_id: Optional[int] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Выбирает фото из библиотеки для КОНКРЕТНОГО события.

    ⚠️ `photo_id` пустой — вернуться к профильному фото. Это не ошибка, а
    штатный способ отказаться от варианта, не удаляя его из библиотеки.
    """
    client_id = int(client["sub"])
    await _check_owns(collaborator_id, client_id, db)
    # ⚠️⚠️ ВЛАДЕНИЕ СОБЫТИЕМ — ТОЛЬКО ЧЕРЕЗ `assert_event_owner`. Я написал
    # `events.client_id` — такой колонки НЕТ ВОВСЕ, и ручка падала с
    # UndefinedColumnError: выбор фото молча не сохранялся. Владение событием
    # считается сложнее (есть коллаборации, где событие ведёт не владелец
    # базы), и ровно поэтому для него существует общая функция.
    await assert_event_owner(db, event_id, client_id)

    if photo_id is not None:
        belongs = await db.fetchval(
            "SELECT 1 FROM collaborator_photos WHERE id = $1 AND collaborator_id = $2",
            photo_id, collaborator_id,
        )
        if not belongs:
            raise HTTPException(status_code=404, detail="Фото не найдено у этого спикера")

    updated = await db.fetchval(
        "UPDATE event_collaborators SET photo_id = $1"
        " WHERE event_id = $2 AND speaker_id = $3 RETURNING id",
        photo_id, event_id, collaborator_id,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Спикер не участвует в этом событии")
    return {"ok": True, "photo_id": photo_id}
