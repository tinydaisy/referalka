"""
Приветствие в чатах — набор случайных фраз приветствия события (миграция 163).

Подвкладка «Приветствие» → «В чатах» в карточке события. Включатель и кодовое
слово хранятся в самом событии (events.chat_greeting_enabled / chat_greeting_keyword,
правятся через PATCH /events/{id}); здесь — CRUD набора фраз, из которого бот
берёт случайную при ответе на кодовое слово.

GET авто-сидит дефолтный набор, если у события ещё нет фраз — чтобы он был
у каждого события (мероприятие/конференция/турнир/конкурс).

API (требуют JWT владельца кабинета):
  GET    /api/v1/events/{event_id}/chat-greetings
  POST   /api/v1/events/{event_id}/chat-greetings
  PATCH  /api/v1/events/{event_id}/chat-greetings/{greeting_id}
  DELETE /api/v1/events/{event_id}/chat-greetings/{greeting_id}
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.chat_archive import get_or_seed_chat_greetings

router = APIRouter(prefix="/events/{event_id}/chat-greetings", tags=["Приветствие в чатах"])


async def _check_event_access(db, client_id: int, event_id: int):
    row = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND id IN "
        "(SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


class GreetingIn(BaseModel):
    text: str
    sort: int = 0


class GreetingPatch(BaseModel):
    text: Optional[str] = None
    sort: Optional[int] = None


@router.get("", summary="Набор фраз приветствия (auto-seed дефолтных)")
async def list_greetings(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    greetings = await get_or_seed_chat_greetings(db, event_id)
    return {"greetings": greetings}


@router.post("", summary="Добавить фразу")
async def create_greeting(
    event_id: int,
    data: GreetingIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    text = (data.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Фраза не может быть пустой")
    row = await db.fetchrow(
        "INSERT INTO event_chat_greetings (event_id, text, sort) VALUES ($1, $2, $3) "
        "RETURNING id, text, sort",
        event_id, text, data.sort,
    )
    return {"greeting": dict(row)}


@router.patch("/{greeting_id}", summary="Изменить фразу")
async def update_greeting(
    event_id: int,
    greeting_id: int,
    data: GreetingPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    updates = data.model_dump(exclude_unset=True)
    if "text" in updates:
        updates["text"] = (updates["text"] or "").strip()
        if not updates["text"]:
            raise HTTPException(status_code=400, detail="Фраза не может быть пустой")
    if not updates:
        raise HTTPException(status_code=400, detail="Нечего обновлять")
    set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
    row = await db.fetchrow(
        f"UPDATE event_chat_greetings SET {', '.join(set_parts)}, updated_at = now() "
        f"WHERE id = $1 AND event_id = $2 RETURNING id, text, sort",
        greeting_id, event_id, *updates.values(),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Фраза не найдена")
    return {"greeting": dict(row)}


@router.delete("/{greeting_id}", summary="Удалить фразу")
async def delete_greeting(
    event_id: int,
    greeting_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    await db.execute(
        "DELETE FROM event_chat_greetings WHERE id = $1 AND event_id = $2",
        greeting_id, event_id,
    )
    return {"ok": True}
