"""
Публичные JSON-эндпоинты для встраивания на СТОРОННИЕ лендинги клиента
(Tilda, GetCourse, Vercel-сайты и т.п.).

В отличие от существующих публичных эндпоинтов (`/public/events/{slug}/landing`,
`/public/clients/{id}/events`, ...) — здесь:
- CORS открыт для любого origin (`*`), потому что лендинг живёт не на нашем
  домене. `allow_credentials=False` — никаких cookies, всё анонимно.
- Сортировка коллабораторов — БЕЗ приоритета `is_commercial` (см. отдельная
  ветка от `collaborator_sort.py`). Клиент хочет, чтобы порядок выдачи на
  лендинге определялся только ролью и количеством приведённых.
- Выдача плоско по группам: organizers / jury / speakers (headliner+speaker)
  / partners (general_partner+partner). В каждой карточке остаётся `role` и
  `is_commercial` — лендинг может сгруппировать иначе при необходимости.

Эндпоинты:
- `GET /api/v1/public/landing-widget/events/{slug}/collaborators`
- `GET /api/v1/public/landing-widget/events/{slug}/program`
"""
from fastapi import APIRouter, Depends, HTTPException, Response
from app.database import get_db
import asyncpg
import json

router = APIRouter(
    prefix="/api/v1/public/landing-widget",
    tags=["Виджеты для сторонних лендингов"],
)


# Заголовки CORS — добавляются вручную, без credentials. Эти эндпоинты не
# участвуют в глобальном CORSMiddleware (тот сконфигурирован с allow_credentials=True,
# несовместимым с allow_origins='*').
_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "public, max-age=60",  # лендинг кешит на минуту
}


def _set_cors(response: Response) -> None:
    for k, v in _CORS_HEADERS.items():
        response.headers[k] = v


# Sort коллабораторов для лендинга — БЕЗ приоритета is_commercial.
# Внутри группы — старый порядок (referrals DESC, priority ASC, id ASC).
_GROUP_RANK_FLAT = """CASE
    WHEN cse.role = 'organizer'       THEN 1
    WHEN cse.role = 'jury'            THEN 2
    WHEN cse.role = 'headliner'       THEN 3
    WHEN cse.role = 'speaker'         THEN 4
    WHEN cse.role = 'general_partner' THEN 5
    WHEN cse.role = 'partner'         THEN 6
    ELSE 7
  END"""

_REFERRALS_COUNT = """COALESCE((
    SELECT COUNT(*) FROM event_participants ep
     WHERE ep.event_id = cse.event_id
       AND ep.referrer_ref_code IS NOT NULL
       AND ep.referrer_ref_code = (
         SELECT ct.ref_code FROM collaborators co_sort
           JOIN contacts ct ON ct.id = co_sort.contact_id
          WHERE co_sort.id = cse.speaker_id
       )
  ), 0)"""

_ORDER_BY = (
    f"{_GROUP_RANK_FLAT} ASC, "
    f"{_REFERRALS_COUNT} DESC, "
    f"COALESCE(cse.priority, 60) ASC, "
    f"cse.id ASC"
)


def _parse_jsonb(value) -> list:
    """asyncpg отдаёт JSONB строкой — парсим в list. None/невалидный → []."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            v = json.loads(value)
            return v if isinstance(v, list) else []
        except (ValueError, TypeError):
            return []
    return []


async def _resolve_event(db: asyncpg.Connection, ref: str):
    """Resolve event by numeric id (if `ref` — только цифры) или по slug.

    Это позволяет владельцу события поменять slug, не ломая интеграции с
    лендингом — он подставляет ID, который не меняется.

    Если строка из цифр не нашлась как id — fallback на поиск по slug
    (на случай если у кого-то slug = "12345").
    """
    if ref.isdigit():
        ev = await db.fetchrow("SELECT id, slug FROM events WHERE id = $1", int(ref))
        if ev:
            return ev
    return await db.fetchrow("SELECT id, slug FROM events WHERE slug = $1", ref)


def _group_for(role: str) -> str:
    role = (role or "").lower()
    if role == "organizer":
        return "organizers"
    if role == "jury":
        return "jury"
    if role in ("speaker", "headliner"):
        return "speakers"
    if role in ("partner", "general_partner"):
        return "partners"
    return "other"


@router.options("/events/{slug}/collaborators", include_in_schema=False)
async def _opts_collaborators(slug: str, response: Response):
    _set_cors(response)
    return Response(status_code=204, headers=_CORS_HEADERS)


@router.options("/events/{slug}/program", include_in_schema=False)
async def _opts_program(slug: str, response: Response):
    _set_cors(response)
    return Response(status_code=204, headers=_CORS_HEADERS)


@router.get("/events/{slug}/collaborators", summary="Все коллабораторы события (для лендинга)")
async def widget_collaborators(
    slug: str,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Плоский список коллабораторов события, сгруппированный по 4 ролям.

    Path-параметр `slug` принимает И slug, И числовой id события — id
    стабильный, лендинг можно завести на него и не бояться переименований.

    Группы: organizers / jury / speakers (headliner+speaker) /
    partners (general_partner+partner).
    Сортировка внутри группы — БЕЗ приоритета is_commercial:
    role > referrals DESC > priority ASC > id ASC.
    """
    _set_cors(response)
    event = await _resolve_event(db, slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    event_id = event["id"]

    rows = await db.fetch(
        f"""SELECT cse.id, cse.speaker_id AS collaborator_id, cse.role,
                   cse.is_commercial, cse.priority, cse.sort_order,
                   cse.speaker_topic AS topic,
                   (SELECT url FROM collaborator_posters cp
                      WHERE cp.id = cse.poster_id OR
                            (cse.poster_id IS NULL AND cp.collaborator_id = c.id)
                      ORDER BY (cp.id = cse.poster_id) DESC, cp.sort_order, cp.id
                      LIMIT 1) AS poster_url,
                   cse.knowledge_base_title, cse.knowledge_base_url,
                   c.name, c.title, c.title AS position, c.achievements,
                   c.photo_url,
                   c.tg_channel_url, c.vk_url, c.max_url,
                   c.instagram_url, c.website_url,
                   c.media_assets,
                   ct.ref_code
              FROM event_collaborators cse
              JOIN collaborators c ON c.id = cse.speaker_id
              LEFT JOIN contacts ct ON ct.id = c.contact_id
             WHERE cse.event_id = $1
             ORDER BY {_ORDER_BY}""",
        event_id,
    )

    groups: dict[str, list] = {
        "organizers": [],
        "jury": [],
        "speakers": [],
        "partners": [],
    }
    for r in rows:
        d = dict(r)
        d["achievements"] = d.get("achievements") or []
        d["media_assets"] = _parse_jsonb(d.get("media_assets"))
        bucket = _group_for(d.get("role"))
        if bucket in groups:
            groups[bucket].append(d)

    return {
        "event_slug": event["slug"],
        "event_id": event_id,
        "organizers": groups["organizers"],
        "jury": groups["jury"],
        "speakers": groups["speakers"],
        "partners": groups["partners"],
    }


@router.get("/events/{slug}/program", summary="Программа события (для лендинга)")
async def widget_program(
    slug: str,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Дерево этапов → дней → сессий с прикреплёнными спикерами.

    Path-параметр `slug` принимает И slug, И числовой id события.

    Формат:
      {
        stages:   [{id, sort_order, title, subtitle, description, start_date, end_date}, ...],
        days:     [{id, day_number, day_date, open_time, close_time, stage_id, title}, ...],
        sessions: [{
            id, day (=day_number), start_time, end_time, title, gift_description,
            track_id, sort_order,
            speaker_event_id, speaker_role,
            speaker: { id, name, title, photo_url, achievements,
                       tg_channel_url, vk_url, max_url, instagram_url, website_url,
                       media_assets } | null
        }, ...]
      }
    """
    _set_cors(response)
    event = await _resolve_event(db, slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    event_id = event["id"]

    stages = await db.fetch(
        """SELECT id, sort_order, title, subtitle, description, start_date, end_date
             FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id""",
        event_id,
    )
    days = await db.fetch(
        """SELECT id, day_number, day_date, open_time, close_time, stage_id, title
             FROM conf_days WHERE event_id = $1 ORDER BY day_number, id""",
        event_id,
    )
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.start_time, s.end_time, s.title,
                  s.gift_description, s.track_id, s.sort_order,
                  s.speaker_id AS speaker_event_id,
                  cse.role AS speaker_role,
                  col.id AS sp_id, col.name AS sp_name, col.title AS sp_title,
                  col.photo_url AS sp_photo_url, col.achievements AS sp_achievements,
                  col.tg_channel_url AS sp_tg_channel_url,
                  col.vk_url AS sp_vk_url, col.max_url AS sp_max_url,
                  col.instagram_url AS sp_instagram_url, col.website_url AS sp_website_url,
                  col.media_assets AS sp_media_assets
             FROM conf_sessions s
             LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
             LEFT JOIN collaborators col ON col.id = cse.speaker_id
            WHERE s.event_id = $1
            ORDER BY s.day, s.sort_order, s.start_time, s.id""",
        event_id,
    )

    def _ser_session(r) -> dict:
        d = dict(r)
        sp = None
        if d.get("sp_id"):
            sp = {
                "id":              d.pop("sp_id"),
                "name":            d.pop("sp_name"),
                "title":           d.pop("sp_title"),
                "photo_url":       d.pop("sp_photo_url"),
                "achievements":    d.pop("sp_achievements") or [],
                "tg_channel_url":  d.pop("sp_tg_channel_url"),
                "vk_url":          d.pop("sp_vk_url"),
                "max_url":         d.pop("sp_max_url"),
                "instagram_url":   d.pop("sp_instagram_url"),
                "website_url":     d.pop("sp_website_url"),
                "media_assets":    _parse_jsonb(d.pop("sp_media_assets")),
            }
        else:
            for k in ("sp_id", "sp_name", "sp_title", "sp_photo_url", "sp_achievements",
                      "sp_tg_channel_url", "sp_vk_url", "sp_max_url",
                      "sp_instagram_url", "sp_website_url", "sp_media_assets"):
                d.pop(k, None)
        # время храним как 'HH:MM' (см. CLAUDE.md «Время программы — строки HH:MM»).
        # asyncpg отдаёт `time` или `text` — нормализуем к строке.
        for k in ("start_time", "end_time"):
            v = d.get(k)
            if v is not None and not isinstance(v, str):
                d[k] = str(v)[:5]
            elif isinstance(v, str):
                d[k] = v[:5]
        d["speaker"] = sp
        return d

    def _ser_day(r) -> dict:
        d = dict(r)
        for k in ("open_time", "close_time"):
            v = d.get(k)
            if v is not None and not isinstance(v, str):
                d[k] = str(v)[:5]
            elif isinstance(v, str):
                d[k] = v[:5]
        if d.get("day_date") is not None:
            d["day_date"] = str(d["day_date"])  # YYYY-MM-DD
        return d

    def _ser_stage(r) -> dict:
        d = dict(r)
        for k in ("start_date", "end_date"):
            if d.get(k) is not None:
                d[k] = str(d[k])
        return d

    return {
        "event_slug": event["slug"],
        "event_id": event_id,
        "stages":   [_ser_stage(r) for r in stages],
        "days":     [_ser_day(r) for r in days],
        "sessions": [_ser_session(r) for r in sessions],
    }
