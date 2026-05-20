"""API воронки догрева на событие.

Воронка догрева — серия сообщений, которая шлётся человеку с момента первого
открытия события (если он не зарегистрировался). Шаги настраивает клиент в
дашборде, дефолтные 3 шаблона добавляются автоматически при первом открытии
вкладки в дашборде.

Триггер запуска: handle_tg_event / handle_vk_event при first event_start
без is_registered=true вызывают start_nurture_run(event_id, contact_id).

Отправка: Celery beat task `nurture.tick` раз в N минут сканирует
event_nurture_runs где finished_at IS NULL, ищет очередной непосланный шаг
и шлёт через бот клиента (или системный).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Literal
import asyncpg

from app.database import get_db
from app.auth import get_current_client

router = APIRouter(prefix="/events", tags=["Воронка догрева"])


# ─── Pydantic ─────────────────────────────────────────────────────────

class NurtureStepCreate(BaseModel):
    offset_seconds: int = Field(..., ge=0)
    text:           str = ""
    button_label:   str = "Зарегистрироваться"
    is_active:      bool = True


class NurtureStepUpdate(BaseModel):
    offset_seconds: Optional[int] = Field(None, ge=0)
    text:           Optional[str] = None
    button_label:   Optional[str] = None
    is_active:      Optional[bool] = None


# ─── Дефолтные тексты (auto-seed при первом GET) ──────────────────────
# Плейсхолдеры: {event_title}, {event_date_short} — подставляются при отправке.
# HTML-форматирование (<b>, <i>, <a>) разрешено.

DEFAULT_STEPS = [
    {
        "offset_seconds": 30 * 60,  # 30 минут
        "text": (
            "⏰ <b>Кажется, что-то отвлекло</b> — но вы открывали «{event_title}»! "
            "Регистрация занимает минуту — закрепите место сейчас, чтобы не пропустить.\n\n"
            "Жмите кнопку ниже и заполняйте форму ↓"
        ),
        "button_label": "Зарегистрироваться",
    },
    {
        "offset_seconds": 60 * 24,
        "text": (
            "💛 <b>Доброго времени!</b>\n\n"
            "Вчера вы открывали «{event_title}», но не успели зарегистрироваться. "
            "Возможно остались вопросы? Свяжитесь с организатором — {owner_telegram} — "
            "и мы поможем определиться.\n\n"
            "А если всё хорошо — забронируйте место одним нажатием ↓"
        ),
        "button_label": "Хочу участвовать",
    },
    {
        "offset_seconds": 60 * 48,
        "text": (
            "⚠️ <b>Последний шанс!</b>\n\n"
            "До «{event_title}» совсем немного — поток участников растёт, "
            "мест может не хватить. Принимайте решение прямо сейчас, дальше будет поздно."
        ),
        "button_label": "Закрепить место",
    },
]


# ─── Helpers ──────────────────────────────────────────────────────────

async def _assert_event_belongs_to_client(db, event_id: int, client_id: int):
    """403 если событие не принадлежит этому клиенту."""
    ok = await db.fetchval(
        "SELECT 1 FROM events WHERE id = $1 AND client_id = $2",
        event_id, client_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Событие не найдено")


async def _seed_default_steps_if_empty(db, event_id: int):
    """Если у события нет ни одного шага — добавляем 3 дефолтных шаблона.
    Идемпотентно: повторный вызов с уже существующими шагами — no-op."""
    cnt = await db.fetchval(
        "SELECT COUNT(*) FROM event_nurture_steps WHERE event_id = $1",
        event_id,
    )
    if cnt > 0:
        return
    for i, step in enumerate(DEFAULT_STEPS):
        await db.execute(
            """INSERT INTO event_nurture_steps
                  (event_id, sort_order, offset_seconds, text, button_label, is_active)
               VALUES ($1, $2, $3, $4, $5, TRUE)""",
            event_id, i, step["offset_seconds"], step["text"], step["button_label"],
        )


# ─── Routes ───────────────────────────────────────────────────────────

@router.get("/{event_id}/nurture/steps")
async def list_nurture_steps(
    event_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Список шагов воронки догрева. При первом обращении auto-seed
    3 дефолтных шага (30 мин / 24 ч / 48 ч)."""
    await _assert_event_belongs_to_client(db, event_id, int(client["sub"]))
    await _seed_default_steps_if_empty(db, event_id)
    rows = await db.fetch(
        """SELECT id, sort_order, offset_seconds, text, button_label, is_active, updated_at
             FROM event_nurture_steps
            WHERE event_id = $1
            ORDER BY sort_order, id""",
        event_id,
    )
    return {"steps": [dict(r) for r in rows]}


@router.post("/{event_id}/nurture/steps")
async def create_nurture_step(
    event_id: int,
    data: NurtureStepCreate,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    await _assert_event_belongs_to_client(db, event_id, int(client["sub"]))
    next_sort = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_nurture_steps WHERE event_id = $1",
        event_id,
    )
    new_id = await db.fetchval(
        """INSERT INTO event_nurture_steps
              (event_id, sort_order, offset_seconds, text, button_label, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id""",
        event_id, next_sort, data.offset_seconds, data.text, data.button_label, data.is_active,
    )
    return {"id": new_id}


@router.patch("/nurture/steps/{step_id}", tags=["Воронка догрева"])
async def update_nurture_step(
    step_id: int,
    data: NurtureStepUpdate,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    # Проверяем принадлежность через event_id шага
    row = await db.fetchrow(
        """SELECT s.event_id, e.client_id
             FROM event_nurture_steps s
             JOIN events e ON e.id = s.event_id
            WHERE s.id = $1""",
        step_id,
    )
    if not row or row["client_id"] != int(client["sub"]):
        raise HTTPException(status_code=404, detail="Шаг не найден")

    updates = []
    args = [step_id]
    if data.offset_seconds is not None:
        args.append(data.offset_seconds); updates.append(f"offset_seconds = ${len(args)}")
    if data.text is not None:
        args.append(data.text); updates.append(f"text = ${len(args)}")
    if data.button_label is not None:
        args.append(data.button_label); updates.append(f"button_label = ${len(args)}")
    if data.is_active is not None:
        args.append(data.is_active); updates.append(f"is_active = ${len(args)}")
    if not updates:
        return {"ok": True, "noop": True}
    updates.append("updated_at = NOW()")
    await db.execute(
        f"UPDATE event_nurture_steps SET {', '.join(updates)} WHERE id = $1",
        *args,
    )
    return {"ok": True}


@router.delete("/nurture/steps/{step_id}", tags=["Воронка догрева"])
async def delete_nurture_step(
    step_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    row = await db.fetchrow(
        """SELECT s.event_id, e.client_id
             FROM event_nurture_steps s
             JOIN events e ON e.id = s.event_id
            WHERE s.id = $1""",
        step_id,
    )
    if not row or row["client_id"] != int(client["sub"]):
        raise HTTPException(status_code=404, detail="Шаг не найден")
    await db.execute("DELETE FROM event_nurture_steps WHERE id = $1", step_id)
    return {"ok": True}


# ─── Trigger (вызывается из event.py и vk_event.py) ───────────────────

async def start_nurture_run_if_eligible(
    db, *, event_id: int, contact_id: int, is_registered: bool,
) -> bool:
    """Создаёт запись event_nurture_runs если человек открыл событие и не
    зарегистрирован. Идемпотентно: при повторном открытии повторно не плодит.

    Возвращает True если run создан (или уже существовал и не завершён).
    """
    if is_registered:
        # Уже зарегистрирован — воронка ему не нужна. Если есть незавершённый run —
        # помечаем finished, чтобы Celery его пропустил.
        await db.execute(
            """UPDATE event_nurture_runs
                  SET finished_at = NOW(), finished_reason = 'registered'
                WHERE event_id = $1 AND contact_id = $2 AND finished_at IS NULL""",
            event_id, contact_id,
        )
        return False

    # У события должны быть хотя бы 1 активный шаг — иначе нечего слать.
    has_step = await db.fetchval(
        """SELECT 1 FROM event_nurture_steps
            WHERE event_id = $1 AND is_active = TRUE LIMIT 1""",
        event_id,
    )
    if not has_step:
        return False

    # UPSERT с ON CONFLICT DO NOTHING — повторный вызов не плодит дубль и не
    # обновляет started_at (чтобы серия с момента первого открытия осталась).
    res = await db.fetchval(
        """INSERT INTO event_nurture_runs (event_id, contact_id, started_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (event_id, contact_id) DO NOTHING
        RETURNING id""",
        event_id, contact_id,
    )
    return res is not None
