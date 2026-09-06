"""Вебинарная комната — клиентский API (дашборд организатора) + внутренний stream-хук.

Миграция 221. Комната на ДЕНЬ события (webinar_rooms по event_id+day_number).
Гейт: фича webinar_room. (Уровень «только ссылка» — webinar_link — удалён миграцией 354.)

Роутеры:
- router          — /api/v1/events/{event_id}/webinar/...  (клиент, JWT)
- internal_router — /api/v1/internal/webinar/stream/...    (хук MediaMTX, X-Bridge-Token)
"""
from __future__ import annotations

from typing import Optional, List
from datetime import datetime

import re
import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Header, Query
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.config import settings
from app.services.features import client_has_feature
from app.services import webinar_service as ws
# ⚠️ Имя человека склеиваем ТОЛЬКО этим хелпером: `name` — это ИМЯ, фамилия
# лежит отдельно (миграция 302). Здесь список для поиска глазами, поэтому
# порядок «Фамилия Имя» — правило проекта.
from app.services.person_name import SEARCH_NAME_SQL

router = APIRouter(prefix="/events/{event_id}/webinar", tags=["Вебинарная комната"])
internal_router = APIRouter(prefix="/internal/webinar", tags=["Вебинар — внутренний хук"])


# ─────────────────────────── гейт ───────────────────────────
async def _assert_webinar_feature(db, client_id: int, *, need_room: bool = True) -> str:
    """Возвращает 'room'. 403, если фичи `webinar_room` нет.

    ⚠️ Второго уровня 'link' («только ссылка на чужую комнату», фича
    `webinar_link`) больше нет — удалён миграцией 354. Он был привязан к тем же
    тарифам, что и `webinar_room`, а комната проверяется первой: ветка не
    срабатывала ни разу. Параметр `need_room` оставлен, чтобы не править
    десяток вызовов, но на решение он больше не влияет.
    """
    if await client_has_feature(db, client_id, "webinar_room"):
        return "room"
    raise HTTPException(
        status_code=403,
        detail="Вебинарная комната доступна на платном тарифе. "
               "Подключить его можно в разделе «Подписка».",
    )


def _cid(client) -> int:
    return int(client["sub"])


# ─────────────────────────── модели ───────────────────────────
class RoomUpsert(BaseModel):
    title: Optional[str] = None
    starts_at: Optional[datetime] = None
    stream_type: Optional[str] = None          # encoder | external_link | auto
    # автовебинар: крутим готовую запись как живой эфир
    auto_recording_id: Optional[int] = None
    auto_mode: Optional[str] = None            # schedule | on_signup
    auto_delay_min: Optional[int] = None
    auto_allow_seek: Optional[bool] = None
    external_url: Optional[str] = None
    hide_viewer_count: Optional[bool] = None
    chat_enabled: Optional[bool] = None
    premoderation: Optional[bool] = None
    redirect_url: Optional[str] = None
    reaction_up_label: Optional[str] = None
    reaction_down_label: Optional[str] = None
    show_down_reaction: Optional[bool] = None
    intro_text: Optional[str] = None
    buttons_per_row: Optional[int] = None      # сколько кнопок-офферов в ряд (1=столбик)
    # форма авторизации зрителя
    auth_mode: Optional[str] = None            # off | auto | always
    auth_require_name: Optional[bool] = None
    auth_require_email: Optional[bool] = None
    auth_require_phone: Optional[bool] = None
    auth_require_tg: Optional[bool] = None
    auth_intro_text: Optional[str] = None


class BlockIn(BaseModel):
    kind: str                                  # button | form | speaker_follow | gift | event_reg
    title: Optional[str] = None
    url: Optional[str] = None
    body: Optional[str] = None
    form_fields: Optional[list] = None
    form_tag: Optional[str] = None
    follow_mode: Optional[str] = None          # auto | fixed
    speaker_id: Optional[int] = None
    show_at_min: Optional[int] = None
    hide_at_min: Optional[int] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None
    reg_event_id: Optional[int] = None         # kind='event_reg': на какое событие регистрировать


class PollIn(BaseModel):
    question: str
    options: List[str] = []


class BattleIn(BaseModel):
    title: Optional[str] = None
    speaker_ids: List[int] = []                # event_collaborators.id
    reaction_up_label: Optional[str] = None
    reaction_down_label: Optional[str] = None
    show_down_reaction: Optional[bool] = None


# ─────────────────────────── список комнат по дням ───────────────────────────
@router.get("", summary="Список дней события с их вебинарными комнатами")
async def list_rooms(event_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    level = await _assert_webinar_feature(db, cid, need_room=False)

    # дни программы события (conf_days). Если их нет — событие без программы,
    # комнат по дням тоже нет (фича для событий со слотами).
    # Только дни с галочкой «Имеет эфир/вебинар» (has_webinar). NULL/старые = TRUE.
    days = await db.fetch(
        "SELECT day_number, day_date, title FROM conf_days "
        "WHERE event_id=$1 AND COALESCE(has_webinar, TRUE)=TRUE ORDER BY day_number", event_id,
    )
    rooms = await db.fetch("SELECT * FROM webinar_rooms WHERE event_id=$1", event_id)
    rooms_by_day = {r["day_number"]: dict(r) for r in rooms}

    # Дата события — запасной источник для дней без своей даты (см. ниже).
    start_at = await db.fetchval("SELECT start_at FROM events WHERE id=$1", event_id)

    # Событие БЕЗ программы (обычное мероприятие, коллаба) — эфир у него один.
    # Отдаём виртуальный «день 1», иначе вкладка «Вебинарные комнаты» пустая и
    # создать комнату неоткуда. Дата — старт самого события.
    if not days:
        days = [{
            "day_number": 1,
            "day_date": start_at.date() if start_at else None,
            "title": None,
        }]
    else:
        # ⚠️ День программы МОЖЕТ БЫТЬ БЕЗ ДАТЫ: у коллабы и у мероприятия дни
        # часто заводят «пустыми», а дату ставят у самого события. Раньше
        # подстановка работала только когда дней нет ВОВСЕ — и у события с
        # пустым днём вебинарная комната показывалась без даты, а человек не
        # понимал, когда эфир (прод, 2026-08-18).
        days = [
            {**dict(d), "day_date": d["day_date"] or (start_at.date() if start_at else None)}
            for d in days
        ]

    out = []
    for d in days:
        dn = d["day_number"]
        room = rooms_by_day.get(dn)
        item = {
            "day_number": dn,
            "day_date": d["day_date"].isoformat() if d["day_date"] else None,
            "day_title": d["title"],
            "room": _room_public(room) if room else None,
        }
        out.append(item)
    return {"level": level, "days": out}


@router.get("/upcoming-events", summary="Предстоящие события клиента (для блока «Регистрация на событие»)")
async def upcoming_events(event_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    """Список НЕ прошедших опубликованных событий владельца этого события —
    для селектора в продающем блоке `event_reg`. Дата: конференция/турнир →
    MAX(conf_days.day_date+close_time), иначе events.end_at/start_at. Прошедшие
    (дата < сейчас МСК) отсекаются. Текущее событие вебинара тоже показываем
    (можно регать на этот же ивент). Сортировка — по ближайшей дате."""
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    rows = await db.fetch(
        """
        WITH ev AS (
          SELECT e.id, e.title, e.slug, e.module_slug, e.status, e.start_at, e.end_at,
                 (SELECT MAX((cd.day_date::timestamp + COALESCE(NULLIF(cd.close_time,''),'23:59')::time))
                    FROM conf_days cd WHERE cd.event_id = e.id) AS conf_end,
                 (SELECT MIN((cd.day_date::timestamp + COALESCE(NULLIF(cd.open_time,''),'00:00')::time))
                    FROM conf_days cd WHERE cd.event_id = e.id) AS conf_start
            FROM events e
            JOIN event_owners eo ON eo.event_id = e.id AND eo.status='accepted' AND eo.client_id = $1
           WHERE e.status IN ('published','ended')
        )
        SELECT id, title, slug, module_slug, status,
               COALESCE(conf_start, start_at) AS starts_at,
               COALESCE(conf_end, end_at, start_at) AS ends_at
          FROM ev
         WHERE COALESCE(conf_end, end_at, start_at) IS NULL
            OR COALESCE(conf_end, end_at, start_at) >= (NOW() AT TIME ZONE 'Europe/Moscow')
         ORDER BY COALESCE(conf_start, start_at) NULLS LAST, id
        """,
        cid,
    )
    return {"events": [
        {"id": r["id"], "title": r["title"], "slug": r["slug"],
         "module_slug": r["module_slug"],
         "starts_at": r["starts_at"].isoformat() if r["starts_at"] else None}
        for r in rows
    ]}


def _room_public(room: Optional[dict]) -> Optional[dict]:
    if not room:
        return None
    r = dict(room)
    key = r.get("stream_key")
    return {
        "id": r["id"],
        "title": r.get("title"),
        "starts_at": r["starts_at"].isoformat() if r.get("starts_at") else None,
        "stream_type": r.get("stream_type"),
        "auto_recording_id": r.get("auto_recording_id"),
        "auto_mode": r.get("auto_mode"),
        "auto_delay_min": r.get("auto_delay_min"),
        "auto_allow_seek": r.get("auto_allow_seek"),
        "stream_key": key,
        "rtmp_url": ws.rtmp_url(key) if key else None,
        "hls_url": ws.hls_url(key) if key else None,
        "external_url": r.get("external_url"),
        "status": r.get("status"),
        "stream_active": r.get("stream_active"),
        "hide_viewer_count": r.get("hide_viewer_count"),
        "chat_enabled": r.get("chat_enabled"),
        "premoderation": r.get("premoderation"),
        "redirect_url": r.get("redirect_url"),
        "reaction_up_label": r.get("reaction_up_label"),
        "reaction_down_label": r.get("reaction_down_label"),
        "show_down_reaction": r.get("show_down_reaction"),
        "intro_text": r.get("intro_text"),
        "buttons_per_row": r.get("buttons_per_row") or 1,
        "auth_mode": r.get("auth_mode") or "auto",
        "auth_require_name": r.get("auth_require_name"),
        "auth_require_email": r.get("auth_require_email"),
        "auth_require_phone": r.get("auth_require_phone"),
        "auth_require_tg": r.get("auth_require_tg"),
        "auth_intro_text": r.get("auth_intro_text"),
        "room_state": r.get("room_state") or "created",
        "opens_at": r["opens_at"].isoformat() if r.get("opens_at") else None,
        "speaker_mode": r.get("speaker_mode") or "auto",
        "manual_speaker_ec_id": r.get("manual_speaker_ec_id"),
        "updated_at": r["updated_at"].isoformat() if r.get("updated_at") else None,
    }


# ─────────────────────────── создать/обновить комнату дня ───────────────────────────
@router.put("/{day_number}", summary="Создать/обновить комнату дня")
async def upsert_room(
    event_id: int, day_number: int, data: RoomUpsert,
    client=Depends(get_current_client), db=Depends(get_db),
):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    level = await _assert_webinar_feature(db, cid, need_room=False)

    # На Профи (level='link') можно только external_link.
    stream_type = data.stream_type or ("encoder" if level == "room" else "external_link")
    if level == "link" and stream_type in ("encoder", "auto"):
        raise HTTPException(status_code=403, detail="Своя комната (видеокодер) — только на тарифе Экстра.")

    # ⚠️ Автовебинар — ОТДЕЛЬНАЯ фича `autowebinar` (только Экстра), а не часть
    # `webinar_room`: обычная комната есть и на Профи, а автовебинар нет.
    if stream_type == "auto" and not await client_has_feature(db, cid, "autowebinar"):
        raise HTTPException(
            status_code=403,
            detail="Автовебинары доступны на тарифе Экстра.")

    existing = await db.fetchrow(
        "SELECT * FROM webinar_rooms WHERE event_id=$1 AND day_number=$2", event_id, day_number)

    fields = data.model_dump(exclude_unset=True)
    fields.pop("stream_type", None)  # тип трансляции обработан отдельно

    if existing:
        sets, args = [], []
        i = 1
        for k, v in fields.items():
            sets.append(f"{k}=${i}"); args.append(v); i += 1
        sets.append(f"stream_type=${i}"); args.append(stream_type); i += 1
        sets.append("updated_at=NOW()")
        args += [event_id, day_number]
        await db.execute(
            f"UPDATE webinar_rooms SET {', '.join(sets)} WHERE event_id=${i} AND day_number=${i+1}",
            *args,
        )
    else:
        stream_key = ws.make_stream_key() if stream_type == "encoder" else None
        hls = ws.hls_url(stream_key) if stream_key else None
        await db.execute(
            "INSERT INTO webinar_rooms (event_id, day_number, title, starts_at, stream_type, "
            " stream_key, hls_url, external_url, hide_viewer_count, chat_enabled, premoderation, "
            " redirect_url, reaction_up_label, reaction_down_label, show_down_reaction, intro_text, "
            " buttons_per_row, auth_mode, auth_require_name, auth_require_email, auth_require_phone, "
            " auth_require_tg, auth_intro_text) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,"
            " COALESCE($9,FALSE), COALESCE($10,TRUE), COALESCE($11,FALSE),"
            " $12, COALESCE($13,'Огонь'), COALESCE($14,'Слабо'), COALESCE($15,TRUE), $16,"
            " COALESCE($17,1), COALESCE($18,'auto'), COALESCE($19,TRUE), COALESCE($20,FALSE),"
            " COALESCE($21,FALSE), COALESCE($22,FALSE), $23)",
            event_id, day_number, fields.get("title"), fields.get("starts_at"), stream_type,
            stream_key, hls, fields.get("external_url"), fields.get("hide_viewer_count"),
            fields.get("chat_enabled"), fields.get("premoderation"), fields.get("redirect_url"),
            fields.get("reaction_up_label"), fields.get("reaction_down_label"),
            fields.get("show_down_reaction"), fields.get("intro_text"),
            fields.get("buttons_per_row"), fields.get("auth_mode"), fields.get("auth_require_name"),
            fields.get("auth_require_email"), fields.get("auth_require_phone"),
            fields.get("auth_require_tg"), fields.get("auth_intro_text"),
        )
    room = await db.fetchrow(
        "SELECT * FROM webinar_rooms WHERE event_id=$1 AND day_number=$2", event_id, day_number)
    return {"room": _room_public(dict(room))}


@router.post("/{day_number}/regenerate-key", summary="Перегенерировать ключ потока")
async def regen_key(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_webinar_feature(db, cid, need_room=True)
    key = ws.make_stream_key()
    await db.execute(
        "UPDATE webinar_rooms SET stream_key=$1, hls_url=$2, updated_at=NOW() "
        "WHERE event_id=$3 AND day_number=$4",
        key, ws.hls_url(key), event_id, day_number,
    )
    return {"stream_key": key, "rtmp_url": ws.rtmp_url(key), "hls_url": ws.hls_url(key)}


@router.delete("/{day_number}", summary="Удалить комнату дня")
async def delete_room(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await db.execute("DELETE FROM webinar_rooms WHERE event_id=$1 AND day_number=$2", event_id, day_number)
    return {"ok": True}


# ─────────────────────────── продающие блоки ───────────────────────────
async def _room_id(db, event_id: int, day_number: int) -> int:
    r = await ws.get_room_or_404(db, event_id, day_number)
    return r["id"]


@router.get("/{day_number}/blocks", summary="Блоки комнаты дня")
async def list_blocks(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch("SELECT * FROM webinar_blocks WHERE room_id=$1 ORDER BY sort_order, id", rid)
    return {"blocks": [dict(r) for r in rows]}


@router.post("/{day_number}/blocks", summary="Создать блок")
async def create_block(event_id: int, day_number: int, data: BlockIn, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    import json
    row = await db.fetchrow(
        "INSERT INTO webinar_blocks (room_id, kind, title, url, body, form_fields, form_tag, "
        " follow_mode, speaker_id, show_at_min, hide_at_min, sort_order, is_active, reg_event_id) "
        "VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,COALESCE($12,0),COALESCE($13,TRUE),$14) RETURNING *",
        rid, data.kind, data.title, data.url, data.body,
        json.dumps(data.form_fields or []), data.form_tag, data.follow_mode, data.speaker_id,
        data.show_at_min, data.hide_at_min, data.sort_order, data.is_active, data.reg_event_id,
    )
    return {"block": dict(row)}


@router.patch("/{day_number}/blocks/{block_id}", summary="Обновить блок")
async def update_block(event_id: int, day_number: int, block_id: int, data: BlockIn, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    import json
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(400, "Нет полей для обновления")
    sets, args, i = [], [], 1
    for k, v in fields.items():
        if k == "form_fields":
            sets.append(f"form_fields=${i}::jsonb"); args.append(json.dumps(v or []))
        else:
            sets.append(f"{k}=${i}"); args.append(v)
        i += 1
    sets.append("updated_at=NOW()")
    args += [block_id, rid]
    await db.execute(
        f"UPDATE webinar_blocks SET {', '.join(sets)} WHERE id=${i} AND room_id=${i+1}", *args)
    row = await db.fetchrow("SELECT * FROM webinar_blocks WHERE id=$1", block_id)
    return {"block": dict(row) if row else None}


@router.delete("/{day_number}/blocks/{block_id}", summary="Удалить блок")
async def delete_block(event_id: int, day_number: int, block_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    await db.execute("DELETE FROM webinar_blocks WHERE id=$1 AND room_id=$2", block_id, rid)
    return {"ok": True}


@router.post("/{day_number}/blocks/{block_id}/pin", summary="Показать/скрыть блок в эфире (пульт)")
async def pin_block(event_id: int, day_number: int, block_id: int, pinned: bool = Query(True), client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    await db.execute("UPDATE webinar_blocks SET is_pinned=$1 WHERE id=$2 AND room_id=$3", pinned, block_id, rid)
    from app.services.webinar_hub import publish
    await publish(rid, {"type": "block_pin", "block_id": block_id, "pinned": pinned})
    return {"ok": True}


# ─────────────────────────── модерация чата / участников ───────────────────────────
@router.post("/{day_number}/chat/{msg_id}/moderate", summary="Скрыть/показать сообщение")
async def moderate_msg(event_id: int, day_number: int, msg_id: int, status: str = Query(...), client=Depends(get_current_client), db=Depends(get_db)):
    if status not in ("visible", "hidden"):
        raise HTTPException(400, "status: visible|hidden")
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    await db.execute("UPDATE webinar_chat_messages SET status=$1 WHERE id=$2 AND room_id=$3", status, msg_id, rid)
    from app.services.webinar_hub import publish
    await publish(rid, {"type": "chat_moderate", "msg_id": msg_id, "status": status})
    return {"ok": True}


@router.post("/{day_number}/participant/remove", summary="Удалить/забанить участника из эфира и чата")
async def remove_participant(
    event_id: int, day_number: int,
    contact_id: Optional[int] = Query(None), session_key: Optional[str] = Query(None),
    client=Depends(get_current_client), db=Depends(get_db),
):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    if not contact_id and not session_key:
        raise HTTPException(400, "Нужен contact_id или session_key")
    await db.execute(
        "INSERT INTO webinar_banned (room_id, contact_id, session_key) VALUES ($1,$2,$3)",
        rid, contact_id, session_key,
    )
    # скрываем все его сообщения
    if contact_id:
        await db.execute("UPDATE webinar_chat_messages SET status='hidden' WHERE room_id=$1 AND contact_id=$2", rid, contact_id)
    from app.services.webinar_hub import publish
    await publish(rid, {"type": "participant_removed", "contact_id": contact_id, "session_key": session_key})
    return {"ok": True}


# ─────────────────────────── опросы (пульт) ───────────────────────────
@router.post("/{day_number}/poll", summary="Создать и запустить опрос")
async def create_poll(event_id: int, day_number: int, data: PollIn, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    async with db.transaction():
        poll = await db.fetchrow(
            "INSERT INTO webinar_polls (room_id, question, status) VALUES ($1,$2,'open') RETURNING *", rid, data.question)
        opts = []
        for idx, txt in enumerate(data.options):
            o = await db.fetchrow(
                "INSERT INTO webinar_poll_options (poll_id, text, sort_order) VALUES ($1,$2,$3) RETURNING *",
                poll["id"], txt, idx)
            opts.append(dict(o))
    payload = {"type": "poll_open", "poll": {**dict(poll), "options": opts}}
    from app.services.webinar_hub import publish
    await publish(rid, payload)
    return {"poll": {**dict(poll), "options": opts}}


@router.post("/{day_number}/poll/{poll_id}/close", summary="Закрыть опрос")
async def close_poll(event_id: int, day_number: int, poll_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    await db.execute("UPDATE webinar_polls SET status='closed' WHERE id=$1 AND room_id=$2", poll_id, rid)
    from app.services.webinar_hub import publish
    await publish(rid, {"type": "poll_close", "poll_id": poll_id})
    return {"ok": True}


# ─────────────────────────── батлы (пульт) ───────────────────────────
@router.post("/{day_number}/battle", summary="Создать/запустить батл (выбор спикеров из события)")
async def create_battle(event_id: int, day_number: int, data: BattleIn, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    # Батлы — только в Премиях/Турнирах (module_slug='turnir').
    mod = await db.fetchval("SELECT module_slug FROM events WHERE id=$1", event_id)
    if mod != "turnir":
        raise HTTPException(403, "Батлы доступны только в Премиях и Турнирах")
    rid = await _room_id(db, event_id, day_number)
    async with db.transaction():
        b = await db.fetchrow(
            "INSERT INTO webinar_battles (room_id, title, status, reaction_up_label, reaction_down_label, show_down_reaction) "
            "VALUES ($1,$2,'live',COALESCE($3,'Огонь'),COALESCE($4,'Слабо'),COALESCE($5,TRUE)) RETURNING *",
            rid, data.title, data.reaction_up_label, data.reaction_down_label, data.show_down_reaction)
        players = []
        for idx, ec_id in enumerate(data.speaker_ids):
            nm = await db.fetchrow(
                "SELECT c.name FROM event_collaborators ec JOIN collaborators c ON c.id=ec.speaker_id WHERE ec.id=$1 AND ec.event_id=$2",
                ec_id, event_id)
            p = await db.fetchrow(
                "INSERT INTO webinar_battle_players (battle_id, speaker_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING *",
                b["id"], ec_id, (nm["name"] if nm else None), idx)
            players.append(dict(p))
    payload = {"type": "battle_start", "battle": {**dict(b), "players": players}}
    from app.services.webinar_hub import publish
    await publish(rid, payload)
    return {"battle": {**dict(b), "players": players}}


@router.post("/{day_number}/battle/{battle_id}/end", summary="Завершить батл")
async def end_battle(event_id: int, day_number: int, battle_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    await db.execute("UPDATE webinar_battles SET status='ended' WHERE id=$1 AND room_id=$2", battle_id, rid)
    from app.services.webinar_hub import publish
    await publish(rid, {"type": "battle_end", "battle_id": battle_id})
    return {"ok": True}


# ─────────────────────────── аналитика ───────────────────────────
@router.get("/{day_number}/sessions", summary="Список запусков эфира (сессий)")
async def sessions(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    from app.services.webinar_analytics import list_sessions
    return await list_sessions(db, rid)


@router.get("/{day_number}/analytics", summary="Аналитика присутствия и активности")
async def analytics(
    event_id: int, day_number: int, step: int = Query(5, ge=1, le=60),
    session_id: Optional[int] = Query(None),
    client=Depends(get_current_client), db=Depends(get_db),
):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    from app.services.webinar_analytics import compute_analytics
    return await compute_analytics(db, rid, step, session_id=session_id)


@router.get("/{day_number}/viewers", summary="Активность по каждому зрителю (геймификация)")
async def viewers(event_id: int, day_number: int, session_id: Optional[int] = Query(None),
                  client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    from app.services.webinar_analytics import viewer_activity
    return await viewer_activity(db, rid, session_id=session_id)


# ─────────────────────────── записи эфира ───────────────────────────
@router.get("/{day_number}/recordings", summary="Записи эфира комнаты")
async def recordings(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    # ⚠️ live_offset_sec — на какой секунде файла нажали «Начать эфир». Нужен
    # редактору нарезки: до него в записи лежит проверка звука, и без этого
    # числа автораскладка меток по программе уехала бы на всю подготовку.
    # NULL = посчитать не удалось (старая запись) → метки только руками.
    rows = await db.fetch(
        "SELECT id, session_id, url, status, duration_sec, size_bytes, started_at, ended_at, "
        "       created_at, live_offset_sec, "
        "       (SELECT count(*) FROM webinar_recording_cuts c WHERE c.recording_id = r.id) AS cuts_count "
        "FROM webinar_recordings r WHERE room_id=$1 ORDER BY created_at DESC", rid)
    return {"recordings": [dict(r) for r in rows]}


@router.get("/{day_number}/sessions/{session_id}/chat", summary="История чата запуска (для записи)")
async def session_chat(event_id: int, day_number: int, session_id: int,
                       client=Depends(get_current_client), db=Depends(get_db)):
    """Полная история чата конкретного запуска эфира — показывается рядом с его записью."""
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    # ⚠️ offset_sec — секунда ЗАПИСИ, на которой написано сообщение. Считаем от
    # started_at сессии: без него чат к записи не привязать, и перемотка по
    # клику на реплику невозможна.
    rows = await db.fetch(
        "SELECT m.id, m.contact_id, m.author_name, m.text, m.at, m.status, "
        "       GREATEST(0, EXTRACT(EPOCH FROM (m.at - s.started_at))::int) AS offset_sec "
        "  FROM webinar_chat_messages m "
        "  JOIN webinar_sessions s ON s.id = m.session_id "
        " WHERE m.room_id=$1 AND m.session_id=$2 "
        " ORDER BY m.at", rid, session_id)
    return {"messages": [dict(r) for r in rows]}


# ─────────────────────────── нарезка записи по спикерам ───────────────────────────
# ⚠️ Эфир пишется одним файлом: сначала настройка звука до «Начать эфир», потом
# открытие, потом выступления подряд. Целиком это никому не отдать — спикеру
# нужно СВОЁ выступление. Клиент расставляет границы (по программе дня одной
# кнопкой) и жмёт «Нарезать».
#
# ⚠️ Одна палочка = одна граница: кусок начинается там, где кончился предыдущий,
# перерывы не вырезаются (решение владельца). Поэтому конец куска НЕ хранится
# отдельно, а берётся из начала следующего.

class CutIn(BaseModel):
    id: Optional[int] = None          # существующий кусок — иначе создаём
    start_sec: int
    title: str
    speaker_ec_id: Optional[int] = None
    session_id: Optional[int] = None


class CutsSave(BaseModel):
    cuts: List[CutIn]


async def _recording_or_404(db, event_id: int, day_number: int, recording_id: int) -> dict:
    """Запись этой комнаты. ⚠️ Проверяем принадлежность КОМНАТЕ, а не только id:
    иначе по чужому номеру можно было бы читать и резать чужие эфиры."""
    rid = await _room_id(db, event_id, day_number)
    row = await db.fetchrow(
        "SELECT id, room_id, status, duration_sec, live_offset_sec, url "
        "  FROM webinar_recordings WHERE id=$1 AND room_id=$2", recording_id, rid)
    if not row:
        raise HTTPException(404, "Запись не найдена")
    return dict(row)


def _hhmm_to_sec(v: Optional[str]) -> Optional[int]:
    """"HH:MM" → секунды от полуночи. Время программы хранится строкой (см. правило
    «Время программы — строки HH:MM»), поэтому разбираем вручную."""
    if not v or not isinstance(v, str):
        return None
    m = re.match(r"^([01]\d|2[0-3]):([0-5]\d)", v.strip())
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60


async def _cuts_payload(db, rec: dict, recording_id: int) -> dict:
    """Ответ со списком кусков. ⚠️ Отдельной функцией, а не вызовом эндпоинта:
    у эндпоинта параметры через Depends, и звать его как обычную функцию —
    ловушка (добавили параметр — сломалось молча)."""
    # ⚠️ program_time берём ЧЕРЕЗ session_id из самой программы, а не копией в
    # метке: поправили тайминг в расписании — подпись обновилась. Копия
    # разъехалась бы с программой и врала бы при сверке.
    rows = await db.fetch(
        "SELECT c.id, c.start_sec, c.end_sec, c.title, c.speaker_ec_id, c.session_id, "
        "       c.sort_order, c.status, c.url, c.duration_sec, c.size_bytes, c.error, "
        "       " + SEARCH_NAME_SQL("cl") + " AS speaker_name, LEFT(cs.start_time, 5) AS program_time "
        "  FROM webinar_recording_cuts c "
        "  LEFT JOIN event_collaborators ec ON ec.id = c.speaker_ec_id "
        "  LEFT JOIN collaborators cl ON cl.id = ec.speaker_id "
        "  LEFT JOIN conf_sessions cs ON cs.id = c.session_id "
        " WHERE c.recording_id=$1 ORDER BY c.sort_order, c.start_sec", recording_id)
    # ⚠️ У меток, разложенных до 06.09.2026, имя было ВКЛЕЕНО в название
    # («Светлана — Выставка…»). Теперь имя отдаётся отдельным полем, и без этой
    # чистки оно задвоилось бы в строке. Режем только точное совпадение начала —
    # тему, которая случайно начинается так же, не тронем.
    # ⚠️ Сверяем и по ПОЛНОМУ имени, и по каждому слову отдельно: старые метки
    # склеивались с одним лишь именем («Светлана — …»), а speaker_name теперь
    # «Фамилия Имя». По полному совпадению такая строка не нашлась бы.
    cuts = []
    for r in rows:
        d = dict(r)
        nm, t = (d.get("speaker_name") or "").strip(), (d.get("title") or "")
        if nm:
            for variant in [nm, *nm.split()]:
                if t.startswith(f"{variant} — "):
                    d["title"] = t[len(variant) + 3:]
                    break
        cuts.append(d)
    return {
        "recording": {
            "id": rec["id"], "url": rec["url"], "status": rec["status"],
            "duration_sec": rec["duration_sec"],
            "live_offset_sec": rec["live_offset_sec"],
        },
        "cuts": cuts,
    }


@router.get("/{day_number}/recordings/{recording_id}/cuts", summary="Куски записи")
async def list_cuts(event_id: int, day_number: int, recording_id: int,
                    client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rec = await _recording_or_404(db, event_id, day_number, recording_id)
    return await _cuts_payload(db, rec, recording_id)


@router.get("/{day_number}/recordings/{recording_id}/program-marks",
            summary="Раскладка меток по программе дня (черновик, не сохраняет)")
async def program_marks(event_id: int, day_number: int, recording_id: int,
                        shift_sec: int = Query(0, description="сдвинуть всё на N секунд"),
                        anchor_sec: Optional[int] = Query(
                            None, description="секунда записи, где начинается anchor_time"),
                        anchor_time: Optional[str] = Query(
                            None, description='время программы "HH:MM" в этой секунде'),
                        client=Depends(get_current_client), db=Depends(get_db)):
    """Что предложить клиенту, если он нажмёт «Расставить по программе дня».

    ⚠️ Ничего не сохраняет — только считает. Клиент сначала смотрит, поправляет
    и лишь потом сохраняет: молча переписать уже расставленные метки нельзя.

    Арифметика: секунда записи = (время слота) − (время нуля записи).

    ⚠️ ДВА способа узнать «время нуля», и второй обязателен. Обычно это
    `webinar_sessions.started_at` — момент нажатия «Начать эфир». Но у записей,
    сделанных до появления учёта смещения, его сопоставить не с чем: сегменты
    удалены, и на какой секунде файла этот момент — неизвестно.

    Тогда точку задаёт человек: он видит на видео, где началось нужное место
    (`anchor_sec`), и говорит, какое это время по программе (`anchor_time`).
    Дальше раскладка считается ТОЧНО ТАК ЖЕ. Без этого раскладка была бы
    недоступна навсегда — а данных для неё хватает, не хватало только точки
    отсчёта, которую человек прекрасно видит глазами.
    """
    await ws.assert_event_owner(db, event_id, _cid(client))
    rec = await _recording_or_404(db, event_id, day_number, recording_id)

    manual_anchor = _hhmm_to_sec(anchor_time) if anchor_time else None
    if manual_anchor is None:
        # ⚠️ Время старта эфира берём из СЕССИИ этой записи, а не «последней» —
        # эфир за день могли запускать несколько раз, и у каждого запуска своё
        # начало. Взять чужое значило бы сдвинуть всю раскладку.
        started = await db.fetchval(
            "SELECT s.started_at FROM webinar_sessions s "
            "  JOIN webinar_recordings r ON r.session_id = s.id WHERE r.id=$1", recording_id)
        if not started:
            raise HTTPException(
                400, "У записи нет времени начала эфира — покажите на видео любой момент "
                     "и укажите, какое это время по программе")
    else:
        started = None

    day = await db.fetchrow(
        "SELECT day_date FROM conf_days WHERE event_id=$1 AND day_number=$2", event_id, day_number)
    if not day or not day["day_date"]:
        raise HTTPException(400, "У этого дня нет даты в программе — расставьте метки вручную")

    rows = await db.fetch(
        "SELECT s.id, s.start_time, s.title, s.speaker_id, "
        "       COALESCE(cst.topic, s.title) AS topic, " + SEARCH_NAME_SQL("cl") + " AS speaker_name "
        "  FROM conf_sessions s "
        "  LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id "
        "  LEFT JOIN event_collaborators ec ON ec.id = s.speaker_id "
        "  LEFT JOIN collaborators cl ON cl.id = ec.speaker_id "
        " WHERE s.event_id=$1 AND s.day=$2 AND s.start_time IS NOT NULL "
        " ORDER BY s.start_time, s.sort_order", event_id, day_number)
    if not rows:
        raise HTTPException(400, "В программе этого дня нет слотов со временем")

    # Какому времени программы соответствует НУЛЕВАЯ секунда записи (в секундах
    # от полуночи МСК). Дальше вычитание одинаково для обоих способов.
    if manual_anchor is not None:
        # Человек показал: «в секунде anchor_sec записи идёт anchor_time по
        # программе». Значит ноль записи — это anchor_time минус эта секунда.
        start_of_day_sec = manual_anchor - int(anchor_sec or 0)
    else:
        from app.services.webinar_service import MSK
        started_msk = started.astimezone(MSK)
        start_of_day_sec = started_msk.hour * 3600 + started_msk.minute * 60 + started_msk.second

    marks = []
    for r in rows:
        slot_sec = _hhmm_to_sec(r["start_time"])
        if slot_sec is None:
            continue
        # ⚠️ Слот раньше нуля прижимаем к нулю, а не выбрасываем: открытие часто
        # объявляют уже после нажатия «Начать эфир», и потерять первый кусок
        # значило бы потерять начало записи.
        sec = max(0, slot_sec - start_of_day_sec + int(shift_sec or 0))
        # ⚠️ Отсекаем по длительности ЭФИРА, а не файла: у автоматического
        # способа первые live_offset_sec секунд файла — это подготовка до «Начать
        # эфир», и метки отсчитываются уже от её конца. При ручной точке
        # смещение неизвестно и равно нулю — там эфир и файл совпадают.
        live_len = int(rec["duration_sec"] or 0) - int(rec["live_offset_sec"] or 0)
        if live_len > 0 and sec >= live_len:
            continue          # слот за пределами записи — эфир кончился раньше
        topic = (r["topic"] or r["title"] or "").strip() or "Без названия"
        # ⚠️ Имя и тему НЕ склеиваем: на полосе нужна только фамилия с именем
        # (тему там всё равно не прочесть — колонка узкая), а в списке снизу —
        # и то и другое. Склеенная строка не даёт показать их по-разному.
        marks.append({
            "start_sec": sec,
            "title": topic[:200],
            "speaker_name": r["speaker_name"],
            "speaker_ec_id": r["speaker_id"],
            "session_id": r["id"],
            # ⚠️ Время слота по расписанию — показываем рядом с меткой. Человек
            # держит в голове программу («Светлана в 11:00»), а не минуты видео,
            # и без этой подписи не может сверить, туда ли встала метка.
            "program_time": (r["start_time"] or "")[:5],
        })
    # ⚠️ Дедуп по секунде: два слота в одну минуту (параллельные залы) дали бы
    # кусок нулевой длины, а ffmpeg на нём падает.
    seen, out = set(), []
    for m in sorted(marks, key=lambda x: x["start_sec"]):
        if m["start_sec"] in seen:
            continue
        seen.add(m["start_sec"])
        out.append(m)
    return {"marks": out}


@router.put("/{day_number}/recordings/{recording_id}/cuts", summary="Сохранить метки")
async def save_cuts(event_id: int, day_number: int, recording_id: int, data: CutsSave,
                    client=Depends(get_current_client), db=Depends(get_db)):
    """Полная замена набора меток.

    ⚠️ Конец куска НЕ приходит от клиента — он считается из начала следующего
    (одна палочка = одна граница). Так граница физически не может разъехаться
    между двумя соседними кусками.

    ⚠️ Уже нарезанные куски (status='ready') не трогаем: их файлы могли уже
    уйти спикерам. Меняются только черновики.
    """
    await ws.assert_event_owner(db, event_id, _cid(client))
    rec = await _recording_or_404(db, event_id, day_number, recording_id)

    # ⚠️ Дедуп по секунде: две метки в одну секунду дали бы кусок нулевой длины
    # (ffmpeg на нём падает) и наложение соседей друг на друга.
    items, _seen = [], set()
    for c in sorted([c for c in data.cuts if c.start_sec is not None and c.start_sec >= 0],
                    key=lambda c: c.start_sec):
        s = int(c.start_sec)
        if s in _seen:
            continue
        _seen.add(s)
        items.append(c)

    # ⚠️ Границы считаем по ВСЕМ меткам записи, включая уже нарезанные: конец
    # черновика может упираться в готовый кусок. Считать только по черновикам —
    # значит наложить один кусок на другой и выдать спикеру чужое выступление.
    ready = await db.fetch(
        "SELECT start_sec FROM webinar_recording_cuts "
        " WHERE recording_id=$1 AND status='ready'", recording_id)
    ready_starts = {int(r["start_sec"]) for r in ready}
    # Метка ровно на нарезанном куске — это он же, второй раз его не заводим.
    items = [c for c in items if int(c.start_sec) not in ready_starts]
    boundaries = sorted(ready_starts | {int(c.start_sec) for c in items})

    def _next_after(sec: int) -> Optional[int]:
        for b in boundaries:
            if b > sec:
                return b
        return None

    async with db.transaction():
        await db.execute(
            "DELETE FROM webinar_recording_cuts WHERE recording_id=$1 AND status <> 'ready'",
            recording_id)
        for i, c in enumerate(items):
            start = int(c.start_sec)
            nxt = _next_after(start)
            await db.execute(
                "INSERT INTO webinar_recording_cuts "
                " (recording_id, start_sec, end_sec, title, speaker_ec_id, session_id, sort_order) "
                " VALUES ($1,$2,$3,$4,$5,$6,$7)",
                recording_id, start, nxt,
                (c.title or "Без названия").strip()[:200] or "Без названия",
                c.speaker_ec_id, c.session_id, i * 10)
    return await _cuts_payload(db, rec, recording_id)


@router.post("/{day_number}/recordings/{recording_id}/cut", summary="Нарезать")
async def run_cut(event_id: int, day_number: int, recording_id: int,
                  client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_webinar_feature(db, cid, need_room=True)
    rec = await _recording_or_404(db, event_id, day_number, recording_id)
    if rec["status"] != "ready":
        raise HTTPException(400, "Запись ещё обрабатывается — подождите")
    pending = await db.fetchval(
        "SELECT count(*) FROM webinar_recording_cuts "
        " WHERE recording_id=$1 AND status IN ('draft','failed')", recording_id)
    if not pending:
        raise HTTPException(400, "Нечего резать — сначала расставьте метки")
    from app.tasks.webinar_cut import cut_recording
    cut_recording.delay(recording_id)
    return {"ok": True, "queued": pending}


@router.delete("/{day_number}/recordings/{recording_id}/cuts/{cut_id}", summary="Удалить кусок")
async def delete_cut(event_id: int, day_number: int, recording_id: int, cut_id: int,
                     client=Depends(get_current_client), db=Depends(get_db)):
    """⚠️ Удаляем и файл в хранилище — иначе он остаётся невидимым мусором и
    висит в квоте клиента."""
    await ws.assert_event_owner(db, event_id, _cid(client))
    await _recording_or_404(db, event_id, day_number, recording_id)
    row = await db.fetchrow(
        "SELECT r2_key FROM webinar_recording_cuts WHERE id=$1 AND recording_id=$2",
        cut_id, recording_id)
    if not row:
        raise HTTPException(404, "Кусок не найден")
    if row["r2_key"]:
        try:
            from app.services import r2_storage
            await r2_storage.delete_object(row["r2_key"])
            await db.execute("DELETE FROM client_files WHERE r2_key=$1", row["r2_key"])
        except Exception:
            pass          # файл мог быть уже удалён — строку всё равно снимаем
    await db.execute("DELETE FROM webinar_recording_cuts WHERE id=$1", cut_id)
    return {"ok": True}


# ─────────────────────────── автовебинар ───────────────────────────
# ⚠️ Отдельной сущности «автовебинар» нет — это та же комната со
# stream_type='auto'. Чат, продающие блоки с таймингом, опросы и аналитика
# переиспользуются как есть; иначе пришлось бы вести две реализации.

async def _assert_autowebinar(db, client_id: int) -> None:
    """⚠️ Автовебинар — ОТДЕЛЬНАЯ фича (только Экстра). Обычная вебинарная
    комната есть и на Профи, поэтому проверять `webinar_room` недостаточно."""
    if not await client_has_feature(db, client_id, "autowebinar"):
        raise HTTPException(status_code=403,
                            detail="Автовебинары доступны на тарифе Экстра.")


class AutoScheduleIn(BaseModel):
    kind: str = "daily"            # daily | weekly | once
    weekdays: list[int] = []       # для weekly: 1=пн … 7=вс
    at_time: str                   # "HH:MM" МСК
    once_date: Optional[str] = None
    is_active: bool = True


class AutoChatIn(BaseModel):
    at_sec: int = 0
    author_name: str
    text: str
    is_host: bool = False


def _norm_hhmm(v: str) -> str:
    """Время строкой HH:MM и всегда МСК — как в программе конференции.
    Иначе сдвиги часовых поясов между Mini App, вебом и рассылками."""
    v = (v or "").strip()
    if not re.match(r"^([01]\d|2[0-3]):([0-5]\d)$", v):
        raise HTTPException(status_code=400, detail="Время задаётся как ЧЧ:ММ, например 19:00")
    return v


@router.get("/{day_number}/auto/schedule", summary="Расписание автовебинара")
async def auto_schedule_list(event_id: int, day_number: int,
                             client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch(
        "SELECT * FROM webinar_auto_schedule WHERE room_id=$1 ORDER BY at_time, id", rid)
    return {"items": [dict(r) for r in rows]}


@router.post("/{day_number}/auto/schedule", summary="Добавить запуск")
async def auto_schedule_add(event_id: int, day_number: int, data: AutoScheduleIn,
                            client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_autowebinar(db, cid)
    rid = await _room_id(db, event_id, day_number)
    row = await db.fetchrow(
        "INSERT INTO webinar_auto_schedule (room_id, kind, weekdays, at_time, once_date, is_active) "
        "VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
        rid, data.kind, data.weekdays, _norm_hhmm(data.at_time),
        data.once_date, data.is_active)
    return dict(row)


@router.delete("/{day_number}/auto/schedule/{item_id}", summary="Удалить запуск")
async def auto_schedule_del(event_id: int, day_number: int, item_id: int,
                            client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_autowebinar(db, cid)
    rid = await _room_id(db, event_id, day_number)
    await db.execute("DELETE FROM webinar_auto_schedule WHERE id=$1 AND room_id=$2", item_id, rid)
    return {"ok": True}


@router.get("/{day_number}/auto/chat", summary="Сценарий чата автовебинара")
async def auto_chat_list(event_id: int, day_number: int,
                         client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch(
        "SELECT * FROM webinar_auto_chat WHERE room_id=$1 ORDER BY at_sec, id", rid)
    return {"items": [dict(r) for r in rows]}


@router.post("/{day_number}/auto/chat", summary="Добавить реплику в сценарий")
async def auto_chat_add(event_id: int, day_number: int, data: AutoChatIn,
                        client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_autowebinar(db, cid)
    rid = await _room_id(db, event_id, day_number)
    row = await db.fetchrow(
        "INSERT INTO webinar_auto_chat (room_id, at_sec, author_name, text, is_host) "
        "VALUES ($1,$2,$3,$4,$5) RETURNING *",
        rid, max(0, data.at_sec), data.author_name.strip()[:80],
        data.text.strip()[:1000], data.is_host)
    return dict(row)


@router.delete("/{day_number}/auto/chat/{item_id}", summary="Удалить реплику")
async def auto_chat_del(event_id: int, day_number: int, item_id: int,
                        client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_autowebinar(db, cid)
    rid = await _room_id(db, event_id, day_number)
    await db.execute("DELETE FROM webinar_auto_chat WHERE id=$1 AND room_id=$2", item_id, rid)
    return {"ok": True}


@router.post("/{day_number}/auto/chat-from-record", summary="Взять чат из живого эфира")
async def auto_chat_from_record(event_id: int, day_number: int, session_id: int,
                                client=Depends(get_current_client), db=Depends(get_db)):
    """Перенести реплики реального эфира в сценарий автовебинара.

    ⚠️ Главный способ наполнить сценарий: писать полсотни реплик руками никто
    не станет, а живой эфир уже дал настоящие вопросы в нужные моменты.
    Тайминги берутся от started_at той сессии.
    """
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_autowebinar(db, cid)
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch(
        "SELECT m.author_name, m.text, "
        "       GREATEST(0, EXTRACT(EPOCH FROM (m.at - s.started_at))::int) AS at_sec "
        "  FROM webinar_chat_messages m JOIN webinar_sessions s ON s.id = m.session_id "
        " WHERE m.room_id=$1 AND m.session_id=$2 AND m.status='visible' ORDER BY m.at",
        rid, session_id)
    n = 0
    for r in rows:
        await db.execute(
            "INSERT INTO webinar_auto_chat (room_id, at_sec, author_name, text) "
            "VALUES ($1,$2,$3,$4)",
            rid, r["at_sec"], (r["author_name"] or "Гость")[:80], (r["text"] or "")[:1000])
        n += 1
    return {"ok": True, "added": n}


@router.delete("/{day_number}/recordings/{rec_id}", summary="Удалить запись (файл + БД)")
async def delete_recording(event_id: int, day_number: int, rec_id: int,
                           client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    rec = await db.fetchrow(
        "SELECT r.r2_key, r.session_id, wr.stream_key "
        "  FROM webinar_recordings r JOIN webinar_rooms wr ON wr.id = r.room_id "
        " WHERE r.id=$1 AND r.room_id=$2", rec_id, rid)
    if not rec:
        raise HTTPException(404, "Запись не найдена")
    # ⚠️ Сначала удаляем ФАЙЛ, и только потом строку. Раньше ошибка удаления
    # глушилась `except: pass`, а строка сносилась всё равно — файл оставался в
    # R2 навсегда и его нельзя было найти: в базе о нём уже ничего не было.
    # Так осиротела запись на 6,2 ГБ (rec_3.mp4), которую клиент считал удалённой.
    if rec["r2_key"]:
        from app.services import r2_storage
        try:
            await r2_storage.delete_object(rec["r2_key"])
        except Exception as e:
            raise HTTPException(
                502,
                detail="Не удалось удалить файл записи из хранилища — запись оставлена. "
                       "Попробуйте ещё раз через минуту.",
            ) from e
        # Снимаем с учёта квоты (файл больше не занимает место).
        await r2_storage.unregister_file(db, rec["r2_key"])

    # ⚠️ Убираем и КУСКИ этого эфира — те, что не успели войти в склейку.
    # Раньше кнопка «Удалить» чистила только хранилище и базу, а сегменты
    # оставались занимать место, и клиент не мог на это повлиять: он считал
    # запись удалённой, а гигабайты продолжали лежать.
    if rec["stream_key"]:
        from app.services import r2_storage as _r2
        left = await db.fetch(
            "SELECT id, r2_key FROM webinar_recording_chunks "
            " WHERE stream_key=$1 AND consumed_at IS NULL", rec["stream_key"])
        for ch in left:
            try:
                await _r2.delete_object(ch["r2_key"])
            except Exception:
                # Не роняем удаление записи из-за куска: строку оставляем,
                # мусор подберёт уборщик по сроку.
                continue
            await db.execute(
                "DELETE FROM webinar_recording_chunks WHERE id=$1", ch["id"])

    await db.execute("DELETE FROM webinar_recordings WHERE id=$1", rec_id)
    return {"ok": True}


# ─────────────────────────── реферальный отчёт вебинара ───────────────────────────
@router.get("/{day_number}/referrals", summary="Кто сколько привёл на вебинар (по реф-ссылкам)")
async def webinar_referrals(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch(
        """
        SELECT ep.referrer_ref_code,
               c.name AS referrer_name,
               COUNT(*) AS brought,
               COUNT(*) FILTER (WHERE reg.contact_id IN (
                   SELECT DISTINCT contact_id FROM webinar_presence WHERE room_id=$1 AND contact_id IS NOT NULL
               )) AS attended
          FROM webinar_registrations reg
          JOIN webinar_rooms wroom ON wroom.id = reg.room_id
          JOIN event_participants ep ON ep.event_id = wroom.event_id AND ep.contact_id = reg.contact_id
          LEFT JOIN contacts c ON c.ref_code = ep.referrer_ref_code
         WHERE reg.room_id=$1 AND ep.referrer_ref_code IS NOT NULL AND ep.referrer_ref_code <> ''
         GROUP BY ep.referrer_ref_code, c.name
         ORDER BY brought DESC
        """, rid,
    )
    total = await db.fetchval("SELECT COUNT(*) FROM webinar_registrations WHERE room_id=$1", rid)
    return {"referrers": [dict(r) for r in rows], "total_registrations": total}


# ─────────────────────────── зрители вебинара ───────────────────────────
@router.get("/{day_number}/audience", summary="Список зрителей вебинара (кто был, откуда, контакты)")
async def audience(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch(
        """
        SELECT c.id AS contact_id, c.name, c.phone,
               (SELECT pu.platform_user_id FROM platform_users pu
                  WHERE pu.contact_id=c.id AND pu.platform_slug='email' LIMIT 1) AS email,
               (SELECT pu.username FROM platform_users pu
                  WHERE pu.contact_id=c.id AND pu.platform_slug='telegram' LIMIT 1) AS tg_username,
               ep.referrer_ref_code,
               rc.name AS referrer_name,
               reg.created_at AS registered_at,
               -- Только присутствие ВО ВРЕМЯ ЭФИРА (session_id IS NOT NULL): иначе
               -- фоновые heartbeat из состояния ожидания раздували диапазон/минуты
               -- («12:12–21:41 · 46 мин» вместо реального времени эфира).
               (SELECT MIN(p.bucket_at) FROM webinar_presence p WHERE p.room_id=$1 AND p.contact_id=c.id AND p.session_id IS NOT NULL) AS first_seen,
               (SELECT MAX(p.bucket_at) FROM webinar_presence p WHERE p.room_id=$1 AND p.contact_id=c.id AND p.session_id IS NOT NULL) AS last_seen,
               (SELECT COUNT(DISTINCT p.bucket_at) FROM webinar_presence p WHERE p.room_id=$1 AND p.contact_id=c.id AND p.session_id IS NOT NULL) AS minutes_online,
               (SELECT COUNT(*) FROM webinar_activity a WHERE a.room_id=$1 AND a.contact_id=c.id AND a.kind='chat_msg') AS messages,
               (SELECT COUNT(*) FROM webinar_activity a WHERE a.room_id=$1 AND a.contact_id=c.id AND a.kind='reaction') AS reactions
          FROM webinar_registrations reg
          JOIN webinar_rooms wroom ON wroom.id = reg.room_id
          JOIN contacts c ON c.id = reg.contact_id
          LEFT JOIN event_participants ep ON ep.event_id = wroom.event_id AND ep.contact_id = reg.contact_id
          LEFT JOIN contacts rc ON rc.ref_code = ep.referrer_ref_code
         WHERE reg.room_id=$1
         -- По дате ВХОДА в комнату (последние вошедшие сверху): первый заход в эфир,
         -- иначе момент регистрации на вебинар (reg.created_at).
         ORDER BY COALESCE(
                    (SELECT MIN(p.bucket_at) FROM webinar_presence p
                      WHERE p.room_id=$1 AND p.contact_id=c.id AND p.session_id IS NOT NULL),
                    reg.created_at) DESC NULLS LAST
        """, rid,
    )
    return {"viewers": [dict(r) for r in rows]}


@router.get("/{day_number}/audience/{contact_id}/timeline", summary="История входов/выходов зрителя")
async def audience_timeline(event_id: int, day_number: int, contact_id: int,
                            client=Depends(get_current_client), db=Depends(get_db)):
    """Интервалы присутствия — из поминутного heartbeat склеиваем в отрезки
    заходил→выходил (разрыв >2 мин = новый заход)."""
    await ws.assert_event_owner(db, event_id, _cid(client))
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch(
        "SELECT bucket_at FROM webinar_presence WHERE room_id=$1 AND contact_id=$2 ORDER BY bucket_at",
        rid, contact_id)
    intervals = []
    start = prev = None
    for r in rows:
        t = r["bucket_at"]
        if start is None:
            start = prev = t
        elif (t - prev).total_seconds() > 180:  # разрыв >3 мин → новый заход
            intervals.append({"from": start.isoformat(), "to": prev.isoformat()})
            start = prev = t
        else:
            prev = t
    if start is not None:
        intervals.append({"from": start.isoformat(), "to": prev.isoformat()})
    return {"intervals": intervals}


# ─────────────────────────── обзор батлов события ───────────────────────────
@router.get("/battles/all", summary="Все батлы события по дням (обзор результатов)")
async def all_battles(event_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    await ws.assert_event_owner(db, event_id, _cid(client))
    rows = await db.fetch(
        """
        SELECT b.id, b.title, b.status, b.created_at, b.reaction_up_label, b.reaction_down_label,
               wr.day_number, wr.title AS room_title
          FROM webinar_battles b
          JOIN webinar_rooms wr ON wr.id = b.room_id
         WHERE wr.event_id = $1
         ORDER BY wr.day_number, b.created_at DESC
        """, event_id,
    )
    out = []
    for b in rows:
        players = await db.fetch(
            "SELECT name, speaker_id, up_count, down_count FROM webinar_battle_players "
            "WHERE battle_id=$1 ORDER BY up_count DESC, sort_order", b["id"])
        out.append({**dict(b), "players": [dict(p) for p in players]})
    return {"battles": out}


@router.post("/{day_number}/segment", summary="Срез: онлайн в интервале → тег контактам")
async def segment(
    event_id: int, day_number: int,
    frm: datetime = Query(..., alias="from"), to: datetime = Query(...),
    tag: Optional[str] = Query(None),
    client=Depends(get_current_client), db=Depends(get_db),
):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    rid = await _room_id(db, event_id, day_number)
    rows = await db.fetch(
        "SELECT DISTINCT contact_id FROM webinar_presence "
        "WHERE room_id=$1 AND contact_id IS NOT NULL AND bucket_at >= $2 AND bucket_at <= $3",
        rid, frm, to,
    )
    contact_ids = [r["contact_id"] for r in rows]
    if tag:
        for c in contact_ids:
            await ws.tag_contact(db, cid, c, tag)
    return {"count": len(contact_ids), "contact_ids": contact_ids, "tagged": bool(tag)}


# ─────────────────────────── внутренний хук MediaMTX ───────────────────────────
def _check_bridge(token: Optional[str]) -> None:
    if not settings.webinar_bridge_token or token != settings.webinar_bridge_token:
        raise HTTPException(status_code=401, detail="bad bridge token")


@internal_router.post("/stream/publish", summary="MediaMTX: поток пошёл (комната готова, но НЕ в эфире)")
async def stream_publish(path: str = Query(...), x_bridge_token: Optional[str] = Header(None), db=Depends(get_db)):
    """path = 'live/{stream_key}'. Разрешаем публикацию только для известного ключа.

    ⚠️ Поток пришёл ≠ эфир начался. Спикер настраивается в Zoom — зрители этого видеть
    не должны. Ставим 'ready' (превью только ведущему), в 'live' переводит ведущий
    кнопкой «Начать эфир» (см. /go-live).
    """
    _check_bridge(x_bridge_token)
    key = path.split("/")[-1] if path else ""
    room = await db.fetchrow("SELECT id, status FROM webinar_rooms WHERE stream_key=$1", key)
    if not room:
        raise HTTPException(status_code=404, detail="unknown stream key")
    # Если ведущий уже начал эфир — не сбиваем 'live' (переподключение видеокодера).
    new_status = "live" if room["status"] == "live" else "ready"
    await db.execute(
        "UPDATE webinar_rooms SET stream_active=TRUE, status=$2 WHERE id=$1", room["id"], new_status)
    from app.services.webinar_hub import publish
    await publish(room["id"], {"type": "stream_ready"})   # ведущему — «поток пошёл»
    return {"ok": True}


@internal_router.post("/stream/unpublish", summary="MediaMTX: поток остановлен")
async def stream_unpublish(path: str = Query(...), x_bridge_token: Optional[str] = Header(None), db=Depends(get_db)):
    """Видеокодер отключился. Эфир НЕ завершаем — это может быть обрыв связи, а
    завершение эфира — решение ведущего (кнопка «Завершить эфир»)."""
    _check_bridge(x_bridge_token)
    key = path.split("/")[-1] if path else ""
    room = await db.fetchrow("SELECT id, status FROM webinar_rooms WHERE stream_key=$1", key)
    if not room:
        return {"ok": True}
    # 'ready' → 'idle' (эфир не начинали). 'live' оставляем: у зрителей плеер сам
    # переподключится, когда поток вернётся; завершает эфир только ведущий.
    new_status = "idle" if room["status"] == "ready" else room["status"]
    await db.execute(
        "UPDATE webinar_rooms SET stream_active=FALSE, status=$2 WHERE id=$1", room["id"], new_status)
    from app.services.webinar_hub import publish
    await publish(room["id"], {"type": "stream_offline"})
    return {"ok": True}


# ─────────────────────────── текущий спикер (пульт ведущего) ───────────────────────────
@router.post("/{day_number}/current-speaker", summary="Поставить текущего спикера вручную / вернуть авто")
async def set_current_speaker(
    event_id: int, day_number: int,
    mode: str = Query(...),                       # auto | manual
    ec_id: Optional[int] = Query(None),           # для manual: event_collaborators.id
    client=Depends(get_current_client), db=Depends(get_db),
):
    await ws.assert_event_owner(db, event_id, _cid(client))
    if mode not in ("auto", "manual"):
        raise HTTPException(400, "mode: auto|manual")
    room = await ws.get_room_or_404(db, event_id, day_number)
    await db.execute(
        "UPDATE webinar_rooms SET speaker_mode=$2, manual_speaker_ec_id=$3 WHERE id=$1",
        room["id"], mode, ec_id if mode == "manual" else None)
    from app.services.webinar_hub import publish
    await publish(room["id"], {"type": "speaker_changed"})   # зрителям — перечитать
    return {"ok": True, "mode": mode, "ec_id": ec_id if mode == "manual" else None}


# ─────────────────────────── управление эфиром (пульт ведущего) ───────────────────────────
@router.post("/{day_number}/go-live", summary="Начать эфир — зрители видят поток")
async def go_live(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_webinar_feature(db, cid, need_room=True)
    room = await ws.get_room_or_404(db, event_id, day_number)
    if (room.get("room_state") or "created") != "open":
        raise HTTPException(400, "Сначала откройте комнату — тогда можно начать эфир.")
    if not room.get("stream_active"):
        raise HTTPException(400, "Поток не идёт — сначала запустите трансляцию в Zoom/OBS")
    # Новая эфирная сессия (запуск) — presence/activity будут писаться в неё.
    sess_id = await db.fetchval(
        "INSERT INTO webinar_sessions (room_id, started_at) VALUES ($1, NOW()) RETURNING id", room["id"])
    await db.execute(
        "UPDATE webinar_rooms SET status='live', started_at=COALESCE(started_at, NOW()), "
        "ended_at=NULL, current_session_id=$2 WHERE id=$1", room["id"], sess_id)
    from app.services.webinar_hub import publish
    await publish(room["id"], {"type": "stream_live"})   # зрителям — показать плеер
    return {"ok": True, "status": "live", "session_id": sess_id}


@router.post("/{day_number}/end-live", summary="Завершить ЭФИР (сессию) — комната остаётся открытой")
async def end_live(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    """Завершает ТЕКУЩИЙ эфир (сессию), но НЕ закрывает комнату — можно запустить
    новый эфир того же дня (кнопка «Начать эфир» снова). Зрители видят «эфир на паузе,
    скоро продолжим». Полное закрытие с редиректом — отдельная кнопка «Закрыть комнату»."""
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_webinar_feature(db, cid, need_room=True)
    room = await ws.get_room_or_404(db, event_id, day_number)
    sess_id = room.get("current_session_id")   # сохранить ДО обнуления
    if sess_id:
        await db.execute(
            "UPDATE webinar_sessions SET ended_at=NOW() WHERE id=$1 AND ended_at IS NULL", sess_id)
    # status='ended' = «эфир сейчас не идёт», но room_state НЕ трогаем (комната открыта).
    await db.execute(
        "UPDATE webinar_rooms SET status='ended', ended_at=NOW(), current_session_id=NULL WHERE id=$1",
        room["id"])
    if sess_id:
        try:
            from app.tasks.webinar_recording import upload_session_recording
            upload_session_recording.delay(sess_id)
        except Exception:
            pass  # запись не критична для завершения эфира
    from app.services.webinar_hub import publish
    # paused — зрители видят «эфир на паузе», плеер прячется, редиректа НЕТ.
    await publish(room["id"], {"type": "stream_paused"})
    return {"ok": True, "status": "ended"}


@router.post("/{day_number}/open-room", summary="Открыть комнату — пускать зрителей на авторизацию")
async def open_room(event_id: int, day_number: int,
                    opens_at: Optional[str] = Query(None),   # ISO время старта для countdown
                    client=Depends(get_current_client), db=Depends(get_db)):
    """room_state='open': зритель может авторизоваться (имя+email) и попасть внутрь.
    До эфира видит афишу + «трансляция начнётся через…». Эфир запускается отдельно."""
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_webinar_feature(db, cid, need_room=True)
    room = await ws.get_room_or_404(db, event_id, day_number)
    import datetime as _dt
    oa = None
    if opens_at:
        try:
            oa = _dt.datetime.fromisoformat(opens_at.replace("Z", "+00:00"))
        except Exception:
            oa = None
    await db.execute(
        "UPDATE webinar_rooms SET room_state='open', opens_at=COALESCE($2, opens_at) WHERE id=$1",
        room["id"], oa)
    from app.services.webinar_hub import publish
    await publish(room["id"], {"type": "room_opened"})   # зрителям — перечитать (появится форма)
    return {"ok": True, "room_state": "open"}


@router.post("/{day_number}/close-room", summary="Закрыть комнату — «вебинар завершён» + редирект")
async def close_room(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    """Финал дня: room_state='closed'. Все, кто заходит, видят «вебинар завершён,
    переводим вас…» и редирект на redirect_url. Идущий эфир тоже гасится."""
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_webinar_feature(db, cid, need_room=True)
    room = await ws.get_room_or_404(db, event_id, day_number)
    sess_id = room.get("current_session_id")
    if sess_id:
        await db.execute(
            "UPDATE webinar_sessions SET ended_at=NOW() WHERE id=$1 AND ended_at IS NULL", sess_id)
        try:
            from app.tasks.webinar_recording import upload_session_recording
            upload_session_recording.delay(sess_id)
        except Exception:
            pass
    await db.execute(
        "UPDATE webinar_rooms SET room_state='closed', status='ended', ended_at=NOW(), "
        "current_session_id=NULL WHERE id=$1", room["id"])
    from app.services.webinar_hub import publish
    await publish(room["id"], {"type": "stream_ended", "redirect_url": (room.get("redirect_url") or "").strip() or None})
    return {"ok": True, "room_state": "closed"}


@router.post("/{day_number}/reset-room", summary="Начать заново — вернуть комнату к отсчёту (created)")
async def reset_room(event_id: int, day_number: int, client=Depends(get_current_client), db=Depends(get_db)):
    """room_state='created': снова афиша + название + обратный отсчёт, БЕЗ формы входа.
    Данные прошлых эфиров (сессии, чат, записи, статистика) НЕ трогаем — только
    сбрасываем доступ. Для повторного цикла (напр. следующий тест / автовебинар)."""
    cid = _cid(client)
    await ws.assert_event_owner(db, event_id, cid)
    await _assert_webinar_feature(db, cid, need_room=True)
    room = await ws.get_room_or_404(db, event_id, day_number)
    # chat_cleared_at=NOW() → живой чат становится чистым (старые сообщения остаются
    # в БД/записях сессий, но в новом цикле не показываются).
    await db.execute(
        "UPDATE webinar_rooms SET room_state='created', status='idle', "
        "current_session_id=NULL, chat_cleared_at=NOW() WHERE id=$1", room["id"])
    from app.services.webinar_hub import publish
    await publish(room["id"], {"type": "room_reset"})   # зрителям — вернуться к отсчёту
    return {"ok": True, "room_state": "created"}
