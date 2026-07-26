"""Вебинарная комната — публичный API зрителя + WebSocket.

Зритель на pluson.ru/webinar/{slug}/{day}. Идентификация: contact_id (известный,
из query/Mini App) ИЛИ анонимный session_key (генерит фронт). Всё пишется в
webinar_activity/presence с contact_id — база аналитики по зрителю.

Роутеры:
- router    — /api/v1/public/webinar/{slug}/{day}/...   (REST зрителя)
- ws_router — /ws/webinar/{slug}/{day}                  (WebSocket realtime)
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.database import get_pool
from app.services import webinar_service as ws
from app.services import webinar_hub as hub
from app.services.contact_merge import find_or_create_contact

router = APIRouter(prefix="/api/v1/public/webinar", tags=["Вебинар — зритель"])
ws_router = APIRouter()


async def _load_room(conn, slug: str, day: int) -> dict:
    ev = await ws.resolve_event_by_slug(conn, slug)
    if not ev:
        raise HTTPException(404, "Событие не найдено")
    room = await conn.fetchrow(
        "SELECT * FROM webinar_rooms WHERE event_id=$1 AND day_number=$2", ev["id"], day)
    if not room:
        raise HTTPException(404, "Вебинарная комната не найдена")
    r = dict(room)
    r["_event"] = ev
    return r


async def _is_banned(conn, room_id: int, contact_id: Optional[int], session_key: Optional[str]) -> bool:
    row = await conn.fetchrow(
        "SELECT 1 FROM webinar_banned WHERE room_id=$1 AND "
        "((contact_id IS NOT NULL AND contact_id=$2) OR (session_key IS NOT NULL AND session_key=$3)) LIMIT 1",
        room_id, contact_id, session_key,
    )
    return bool(row)


# ─────────────────────────── данные комнаты ───────────────────────────
@router.get("/{slug}/{day}", summary="Данные комнаты дня для зрителя")
async def room_view(slug: str, day: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid, ev = room["id"], room["_event"]

        # Блоки зрителю: показываем только те, что менеджер включил вручную (is_pinned),
        # либо те, у кого задан тайминг и текущая минута эфира в него попала.
        # Блок без тайминга и не включённый вручную — зрителю не виден (лежит заготовкой).
        all_blocks = await conn.fetch(
            "SELECT id, kind, title, url, body, form_fields, form_tag, follow_mode, speaker_id, "
            "       is_pinned, show_at_min, hide_at_min, sort_order "
            "FROM webinar_blocks WHERE room_id=$1 AND is_active=TRUE ORDER BY sort_order, id", rid)

        elapsed_min = None
        if room.get("status") == "live" and room.get("started_at"):
            elapsed_min = (datetime.now(timezone.utc) - room["started_at"]).total_seconds() / 60

        def _visible(b) -> bool:
            if b["is_pinned"]:
                return True
            if elapsed_min is None or b["show_at_min"] is None:
                return False
            if elapsed_min < b["show_at_min"]:
                return False
            if b["hide_at_min"] is not None and elapsed_min > b["hide_at_min"]:
                return False
            return True

        blocks = [b for b in all_blocks if _visible(b)]

        # текущий спикер по слоту (для авто-кнопки/подарка)
        cur_ec = await ws.current_speaker_ec_id(conn, ev["id"], day)
        follow = await ws.speaker_follow_card(conn, ev["id"], cur_ec)
        gift = await ws.speaker_gift_card(conn, ev["id"], cur_ec)

        # активный опрос / батл
        poll = await conn.fetchrow(
            "SELECT * FROM webinar_polls WHERE room_id=$1 AND status='open' ORDER BY id DESC LIMIT 1", rid)
        poll_out = None
        if poll:
            opts = await conn.fetch("SELECT id, text, votes FROM webinar_poll_options WHERE poll_id=$1 ORDER BY sort_order", poll["id"])
            poll_out = {**dict(poll), "options": [dict(o) for o in opts]}

        battle = await conn.fetchrow(
            "SELECT * FROM webinar_battles WHERE room_id=$1 AND status='live' ORDER BY id DESC LIMIT 1", rid)
        battle_out = None
        if battle:
            pls = await conn.fetch("SELECT id, speaker_id, name, up_count, down_count FROM webinar_battle_players WHERE battle_id=$1 ORDER BY sort_order", battle["id"])
            battle_out = {**dict(battle), "players": [dict(p) for p in pls]}

        # реакции спикерам (счётчики)
        rx = await conn.fetch(
            "SELECT speaker_id, reaction_key, count FROM webinar_speaker_reactions WHERE room_id=$1", rid)

        # ⚠️ HLS отдаём зрителю ТОЛЬКО когда ведущий начал эфир (status='live').
        # Пока 'ready' — спикер настраивается в Zoom, зрители видеть не должны.
        is_live = room.get("status") == "live"

        # бренд клиента для шапки комнаты (как в Mini App: логотип + название)
        brand = await conn.fetchrow(
            "SELECT COALESCE(NULLIF(brand_name,''), name) AS brand_name, brand_logo_url "
            "FROM clients WHERE id=$1", ev["client_id"])

        # Афиша-заставка до эфира: сначала афиша ЭТОГО дня, иначе общая афиша
        # события (горизонтальная в приоритете) — правило проекта (миграция 215).
        poster = await conn.fetchval(
            "SELECT url FROM event_posters WHERE event_id=$1 AND day=$2 "
            " ORDER BY CASE orientation WHEN 'horizontal' THEN 1 WHEN 'square' THEN 2 "
            "                           WHEN 'vertical' THEN 3 ELSE 4 END, sort, id LIMIT 1",
            ev["id"], day,
        )
        if not poster:
            poster = await conn.fetchval(
                "SELECT url FROM event_posters WHERE event_id=$1 AND day IS NULL "
                " ORDER BY CASE orientation WHEN 'horizontal' THEN 1 WHEN 'square' THEN 2 "
                "                           WHEN 'vertical' THEN 3 ELSE 4 END, sort, id LIMIT 1",
                ev["id"],
            )

        return {
            "event": {"id": ev["id"], "title": ev["title"], "slug": ev["slug"]},
            "brand": {
                "name": brand["brand_name"] if brand else None,
                "logo_url": brand["brand_logo_url"] if brand else None,
            },
            "poster_url": poster,   # заставка до начала эфира
            "room": {
                "id": rid,
                "title": room.get("title"),
                "status": room.get("status"),
                "stream_type": room.get("stream_type"),
                "hls_url": room.get("hls_url") if is_live else None,
                "external_url": room.get("external_url"),
                "hide_viewer_count": room.get("hide_viewer_count"),
                "chat_enabled": room.get("chat_enabled"),
                "premoderation": room.get("premoderation"),
                "redirect_url": room.get("redirect_url"),
                "reaction_up_label": room.get("reaction_up_label"),
                "reaction_down_label": room.get("reaction_down_label"),
                "show_down_reaction": room.get("show_down_reaction"),
                "intro_text": room.get("intro_text"),
                "buttons_per_row": room.get("buttons_per_row") or 1,
                "auth_mode": room.get("auth_mode") or "auto",
                "auth_require_name": room.get("auth_require_name"),
                "auth_require_email": room.get("auth_require_email"),
                "auth_require_phone": room.get("auth_require_phone"),
                "auth_require_tg": room.get("auth_require_tg"),
                "auth_intro_text": room.get("auth_intro_text"),
            },
            "blocks": [dict(b) for b in blocks],
            "current_speaker": follow,
            "current_gift": gift,
            "poll": poll_out,
            "battle": battle_out,
            "speaker_reactions": [dict(r) for r in rx],
            "online": (None if room.get("hide_viewer_count") else await _online_now(conn, rid)),
        }


async def _online_now(conn, room_id: int) -> int:
    """Сколько зрителей онлайн СЕЙЧАС — по heartbeat за последние 2 минуты.
    Надёжнее числа живых сокетов: переживает переподключения и разные процессы."""
    n = await conn.fetchval(
        "SELECT COUNT(DISTINCT COALESCE(contact_id::text, session_key)) "
        "FROM webinar_presence WHERE room_id=$1 AND bucket_at >= NOW() - INTERVAL '2 minutes'",
        room_id,
    )
    return n or 0


# ─────────────────────────── heartbeat присутствия ───────────────────────────
class Heartbeat(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    device: Optional[str] = None


@router.post("/{slug}/{day}/heartbeat", summary="Пинг присутствия (раз в минуту)")
async def heartbeat(slug: str, day: int, body: Heartbeat):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        await conn.execute(
            "INSERT INTO webinar_presence (room_id, contact_id, session_key, bucket_at, device, session_id) "
            "VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
            rid, body.contact_id, body.session_key, now, body.device, room.get("current_session_id"),
        )
        online = await _online_now(conn, rid)
    # живой счётчик всем в комнате (если не скрыт)
    if not room.get("hide_viewer_count"):
        await hub.publish(rid, {"type": "online", "count": online})
    return {"ok": True, "online": online}


# ─────────────────────────── чат ───────────────────────────
class ChatIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    author_name: Optional[str] = None
    text: str


@router.post("/{slug}/{day}/chat", summary="Отправить сообщение в чат")
async def chat_send(slug: str, day: int, body: ChatIn):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        if not room.get("chat_enabled"):
            raise HTTPException(403, "Чат отключён")
        if await _is_banned(conn, rid, body.contact_id, body.session_key):
            raise HTTPException(403, "Вы удалены из чата")
        text = (body.text or "").strip()
        if not text:
            raise HTTPException(400, "Пустое сообщение")
        status = "premod" if room.get("premoderation") else "visible"
        row = await conn.fetchrow(
            "INSERT INTO webinar_chat_messages (room_id, contact_id, author_name, text, status) "
            "VALUES ($1,$2,$3,$4,$5) RETURNING id, at",
            rid, body.contact_id, body.author_name, text, status,
        )
        # активность по зрителю
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, session_id) VALUES ($1,$2,$3,'chat_msg',$4)",
            rid, body.contact_id, body.session_key, room.get("current_session_id"),
        )
    msg = {
        "type": "chat", "id": row["id"], "text": text, "author_name": body.author_name,
        "contact_id": body.contact_id, "at": row["at"].isoformat(), "status": status,
    }
    if status == "visible":
        await hub.publish(rid, msg)
    return {"ok": True, "id": row["id"], "status": status}


@router.get("/{slug}/{day}/chat", summary="История чата")
async def chat_history(slug: str, day: int, limit: int = Query(100, le=300)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rows = await conn.fetch(
            "SELECT id, contact_id, author_name, text, at FROM webinar_chat_messages "
            "WHERE room_id=$1 AND status='visible' ORDER BY at DESC LIMIT $2", room["id"], limit)
        items = [dict(r) for r in reversed(rows)]
    return {"messages": items}


# ─────────────────────────── реакции по спикерам ───────────────────────────
class ReactIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    speaker_id: int                      # event_collaborators.id
    reaction: str                        # up | down


@router.post("/{slug}/{day}/react", summary="👍/👎 спикеру")
async def react(slug: str, day: int, body: ReactIn):
    if body.reaction not in ("up", "down"):
        raise HTTPException(400, "reaction: up|down")
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        if body.reaction == "down" and not room.get("show_down_reaction"):
            raise HTTPException(403, "Отрицательная реакция отключена")
        if await _is_banned(conn, rid, body.contact_id, body.session_key):
            raise HTTPException(403, "Вы удалены из эфира")
        cnt = await conn.fetchval(
            "INSERT INTO webinar_speaker_reactions (room_id, speaker_id, reaction_key, count) "
            "VALUES ($1,$2,$3,1) ON CONFLICT (room_id, speaker_id, reaction_key) "
            "DO UPDATE SET count = webinar_speaker_reactions.count + 1 RETURNING count",
            rid, body.speaker_id, body.reaction,
        )
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, value, session_id) "
            "VALUES ($1,$2,$3,'reaction','speaker',$4,$5,$6)",
            rid, body.contact_id, body.session_key, body.speaker_id, body.reaction, room.get("current_session_id"),
        )
    await hub.publish(rid, {"type": "reaction", "speaker_id": body.speaker_id, "reaction": body.reaction, "count": cnt})
    return {"ok": True, "count": cnt}


# ─────────────────────────── батл-голос ───────────────────────────
class BattleVoteIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    player_id: int
    reaction: str                        # up | down


@router.post("/{slug}/{day}/battle/{battle_id}/vote", summary="Голос в батле")
async def battle_vote(slug: str, day: int, battle_id: int, body: BattleVoteIn):
    if body.reaction not in ("up", "down"):
        raise HTTPException(400, "reaction: up|down")
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        b = await conn.fetchrow("SELECT show_down_reaction FROM webinar_battles WHERE id=$1 AND room_id=$2 AND status='live'", battle_id, rid)
        if not b:
            raise HTTPException(404, "Батл не активен")
        if body.reaction == "down" and not b["show_down_reaction"]:
            raise HTTPException(403, "Отрицательная реакция отключена")
        # один голос на игрока от зрителя (можно менять)
        await conn.execute(
            "INSERT INTO webinar_battle_votes (battle_id, player_id, contact_id, session_key, reaction_key) "
            "VALUES ($1,$2,$3,$4,$5) ON CONFLICT (player_id, COALESCE(contact_id,0), COALESCE(session_key,'')) "
            "DO UPDATE SET reaction_key=EXCLUDED.reaction_key, at=NOW()",
            battle_id, body.player_id, body.contact_id, body.session_key, body.reaction,
        )
        # пересчёт счётчиков игрока
        up = await conn.fetchval("SELECT COUNT(*) FROM webinar_battle_votes WHERE player_id=$1 AND reaction_key='up'", body.player_id)
        down = await conn.fetchval("SELECT COUNT(*) FROM webinar_battle_votes WHERE player_id=$1 AND reaction_key='down'", body.player_id)
        await conn.execute("UPDATE webinar_battle_players SET up_count=$1, down_count=$2 WHERE id=$3", up, down, body.player_id)
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, value, session_id) "
            "VALUES ($1,$2,$3,'reaction','battle_player',$4,$5,$6)",
            rid, body.contact_id, body.session_key, body.player_id, body.reaction, room.get("current_session_id"),
        )
    await hub.publish(rid, {"type": "battle_vote", "player_id": body.player_id, "up": up, "down": down})
    return {"ok": True, "up": up, "down": down}


# ─────────────────────────── опрос-голос ───────────────────────────
class PollVoteIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    option_id: int


@router.post("/{slug}/{day}/poll/{poll_id}/vote", summary="Голос в опросе")
async def poll_vote(slug: str, day: int, poll_id: int, body: PollVoteIn):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid = room["id"]
        poll = await conn.fetchrow("SELECT 1 FROM webinar_polls WHERE id=$1 AND room_id=$2 AND status='open'", poll_id, rid)
        if not poll:
            raise HTTPException(404, "Опрос не активен")
        inserted = await conn.fetchrow(
            "INSERT INTO webinar_poll_votes (poll_id, option_id, contact_id, session_key) "
            "VALUES ($1,$2,$3,$4) ON CONFLICT (poll_id, COALESCE(contact_id,0), COALESCE(session_key,'')) "
            "DO NOTHING RETURNING id",
            poll_id, body.option_id, body.contact_id, body.session_key,
        )
        if inserted:
            await conn.execute("UPDATE webinar_poll_options SET votes=votes+1 WHERE id=$1", body.option_id)
            await conn.execute(
                "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, session_id) "
                "VALUES ($1,$2,$3,'poll_vote','poll_option',$4,$5)",
                rid, body.contact_id, body.session_key, body.option_id, room.get("current_session_id"),
            )
        opts = await conn.fetch("SELECT id, text, votes FROM webinar_poll_options WHERE poll_id=$1 ORDER BY sort_order", poll_id)
    await hub.publish(rid, {"type": "poll_update", "poll_id": poll_id, "options": [dict(o) for o in opts]})
    return {"ok": True, "options": [dict(o) for o in opts]}


# ─────────────────────────── клик по продающей кнопке ───────────────────────────
class TrackIn(BaseModel):
    contact_id: Optional[int] = None
    session_key: Optional[str] = None
    block_id: Optional[int] = None
    kind: str = "click"                  # click | order | payment


@router.post("/{slug}/{day}/track", summary="Клик/заказ/оплата по продающему блоку")
async def track(slug: str, day: int, body: TrackIn):
    if body.kind not in ("click", "order", "payment"):
        raise HTTPException(400, "kind: click|order|payment")
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, session_id) "
            "VALUES ($1,$2,$3,$4,'block',$5,$6)",
            room["id"], body.contact_id, body.session_key, body.kind, body.block_id, room.get("current_session_id"),
        )
    return {"ok": True}


# ─────────────────────────── умная форма заявки / регистрация ───────────────────────────
class FormIn(BaseModel):
    contact_id: Optional[int] = None     # известный зритель → заявка в один тап
    session_key: Optional[str] = None
    # поля для нового контакта (неизвестный зритель):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None


@router.post("/{slug}/{day}/form/{block_id}", summary="Умная форма заявки (известный → 1 тап, новый → контакт)")
async def form_submit(slug: str, day: int, block_id: int, body: FormIn):
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid, ev = room["id"], room["_event"]
        client_id = ev["client_id"]
        block = await conn.fetchrow("SELECT form_tag FROM webinar_blocks WHERE id=$1 AND room_id=$2", block_id, rid)
        if not block:
            raise HTTPException(404, "Блок не найден")

        contact_id = body.contact_id
        if not contact_id:
            # неизвестный — создаём/находим контакт по данным формы
            if not (body.name or body.email or body.phone or body.telegram_username):
                raise HTTPException(400, "Заполните имя и хотя бы один контакт")
            contact_id, _ = await find_or_create_contact(
                conn, client_id=client_id,
                name=body.name, email=body.email, phone=body.phone,
                lookup_telegram_username=body.telegram_username,
            )
        if not contact_id:
            raise HTTPException(400, "Не удалось определить контакт")

        # тег формы = «группа» GetCourse
        if block["form_tag"]:
            await ws.tag_contact(conn, client_id, contact_id, block["form_tag"])

        await conn.execute(
            "INSERT INTO webinar_activity (room_id, contact_id, session_key, kind, target_kind, target_id, session_id) "
            "VALUES ($1,$2,$3,'form_submit','block',$4,$5)",
            rid, contact_id, body.session_key, block_id, room.get("current_session_id"),
        )
    return {"ok": True, "contact_id": contact_id}


class RegisterIn(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    tg_id: Optional[int] = None            # из Mini App/бота — опознание без формы
    pid: Optional[str] = None              # реф-код рефовода (как в реф-программе)
    utm_source: Optional[str] = None


@router.post("/{slug}/{day}/register", summary="Авторизация зрителя (форма перед эфиром)")
async def register(slug: str, day: int, body: RegisterIn):
    """Форма авторизации: находит/создаёт контакт по tg_id/email/phone/нику.
    Учитывает реф-код (pid) и UTM. Помечает контакт «был в эфире».
    Возвращает contact_id — фронт запоминает его в cookie (без повторного ввода)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        room = await _load_room(conn, slug, day)
        rid, ev = room["id"], room["_event"]
        client_id = ev["client_id"]

        contact_id = None
        # 1) известный tg_id (Mini App/бот) — опознаём без формы
        if body.tg_id:
            from app.services.contact_merge import upsert_contact_with_identity
            res = await upsert_contact_with_identity(
                conn, client_id=client_id, platform_slug="telegram",
                platform_user_id=str(body.tg_id), username=body.telegram_username,
                first_name=body.name, utm_source=body.utm_source,
            )
            contact_id = res[0] if isinstance(res, (tuple, list)) else res
        # 2) иначе — по данным формы
        if not contact_id:
            if not (body.name or body.email or body.phone or body.telegram_username):
                raise HTTPException(400, "Заполните имя и хотя бы один контакт")
            contact_id, _ = await find_or_create_contact(
                conn, client_id=client_id,
                name=body.name, email=body.email, phone=body.phone,
                utm_source=body.utm_source,
                lookup_telegram_username=body.telegram_username,
            )
        if not contact_id:
            raise HTTPException(400, "Заполните имя и хотя бы один контакт")

        # реф-код рефовода (как в реф-программе события) — привязываем, если ещё не задан
        if body.pid:
            try:
                await conn.execute(
                    "UPDATE contacts SET first_referrer_contact_id = COALESCE(first_referrer_contact_id, "
                    "(SELECT id FROM contacts WHERE ref_code=$2 AND client_id=$3 LIMIT 1)) "
                    "WHERE id=$1 AND id <> (SELECT id FROM contacts WHERE ref_code=$2 AND client_id=$3 LIMIT 1)",
                    contact_id, body.pid, client_id)
            except Exception:
                pass

        # Реф-регистрация: фиксируем, по чьей ссылке пришёл (referrer_ref_code).
        # Заслуга рефовода = человек зарегистрировался на вебинар (даже если не в боте).
        await conn.execute(
            "INSERT INTO webinar_registrations (room_id, contact_id, referrer_ref_code) "
            "VALUES ($1,$2,$3) ON CONFLICT (room_id, contact_id) "
            "DO UPDATE SET referrer_ref_code = COALESCE(webinar_registrations.referrer_ref_code, EXCLUDED.referrer_ref_code)",
            rid, contact_id, body.pid)
        await conn.execute("UPDATE contacts SET was_in_webinar=TRUE WHERE id=$1", contact_id)
        await ws.tag_contact(conn, client_id, contact_id, f"webinar:{ev['slug']}:{day}")
    return {"ok": True, "contact_id": contact_id}


# ─────────────────────────── WebSocket ───────────────────────────
@ws_router.websocket("/ws/webinar/{slug}/{day}")
async def webinar_ws(websocket: WebSocket, slug: str, day: int):
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            room = await _load_room(conn, slug, day)
        except HTTPException:
            await websocket.close(code=4404)
            return
    rid = room["id"]
    await websocket.accept()
    await hub.connect(rid, websocket)
    try:
        # держим соединение; клиент только слушает (пинги для keepalive)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(rid, websocket)
