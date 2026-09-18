"""
Библиотека логотипов бренда в профиле клиента (миграция 449).

Зачем. Логотип у бренда не один: горизонтальный и квадратный, полный знак и
только иконка, цветной и монохромный для печати. Организатору под афишу нужна
своя версия, и раньше он её просто не получал — у клиента было ровно два поля
(для тёмного и для светлого фона), остальное пересылалось файлами в личке.
Ровно та работа, ради отмены которой делалась страница /sp/{код}.

Устроено ТАК ЖЕ, как библиотека фото спикера ([client_speaker_photos.py]) —
вплоть до имён колонок и путей ручек. Одинаковая форма нужна, чтобы не
разбираться дважды: у картинок общий жизненный цикл (загрузка в хранилище,
переименование, удаление с чисткой файла, порядок).

⚠️ Поля `clients.brand_logo_url` и `brand_logo_light_url` НЕ заменяются — на
них завязаны афиши, обложки, шапки страниц, favicon и письма. Библиотека
дополняет их: это витрина для организатора, а не рабочий знак платформы.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import asyncpg

from app.auth import get_current_client
from app.database import get_db
from app.services import r2_storage


router = APIRouter(prefix="/api/v1/clients/me/brand-logos", tags=["Логотипы бренда"])

_SELECT = "id, url, label, on_dark, is_primary, sort_order, created_at"


class LogoCreate(BaseModel):
    url: str
    label: Optional[str] = None
    on_dark: Optional[bool] = None


class LogoUpdate(BaseModel):
    label: Optional[str] = None
    on_dark: Optional[bool] = None
    sort_order: Optional[int] = None
    is_primary: Optional[bool] = None


class ReorderRequest(BaseModel):
    ids: List[int]


@router.get("", summary="Библиотека логотипов бренда")
async def list_logos(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        f"""SELECT {_SELECT} FROM client_brand_logos
             WHERE client_id = $1
             ORDER BY sort_order, id""",
        int(client["sub"]),
    )
    return {"logos": [dict(r) for r in rows]}


@router.post("", summary="Добавить логотип")
async def add_logo(
    data: LogoCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    url = (data.url or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="Не хватает ссылки на файл")

    next_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM client_brand_logos WHERE client_id = $1",
        client_id,
    )
    # Первый загруженный логотип сразу становится главным — иначе на странице
    # для организаторов не показалось бы ничего, пока человек не поставит
    # галочку руками.
    is_first = not await db.fetchval(
        "SELECT 1 FROM client_brand_logos WHERE client_id = $1 LIMIT 1", client_id
    )
    row = await db.fetchrow(
        f"""INSERT INTO client_brand_logos (client_id, url, label, on_dark, sort_order, is_primary)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING {_SELECT}""",
        client_id, url, (data.label or None), bool(data.on_dark),
        int(next_sort), is_first,
    )
    return {"logo": dict(row)}


@router.patch("/{logo_id}", summary="Переименовать, сменить подложку, сделать главным")
async def update_logo(
    logo_id: int,
    data: LogoUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    fs = data.model_fields_set
    if not fs:
        raise HTTPException(status_code=422, detail="Нечего менять")

    async with db.transaction():
        # Главный логотип один — снимаем галочку с прежнего, иначе частичный
        # UNIQUE-индекс отклонит вставку второго.
        if "is_primary" in fs and data.is_primary:
            await db.execute(
                "UPDATE client_brand_logos SET is_primary = FALSE WHERE client_id = $1 AND is_primary",
                client_id,
            )

        updates = {k: getattr(data, k) for k in fs
                   if k in ("label", "on_dark", "sort_order", "is_primary")}
        if not updates:
            raise HTTPException(status_code=422, detail="Нечего менять")
        parts = [f"{k} = ${i + 3}" for i, k in enumerate(updates.keys())]
        row = await db.fetchrow(
            f"""UPDATE client_brand_logos
                   SET {', '.join(parts)}
                 WHERE id = $1 AND client_id = $2
                 RETURNING {_SELECT}""",
            logo_id, client_id, *updates.values(),
        )
    if not row:
        raise HTTPException(status_code=404, detail="Логотип не найден")
    return {"logo": dict(row)}


@router.post("/reorder", summary="Изменить порядок")
async def reorder_logos(
    data: ReorderRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    async with db.transaction():
        for i, lid in enumerate(data.ids):
            await db.execute(
                "UPDATE client_brand_logos SET sort_order = $1 WHERE id = $2 AND client_id = $3",
                i, int(lid), client_id,
            )
    return {"ok": True}


@router.delete("/{logo_id}", summary="Удалить логотип")
async def delete_logo(
    logo_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Удаляет запись и сам файл из хранилища."""
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT id, url, is_primary FROM client_brand_logos WHERE id = $1 AND client_id = $2",
        logo_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Логотип не найден")

    # ⚠️ Файл сносим ТОЛЬКО если на него больше никто не ссылается: тот же знак
    # обычно стоит и в `clients.brand_logo_url` (шапки, афиши, favicon), и мог
    # быть добавлен в библиотеку второй раз. Удалив файл вслепую, мы погасили бы
    # логотип по всей платформе.
    key = r2_storage.key_from_url(row["url"])
    still_used = await db.fetchval(
        """SELECT 1 FROM clients
            WHERE id = $1 AND $2 IN (brand_logo_url, brand_logo_light_url)
            UNION ALL
           SELECT 1 FROM client_brand_logos
            WHERE client_id = $1 AND url = $2 AND id <> $3
            LIMIT 1""",
        client_id, row["url"], logo_id,
    )
    if key and not still_used:
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

    await db.execute("DELETE FROM client_brand_logos WHERE id = $1", logo_id)

    # Удалили главный — назначаем главным первый из оставшихся, чтобы страница
    # для организаторов не осталась без логотипа.
    if row["is_primary"]:
        await db.execute(
            """UPDATE client_brand_logos SET is_primary = TRUE
                WHERE id = (SELECT id FROM client_brand_logos
                             WHERE client_id = $1 ORDER BY sort_order, id LIMIT 1)""",
            client_id,
        )
    return {"ok": True}
