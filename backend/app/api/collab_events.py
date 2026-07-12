"""
Коллаборации: запросы (серый→зелёный), co-ownership совместных событий, умный сват, отзывы.

Поток (см. documentation/CONCEPT-COLLAB-NETWORK.md §9):
1. Клиент 1 из Хаба жмёт «Предложить коллаборацию» (опц. к своему событию) → hub_collab_requests (pending=серый).
2. Клиент 2 видит входящий запрос → Принять/Отклонить.
3. Принял → event_owners(event_id, client_2, accepted, co_owner). Событие становится коллаб (is_collab=TRUE).
   Реф-ссылка клиента 2 на событие создаётся (его вклад считается). Молчун — висит серым, не участвует.
4. Активно, если подтвердил ≥1. Реф-ссылки только подтвердившим.

Защита: в коллаб-событии нельзя удалять участников / менять рефоводов (см. middleware/правила — на уровне API).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
from app.api.collab_hub import require_collab_hub
import asyncpg

router = APIRouter(prefix="/collab", tags=["Коллаборации"],
                   dependencies=[Depends(require_collab_hub)])


async def _client_telegram(db, client_id: int) -> Optional[str]:
    """TG-ник клиента для кнопки «Написать в Telegram» (из platform_users или telegram_username)."""
    row = await db.fetchrow("SELECT telegram_username FROM clients WHERE id=$1", client_id)
    return row["telegram_username"] if row else None


# ═══════════════════════════════════════════════════════════════
# Запросы на коллаборацию
# ═══════════════════════════════════════════════════════════════
class CollabRequestIn(BaseModel):
    to_client_id: int           # кому предлагаем (created_by_client_id из карточки каталога)
    event_id: Optional[int] = None   # к какому СВОЕМУ событию (опц.)
    message: Optional[str] = None


@router.post("/requests")
async def create_request(data: CollabRequestIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Отправить запрос на коллаборацию. У инициатора будет «серым», пока не ответят."""
    me = int(client["sub"])
    if data.to_client_id == me:
        raise HTTPException(400, "Нельзя пригласить самого себя")
    # если к событию — проверяем что событие моё (я владелец)
    if data.event_id:
        owns = await db.fetchval(
            "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'",
            data.event_id, me)
        if not owns:
            raise HTTPException(403, "Это не ваше событие")
    # не плодим дубль pending к тому же человеку по тому же событию
    dup = await db.fetchval(
        """SELECT id FROM hub_collab_requests
            WHERE from_client_id=$1 AND to_client_id=$2 AND status='pending'
              AND (event_id=$3 OR ($3 IS NULL AND event_id IS NULL))""",
        me, data.to_client_id, data.event_id)
    if dup:
        raise HTTPException(409, "Запрос уже отправлен и ждёт ответа")
    # event_id опционален: NULL → коллаба-событие создастся ТОЛЬКО при принятии (не плодим пустые события).
    # event_id задан → присоединяем партнёра к существующей коллабе.
    rid = await db.fetchval(
        """INSERT INTO hub_collab_requests (from_client_id, to_client_id, event_id, message)
           VALUES ($1,$2,$3,$4) RETURNING id""",
        me, data.to_client_id, data.event_id, data.message)
    return {"ok": True, "request_id": rid}


# Организаторы коллабы (для запроса на присоединение третьим человеком):
# кто уже в коллабе — список карточек, фронт рисует «уже в коллабе: Иванов, Петров»
# + кнопка «О коллабе» (название события, описание, карточки организаторов).
_COLLAB_INFO_SUBQ = """
    (SELECT json_agg(json_build_object(
              'client_id', o.client_id,
              'name', c2.name,
              'brand_name', c2.brand_name,
              'photo_url', COALESCE(c2.owner_photo_url, c2.profile_photo_url))
            ORDER BY (o.role='owner') DESC, o.id)
       FROM event_owners o JOIN clients c2 ON c2.id=o.client_id
      WHERE o.event_id = r.event_id AND o.status='accepted') AS collab_organizers
"""


@router.get("/requests")
async def list_requests(direction: str = "incoming", client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """direction=incoming (входящие мне) | outgoing (мои отправленные, в т.ч. серые).

    Если запрос на присоединение к УЖЕ СУЩЕСТВУЮЩЕЙ коллабе — отдаём название события,
    описание и список организаторов, которые уже в ней (collab_organizers).
    """
    me = int(client["sub"])
    if direction == "outgoing":
        rows = await db.fetch(
            f"""SELECT r.id, r.to_client_id AS other_client_id, COALESCE(tc.brand_name,tc.name) AS other_name,
                      COALESCE(tc.owner_photo_url,tc.profile_photo_url) AS other_photo,
                      tc.is_published_in_hub AS other_published,
                      tc.telegram_username AS other_tg, r.event_id,
                      e.title AS event_title, e.description AS event_description,
                      {_COLLAB_INFO_SUBQ},
                      r.status, r.message, r.created_at, r.responded_at, r.decline_reason
                 FROM hub_collab_requests r
                 LEFT JOIN clients tc ON tc.id=r.to_client_id
                 LEFT JOIN events e ON e.id=r.event_id
                WHERE r.from_client_id=$1 ORDER BY r.created_at DESC""", me)
    else:
        rows = await db.fetch(
            f"""SELECT r.id, r.from_client_id AS other_client_id, COALESCE(fc.brand_name,fc.name) AS other_name,
                      COALESCE(fc.owner_photo_url,fc.profile_photo_url) AS other_photo,
                      fc.is_published_in_hub AS other_published,
                      fc.telegram_username AS other_tg, r.event_id,
                      e.title AS event_title, e.description AS event_description,
                      {_COLLAB_INFO_SUBQ},
                      r.status, r.message, r.created_at, r.responded_at, r.decline_reason
                 FROM hub_collab_requests r
                 LEFT JOIN clients fc ON fc.id=r.from_client_id
                 LEFT JOIN events e ON e.id=r.event_id
                WHERE r.to_client_id=$1 ORDER BY r.created_at DESC""", me)
    import json as _json
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("collab_organizers"), str):
            try: d["collab_organizers"] = _json.loads(d["collab_organizers"])
            except Exception: d["collab_organizers"] = []
        out.append(d)
    return {"requests": out, "direction": direction}


def _surname(name):
    if not name: return "?"
    parts = name.strip().split()
    return parts[-1] if parts else name

import secrets as _secrets
_SLUG_AB = '23456789abcdefghjkmnpqrstuvwxyz'
async def _make_collab_slug(db):
    while True:
        s = ''.join(_secrets.choice(_SLUG_AB) for _ in range(6))
        if not await db.fetchval("SELECT 1 FROM events WHERE slug=$1", s):
            return s


@router.post("/requests/{request_id}/respond")
async def respond_request(request_id: int, body: dict, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Принять/отклонить запрос. accept=true:
      - есть event_id → присоединяю партнёра к существующей коллабе (co_owner).
      - нет event_id → СОЗДАЮ коллабу-событие (название из фамилий). Пустые события заранее НЕ плодим."""
    me = int(client["sub"])
    accept = bool(body.get("accept"))
    req = await db.fetchrow("SELECT * FROM hub_collab_requests WHERE id=$1", request_id)
    if not req or req["to_client_id"] != me:
        raise HTTPException(404, "Запрос не найден")
    # accepted менять нельзя (коллаба уже создана). pending и declined — можно (передумать).
    if req["status"] == "accepted":
        raise HTTPException(409, "Запрос уже принят — коллаба создана")
    new_status = "accepted" if accept else "declined"
    reason = (body.get("reason") or "").strip() or None if not accept else None
    created_event_id = None
    async with db.transaction():
        await db.execute("UPDATE hub_collab_requests SET status=$2, responded_at=NOW(), decline_reason=$3 WHERE id=$1", request_id, new_status, reason)
        if accept:
            initiator, acceptor = req["from_client_id"], req["to_client_id"]
            if req["event_id"]:
                ev = await db.fetchrow("SELECT client_id FROM event_owners WHERE event_id=$1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1", req["event_id"])
                owner_cid = ev["client_id"] if ev else None
                partner_cid = initiator if owner_cid == acceptor else acceptor
                if partner_cid and partner_cid != owner_cid:
                    await db.execute(
                        """INSERT INTO event_owners (event_id, client_id, status, role, invited_by_client_id, responded_at)
                           VALUES ($1,$2,'accepted','co_owner',$3,NOW())
                           ON CONFLICT (event_id, client_id) DO UPDATE SET status='accepted', role='co_owner', responded_at=NOW()""",
                        req["event_id"], partner_cid, owner_cid)
                await db.execute("UPDATE events SET is_collab=TRUE WHERE id=$1", req["event_id"])
                created_event_id = req["event_id"]
            else:
                # Название по умолчанию: «Событие между {основатель1} и {основатель2}».
                # Берём ИМЯ ОСНОВАТЕЛЯ (clients.name), НЕ бренд.
                names = await db.fetch("SELECT id, name FROM clients WHERE id=ANY($1)", [initiator, acceptor])
                nm = {r["id"]: r["name"] for r in names}
                title = f"Событие между {nm.get(initiator) or '?'} и {nm.get(acceptor) or '?'}"
                slug = await _make_collab_slug(db)
                ev = await db.fetchrow(
                    "INSERT INTO events (slug, title, module_slug, status, is_collab) VALUES ($1,$2,'base','draft',TRUE) RETURNING id",
                    slug, title)
                created_event_id = ev["id"]
                await db.execute("INSERT INTO event_owners (event_id, client_id, status, role) VALUES ($1,$2,'accepted','owner') ON CONFLICT DO NOTHING", created_event_id, initiator)
                await db.execute(
                    """INSERT INTO event_owners (event_id, client_id, status, role, invited_by_client_id, responded_at)
                       VALUES ($1,$2,'accepted','co_owner',$3,NOW()) ON CONFLICT (event_id, client_id) DO NOTHING""",
                    created_event_id, acceptor, initiator)
                await db.execute("UPDATE hub_collab_requests SET event_id=$2 WHERE id=$1", request_id, created_event_id)
    return {"ok": True, "status": new_status, "event_id": created_event_id}


@router.post("/requests/{request_id}/reconsider")
async def reconsider_request(request_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Передумать по СВОЕМУ ответу (я — получатель). Возвращает запрос в pending («думаю»).
    Если был accepted и коллаба создалась этим запросом — выхожу из неё (co_owner удаляется);
    если коллаба-событие осталось без второго владельца и было создано этим запросом — удаляется."""
    me = int(client["sub"])
    req = await db.fetchrow("SELECT * FROM hub_collab_requests WHERE id=$1", request_id)
    if not req or req["to_client_id"] != me:
        raise HTTPException(404, "Запрос не найден")
    if req["status"] == "pending":
        return {"ok": True, "status": "pending"}  # уже думаю
    async with db.transaction():
        if req["status"] == "accepted" and req["event_id"]:
            ev_id = req["event_id"]
            # я (acceptor) выхожу из коллабы
            await db.execute("DELETE FROM event_owners WHERE event_id=$1 AND client_id=$2 AND role='co_owner'", ev_id, me)
            cnt = await db.fetchval("SELECT count(*) FROM event_owners WHERE event_id=$1 AND status='accepted'", ev_id)
            if (cnt or 0) <= 1:
                await db.execute("UPDATE events SET is_collab=FALSE WHERE id=$1", ev_id)
            # если событие было создано ЭТИМ запросом (название «Событие между …») и без участников — удаляем, чтобы не висело пустым
            has_parts = await db.fetchval("SELECT EXISTS(SELECT 1 FROM event_participants WHERE event_id=$1)", ev_id)
            ev = await db.fetchrow("SELECT title, status FROM events WHERE id=$1", ev_id)
            if ev and not has_parts and (ev["title"] or "").startswith("Событие между ") and ev["status"] == "draft":
                await db.execute("DELETE FROM events WHERE id=$1", ev_id)
                await db.execute("UPDATE hub_collab_requests SET event_id=NULL WHERE id=$1", request_id)
        await db.execute("UPDATE hub_collab_requests SET status='pending', responded_at=NULL, decline_reason=NULL WHERE id=$1", request_id)
    return {"ok": True, "status": "pending"}


@router.delete("/requests/{request_id}")
async def delete_request(request_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Удалить СВОЙ отправленный запрос (только инициатор, только пока не принят)."""
    me = int(client["sub"])
    req = await db.fetchrow("SELECT from_client_id, status FROM hub_collab_requests WHERE id=$1", request_id)
    if not req or req["from_client_id"] != me:
        raise HTTPException(404, "Запрос не найден или не ваш")
    if req["status"] == "accepted":
        raise HTTPException(409, "Запрос уже принят — коллаба создана, удалить нельзя")
    await db.execute("DELETE FROM hub_collab_requests WHERE id=$1", request_id)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# Владельцы (Организаторы) события
# ═══════════════════════════════════════════════════════════════
@router.get("/events/{event_id}/owners")
async def event_owners(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Организаторы события (статусы серый/зелёный). Видит любой из владельцев."""
    me = int(client["sub"])
    iam = await db.fetchval(
        "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2", event_id, me)
    if not iam:
        raise HTTPException(403, "Вы не организатор этого события")
    rows = await db.fetch(
        """SELECT o.client_id, c.name, c.telegram_username, o.status, o.role, o.created_at, o.responded_at
             FROM event_owners o LEFT JOIN clients c ON c.id=o.client_id
            WHERE o.event_id=$1 ORDER BY o.role='owner' DESC, o.created_at""", event_id)
    return {"owners": [dict(r) for r in rows]}


@router.get("/events/{event_id}/organizers")
async def collab_organizers_with_links(event_id: int, mode: Optional[str] = None,
                                       client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Организаторы коллаб-события (раздел «Люди» → «Организаторы») + реф-ссылки КАЖДОГО.

    ⚠️ КЛЮЧЕВОЕ ДЛЯ КОЛЛАБЫ: у каждого организатора СВОЙ VIP-бот и СВОЯ база.
    Поэтому ссылка каждого строится через ЕГО бота (build_share_links с его client_id),
    а не через бота владельца события. Реф-код (pid) — его собственный (contacts.ref_code
    его self-коллаба), чтобы приведённые им люди засчитались ему (вклад в hub_collab_history).
    """
    from app.services.share_links import build_share_links, resolve_event_link_mode
    from app.services.self_collaborator import ensure_self_collaborator
    me = int(client["sub"])
    iam = await db.fetchval(
        "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'", event_id, me)
    if not iam:
        raise HTTPException(403, "Вы не организатор этого события")
    ev = await db.fetchrow("SELECT slug, link_mode FROM events WHERE id=$1", event_id)
    if not ev:
        raise HTTPException(404, "Событие не найдено")

    # Реф-код организатора живёт в его self-коллабе. У старых клиентов его могло не быть
    # (создаётся при регистрации) — гарантируем идемпотентно, иначе ссылка уйдёт без pid
    # и приведённые им люди не засчитаются ему в вклад.
    owner_ids = await db.fetch(
        "SELECT client_id FROM event_owners WHERE event_id=$1 AND status='accepted'", event_id)
    for o in owner_ids:
        try:
            await ensure_self_collaborator(db, o["client_id"])
        except Exception:
            pass  # не роняем список из-за одного клиента

    # У каждого организатора должна быть КАРТОЧКА в событии (event_collaborators,
    # role='organizer') — там живут тема, подарки, афиша (как у спикера конференции).
    # Заводим её из его self-коллаба, идемпотентно.
    for o in owner_ids:
        await _ensure_organizer_card(db, event_id, o["client_id"])

    rows = await db.fetch(
        """SELECT o.client_id, o.role, o.status,
                  c.name, c.brand_name, c.telegram_username,
                  COALESCE(c.owner_photo_url, c.profile_photo_url) AS photo_url,
                  c.self_collaborator_id,
                  -- Реф-код организатора = ref_code контакта его self-коллаба
                  (SELECT ct.ref_code FROM collaborators col
                     JOIN contacts ct ON ct.id = col.contact_id
                    WHERE col.id = c.self_collaborator_id) AS ref_code,
                  -- Карточка этого организатора в событии
                  (SELECT ec.id FROM event_collaborators ec
                    WHERE ec.event_id = $1 AND ec.speaker_id = c.self_collaborator_id) AS ec_id
             FROM event_owners o
             JOIN clients c ON c.id = o.client_id
            WHERE o.event_id=$1 AND o.status='accepted'
            ORDER BY (o.role='owner') DESC, o.id""", event_id)

    out = []
    for r in rows:
        d = dict(r)
        d["is_me"] = d["client_id"] == me
        out.append(d)
    # ⚠️ Ссылки здесь НЕ отдаём — это просто список людей.
    # Реф-ссылки живут внутри карточки организатора (вкладка «Ссылки»).
    return {"organizers": out, "slug": ev["slug"]}


async def _ensure_organizer_card(db, event_id: int, client_id: int) -> Optional[int]:
    """Гарантирует карточку организатора в событии (event_collaborators, role='organizer').

    Организатор коллабы — это КЛИЕНТ (event_owners). Но тема/подарки/афиша живут на
    карточке человека в событии (event_collaborators, как у спикера конференции).
    Мост между ними — self-коллаб клиента (clients.self_collaborator_id).
    Идемпотентно: есть карточка → вернуть её id.
    """
    from app.services.self_collaborator import ensure_self_collaborator
    try:
        collab_id = await ensure_self_collaborator(db, client_id)
    except Exception:
        collab_id = None
    if not collab_id:
        return None
    ec_id = await db.fetchval(
        "SELECT id FROM event_collaborators WHERE event_id=$1 AND speaker_id=$2", event_id, collab_id)
    if ec_id:
        return ec_id
    return await db.fetchval(
        """INSERT INTO event_collaborators (speaker_id, event_id, role, sort_order)
           VALUES ($1, $2, 'organizer',
                   COALESCE((SELECT MAX(sort_order)+1 FROM event_collaborators
                              WHERE event_id=$2 AND role='organizer'), 0))
           RETURNING id""",
        collab_id, event_id)


# ═══════════════════════════════════════════════════════════════
# Карточка организатора внутри коллаб-события
# (как карточка спикера конференции: «Выступление» + «Ссылки»)
# ═══════════════════════════════════════════════════════════════
class OrganizerCardUpdate(BaseModel):
    topics: Optional[list] = None            # список тем (conf_speaker_topics)
    poster_id: Optional[int] = None          # индивидуальная афиша из библиотеки коллаба
    # ⚠️ Подарки в коллабе — ТОЛЬКО из ПЛЮСОНа (до 4). Полей «название текстом + ссылка»
    # здесь НЕТ (в отличие от конференции, где можно задать вручную).
    gift_lead_magnets: Optional[list] = None  # [{kind:'magnet'|'package', id:int}]


async def _organizer_ctx(db, event_id: int, client_id: int, me: int):
    """Общая проверка: я организатор события; целевой client_id — тоже организатор.
    Возвращает (ec_id, collab_id, can_edit). can_edit=True только для СВОЕЙ карточки."""
    iam = await db.fetchval(
        "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'", event_id, me)
    if not iam:
        raise HTTPException(403, "Вы не организатор этого события")
    target = await db.fetchval(
        "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'", event_id, client_id)
    if not target:
        raise HTTPException(404, "Организатор не найден в этом событии")
    ec_id = await _ensure_organizer_card(db, event_id, client_id)
    if not ec_id:
        raise HTTPException(400, "Не удалось создать карточку организатора")
    collab_id = await db.fetchval("SELECT self_collaborator_id FROM clients WHERE id=$1", client_id)
    return ec_id, collab_id, (client_id == me)


@router.get("/events/{event_id}/organizers/{client_id}")
async def get_organizer_card(event_id: int, client_id: int, mode: Optional[str] = None,
                             client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Карточка организатора в коллаб-событии: профиль + тема + подарки (из ПЛЮСОНа) +
    афиша + реф-ссылки ЧЕРЕЗ ЕГО БОТА. Чужую карточку видно, но редактировать нельзя."""
    from app.services.share_links import build_share_links, resolve_event_link_mode
    me = int(client["sub"])
    ec_id, collab_id, can_edit = await _organizer_ctx(db, event_id, client_id, me)

    ev = await db.fetchrow("SELECT slug, link_mode, status FROM events WHERE id=$1", event_id)
    row = await db.fetchrow(
        """SELECT c.id AS client_id, c.name, c.brand_name,
                  COALESCE(c.owner_photo_url, c.profile_photo_url) AS photo_url,
                  c.owner_positioning, c.positioning,
                  o.role,
                  (SELECT ct.ref_code FROM collaborators col JOIN contacts ct ON ct.id=col.contact_id
                    WHERE col.id = c.self_collaborator_id) AS ref_code,
                  ec.poster_id
             FROM event_owners o
             JOIN clients c ON c.id=o.client_id
             LEFT JOIN event_collaborators ec ON ec.id = $3
            WHERE o.event_id=$1 AND o.client_id=$2""", event_id, client_id, ec_id)

    topics = await db.fetch(
        "SELECT id, topic, sort_order FROM conf_speaker_topics WHERE cse_id=$1 ORDER BY sort_order, id", ec_id)

    gifts = await db.fetch(
        """SELECT g.lead_magnet_id, g.package_id, g.sort_order,
                  lm.name AS lm_name, lp.name AS lp_name
             FROM event_collaborator_lead_magnets g
             LEFT JOIN lead_magnets lm ON lm.id = g.lead_magnet_id
             LEFT JOIN lead_magnet_packages lp ON lp.id = g.package_id
            WHERE g.ec_id=$1 ORDER BY g.sort_order, g.id""", ec_id)
    gift_list = [
        {"kind": "magnet", "id": g["lead_magnet_id"], "name": g["lm_name"]} if g["lead_magnet_id"]
        else {"kind": "package", "id": g["package_id"], "name": g["lp_name"]}
        for g in gifts
    ]

    posters = await db.fetch(
        "SELECT id, url, label FROM collaborator_posters WHERE collaborator_id=$1 ORDER BY sort_order, id",
        collab_id) if collab_id else []

    # ⚠️ Режим регистрации — ЛИЧНЫЙ у каждого организатора (его настройка «Бот и ссылки»):
    # у одного Mini App, у другого веб. И площадки только ЕГО (у кого есть MAX — с MAX,
    # у кого только TG — только TG). Поэтому и режим, и ссылки считаем по ЕГО client_id.
    lm = mode if mode in ("miniapp", "bot") else await resolve_event_link_mode(
        db, client_id=client_id, event_link_mode=ev["link_mode"])
    links = await build_share_links(
        db, client_id=client_id, event_slug=ev["slug"],
        partner_id=row["ref_code"] if row else None, link_mode=lm)

    d = dict(row) if row else {}
    d["positioning"] = d.pop("owner_positioning", None) or d.pop("positioning", None)
    return {
        "ec_id": ec_id,
        "can_edit": can_edit,
        "is_me": can_edit,
        "event_status": ev["status"],
        "organizer": d,
        "topics": [dict(t) for t in topics],
        "gift_lead_magnets": gift_list,
        "posters": [dict(p) for p in posters],
        "links": links,
        "link_mode": lm,          # 'miniapp' | 'bot' — как регистрирует ЭТОТ организатор
        "slug": ev["slug"],
    }


@router.patch("/events/{event_id}/organizers/{client_id}")
async def update_organizer_card(event_id: int, client_id: int, data: OrganizerCardUpdate,
                                client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Сохранить СВОЮ карточку организатора (тема / подарки из ПЛЮСОНа / афиша).
    ⚠️ Чужую карточку править нельзя — 403."""
    me = int(client["sub"])
    ec_id, collab_id, can_edit = await _organizer_ctx(db, event_id, client_id, me)
    if not can_edit:
        raise HTTPException(403, "Можно редактировать только свою карточку")

    fs = data.model_fields_set

    # Темы — переписываем список целиком
    if "topics" in fs:
        topics = [str(t).strip() for t in (data.topics or []) if str(t).strip()]
        await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id=$1", ec_id)
        for i, t in enumerate(topics):
            await db.execute(
                "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1,$2,$3)", ec_id, t, i)

    # Афиша — из библиотеки ЭТОГО коллаба
    if "poster_id" in fs:
        pid = data.poster_id
        if pid:
            ok = await db.fetchval(
                "SELECT 1 FROM collaborator_posters WHERE id=$1 AND collaborator_id=$2", pid, collab_id)
            if not ok:
                raise HTTPException(400, "Афиша не найдена в вашей библиотеке")
        await db.execute("UPDATE event_collaborators SET poster_id=$2 WHERE id=$1", ec_id, pid)

    # Подарки — ТОЛЬКО из ПЛЮСОНа этого клиента, до 4
    if "gift_lead_magnets" in fs:
        items = data.gift_lead_magnets or []
        if len(items) > 4:
            raise HTTPException(400, "Можно привязать не более 4 подарков")
        clean = []
        for it in items:
            kind = (it or {}).get("kind")
            try:
                iid = int((it or {}).get("id") or 0)
            except (ValueError, TypeError):
                iid = 0
            if iid <= 0 or kind not in ("magnet", "package"):
                continue
            table = "lead_magnets" if kind == "magnet" else "lead_magnet_packages"
            ok = await db.fetchval(
                f"SELECT 1 FROM {table} WHERE id=$1 AND client_id=$2", iid, client_id)
            if not ok:
                raise HTTPException(400, "Подарок не найден в вашем ПЛЮСОНе")
            clean.append((kind, iid))
        await db.execute("DELETE FROM event_collaborator_lead_magnets WHERE ec_id=$1", ec_id)
        for i, (kind, iid) in enumerate(clean):
            if kind == "magnet":
                await db.execute(
                    "INSERT INTO event_collaborator_lead_magnets (ec_id, lead_magnet_id, sort_order) VALUES ($1,$2,$3)",
                    ec_id, iid, i)
            else:
                await db.execute(
                    "INSERT INTO event_collaborator_lead_magnets (ec_id, package_id, sort_order) VALUES ($1,$2,$3)",
                    ec_id, iid, i)

    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# Коллабы — список совместных событий, где я владелец (с ФИО организаторов)
# ═══════════════════════════════════════════════════════════════
@router.get("/collabs")
async def my_collabs(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Мои коллабы (совместные события). С названием и ФИО всех организаторов."""
    me = int(client["sub"])
    rows = await db.fetch(
        """SELECT e.id AS event_id, e.title, e.status, e.is_collab,
                  (SELECT json_agg(json_build_object('client_id', o2.client_id,
                          'name', c2.name, 'role', o2.role)
                          ORDER BY (o2.role='owner') DESC, o2.id)
                     FROM event_owners o2 JOIN clients c2 ON c2.id=o2.client_id
                    WHERE o2.event_id=e.id AND o2.status='accepted') AS organizers
             FROM events e
             JOIN event_owners o ON o.event_id=e.id AND o.client_id=$1 AND o.status='accepted'
            WHERE e.is_collab=TRUE
            ORDER BY e.created_at DESC""", me)
    import json as _json
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("organizers"), str):
            try: d["organizers"] = _json.loads(d["organizers"])
            except Exception: d["organizers"] = []
        out.append(d)
    return {"collabs": out}


# ═══════════════════════════════════════════════════════════════
# Отзыв согласия — выйти из коллабы
# ═══════════════════════════════════════════════════════════════
@router.post("/events/{event_id}/leave")
async def leave_collab(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Отозвать согласие / выйти из коллабы. Owner (создатель) выйти не может — он распускает коллабу удалением события."""
    me = int(client["sub"])
    row = await db.fetchrow("SELECT role FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'", event_id, me)
    if not row:
        raise HTTPException(404, "Вы не участник этой коллабы")
    if row["role"] == 'owner':
        raise HTTPException(403, "Вы создатель коллабы — чтобы распустить, удалите событие. Выйти может только присоединившийся.")
    await db.execute("DELETE FROM event_owners WHERE event_id=$1 AND client_id=$2", event_id, me)
    # если остался 1 владелец — событие перестаёт быть коллабой
    cnt = await db.fetchval("SELECT count(*) FROM event_owners WHERE event_id=$1 AND status='accepted'", event_id)
    if (cnt or 0) <= 1:
        await db.execute("UPDATE events SET is_collab=FALSE WHERE id=$1", event_id)
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# Умный сват — подбор партнёра по нише + медийность + рейтинг
# ═══════════════════════════════════════════════════════════════
@router.get("/matchmaker")
async def matchmaker(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Подбор 3-5 партнёров-организаторов: моя ниша → близкие, лучше рейтинг. Не я. Данные из clients."""
    me = int(client["sub"])
    mine = await db.fetchrow("SELECT hub_niche, hub_city FROM clients WHERE id=$1", me)
    niche = mine["hub_niche"] if mine else None
    rows = await db.fetch(
        """SELECT cl.id AS client_id, cl.name AS name, cl.name AS owner_name, cl.brand_name,
                  cl.hub_about, cl.bio, cl.owner_positioning, cl.positioning,
                  COALESCE(cl.owner_photo_url,cl.profile_photo_url) AS photo_url,
                  cl.hub_category, cl.hub_niche, cl.hub_city, cl.media_assets,
                  (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=cl.id) AS collabs_count,
                  (cl.hub_niche IS NOT DISTINCT FROM $2) AS same_niche
             FROM clients cl
            WHERE cl.is_published_in_hub=TRUE AND cl.id<>$1
            ORDER BY (cl.hub_niche IS NOT DISTINCT FROM $2) DESC, collabs_count DESC NULLS LAST, cl.hub_published_at DESC NULLS LAST
            LIMIT 5""", me, niche)
    out = []
    for r in rows:
        d = dict(r)
        d['media_tier'] = _media_tier_from(d.pop('media_assets', None))
        # positioning: приоритет у позиционирования основателя (как в _client_card)
        d['positioning'] = d.pop('owner_positioning', None) or d.pop('positioning', None)
        out.append(d)
    return {"my_niche": niche, "suggestions": out}


def _media_tier_from(ma) -> str:
    import json as _j
    try:
        arr = ma if isinstance(ma, list) else (_j.loads(ma) if ma else [])
        s = sum(int(a.get('subscribers') or 0) for a in arr if isinstance(a, dict))
    except Exception:
        s = 0
    return 'over_10k' if s>=10000 else '5k_10k' if s>=5000 else '1k_5k' if s>=1000 else 'under_1k'


# ═══════════════════════════════════════════════════════════════
# Отзывы
# ═══════════════════════════════════════════════════════════════
class ReviewIn(BaseModel):
    client_id: int    # о ком
    rating: int
    text: Optional[str] = None


# ═══════════════════════════════════════════════════════════════
# Рассылки коллаб-события — подтверждение постановки по МОЕЙ базе
# ═══════════════════════════════════════════════════════════════
@router.get("/broadcast-confirmations")
async def broadcast_confirmations(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Мои рассылки коллаб-событий, ожидающие подтверждения (сгруппированы по пакетам).
    Инициатор (origin) попросил разослать это по МОЕЙ базе — я решаю."""
    me = int(client["sub"])
    rows = await db.fetch(
        """SELECT bs.confirm_batch_id, bs.event_id, e.title AS event_title,
                  bs.origin_client_id, COALESCE(oc.brand_name, oc.name) AS origin_name,
                  count(*) AS msg_count, min(bs.fire_at) AS first_fire_at,
                  (array_agg(bs.snapshot_text ORDER BY bs.fire_at))[1] AS sample_text,
                  min(bs.created_at) AS created_at
             FROM broadcast_schedules bs
             LEFT JOIN events e ON e.id = bs.event_id
             LEFT JOIN clients oc ON oc.id = bs.origin_client_id
            WHERE bs.client_id = $1 AND bs.status = 'awaiting_confirm'
              AND bs.confirm_batch_id IS NOT NULL
            GROUP BY bs.confirm_batch_id, bs.event_id, e.title, bs.origin_client_id, oc.brand_name, oc.name
            ORDER BY min(bs.created_at) DESC""", me)
    return {"confirmations": [dict(r) for r in rows]}


@router.post("/broadcast-confirmations/{batch_id}")
async def respond_broadcast_confirmation(batch_id: str, body: dict,
                                         client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Подтвердить/отклонить весь пакет рассылок по МОЕЙ базе.
    accept=true → все мои копии пакета → pending (уйдут по моей базе/боту).
    accept=false → cancelled. Затрагиваются ТОЛЬКО мои строки (client_id=я)."""
    me = int(client["sub"])
    accept = bool(body.get("accept"))
    n = await db.fetchval(
        "SELECT count(*) FROM broadcast_schedules WHERE confirm_batch_id=$1 AND client_id=$2 AND status='awaiting_confirm'",
        batch_id, me)
    if not n:
        raise HTTPException(404, "Пакет не найден или уже обработан")
    new_status = "pending" if accept else "cancelled"
    await db.execute(
        "UPDATE broadcast_schedules SET status=$3 WHERE confirm_batch_id=$1 AND client_id=$2 AND status='awaiting_confirm'",
        batch_id, me, new_status)
    return {"ok": True, "status": new_status, "affected": n}


@router.get("/broadcast-confirmations/count")
async def broadcast_confirmations_count(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Число пакетов, ожидающих моего подтверждения — для бейджа в сайдбаре/разделе."""
    me = int(client["sub"])
    n = await db.fetchval(
        """SELECT count(DISTINCT confirm_batch_id) FROM broadcast_schedules
            WHERE client_id=$1 AND status='awaiting_confirm' AND confirm_batch_id IS NOT NULL""", me)
    return {"count": n or 0}


@router.post("/reviews")
async def add_review(data: ReviewIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    me = int(client["sub"])
    if data.client_id == me:
        raise HTTPException(400, "Нельзя оставить отзыв самому себе")
    if not (1 <= data.rating <= 5):
        raise HTTPException(400, "Оценка 1..5")
    await db.execute(
        """INSERT INTO hub_reviews (client_id, author_client_id, rating, text)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (client_id, author_client_id)
           DO UPDATE SET rating=$3, text=$4, created_at=NOW()""",
        data.client_id, me, data.rating, data.text)
    return {"ok": True}
