"""Диалоги внедренца — переписка с теми, кто написал в @pluson_bot (миграция 392).

⚠️⚠️ ЗДЕСЬ ЧИТАЮТСЯ ДИАЛОГИ СИСТЕМНОГО КАБИНЕТА, а не клиента. В @pluson_bot
пишут будущие клиенты и просто люди с вопросами: их сообщения попадают в базу
СЕРВИСНОГО кабинета, потому что этот бот принадлежит ему.

⚠️ Внедренец видит ТОЛЬКО назначенные ему разговоры. Отдать все и отфильтровать
на фронте нельзя: запрос повторяется мимо интерфейса.

⚠️ Отправка идёт ГОТОВОЙ функцией из `dialogs.py`, а не своей копией: там уже
разобраны четыре площадки, выбор токена и запись в ленту. Вторая копия
разошлась бы с первой на первой же правке.
"""

from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_tech
from app.database import get_db

router = APIRouter(prefix="/tech/dialogs", tags=["Внедренец: диалоги"])


class ReplyIn(BaseModel):
    platform: str
    text: str


async def _system_client_id(db) -> int:
    """Кабинет, которому принадлежит @pluson_bot."""
    cid = await db.fetchval(
        "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1")
    if not cid:
        raise HTTPException(404, "Системный кабинет не найден")
    return cid


async def _assert_mine(db, spec_id: int, client_id: int, contact_id: int) -> None:
    """Разговор назначен именно этому внедренцу — иначе 404.

    ⚠️ Именно 404, а не 403: по чужому id не должно быть видно даже того, что
    такой разговор существует.
    """
    ok = await db.fetchval(
        """SELECT 1 FROM dialog_assignments
            WHERE client_id = $1 AND contact_id = $2 AND spec_id = $3""",
        client_id, contact_id, spec_id,
    )
    if not ok:
        raise HTTPException(404, "Диалог не найден")


@router.get("", summary="Мои диалоги")
async def my_dialogs(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Назначенные мне разговоры с последним сообщением и счётчиком непрочитанных."""
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)

    rows = await db.fetch(
        """WITH last AS (
             SELECT DISTINCT ON (dm.contact_id)
                    dm.contact_id, dm.text, dm.media_kind, dm.direction, dm.sent_at
               FROM direct_messages dm
              WHERE dm.client_id = $1 AND dm.contact_id IS NOT NULL
              ORDER BY dm.contact_id, dm.sent_at DESC
           ), agg AS (
             SELECT dm.contact_id,
                    MAX(dm.sent_at) AS last_at,
                    array_agg(DISTINCT dm.platform) AS platforms,
                    COUNT(*) FILTER (WHERE dm.direction='in' AND NOT dm.is_read) AS unread
               FROM direct_messages dm
              WHERE dm.client_id = $1 AND dm.contact_id IS NOT NULL
              GROUP BY dm.contact_id
           )
           SELECT c.id AS contact_id, c.name, c.phone,
                  a.last_at, a.platforms, a.unread,
                  l.text AS last_text, l.media_kind AS last_media_kind,
                  l.direction AS last_direction,
                  da.assigned_at,
                  -- Клиент ли платформы этот человек: у внедренца в списке
                  -- вопрос от клиента и от постороннего выглядят одинаково, а
                  -- отвечать на них надо по-разному.
                  (SELECT cl.id FROM clients cl
                    WHERE LOWER(cl.email) = LOWER((
                      SELECT pe.platform_user_id FROM platform_users pe
                       WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                       ORDER BY pe.id LIMIT 1)) LIMIT 1) AS platform_client_id
             FROM dialog_assignments da
             JOIN contacts c ON c.id = da.contact_id
             JOIN agg a ON a.contact_id = c.id
             LEFT JOIN last l ON l.contact_id = c.id
            WHERE da.client_id = $1 AND da.spec_id = $2
            ORDER BY a.last_at DESC""",
        client_id, spec_id,
    )
    return {"dialogs": [dict(r) for r in rows]}


@router.get("/{contact_id}", summary="Лента переписки")
async def messages(
    contact_id: int,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    await _assert_mine(db, spec_id, client_id, contact_id)

    rows = await db.fetch(
        """SELECT id, platform, direction, author_kind, text, media_url,
                  media_kind, error, sent_at, is_deleted
             FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2
            ORDER BY sent_at""",
        client_id, contact_id,
    )
    # Помечаем прочитанным: человек открыл ленту и увидел сообщения.
    await db.execute(
        """UPDATE direct_messages SET is_read = TRUE
            WHERE client_id = $1 AND contact_id = $2
              AND direction = 'in' AND NOT is_read""",
        client_id, contact_id,
    )
    contact = await db.fetchrow(
        "SELECT id, name, phone FROM contacts WHERE id = $1", contact_id)
    return {"contact": dict(contact) if contact else None,
            "messages": [dict(r) for r in rows]}


@router.post("/{contact_id}/reply", summary="Ответить")
async def reply(
    contact_id: int,
    data: ReplyIn,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Ответ уходит через бот СИСТЕМНОГО кабинета — тот, в который человек писал.

    ⚠️ Переиспользуем готовую отправку из `dialogs.py`: там разобраны четыре
    площадки, выбор токена и запись в ленту. Своя копия разошлась бы с ней.
    """
    spec_id = int(user["sub"])
    client_id = await _system_client_id(db)
    await _assert_mine(db, spec_id, client_id, contact_id)

    from app.api.dialogs import ReplyBody, reply_to_contact

    # Готовая функция ждёт токен КЛИЕНТА (в `sub` — id кабинета). Подставляем
    # системный кабинет и помечаем, кто на самом деле пишет: без пометки в
    # логах не отличить ответ внедренца от ответа владельца.
    fake_client = {"sub": str(client_id), "role": "client",
                   "acting_tech_id": spec_id}
    return await reply_to_contact(
        contact_id=contact_id,
        body=ReplyBody(platform=data.platform, text=data.text),
        client=fake_client,
        db=db,
    )
