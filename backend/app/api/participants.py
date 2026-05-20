"""
API регистрации участников события (миграция 036+).

Использует helper `upsert_contact_with_identity` — автомердж по email/phone
и единая точка входа контакта в систему.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Literal
import asyncpg

from app.database import get_db
from app.services.contact_merge import upsert_contact_with_identity, resolve_ref_code

router = APIRouter(prefix="/participants", tags=["Участники"])


class RegisterParticipantRequest(BaseModel):
    event_slug: str
    tg_id: int  # Исторически называется tg_id, но это platform_user_id (для VK — vk_user_id)
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    ref_code: Optional[str] = None
    partner_tg_id: Optional[str] = None
    platform: Literal["telegram", "vk", "max"] = "telegram"


async def _resolve_post_register_redirect(db, client_id: int, event_slug: str) -> dict:
    """Куда вернуть пользователя после регистрации через /r/{slug}.

    У VIP-клиента (есть свой telegram-бот в channels с is_system=FALSE) —
    в Mini App его бота `/c/{client_id}/tg/event/{slug}`. Иначе — общий
    @pluson_bot `/tg/event/{slug}`.

    Возвращаем ещё `bot_handle` — для fallback'а в обычном браузере
    (когда нет Telegram.WebApp): `https://t.me/{handle}` для VIP,
    `https://t.me/pluson_bot/pluson?startapp=…` для общего.
    """
    vip_handle = await db.fetchval(
        """SELECT ch.handle
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
              AND cc.is_active = TRUE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id LIMIT 1""",
        client_id
    )
    if vip_handle:
        return {
            "redirect_path": f"/c/{client_id}/tg/event/{event_slug}",
            "bot_handle":    vip_handle.lstrip('@'),
            "is_vip_bot":    True,
        }
    return {
        "redirect_path": f"/tg/event/{event_slug}",
        "bot_handle":    "pluson_bot",
        "is_vip_bot":    False,
    }


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
    redirect = await _resolve_post_register_redirect(db, event["client_id"], data.event_slug)

    # Создаём/находим контакт + идентичность (автомердж по email/phone).
    # platform — 'telegram'/'vk'/'max'. VK Mini App шлёт platform='vk' и в tg_id
    # сидит vk_user_id (это исторически имя поля, не привязка к платформе).
    contact_id, _platform_user_id, _is_new_contact = await upsert_contact_with_identity(
        db,
        client_id=event["client_id"],
        platform_slug=data.platform,
        platform_user_id=str(data.tg_id),
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
        email=data.email,
        phone=data.phone,
    )

    # Уже зарегистрирован?
    existing = await db.fetchrow(
        """SELECT ep.id, c.ref_code, ep.is_registered, ep.referrer_ref_code
             FROM event_participants ep
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ep.event_id = $1 AND ep.contact_id = $2""",
        event["id"], contact_id
    )
    if existing:
        # Запись есть, но человек был только «интересующимся» (например,
        # event_start при открытии Mini App не дошёл до формы). Раз он
        # снова прошёл форму — фиксируем как зарегистрированного.
        # Заодно досчитываем реферера, если он ещё не проставлен и
        # форма пришла с ref_code (event_start мог быть без pid).
        upd_ref_code = None
        upd_referrer_pid = None
        if existing["referrer_ref_code"] is None and data.ref_code:
            upd_ref_code, upd_referrer_contact_id = await resolve_ref_code(
                db, data.ref_code, client_id=event["client_id"]
            )
            if upd_referrer_contact_id:
                upd_referrer_pid = await db.fetchval(
                    """SELECT id FROM event_participants
                        WHERE contact_id = $1 AND event_id = $2 LIMIT 1""",
                    upd_referrer_contact_id, event["id"]
                )

        if not existing["is_registered"] or upd_ref_code:
            await db.execute(
                """UPDATE event_participants
                      SET is_registered = TRUE,
                          referrer_ref_code = COALESCE(referrer_ref_code, $2),
                          referrer_participant_id = COALESCE(referrer_participant_id, $3)
                    WHERE id = $1""",
                existing["id"], upd_ref_code, upd_referrer_pid
            )
            # Останов воронки догрева — теперь зарегистрирован
            try:
                from app.api.event_nurture import start_nurture_run_if_eligible
                await start_nurture_run_if_eligible(
                    db, event_id=event["id"], contact_id=contact_id, is_registered=True,
                )
            except Exception:
                pass
        return {"participant": dict(existing), "is_new": False, **redirect}

    # Резолв реферера: если передан ref_code (может быть legacy длинный из
    # старой ссылки в Salebot) — нормализуем в актуальный короткий через
    # merged_ref_codes. Иначе пробуем достать по partner_tg_id.
    resolved_ref_code = None
    referrer_contact_id = None
    if data.ref_code:
        resolved_ref_code, referrer_contact_id = await resolve_ref_code(
            db, data.ref_code, client_id=event["client_id"]
        )
    if not resolved_ref_code and data.partner_tg_id:
        # Реферер ищется в той же платформе что и сам участник
        # (VK-юзер не может быть приведён через TG-аккаунт партнёра и наоборот).
        partner_row = await db.fetchrow(
            """SELECT c.id, c.ref_code
                 FROM platform_users pu
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE pu.client_id = $1 AND pu.platform_slug = $3 AND pu.platform_user_id = $2""",
            event["client_id"], str(data.partner_tg_id), data.platform
        )
        if partner_row:
            resolved_ref_code = partner_row["ref_code"]
            referrer_contact_id = partner_row["id"]

    # Если контакт-реферер тоже участник этого события — связываем
    referrer_participant_id = None
    if referrer_contact_id:
        referrer_participant_id = await db.fetchval(
            """SELECT id FROM event_participants
                WHERE contact_id = $1 AND event_id = $2 LIMIT 1""",
            referrer_contact_id, event["id"]
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

    # Регистрация = останов воронки догрева (если она была запущена).
    try:
        from app.api.event_nurture import start_nurture_run_if_eligible
        await start_nurture_run_if_eligible(
            db, event_id=event["id"], contact_id=contact_id, is_registered=True,
        )
    except Exception:
        pass

    return {
        "participant": {"id": participant["id"], "ref_code": user_ref_code},
        "is_new": True,
        **redirect,
    }


@router.post("/{participant_id}/activate", summary="Активировать участника")
async def activate_participant(participant_id: int, db: asyncpg.Connection = Depends(get_db)):
    await db.execute(
        "UPDATE event_participants SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL",
        participant_id
    )
    return {"activated": True}


@router.post("/{participant_id}/welcomed", summary="Отметить, что участник увидел welcome-экран")
async def mark_welcomed(participant_id: int, db: asyncpg.Connection = Depends(get_db)):
    """Mini App вызывает один раз — после показа экрана-поздравления
    («Поздравляем с регистрацией!»). Дальше welcome-экран не показывается."""
    await db.execute(
        "UPDATE event_participants SET welcomed_at = NOW() WHERE id = $1 AND welcomed_at IS NULL",
        participant_id
    )
    return {"welcomed": True}


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
async def get_miniapp_me_events(tg_id: int, platform: str = "telegram", db: asyncpg.Connection = Depends(get_db)):
    # Селектор @pluson_bot показывает группы организаторов:
    #   1. Клиенты, у которых пользователь был участником ИЛИ владельцем (по telegram_username).
    #   2. Клиенты с активной фичей 'channels' (свой бот) ИСКЛЮЧАЮТСЯ — у них свой Mini App.
    # В каждой группе:
    #   • будущие/идущие опубликованные события клиента — ВСЕ (промо для участника);
    #   • прошедшие события — только те, где пользователь был участником (личная история);
    #   • для владельца клиента — все опубликованные/завершённые события его клиента.
    # Для конференций даты — из conf_days (MIN/MAX), не из events.start_at/end_at.
    #
    # `platform` (telegram/vk/max) — определяет идентичность пользователя; параметр `tg_id`
    # сохраняет имя для обратной совместимости, но в VK/MAX-контексте туда идёт vk_id/max_id.
    if platform not in ("telegram", "vk", "max"):
        raise HTTPException(status_code=400, detail="Invalid platform")
    rows = await db.fetch(
        """WITH user_username AS (
              SELECT username FROM platform_users
               WHERE platform_slug = $2 AND platform_user_id = $1
               LIMIT 1
           ),
           participant_events AS (
              SELECT DISTINCT ON (ep.event_id)
                     ep.event_id, ep.id AS participant_id, c.ref_code,
                     ep.is_registered, ep.is_in_chat
                FROM event_participants ep
                JOIN contacts c        ON c.id  = ep.contact_id
                JOIN platform_users pu ON pu.contact_id = c.id
               WHERE pu.platform_slug = $2 AND pu.platform_user_id = $1
           ),
           owned_clients AS (
              -- LTRIM '@' — clients.telegram_username исторически бывает с собакой,
              -- platform_users.username хранится без неё.
              SELECT cl.id FROM clients cl
               WHERE cl.telegram_username IS NOT NULL
                 AND LOWER(LTRIM(cl.telegram_username, '@')) =
                     LOWER((SELECT username FROM user_username))
           ),
           funnel_clients AS (
              -- Клиенты, у которых человек запускал воронку лид-магнита
              -- (даже если не стал участником ни одного события)
              SELECT DISTINCT fr.client_id AS id
                FROM funnel_runs fr
                JOIN platform_users pu ON pu.contact_id = fr.contact_id
               WHERE pu.platform_slug = $2 AND pu.platform_user_id = $1
           ),
           relevant_clients AS (
              SELECT DISTINCT e.client_id AS id
                FROM events e
                JOIN participant_events pe ON pe.event_id = e.id
              UNION
              SELECT id FROM owned_clients
              UNION
              SELECT id FROM funnel_clients
           ),
           allowed_clients AS (
              -- VIP-фильтр снят: если человек зашёл в этот бот/Mini App, значит
              -- он должен видеть ВСЕ свои события (включая VIP-клиентов).
              -- Логика разделения по ботам делается на уровне «куда человек
              -- пришёл» — общий бот → видит всех, VIP-бот клиента → видит этого клиента.
              SELECT id FROM relevant_clients
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
        platform,
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


@router.get(
    "/miniapp/me/leaders",
    summary="Список «лидеров» (организаторов) с которыми связан участник",
)
async def get_miniapp_me_leaders(
    tg_id: int,
    platform: str = "telegram",
    db: asyncpg.Connection = Depends(get_db),
):
    """Список клиентов, с которыми у участника есть хоть какая-то связь:
    либо он участник их события (event_participants),
    либо он запустил их воронку лид-магнита (funnel_runs),
    либо он сам владелец клиента (clients.telegram_username).

    Клик по карточке лидера в Mini App → переход на Hub этого клиента
    (`/c/{client_id}/tg/` или `/c/{client_id}/vk/`).
    """
    if platform not in ("telegram", "vk", "max"):
        raise HTTPException(status_code=400, detail="Invalid platform")

    rows = await db.fetch(
        """WITH ep_clients AS (
              SELECT DISTINCT e.client_id AS id, MAX(ep.registered_at) AS last_at
                FROM event_participants ep
                JOIN events e          ON e.id = ep.event_id
                JOIN platform_users pu ON pu.contact_id = ep.contact_id
               WHERE pu.platform_slug = $2 AND pu.platform_user_id = $1
               GROUP BY e.client_id
           ),
           fr_clients AS (
              SELECT DISTINCT fr.client_id AS id, MAX(fr.landed_at) AS last_at
                FROM funnel_runs fr
                JOIN platform_users pu ON pu.contact_id = fr.contact_id
               WHERE pu.platform_slug = $2 AND pu.platform_user_id = $1
               GROUP BY fr.client_id
           ),
           own_clients AS (
              SELECT cl.id, NULL::timestamptz AS last_at
                FROM clients cl
                JOIN platform_users pu ON LOWER(LTRIM(cl.telegram_username,'@')) = LOWER(pu.username)
               WHERE pu.platform_slug = $2 AND pu.platform_user_id = $1
                 AND cl.telegram_username IS NOT NULL
           ),
           merged AS (
              SELECT id, last_at FROM ep_clients
              UNION ALL
              SELECT id, last_at FROM fr_clients
              UNION ALL
              SELECT id, last_at FROM own_clients
           ),
           leaders AS (
              SELECT id, MAX(last_at) AS last_at
                FROM merged
               GROUP BY id
           )
           SELECT cl.id AS client_id,
                  cl.name AS client_name,
                  cl.brand_name        AS client_brand_name,
                  cl.profile_photo_url AS client_photo_url,
                  cl.positioning       AS client_positioning,
                  l.last_at,
                  (SELECT COUNT(*) FROM events e
                    WHERE e.client_id = cl.id AND e.status IN ('published','ended')) AS events_total,
                  EXISTS (
                    SELECT 1 FROM funnel_runs fr
                      JOIN platform_users pu ON pu.contact_id = fr.contact_id
                     WHERE fr.client_id = cl.id
                       AND pu.platform_slug = $2 AND pu.platform_user_id = $1
                  ) AS via_lead_magnet
             FROM leaders l
             JOIN clients cl ON cl.id = l.id
            ORDER BY l.last_at DESC NULLS LAST, cl.id""",
        str(tg_id), platform,
    )

    return {
        "leaders": [
            {
                "client_id":         r["client_id"],
                "client_name":       r["client_name"],
                "client_brand_name": r["client_brand_name"],
                "client_photo_url":  r["client_photo_url"],
                "client_positioning": r["client_positioning"],
                "events_total":      int(r["events_total"]),
                "via_lead_magnet":   bool(r["via_lead_magnet"]),
            }
            for r in rows
        ]
    }


def _build_messenger_url(platform_slug: str, username: str | None, pid: str | None) -> str | None:
    """URL для перехода в ЛС на конкретной платформе."""
    if platform_slug == 'telegram':
        if username:
            return f"https://t.me/{username.lstrip('@')}"
        if pid:
            return f"tg://user?id={pid}"
        return None
    if platform_slug == 'vk':
        if username:
            return f"https://vk.com/{username.lstrip('@')}"
        if pid:
            return f"https://vk.com/id{pid}"
        return None
    if platform_slug == 'max':
        # У MAX публичный username даёт ссылку вида max.ru/{username}.
        if username:
            return f"https://max.ru/{username.lstrip('@')}"
        return None
    return None


@router.get(
    "/event/{event_slug}/participants/{participant_id}/card",
    summary="Карточка участника со списком его мессенджеров",
)
async def get_participant_card(
    event_slug: str,
    participant_id: int,
    viewer_tg_id: int,
    db: asyncpg.Connection = Depends(get_db),
):
    # Зрителем может быть только участник того же события (или владелец клиента).
    # Иначе любой посторонний мог бы вытащить контакты всей базы клиента.
    target = await db.fetchrow(
        """SELECT ep.id, ep.contact_id, e.client_id,
                  COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ',
                      (SELECT pu.first_name FROM platform_users pu
                        WHERE pu.contact_id = ep.contact_id LIMIT 1),
                      (SELECT pu.last_name FROM platform_users pu
                        WHERE pu.contact_id = ep.contact_id LIMIT 1)
                    )), ''),
                    c.name
                  ) AS name
             FROM event_participants ep
             JOIN events e   ON e.id = ep.event_id
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ep.id = $1 AND e.slug = $2
            LIMIT 1""",
        participant_id, event_slug,
    )
    if not target:
        raise HTTPException(status_code=404, detail="Участник не найден")

    viewer_ok = await db.fetchval(
        """SELECT 1
             FROM event_participants ep
             JOIN events e ON e.id = ep.event_id
             JOIN platform_users pu ON pu.contact_id = ep.contact_id
            WHERE e.slug = $1
              AND pu.platform_slug = 'telegram'
              AND pu.platform_user_id = $2
            LIMIT 1""",
        event_slug, str(viewer_tg_id),
    )
    if not viewer_ok:
        # Владелец клиента тоже может смотреть (через сверку telegram_username).
        owner_ok = await db.fetchval(
            """SELECT 1 FROM clients cl
                JOIN platform_users pu
                  ON pu.platform_slug = 'telegram'
                 AND pu.platform_user_id = $1
                 AND LOWER(LTRIM(cl.telegram_username, '@')) = LOWER(pu.username)
               WHERE cl.id = $2
               LIMIT 1""",
            str(viewer_tg_id), target["client_id"],
        )
        if not owner_ok:
            raise HTTPException(status_code=403, detail="Нет доступа")

    messengers_rows = await db.fetch(
        """SELECT pu.platform_slug, pu.username, pu.platform_user_id,
                  p.display_name AS platform_name,
                  p.icon_url, p.color_hex, p.sort_order
             FROM platform_users pu
             JOIN platforms p ON p.slug = pu.platform_slug
            WHERE pu.contact_id = $1
            ORDER BY p.sort_order""",
        target["contact_id"],
    )
    messengers = []
    for m in messengers_rows:
        url = _build_messenger_url(m["platform_slug"], m["username"], m["platform_user_id"])
        messengers.append({
            "platform_slug": m["platform_slug"],
            "platform_name": m["platform_name"],
            "icon_url":      m["icon_url"],
            "color_hex":     m["color_hex"],
            "username":      m["username"],
            "url":           url,
        })

    return {
        "id":         target["id"],
        "name":       target["name"] or "Без имени",
        "messengers": messengers,
    }


@router.get("/event/{event_slug}/user/{tg_id}", summary="Данные участника в событии")
async def get_participant_in_event(
    event_slug: str,
    tg_id: int,
    platform: str = "telegram",  # ?platform=vk — для VK Mini App (тогда tg_id это vk_user_id)
    db: asyncpg.Connection = Depends(get_db)
):
    # Поддерживаемые платформы. Имя query-параметра tg_id оставлено для
    # обратной совместимости со старыми клиентами — на самом деле это
    # platform_user_id любой из платформ.
    if platform not in ("telegram", "vk", "max"):
        raise HTTPException(status_code=400, detail="Unknown platform")

    # Событие — нужно для топа (его считаем независимо от участия пользователя).
    event_id = await db.fetchval(
        "SELECT id FROM events WHERE slug = $1 LIMIT 1", event_slug
    )
    if not event_id:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    # Контакт у клиента ЭТОГО события (по platform_user_id). Email/phone отсюда —
    # если оба поля заполнены, фронт пропускает форму регистрации.
    prefill = await db.fetchrow(
        """SELECT c.email, c.phone, c.name
             FROM events e
             JOIN platform_users pu ON pu.client_id = e.client_id
                                    AND pu.platform_slug = $3
                                    AND pu.platform_user_id = $2
             JOIN contacts c ON c.id = pu.contact_id
            WHERE e.slug = $1
            LIMIT 1""",
        event_slug, str(tg_id), platform
    )
    prefill_dict = dict(prefill) if prefill else None

    row = await db.fetchrow(
        """SELECT ep.id, ep.event_id, c.ref_code, ep.is_registered, ep.is_in_chat,
                  ep.registered_at, ep.activated_at, ep.welcomed_at,
                  e.title AS event_title, e.module_slug
             FROM event_participants ep
             JOIN events e ON e.id = ep.event_id
             JOIN contacts c ON c.id = ep.contact_id
             JOIN platform_users pu ON pu.contact_id = c.id
            WHERE e.slug = $1 AND pu.platform_slug = $3 AND pu.platform_user_id = $2
            LIMIT 1""",
        event_slug, str(tg_id), platform
    )
    my_pid = row["id"] if row else None

    # Топ-рейтинг события: кто сколько привёл зарегавшихся.
    # Считаем по всем участникам, у которых referrer_participant_id указывает
    # на ДРУГОГО участника (не спикера) этого события. Спикеры исключаются:
    # их contact_id есть в collaborators ⇄ event_collaborators.
    leaderboard = await db.fetch(
        """WITH speaker_contacts AS (
              SELECT col.contact_id
                FROM event_collaborators cse
                JOIN collaborators col ON col.id = cse.speaker_id
               WHERE cse.event_id = $1 AND col.contact_id IS NOT NULL
           ),
           leaders AS (
              -- count: все приведённые (visited), reg_count: из них зарегавшиеся.
              -- Сортируем сначала по reg_count (полезное действие), потом по
              -- общему числу — чтобы зарегавшийся приведённый «весил» больше.
              SELECT ep.referrer_participant_id AS pid,
                     COUNT(*) AS cnt,
                     COUNT(*) FILTER (WHERE ep.is_registered) AS reg_count
                FROM event_participants ep
                JOIN event_participants rp ON rp.id = ep.referrer_participant_id
               WHERE ep.event_id = $1
                 AND ep.referrer_participant_id IS NOT NULL
                 AND rp.contact_id NOT IN (SELECT contact_id FROM speaker_contacts)
              GROUP BY ep.referrer_participant_id
           ),
           ranked AS (
              SELECT pid, cnt, reg_count,
                     ROW_NUMBER() OVER (ORDER BY reg_count DESC, cnt DESC, pid) AS rank
                FROM leaders
           )
           SELECT r.pid, r.cnt, r.rank,
                  COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ',
                      (SELECT pu.first_name FROM platform_users pu
                        WHERE pu.contact_id = ep.contact_id LIMIT 1),
                      (SELECT pu.last_name FROM platform_users pu
                        WHERE pu.contact_id = ep.contact_id LIMIT 1)
                    )), ''),
                    c.name
                  ) AS name,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = ep.contact_id
                      AND pu.platform_slug = 'telegram' LIMIT 1) AS username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = ep.contact_id
                      AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_id
             FROM ranked r
             JOIN event_participants ep ON ep.id = r.pid
             JOIN contacts c ON c.id = ep.contact_id
            ORDER BY r.rank""",
        event_id
    )
    top = [
        {
            "rank":     int(l["rank"]),
            "name":     l["name"] or "Без имени",
            "count":    int(l["cnt"]),
            "username": l["username"],
            "tg_id":    l["tg_id"],
            "participant_id": l["pid"],
            "isMe":     my_pid is not None and l["pid"] == my_pid,
        }
        for l in leaderboard[:10]
    ]
    my_rank = (
        next((int(l["rank"]) for l in leaderboard if l["pid"] == my_pid), None)
        if my_pid is not None else None
    )

    if not row:
        # Участника ещё нет — но prefill может быть (контакт уже в базе клиента
        # из другого события или из импорта). Возвращаем 200, не 404.
        # gift_count_mode достаём по slug → event_id, чтобы Mini App всегда
        # показывал правильную жёлтую подсказку про правило подсчёта,
        # даже до регистрации.
        no_row_mode = await db.fetchval(
            """SELECT ers.gift_count_mode
                 FROM event_referral_settings ers
                 JOIN events e ON e.id = ers.event_id
                WHERE e.slug = $1""",
            event_slug
        ) or "registered"
        return {
            "participant": None,
            "referrals_count": 0,
            "visited_count": 0,
            "registered_count": 0,
            "clicked_count": 0,
            "gift_count_mode": no_row_mode,
            "gift_count_value": 0,
            "gifts_received_count": 0,
            "my_people": [],
            "top": top,
            "my_rank": None,
            "prefill": prefill_dict,
        }

    # Сколько людей пришло по моей ссылке (включая «интересовавшихся»)
    visited_count = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE referrer_participant_id = $1",
        row["id"]
    )
    # Сколько из них зарегистрировались
    registered_count = await db.fetchval(
        """SELECT COUNT(*) FROM event_participants
            WHERE referrer_participant_id = $1 AND is_registered = TRUE""",
        row["id"]
    )
    # Сколько из них нажали главную CTA-ссылку (стрим/голосование)
    clicked_count = await db.fetchval(
        """SELECT COUNT(*) FROM event_participants
            WHERE referrer_participant_id = $1 AND link_clicked_at IS NOT NULL""",
        row["id"]
    )

    # Выбираем «зачёт» по которому считаются подарки: registered / visited / clicked_link.
    # Если event_referral_settings нет — дефолт 'registered'.
    gift_mode = await db.fetchval(
        "SELECT gift_count_mode FROM event_referral_settings WHERE event_id = $1",
        row["event_id"]
    ) or "registered"
    if gift_mode == "visited":
        gift_count_value = visited_count
    elif gift_mode == "clicked_link":
        gift_count_value = clicked_count
    else:
        gift_count_value = registered_count

    # Сколько подарков получено: пороги, у которых threshold_count <= gift_count_value.
    # Если у события есть подарок за 0 — он засчитан сразу всем участникам.
    gifts_received_count = await db.fetchval(
        """SELECT COUNT(*) FROM event_referral_thresholds
            WHERE event_id = $1 AND threshold_count <= $2""",
        row["event_id"], gift_count_value
    )

    # Список приведённых людей: имя из platform_users (Telegram-первый), fallback на contacts.name
    people_rows = await db.fetch(
        """SELECT ep.id,
                  COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ',
                      (SELECT pu.first_name FROM platform_users pu
                        WHERE pu.contact_id = ep.contact_id LIMIT 1),
                      (SELECT pu.last_name FROM platform_users pu
                        WHERE pu.contact_id = ep.contact_id LIMIT 1)
                    )), ''),
                    c.name
                  ) AS name,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = ep.contact_id LIMIT 1) AS username,
                  ep.is_registered,
                  ep.link_clicked_at
             FROM event_participants ep
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ep.referrer_participant_id = $1
            ORDER BY (ep.link_clicked_at IS NOT NULL) DESC, ep.is_registered DESC, ep.registered_at DESC""",
        row["id"]
    )
    my_people = [
        {
            "id": p["id"],
            "name": p["name"] or "Без имени",
            "username": p["username"],
            "is_registered": p["is_registered"],
            "link_clicked": p["link_clicked_at"] is not None,
        }
        for p in people_rows
    ]

    return {
        "participant": dict(row),
        "referrals_count": visited_count,         # legacy alias
        "visited_count": visited_count,
        "registered_count": registered_count,
        "clicked_count": clicked_count,
        "gift_count_mode": gift_mode,
        "gift_count_value": gift_count_value,
        "gifts_received_count": gifts_received_count,
        "my_people": my_people,
        "top": top,
        "my_rank": my_rank,
        "prefill": prefill_dict,
    }
