from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
import asyncpg
import re
import secrets

router = APIRouter(prefix="/events", tags=["События"])

# Алфавит без визуально похожих символов (без 0/o, 1/l/i)
_SLUG_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'


def _short_code(n: int = 5) -> str:
    return ''.join(secrets.choice(_SLUG_CODE_ALPHABET) for _ in range(n))


async def _make_unique_slug(db: asyncpg.Connection, base: str) -> str:
    """`<base>-<5 случайных символа>`. Коллизия маловероятна (~1/33M),
    но повторяем до уникальности на всякий случай."""
    while True:
        candidate = f"{base}-{_short_code(5)}"
        exists = await db.fetchval("SELECT 1 FROM events WHERE slug = $1", candidate)
        if not exists:
            return candidate


_TRANSLIT_MAP = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
}


def slugify(title: str) -> str:
    s = title.lower().strip()
    s = ''.join(_TRANSLIT_MAP.get(ch, ch) for ch in s)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s).strip('-')
    return s[:50] or 'event'


class CreateEventRequest(BaseModel):
    title: str
    description: Optional[str] = None
    landing_url: Optional[str] = None
    address: Optional[str] = None       # одно поле: URL стрима / ссылка на видео / офлайн-адрес
    start_at: Optional[str] = None      # ISO-8601
    end_at:   Optional[str] = None
    webhook_url: Optional[str] = None
    module_slug: str = "base"
    points_free: int = 1
    points_paid: int = 0
    require_subscription: bool = False


class UpdateEventRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    landing_url: Optional[str] = None
    address: Optional[str] = None
    start_at: Optional[str] = None
    end_at:   Optional[str] = None
    webhook_url: Optional[str] = None
    status: Optional[str] = None
    points_free: Optional[int] = None
    points_paid: Optional[int] = None
    require_subscription: Optional[bool] = None
    successor_event_id: Optional[int] = None
    # VIP/Чат конференции (миграция 042)
    has_vip_tariff: Optional[bool] = None
    vip_price: Optional[int] = None
    vip_url: Optional[str] = None
    vip_title: Optional[str] = None
    vip_description: Optional[str] = None
    chat_url: Optional[str] = None
    chat_subscriptions_required: Optional[bool] = None
    chat_member_count_label: Optional[str] = None


@router.get("/", summary="Список событий клиента")
async def list_events(
    module_slug: str = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    # effective_start: для конференций fallback на минимальную дату из conf_days,
    # для остальных — собственный start_at
    base_select = """
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
               e.points_free, e.points_paid, e.created_at, e.start_at, e.end_at, e.address,
               COALESCE(
                 e.start_at,
                 CASE WHEN e.module_slug = 'conference' THEN
                   (SELECT MIN(day_date)::timestamp AT TIME ZONE 'Europe/Moscow'
                    FROM conf_days WHERE event_id = e.id)
                 END
               ) AS effective_start_at,
               COUNT(DISTINCT ep.id) as participants_count
        FROM events e
        LEFT JOIN event_participants ep ON ep.event_id = e.id
    """
    if module_slug:
        events = await db.fetch(
            base_select + " WHERE e.client_id = $1 AND e.module_slug = $2 GROUP BY e.id ORDER BY e.created_at DESC",
            client_id, module_slug
        )
    else:
        events = await db.fetch(
            base_select + " WHERE e.client_id = $1 GROUP BY e.id ORDER BY e.created_at DESC",
            client_id
        )
    return {"events": [dict(e) for e in events]}


@router.post("/", summary="Создать событие")
async def create_event(
    data: CreateEventRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    slug = await _make_unique_slug(db, slugify(data.title))

    from datetime import datetime as _dt
    def _parse_dt(s):
        return _dt.fromisoformat(s.replace('Z', '+00:00')) if s else None

    event = await db.fetchrow(
        """
        INSERT INTO events (client_id, slug, title, description, landing_url, address,
                            start_at, end_at, webhook_url,
                            module_slug, points_free, points_paid, require_subscription, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft')
        RETURNING *
        """,
        client_id, slug, data.title, data.description, data.landing_url, data.address,
        _parse_dt(data.start_at), _parse_dt(data.end_at), data.webhook_url,
        data.module_slug, data.points_free, data.points_paid, data.require_subscription
    )

    # Если модуль — конференция, создаём запись в conf_conferences
    if data.module_slug == "conference":
        await db.execute(
            "INSERT INTO conf_conferences (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
            event["id"]
        )

    return {"event": dict(event)}


# Подзапрос: лучшая афиша из event_posters по приоритету square > horizontal > vertical.
# Используется во всех ответах API, где раньше отдавалось events.poster_url
# (миграция 044 удалила это поле, источник истины теперь — event_posters).
_POSTER_SUBQ = """(
    SELECT url FROM event_posters
     WHERE event_id = e.id
     ORDER BY CASE orientation
                WHEN 'square'     THEN 1
                WHEN 'horizontal' THEN 2
                WHEN 'vertical'   THEN 3
                ELSE 4
              END, sort, id
     LIMIT 1
) AS poster_url"""


@router.get("/slug/{slug}", summary="Получить событие по slug")
async def get_event_by_slug(slug: str, db: asyncpg.Connection = Depends(get_db)):
    event = await db.fetchrow(f"SELECT e.*, {_POSTER_SUBQ} FROM events e WHERE e.slug = $1", slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"event": dict(event)}


@router.get("/{event_id}", summary="Получить событие по ID")
async def get_event(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        f"SELECT e.*, {_POSTER_SUBQ} FROM events e WHERE e.id = $1 AND e.client_id = $2",
        event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"event": dict(event)}


@router.patch("/{event_id}", summary="Обновить событие")
async def update_event(
    event_id: int,
    data: UpdateEventRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    # Преобразование ISO-строк в datetime для timestamp-полей
    from datetime import datetime as _dt
    for dt_field in ("start_at", "end_at"):
        if dt_field in updates and isinstance(updates[dt_field], str):
            updates[dt_field] = _dt.fromisoformat(updates[dt_field].replace('Z', '+00:00'))

    set_parts = [f"{k} = ${i+2}" for i, k in enumerate(updates.keys())]
    values = list(updates.values())
    await db.execute(
        f"UPDATE events SET {', '.join(set_parts)} WHERE id = $1",
        event_id, *values
    )
    updated = await db.fetchrow(f"SELECT e.*, {_POSTER_SUBQ} FROM events e WHERE e.id = $1", event_id)
    return {"event": dict(updated)}


@router.post("/{event_id}/copy", summary="Скопировать событие со всеми настройками")
async def copy_event(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    src = await db.fetchrow(
        "SELECT * FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not src:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    new_title = f"Копия — {src['title']}"
    new_slug = await _make_unique_slug(db, slugify(new_title))

    # Копия события — всегда черновик, start_at/end_at не наследуем
    # (для конференций они вообще берутся из conf_days, для остальных
    # клиент задаст заново — старые даты всё равно неактуальны).
    async with db.transaction():
        new_event = await db.fetchrow(
            """INSERT INTO events
                 (client_id, slug, title, description, landing_url, address, start_at, end_at,
                  webhook_url, module_slug, points_free, points_paid, points_scope,
                  require_subscription, status)
               VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8,$9,$10,$11,$12,'draft')
               RETURNING *""",
            client_id, new_slug, new_title, src['description'], src['landing_url'],
            src.get('address'),
            src['webhook_url'], src['module_slug'],
            src['points_free'], src['points_paid'], src['points_scope'],
            src['require_subscription']
        )
        new_id = new_event['id']

        # event_posters: копируем + строим map старый_id → новый_id для materials
        poster_id_map: dict = {}
        old_posters = await db.fetch(
            "SELECT * FROM event_posters WHERE event_id = $1 ORDER BY id", event_id
        )
        for p in old_posters:
            new_p = await db.fetchval(
                """INSERT INTO event_posters (event_id, url, orientation, sort)
                   VALUES ($1, $2, $3, $4) RETURNING id""",
                new_id, p['url'], p['orientation'], p['sort']
            )
            poster_id_map[p['id']] = new_p

        # event_referral_settings
        srs = await db.fetchrow(
            "SELECT welcome_text, share_text FROM event_referral_settings WHERE event_id = $1",
            event_id
        )
        if srs:
            await db.execute(
                """INSERT INTO event_referral_settings (event_id, welcome_text, share_text)
                   VALUES ($1, $2, $3)""",
                new_id, srs['welcome_text'], srs['share_text']
            )

        # event_referral_thresholds
        thresholds = await db.fetch(
            "SELECT * FROM event_referral_thresholds WHERE event_id = $1", event_id
        )
        for t in thresholds:
            await db.execute(
                """INSERT INTO event_referral_thresholds
                     (event_id, threshold_count, lead_magnet_id, certificate_url, gift_template_text, sort)
                   VALUES ($1,$2,$3,$4,$5,$6)""",
                new_id, t['threshold_count'], t['lead_magnet_id'],
                t['certificate_url'], t['gift_template_text'], t['sort']
            )

        # event_referral_materials (с маппингом source_poster_id)
        materials = await db.fetch(
            "SELECT * FROM event_referral_materials WHERE event_id = $1 ORDER BY id", event_id
        )
        for m in materials:
            mapped_pid = poster_id_map.get(m['source_poster_id']) if m['source_poster_id'] else None
            await db.execute(
                """INSERT INTO event_referral_materials (event_id, image_url, source, source_poster_id, sort)
                   VALUES ($1,$2,$3,$4,$5)""",
                new_id, m['image_url'], m['source'], mapped_pid, m['sort']
            )

        # gifts (старая модель подарков, осталась для совместимости)
        gifts = await db.fetch("SELECT * FROM gifts WHERE event_id = $1", event_id)
        for g in gifts:
            cols = [k for k in dict(g).keys() if k not in ('id', 'event_id')]
            placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
            await db.execute(
                f"INSERT INTO gifts (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                new_id, *[g[c] for c in cols]
            )

        # Если конференция — копируем conf_*
        if src['module_slug'] == 'conference':
            old_conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
            if old_conf:
                cols = [k for k in dict(old_conf).keys() if k not in ('id', 'event_id', 'editor_code')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_conferences (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    new_id, *[old_conf[c] for c in cols]
                )

            # Маппинг conf_speaker_events для дальнейших таблиц
            cse_map: dict = {}
            old_cses = await db.fetch("SELECT * FROM conf_speaker_events WHERE event_id = $1", event_id)
            for cse in old_cses:
                cols = [k for k in dict(cse).keys() if k not in ('id', 'event_id')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                new_cse_id = await db.fetchval(
                    f"INSERT INTO conf_speaker_events (event_id, {','.join(cols)}) VALUES ($1, {placeholders}) RETURNING id",
                    new_id, *[cse[c] for c in cols]
                )
                cse_map[cse['id']] = new_cse_id

            # conf_speaker_topics → cse_id
            topics = await db.fetch(
                "SELECT * FROM conf_speaker_topics WHERE cse_id = ANY($1::int[])",
                list(cse_map.keys()) or [0]
            )
            for tp in topics:
                cols = [k for k in dict(tp).keys() if k not in ('id', 'cse_id')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_speaker_topics (cse_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    cse_map[tp['cse_id']], *[tp[c] for c in cols]
                )

            # conf_days
            days = await db.fetch("SELECT * FROM conf_days WHERE event_id = $1", event_id)
            for d in days:
                cols = [k for k in dict(d).keys() if k not in ('id', 'event_id')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_days (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    new_id, *[d[c] for c in cols]
                )

            # conf_sessions (speaker_id → conf_speaker_events.id, mapping)
            sessions = await db.fetch("SELECT * FROM conf_sessions WHERE event_id = $1", event_id)
            for s in sessions:
                cols_dict = dict(s)
                cols_dict.pop('id', None)
                cols_dict.pop('event_id', None)
                if 'speaker_id' in cols_dict and cols_dict['speaker_id']:
                    cols_dict['speaker_id'] = cse_map.get(cols_dict['speaker_id'])
                cols = list(cols_dict.keys())
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_sessions (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    new_id, *cols_dict.values()
                )

            # conf_secret_codes (speaker_id mapping)
            codes = await db.fetch("SELECT * FROM conf_secret_codes WHERE event_id = $1", event_id)
            for c in codes:
                cd = dict(c); cd.pop('id', None); cd.pop('event_id', None)
                if 'speaker_id' in cd and cd['speaker_id']:
                    cd['speaker_id'] = cse_map.get(cd['speaker_id'])
                cols = list(cd.keys())
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_secret_codes (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    new_id, *cd.values()
                )

            # conf_commercial_items
            items = await db.fetch("SELECT * FROM conf_commercial_items WHERE event_id = $1", event_id)
            for it in items:
                cols = [k for k in dict(it).keys() if k not in ('id', 'event_id')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_commercial_items (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    new_id, *[it[c] for c in cols]
                )

            # conf_promo_partners
            partners = await db.fetch("SELECT * FROM conf_promo_partners WHERE event_id = $1", event_id)
            for p in partners:
                cols = [k for k in dict(p).keys() if k not in ('id', 'event_id')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_promo_partners (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    new_id, *[p[c] for c in cols]
                )

        # broadcast_templates — копируем шаблоны (без расписания/очереди)
        templates = await db.fetch("SELECT * FROM broadcast_templates WHERE event_id = $1", event_id)
        for tpl in templates:
            cols = [k for k in dict(tpl).keys() if k not in ('id', 'event_id', 'created_at', 'updated_at')]
            placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
            await db.execute(
                f"INSERT INTO broadcast_templates (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                new_id, *[tpl[c] for c in cols]
            )

    return {"event": dict(new_event)}


@router.delete("/{event_id}", summary="Удалить событие")
async def delete_event(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    result = await db.execute(
        "DELETE FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"message": "Событие удалено"}


@router.get("/{event_id}/analytics", summary="Аналитика события")
async def event_analytics(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    stats = await db.fetchrow(
        """
        SELECT
          COUNT(DISTINCT ep.id) as participants_total,
          COUNT(DISTINCT re.id) FILTER (WHERE re.type = 'click') as clicks_total,
          COUNT(DISTINCT re.id) FILTER (WHERE re.type = 'free') as conversions_free,
          COUNT(DISTINCT re.id) FILTER (WHERE re.type = 'paid') as conversions_paid,
          COUNT(DISTINCT gi.id) as gifts_issued
        FROM events e
        LEFT JOIN event_participants ep ON ep.event_id = e.id
        LEFT JOIN referral_events re ON re.event_id = e.id
        LEFT JOIN gift_issuances gi ON gi.participant_id = ep.id AND gi.status = 'issued'
        WHERE e.id = $1
        """,
        event_id
    )

    # Топ рефереров (ref_code живёт в contacts с миграции 036)
    top = await db.fetch(
        """
        SELECT c.ref_code, c.name AS contact_name,
               (SELECT username FROM platform_users pu WHERE pu.contact_id = c.id LIMIT 1) AS username,
               COUNT(re.id) as referrals_count
        FROM event_participants ep
        JOIN contacts c ON c.id = ep.contact_id
        LEFT JOIN referral_events re ON re.ref_code = c.ref_code AND re.type IN ('free','paid')
        WHERE ep.event_id = $1
        GROUP BY ep.id, c.id
        ORDER BY referrals_count DESC
        LIMIT 10
        """,
        event_id
    )

    return {
        **dict(stats),
        "top_referrers": [dict(r) for r in top]
    }


@router.get("/{event_id}/participants", summary="Список участников события")
async def event_participants(
    event_id: int,
    registered: str = "all",  # all | yes | no
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    where_extra = ""
    if registered == "yes":
        where_extra = " AND ep.is_registered = TRUE"
    elif registered == "no":
        where_extra = " AND ep.is_registered = FALSE"

    rows = await db.fetch(
        f"""SELECT ep.id,
                  c.id AS contact_id,
                  c.ref_code, ep.referrer_ref_code,
                  ep.is_registered, ep.is_in_chat, ep.registered_at,
                  c.name AS contact_name,
                  c.email, c.phone, c.salebot_id,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS platform_user_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id LIMIT 1) AS username,
                  (SELECT pu.first_name FROM platform_users pu
                    WHERE pu.contact_id = c.id LIMIT 1) AS first_name,
                  (SELECT pu.last_name FROM platform_users pu
                    WHERE pu.contact_id = c.id LIMIT 1) AS last_name,
                  (SELECT rc.id FROM contacts rc WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1) AS referrer_contact_id,
                  (SELECT rc.name FROM contacts rc WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1) AS referrer_name,
                  (SELECT rpu.username FROM platform_users rpu
                     JOIN contacts rc ON rc.id = rpu.contact_id
                    WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1) AS referrer_username,
                  COUNT(re.id) FILTER (WHERE re.type IN ('free','paid')) as referral_count
           FROM event_participants ep
           JOIN contacts c ON c.id = ep.contact_id
           LEFT JOIN referral_events re ON re.ref_code = c.ref_code AND re.event_id = ep.event_id
           WHERE ep.event_id = $1{where_extra}
           GROUP BY ep.id, c.id, ep.referrer_ref_code,
                    ep.is_registered, ep.is_in_chat
           ORDER BY ep.registered_at DESC""",
        event_id
    )

    counts = await db.fetchrow(
        """SELECT
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE is_registered = TRUE) AS registered,
             COUNT(*) FILTER (WHERE is_registered = FALSE) AS not_registered
           FROM event_participants WHERE event_id = $1""",
        event_id
    )
    return {
        "participants": [dict(r) for r in rows],
        "counts": dict(counts) if counts else {"total": 0, "registered": 0, "not_registered": 0},
    }


class UpdateParticipantRequest(BaseModel):
    is_registered: Optional[bool] = None


@router.patch("/{event_id}/participants/{participant_id}", summary="Обновить статус участника (вручную)")
async def update_event_participant(
    event_id: int,
    participant_id: int,
    data: UpdateParticipantRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ep.id FROM event_participants ep
           JOIN events e ON e.id = ep.event_id
           WHERE ep.id = $1 AND ep.event_id = $2 AND e.client_id = $3""",
        participant_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Участник не найден")

    if data.is_registered is None:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    await db.execute(
        "UPDATE event_participants SET is_registered = $1 WHERE id = $2",
        data.is_registered, participant_id
    )
    return {"id": participant_id, "is_registered": data.is_registered}
