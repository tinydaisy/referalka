"""
API регистрации участников события (миграция 036+).

Использует helper `upsert_contact_with_identity` — автомердж по email/phone
и единая точка входа контакта в систему.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.services.contact_merge import upsert_contact_with_identity

router = APIRouter(prefix="/participants", tags=["Участники"])


class RegisterParticipantRequest(BaseModel):
    event_slug: str
    tg_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    ref_code: Optional[str] = None
    partner_tg_id: Optional[str] = None


@router.post("/register", summary="Зарегистрировать участника в событии")
async def register_participant(
    data: RegisterParticipantRequest,
    db: asyncpg.Connection = Depends(get_db)
):
    event = await db.fetchrow(
        "SELECT id, client_id FROM events WHERE slug = $1 AND status = 'published'",
        data.event_slug
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено или не опубликовано")

    # Создаём/находим контакт + идентичность (автомердж по email/phone)
    contact_id, _platform_user_id, _is_new_contact = await upsert_contact_with_identity(
        db,
        client_id=event["client_id"],
        platform_slug='telegram',
        platform_user_id=str(data.tg_id),
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
        email=data.email,
        phone=data.phone,
    )

    # Уже зарегистрирован?
    existing = await db.fetchrow(
        """SELECT ep.id, c.ref_code, ep.is_registered
             FROM event_participants ep
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ep.event_id = $1 AND ep.contact_id = $2""",
        event["id"], contact_id
    )
    if existing:
        # Запись есть, но человек был только «интересующимся» (например,
        # event_start при открытии Mini App не дошёл до формы). Раз он
        # снова прошёл форму — фиксируем как зарегистрированного.
        if not existing["is_registered"]:
            await db.execute(
                "UPDATE event_participants SET is_registered = TRUE WHERE id = $1",
                existing["id"]
            )
        return {"participant": dict(existing), "is_new": False}

    # Резолв реферера: если передан ref_code — берём, иначе через partner_tg_id
    resolved_ref_code = data.ref_code
    if not resolved_ref_code and data.partner_tg_id:
        partner_code = await db.fetchval(
            """SELECT c.ref_code
                 FROM platform_users pu
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE pu.client_id = $1 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $2""",
            event["client_id"], str(data.partner_tg_id)
        )
        if partner_code:
            resolved_ref_code = partner_code

    # Если контакт-реферер тоже участник этого события — связываем
    referrer_participant_id = None
    if resolved_ref_code:
        referrer_participant_id = await db.fetchval(
            """SELECT ep.id
                 FROM contacts c
                 JOIN event_participants ep ON ep.contact_id = c.id
                WHERE c.ref_code = $1 AND ep.event_id = $2""",
            resolved_ref_code, event["id"]
        )

    # ref_code контакта (уже создан в upsert_contact_with_identity, но получим для ответа)
    user_ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", contact_id)

    # Регистрация через форму = is_registered=true. Иначе человек так
    # и останется в статусе «интересовался» и будет получать форму
    # регистрации каждый раз при открытии Mini App.
    participant = await db.fetchrow(
        """INSERT INTO event_participants
              (event_id, contact_id, referrer_participant_id, referrer_ref_code, is_registered)
            VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id""",
        event["id"], contact_id, referrer_participant_id, resolved_ref_code
    )

    return {
        "participant": {"id": participant["id"], "ref_code": user_ref_code},
        "is_new": True
    }


@router.post("/{participant_id}/activate", summary="Активировать участника")
async def activate_participant(participant_id: int, db: asyncpg.Connection = Depends(get_db)):
    await db.execute(
        "UPDATE event_participants SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL",
        participant_id
    )
    return {"activated": True}


@router.get("/telegram/{tg_id}/events", summary="События участника по tg_id")
async def get_participant_events(tg_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT e.id, e.slug, e.title, e.module_slug, e.status,
                  (SELECT url FROM event_posters
                    WHERE event_id = e.id
                    ORDER BY CASE orientation
                               WHEN 'square'     THEN 1
                               WHEN 'horizontal' THEN 2
                               WHEN 'vertical'   THEN 3
                               ELSE 4
                             END, sort, id
                    LIMIT 1) AS poster_url,
                  ep.id AS participant_id, c.ref_code, ep.is_registered, ep.is_in_chat
             FROM event_participants ep
             JOIN events e ON e.id = ep.event_id
             JOIN contacts c ON c.id = ep.contact_id
             JOIN platform_users pu ON pu.contact_id = c.id
            WHERE pu.platform_slug = 'telegram' AND pu.platform_user_id = $1
            ORDER BY ep.registered_at DESC""",
        str(tg_id)
    )
    return {"events": [dict(r) for r in rows]}


@router.get(
    "/miniapp/me/events",
    summary="События участника для селектора общего бота (группировка по организатору)",
)
async def get_miniapp_me_events(tg_id: int, db: asyncpg.Connection = Depends(get_db)):
    # Селектор @pluson_bot показывает группы организаторов:
    #   1. Клиенты, у которых пользователь был участником ИЛИ владельцем (по telegram_username).
    #   2. VIP-клиенты (tariffs.allow_custom_bot = true) ИСКЛЮЧАЮТСЯ — у них свой бот со своим хабом.
    # В каждой группе:
    #   • будущие/идущие опубликованные события клиента — ВСЕ (промо для участника);
    #   • прошедшие события — только те, где пользователь был участником (личная история);
    #   • для владельца клиента — все опубликованные/завершённые события его клиента.
    # Для конференций даты — из conf_days (MIN/MAX), не из events.start_at/end_at.
    rows = await db.fetch(
        """WITH user_username AS (
              SELECT username FROM platform_users
               WHERE platform_slug = 'telegram' AND platform_user_id = $1
               LIMIT 1
           ),
           participant_events AS (
              SELECT DISTINCT ON (ep.event_id)
                     ep.event_id, ep.id AS participant_id, c.ref_code,
                     ep.is_registered, ep.is_in_chat
                FROM event_participants ep
                JOIN contacts c        ON c.id  = ep.contact_id
                JOIN platform_users pu ON pu.contact_id = c.id
               WHERE pu.platform_slug = 'telegram' AND pu.platform_user_id = $1
           ),
           owned_clients AS (
              -- LTRIM '@' — clients.telegram_username исторически бывает с собакой,
              -- platform_users.username хранится без неё.
              SELECT cl.id FROM clients cl
               WHERE cl.telegram_username IS NOT NULL
                 AND LOWER(LTRIM(cl.telegram_username, '@')) =
                     LOWER((SELECT username FROM user_username))
           ),
           relevant_clients AS (
              SELECT DISTINCT e.client_id AS id
                FROM events e
                JOIN participant_events pe ON pe.event_id = e.id
              UNION
              SELECT id FROM owned_clients
           ),
           allowed_clients AS (
              SELECT cl.id FROM clients cl
               LEFT JOIN tariffs t ON t.slug = cl.tariff_slug
               WHERE cl.id IN (SELECT id FROM relevant_clients)
                 AND COALESCE(t.allow_custom_bot, false) = false
           ),
           conf_dates AS (
              -- start = первый день: open_time дня 1, иначе MIN(start_time) сессий дня 1
              -- end   = последний день: close_time, иначе MAX(end_time) сессий посл. дня
              SELECT d.event_id,
                     (SELECT (d2.day_date + COALESCE(
                                NULLIF(d2.open_time,'')::time,
                                (SELECT MIN(NULLIF(s.start_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                '00:00'::time
                              )) AT TIME ZONE 'Europe/Moscow'
                        FROM conf_days d2
                        WHERE d2.event_id = d.event_id
                        ORDER BY d2.day_number ASC LIMIT 1) AS start_at,
                     (SELECT (d2.day_date + COALESCE(
                                NULLIF(d2.close_time,'')::time,
                                (SELECT MAX(NULLIF(s.end_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                (SELECT MAX(NULLIF(s.start_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                '23:59'::time
                              )) AT TIME ZONE 'Europe/Moscow'
                        FROM conf_days d2
                        WHERE d2.event_id = d.event_id
                        ORDER BY d2.day_number DESC LIMIT 1) AS end_at
                FROM conf_days d
               GROUP BY d.event_id
           )
           SELECT e.id, e.slug, e.title, e.module_slug, e.status,
                  (SELECT url FROM event_posters
                    WHERE event_id = e.id
                    ORDER BY CASE orientation
                               WHEN 'square'     THEN 1
                               WHEN 'horizontal' THEN 2
                               WHEN 'vertical'   THEN 3
                               ELSE 4
                             END, sort, id
                    LIMIT 1) AS poster_url,
                  CASE WHEN e.module_slug = 'conference'
                       THEN cd.start_at ELSE e.start_at END AS start_at,
                  CASE WHEN e.module_slug = 'conference'
                       THEN cd.end_at   ELSE e.end_at   END AS end_at,
                  pe.participant_id, pe.ref_code,
                  COALESCE(pe.is_registered, false) AS is_registered,
                  COALESCE(pe.is_in_chat,    false) AS is_in_chat,
                  cl.id   AS client_id,
                  cl.name AS client_name,
                  cl.brand_name        AS client_brand_name,
                  cl.profile_photo_url AS client_photo_url,
                  cl.positioning       AS client_positioning
             FROM events e
             JOIN clients cl ON cl.id = e.client_id
             LEFT JOIN participant_events pe ON pe.event_id = e.id
             LEFT JOIN conf_dates cd ON cd.event_id = e.id
            WHERE e.client_id IN (SELECT id FROM allowed_clients)
              AND e.status IN ('published', 'ended')
              AND (
                -- будущие/идущие опубликованные — все, как промо
                (e.status = 'published' AND (
                   (CASE WHEN e.module_slug = 'conference' THEN cd.end_at ELSE e.end_at END) IS NULL
                   OR (CASE WHEN e.module_slug = 'conference' THEN cd.end_at ELSE e.end_at END) >= NOW()
                ))
                -- прошедшие — только если пользователь был участником
                OR pe.event_id IS NOT NULL
                -- владелец клиента — все опубликованные/завершённые
                OR e.client_id IN (SELECT id FROM owned_clients)
              )""",
        str(tg_id),
    )

    from datetime import datetime, timezone
    now_ts = datetime.now(timezone.utc)

    # 1) Раскладываем события по группам организаторов и определяем bucket
    groups: dict[int, dict] = {}
    for r in rows:
        item = dict(r)
        if item.get("start_at"): item["start_at"] = item["start_at"].isoformat()
        if item.get("end_at"):   item["end_at"]   = item["end_at"].isoformat()

        start = r["start_at"]
        end   = r["end_at"]
        status = (r["status"] or "").lower()

        is_live = status == "live" or (start and end and start <= now_ts <= end)
        is_past = status in ("archived", "ended", "completed") or (end and end < now_ts)
        item["bucket"] = "now" if is_live else ("past" if is_past else "soon")

        # Статус участия пользователя в событии:
        #   нет записи в event_participants → 'new' (ещё не открывал событие)
        #   запись есть, is_registered=false → 'interested'
        #   запись есть, is_registered=true  → 'registered'
        if r["participant_id"] is None:
            item["participation_status"] = "new"
        elif r["is_registered"]:
            item["participation_status"] = "registered"
        else:
            item["participation_status"] = "interested"

        cid = item["client_id"]
        if cid not in groups:
            groups[cid] = {
                "client_id":          cid,
                "client_name":        item.get("client_name"),
                "client_brand_name":  item.get("client_brand_name"),
                "client_photo_url":   item.get("client_photo_url"),
                "client_positioning": item.get("client_positioning"),
                "events": [],
            }
        groups[cid]["events"].append(item)

    # 2) Внутри группы: now (asc) → soon (asc) → past (desc по end_at)
    for g in groups.values():
        evs = g["events"]
        now_evs  = sorted([e for e in evs if e["bucket"] == "now"],
                          key=lambda e: e.get("start_at") or "")
        soon_evs = sorted([e for e in evs if e["bucket"] == "soon"],
                          key=lambda e: e.get("start_at") or "9999")
        past_evs = sorted([e for e in evs if e["bucket"] == "past"],
                          key=lambda e: e.get("end_at") or "", reverse=True)
        g["events"] = now_evs + soon_evs + past_evs

    # 3) Сортировка групп: сначала с будущими (по ближайшему ASC),
    #    потом только-прошедшие (по самому свежему прошедшему DESC).
    def nearest_future(g: dict) -> str | None:
        candidates = [e["start_at"] for e in g["events"]
                      if e["bucket"] in ("now", "soon") and e.get("start_at")]
        return min(candidates) if candidates else None

    def nearest_past(g: dict) -> str | None:
        candidates = [e["end_at"] for e in g["events"]
                      if e["bucket"] == "past" and e.get("end_at")]
        return max(candidates) if candidates else None

    with_future = []
    only_past   = []
    for g in groups.values():
        # Группа считается «с будущим», если в ней есть события now/soon
        has_future = any(e["bucket"] in ("now", "soon") for e in g["events"])
        if has_future:
            with_future.append(g)
        else:
            only_past.append(g)

    # ближайшее будущее ASC; группы без даты в будущем — в конец этого блока
    with_future.sort(key=lambda g: (nearest_future(g) is None, nearest_future(g) or ""))
    # самое свежее прошедшее DESC
    only_past.sort(key=lambda g: nearest_past(g) or "", reverse=True)

    return {"groups": with_future + only_past}


@router.get("/event/{event_slug}/user/{tg_id}", summary="Данные участника в событии")
async def get_participant_in_event(
    event_slug: str,
    tg_id: int,
    db: asyncpg.Connection = Depends(get_db)
):
    # Контакт у клиента ЭТОГО события (по tg_id). Email/phone отсюда —
    # если оба поля заполнены, фронт пропускает форму регистрации.
    prefill = await db.fetchrow(
        """SELECT c.email, c.phone, c.name
             FROM events e
             JOIN platform_users pu ON pu.client_id = e.client_id
                                    AND pu.platform_slug = 'telegram'
                                    AND pu.platform_user_id = $2
             JOIN contacts c ON c.id = pu.contact_id
            WHERE e.slug = $1
            LIMIT 1""",
        event_slug, str(tg_id)
    )
    prefill_dict = dict(prefill) if prefill else None

    row = await db.fetchrow(
        """SELECT ep.id, c.ref_code, ep.is_registered, ep.is_in_chat, ep.registered_at, ep.activated_at,
                  e.title AS event_title, e.module_slug
             FROM event_participants ep
             JOIN events e ON e.id = ep.event_id
             JOIN contacts c ON c.id = ep.contact_id
             JOIN platform_users pu ON pu.contact_id = c.id
            WHERE e.slug = $1 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $2
            LIMIT 1""",
        event_slug, str(tg_id)
    )
    if not row:
        # Участника ещё нет — но prefill может быть (контакт уже в базе клиента
        # из другого события или из импорта). Возвращаем 200, не 404.
        return {"participant": None, "referrals_count": 0, "prefill": prefill_dict}

    referrals = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE referrer_participant_id = $1",
        row["id"]
    )

    return {"participant": dict(row), "referrals_count": referrals, "prefill": prefill_dict}
