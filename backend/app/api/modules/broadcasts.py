from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
import asyncpg

from app.database import get_db
from app.auth import get_current_client

router = APIRouter(prefix="/events/{event_id}/broadcasts", tags=["Рассылки"])


# ─────────────────────────────────────────
# ШАБЛОНЫ
# ─────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    type: str                        # 'pre_start' | 'gift'
    text: Optional[str] = None
    photo_url: Optional[str] = None
    button_text: Optional[str] = None
    button_url: Optional[str] = None


class TemplateUpdate(TemplateCreate):
    pass


@router.get("/templates", summary="Список шаблонов рассылок")
async def list_templates(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await db.fetch(
        """
        SELECT id, name, type, text, photo_url, button_text, button_url, created_at
        FROM broadcast_templates
        WHERE event_id = $1
        ORDER BY type, created_at
        """,
        event_id
    )
    return {"templates": [dict(r) for r in rows]}


@router.post("/templates", summary="Создать шаблон")
async def create_template(
    event_id: int,
    data: TemplateCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates (client_id, event_id, name, type, text, photo_url, button_text, button_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, name, type, text, photo_url, button_text, button_url, created_at
        """,
        client_id, event_id, data.name, data.type,
        data.text, data.photo_url, data.button_text, data.button_url
    )
    return dict(row)


@router.put("/templates/{template_id}", summary="Редактировать шаблон")
async def update_template(
    event_id: int,
    template_id: int,
    data: TemplateUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    row = await db.fetchrow(
        """
        UPDATE broadcast_templates SET
            name = $1, type = $2, text = $3,
            photo_url = $4, button_text = $5, button_url = $6,
            updated_at = NOW()
        WHERE id = $7 AND event_id = $8
        RETURNING id, name, type, text, photo_url, button_text, button_url
        """,
        data.name, data.type, data.text,
        data.photo_url, data.button_text, data.button_url,
        template_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    return dict(row)


@router.delete("/templates/{template_id}", summary="Удалить шаблон")
async def delete_template(
    event_id: int,
    template_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    await db.execute(
        "DELETE FROM broadcast_templates WHERE id = $1 AND event_id = $2",
        template_id, event_id
    )
    return {"ok": True}


# ─────────────────────────────────────────
# РАСПИСАНИЕ РАССЫЛОК
# ─────────────────────────────────────────

@router.get("/schedules", summary="Очередь рассылок")
async def list_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await db.fetch(
        """
        SELECT bs.id, bs.type, bs.fire_at, bs.status,
               bs.recipients_sent, bs.is_test,
               bt.name as template_name,
               cs.title as session_title,
               cs.start_datetime, cs.end_datetime,
               c.name as speaker_name
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        LEFT JOIN conf_sessions cs ON cs.id = bs.session_id
        LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
        LEFT JOIN collaborators c ON c.id = cse.speaker_id
        WHERE bs.event_id = $1
        ORDER BY bs.fire_at
        """,
        event_id
    )

    now = datetime.utcnow()
    result = []
    for r in rows:
        d = dict(r)
        # Считаем секунды до отправки
        if r["fire_at"] and r["status"] == "pending":
            diff = (r["fire_at"].replace(tzinfo=None) - now).total_seconds()
            d["seconds_until"] = max(0, int(diff))
        else:
            d["seconds_until"] = None
        result.append(d)

    return {"schedules": result}


@router.post("/schedules/generate", summary="Создать расписание из программы конференции")
async def generate_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Создаёт записи broadcast_schedules для всех сессий конференции:
    - pre_start: за 5 минут до start_datetime
    - gift: за 10 минут до end_datetime
    Пропускает сессии без спикера или без времени.
    Не создаёт дубли — если рассылка уже есть, пропускает.
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    # Берём шаблоны для этого события
    tmpl_pre = await db.fetchrow(
        "SELECT id FROM broadcast_templates WHERE event_id=$1 AND type='pre_start' LIMIT 1", event_id
    )
    tmpl_gift = await db.fetchrow(
        "SELECT id FROM broadcast_templates WHERE event_id=$1 AND type='gift' LIMIT 1", event_id
    )

    if not tmpl_pre and not tmpl_gift:
        raise HTTPException(status_code=400, detail="Сначала создайте шаблоны рассылок")

    # Берём все сессии с временем и спикером
    sessions = await db.fetch(
        """
        SELECT cs.id, cs.start_datetime, cs.end_datetime, cs.title
        FROM conf_sessions cs
        WHERE cs.event_id = $1
          AND cs.speaker_id IS NOT NULL
          AND cs.start_datetime IS NOT NULL
        ORDER BY cs.start_datetime
        """,
        event_id
    )

    created = 0
    skipped = 0

    for s in sessions:
        # pre_start — за 5 минут до начала
        if tmpl_pre and s["start_datetime"]:
            fire_at = s["start_datetime"] - timedelta(minutes=5)
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND session_id=$2 AND type='pre_start'",
                event_id, s["id"]
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules (event_id, session_id, template_id, type, fire_at, status)
                    VALUES ($1, $2, $3, 'pre_start', $4, 'pending')
                    """,
                    event_id, s["id"], tmpl_pre["id"], fire_at
                )
                created += 1
            else:
                skipped += 1

        # gift — за 10 минут до конца
        if tmpl_gift and s["end_datetime"]:
            fire_at = s["end_datetime"] - timedelta(minutes=10)
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND session_id=$2 AND type='gift'",
                event_id, s["id"]
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules (event_id, session_id, template_id, type, fire_at, status)
                    VALUES ($1, $2, $3, 'gift', $4, 'pending')
                    """,
                    event_id, s["id"], tmpl_gift["id"], fire_at
                )
                created += 1
            else:
                skipped += 1

    return {"ok": True, "created": created, "skipped": skipped}


@router.post("/schedules/{schedule_id}/cancel", summary="Отменить рассылку")
async def cancel_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    await db.execute(
        "UPDATE broadcast_schedules SET status='cancelled' WHERE id=$1 AND event_id=$2 AND status='pending'",
        schedule_id, event_id
    )
    return {"ok": True}


@router.post("/schedules/cancel-all", summary="Отменить все pending рассылки")
async def cancel_all_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    count = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='pending'", event_id
    )
    await db.execute(
        "UPDATE broadcast_schedules SET status='cancelled' WHERE event_id=$1 AND status='pending'", event_id
    )
    return {"ok": True, "cancelled": count}


# ─────────────────────────────────────────
# Хелпер
# ─────────────────────────────────────────
async def _check_event(db, event_id: int, client_id: int):
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id=$1 AND client_id=$2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
