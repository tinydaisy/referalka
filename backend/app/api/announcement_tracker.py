"""
Трекер анонсов спикеров — вкладка внутри карточки конференции/турнира/премии.

Матрица: строки = коллабораторы события (все роли; организаторы внизу),
колонки = «Анонс N» × площадки. В ячейке — чекбокс «сделано» + свободный текст.
Слева колонка «Договорённости» (текст на спикера).

Площадки и анонсы настраиваются клиентом per-event. При первом открытии
автоматически сидятся дефолты (7 площадок + 3 анонса).

Хранилище — миграция 124. Ячейки/договорённости ключуются по collaborator_id
(глобальный коллаб), поэтому при удалении спикера из события текст не теряется.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
from app.services.collaborator_sort import group_rank_sql, referrals_count_sql
import asyncpg

router = APIRouter(prefix="/events/{event_id}/announcement-tracker", tags=["Трекер анонсов"])

DEFAULT_PLATFORMS = ["ТГ", "Инст", "Чат-бот", "ВК", "МАХ", "Ютюб", "Емейл"]
DEFAULT_COLUMNS = 3


async def _check_event_owned(event_id: int, client_id: int, db: asyncpg.Connection):
    ev = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')", event_id, client_id
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")


async def _ensure_seeded(event_id: int, db: asyncpg.Connection):
    """При первом открытии — засеять дефолтные площадки и 3 анонса."""
    has_platforms = await db.fetchval(
        "SELECT 1 FROM event_announcement_platforms WHERE event_id = $1 LIMIT 1", event_id
    )
    if not has_platforms:
        for i, label in enumerate(DEFAULT_PLATFORMS):
            await db.execute(
                "INSERT INTO event_announcement_platforms (event_id, label, sort_order) VALUES ($1, $2, $3)",
                event_id, label, i
            )
    has_columns = await db.fetchval(
        "SELECT 1 FROM event_announcement_columns WHERE event_id = $1 LIMIT 1", event_id
    )
    if not has_columns:
        for i in range(DEFAULT_COLUMNS):
            await db.execute(
                "INSERT INTO event_announcement_columns (event_id, title, sort_order) VALUES ($1, $2, $3)",
                event_id, f"Анонс {i + 1}", i
            )


# ──────────────────────────────────────────────
# GET — вся матрица
# ──────────────────────────────────────────────

@router.get("", summary="Трекер анонсов: площадки, анонсы, спикеры, ячейки")
async def get_tracker(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_owned(event_id, client_id, db)
    await _ensure_seeded(event_id, db)

    platforms = await db.fetch(
        "SELECT id, label, sort_order FROM event_announcement_platforms "
        "WHERE event_id = $1 ORDER BY sort_order, id", event_id
    )
    columns = await db.fetch(
        "SELECT id, title, sort_order FROM event_announcement_columns "
        "WHERE event_id = $1 ORDER BY sort_order, id", event_id
    )

    # Все коллабораторы события, организаторы — внизу.
    speakers = await db.fetch(f"""
        SELECT co.id AS collaborator_id, co.name, ec.role, co.title, co.photo_url
          FROM event_collaborators ec
          JOIN collaborators co ON co.id = ec.speaker_id
         WHERE ec.event_id = $1
         ORDER BY (CASE WHEN ec.role = 'organizer' THEN 1 ELSE 0 END) ASC,
                  {referrals_count_sql('ec')} DESC,
                  {group_rank_sql('ec')} ASC,
                  COALESCE(ec.priority, 60) ASC,
                  ec.id ASC
    """, event_id)

    cells = await db.fetch(
        "SELECT collaborator_id, column_id, platform_id, is_done, content "
        "FROM speaker_announcement_cells WHERE event_id = $1", event_id
    )
    agreements = await db.fetch(
        "SELECT collaborator_id, content FROM speaker_announcement_agreements WHERE event_id = $1",
        event_id
    )

    cell_map = {
        f"{c['column_id']}_{c['platform_id']}_{c['collaborator_id']}": {
            "is_done": c["is_done"], "content": c["content"]
        }
        for c in cells
    }
    agreement_map = {a["collaborator_id"]: a["content"] for a in agreements}

    return {
        "platforms": [dict(p) for p in platforms],
        "columns": [dict(c) for c in columns],
        "speakers": [dict(s) for s in speakers],
        "cells": cell_map,
        "agreements": agreement_map,
    }


# ──────────────────────────────────────────────
# ПЛОЩАДКИ (колонки)
# ──────────────────────────────────────────────

class PlatformIn(BaseModel):
    label: str
    sort_order: Optional[int] = None


@router.post("/platforms", summary="Добавить площадку")
async def add_platform(
    event_id: int, data: PlatformIn,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    label = (data.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="Введите название площадки")
    sort_order = data.sort_order
    if sort_order is None:
        sort_order = (await db.fetchval(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_announcement_platforms WHERE event_id = $1",
            event_id
        )) or 0
    row = await db.fetchrow(
        "INSERT INTO event_announcement_platforms (event_id, label, sort_order) "
        "VALUES ($1, $2, $3) RETURNING id, label, sort_order",
        event_id, label, sort_order
    )
    return dict(row)


@router.patch("/platforms/{platform_id}", summary="Переименовать/переставить площадку")
async def update_platform(
    event_id: int, platform_id: int, data: PlatformIn,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    label = (data.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="Введите название площадки")
    row = await db.fetchrow(
        "UPDATE event_announcement_platforms SET label = $1, "
        "sort_order = COALESCE($2, sort_order) "
        "WHERE id = $3 AND event_id = $4 RETURNING id, label, sort_order",
        label, data.sort_order, platform_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Площадка не найдена")
    return dict(row)


@router.delete("/platforms/{platform_id}", summary="Удалить площадку")
async def delete_platform(
    event_id: int, platform_id: int,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    res = await db.execute(
        "DELETE FROM event_announcement_platforms WHERE id = $1 AND event_id = $2",
        platform_id, event_id
    )
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="Площадка не найдена")
    return {"ok": True}


# ──────────────────────────────────────────────
# АНОНСЫ (колонки-группы)
# ──────────────────────────────────────────────

class ColumnIn(BaseModel):
    title: Optional[str] = None
    sort_order: Optional[int] = None


@router.post("/columns", summary="Добавить анонс")
async def add_column(
    event_id: int, data: ColumnIn,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    next_sort = (await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_announcement_columns WHERE event_id = $1",
        event_id
    )) or 0
    title = (data.title or "").strip() or f"Анонс {next_sort + 1}"
    row = await db.fetchrow(
        "INSERT INTO event_announcement_columns (event_id, title, sort_order) "
        "VALUES ($1, $2, $3) RETURNING id, title, sort_order",
        event_id, title, next_sort
    )
    return dict(row)


@router.patch("/columns/{column_id}", summary="Переименовать анонс")
async def update_column(
    event_id: int, column_id: int, data: ColumnIn,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    title = (data.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Введите название анонса")
    row = await db.fetchrow(
        "UPDATE event_announcement_columns SET title = $1, "
        "sort_order = COALESCE($2, sort_order) "
        "WHERE id = $3 AND event_id = $4 RETURNING id, title, sort_order",
        title, data.sort_order, column_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Анонс не найден")
    return dict(row)


@router.delete("/columns/{column_id}", summary="Удалить анонс")
async def delete_column(
    event_id: int, column_id: int,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    res = await db.execute(
        "DELETE FROM event_announcement_columns WHERE id = $1 AND event_id = $2",
        column_id, event_id
    )
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="Анонс не найден")
    return {"ok": True}


# ──────────────────────────────────────────────
# ЯЧЕЙКА (upsert)
# ──────────────────────────────────────────────

class CellIn(BaseModel):
    collaborator_id: int
    column_id: int
    platform_id: int
    is_done: bool = False
    content: str = ""


@router.put("/cell", summary="Сохранить ячейку (чекбокс + текст)")
async def save_cell(
    event_id: int, data: CellIn,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    # Колонка и площадка должны принадлежать этому событию.
    col_ok = await db.fetchval(
        "SELECT 1 FROM event_announcement_columns WHERE id = $1 AND event_id = $2",
        data.column_id, event_id
    )
    plat_ok = await db.fetchval(
        "SELECT 1 FROM event_announcement_platforms WHERE id = $1 AND event_id = $2",
        data.platform_id, event_id
    )
    if not col_ok or not plat_ok:
        raise HTTPException(status_code=404, detail="Колонка или площадка не найдены")
    await db.execute(
        """INSERT INTO speaker_announcement_cells
             (event_id, collaborator_id, column_id, platform_id, is_done, content, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (column_id, platform_id, collaborator_id)
           DO UPDATE SET is_done = EXCLUDED.is_done,
                         content = EXCLUDED.content,
                         updated_at = NOW()""",
        event_id, data.collaborator_id, data.column_id, data.platform_id,
        data.is_done, data.content or ""
    )
    return {"ok": True}


# ──────────────────────────────────────────────
# ДОГОВОРЁННОСТИ (upsert)
# ──────────────────────────────────────────────

class AgreementIn(BaseModel):
    collaborator_id: int
    content: str = ""


@router.put("/agreement", summary="Сохранить договорённости спикера")
async def save_agreement(
    event_id: int, data: AgreementIn,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    await db.execute(
        """INSERT INTO speaker_announcement_agreements
             (event_id, collaborator_id, content, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (event_id, collaborator_id)
           DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()""",
        event_id, data.collaborator_id, data.content or ""
    )
    return {"ok": True}
