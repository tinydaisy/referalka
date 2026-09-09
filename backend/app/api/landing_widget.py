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
from app.services.tariff_discount import with_discount
import asyncpg
import json
from app.services.share_links import TG_DOMAIN
from app.services.person_name import DISPLAY_NAME_SQL

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


# Число приведённых людей коллаба (для сортировки по рефералам).
# ⚠️ Считаем ТОЧНО так же, как турнирный критерий «Привёл по реф-ссылке» и
# выдача подарков — по event_referral_settings.gift_count_mode:
#   registered (default) → только is_registered = TRUE (число регистраций),
#   clicked_link         → только с переходом (link_clicked_at IS NOT NULL),
#   visited              → все перешедшие.
# Раньше здесь считались ВСЕ перешедшие безусловно — из-за этого порядок
# спикеров на сайте расходился с турнирной таблицей.
_REFERRALS_COUNT = """COALESCE((
    SELECT COUNT(*) FROM event_participants ep
     WHERE ep.event_id = cse.event_id
       AND ep.referrer_ref_code IS NOT NULL
       AND ep.referrer_ref_code = (
         SELECT ct.ref_code FROM collaborators co_sort
           JOIN contacts ct ON ct.id = co_sort.contact_id
          WHERE co_sort.id = cse.speaker_id
       )
       AND CASE
             (SELECT COALESCE(gift_count_mode, 'registered')
                FROM event_referral_settings WHERE event_id = cse.event_id)
           WHEN 'visited'      THEN TRUE
           WHEN 'clicked_link' THEN ep.link_clicked_at IS NOT NULL
           ELSE ep.is_registered = TRUE
           END
  ), 0)"""


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


@router.options("/events/{slug}/tariffs", include_in_schema=False)
async def _opts_tariffs(slug: str, response: Response):
    _set_cors(response)
    return Response(status_code=204, headers=_CORS_HEADERS)


@router.get("/events/{slug}/tariffs", summary="Тарифы события + оферта (для лендинга)")
async def widget_tariffs(
    slug: str,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Активные тарифы мероприятия + ссылка на оферту.

    Path-параметр `slug` принимает И slug, И числовой id события.
    Клиент верстает кнопки «Купить» сам, используя `pay_url` каждого тарифа.
    """
    _set_cors(response)
    event = await _resolve_event(db, slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    event_id = event["id"]

    offer_url = await db.fetchval("SELECT offer_url FROM events WHERE id = $1", event_id)
    rows = await db.fetch(
        """SELECT code, title, description, price,
                  discount_kind, discount_value, pay_url, sort_order
             FROM event_tariffs
            WHERE event_id = $1 AND is_active = TRUE
            ORDER BY sort_order, id""",
        event_id,
    )
    # old_price / discount_percent отдаём и сюда: клиент верстает свой лендинг
    # сам, и без них зачёркнутую цену ему пришлось бы считать руками.
    return {
        "event_slug": event["slug"],
        "event_id": event_id,
        "offer_url": offer_url,
        "tariffs": [with_discount(r) for r in rows],
    }


@router.options("/events/{slug}/organizer", include_in_schema=False)
async def _opts_organizer(slug: str, response: Response):
    _set_cors(response)
    return Response(status_code=204, headers=_CORS_HEADERS)


@router.get("/events/{slug}/organizer", summary="Организатор события — бренд и основатель (для лендинга)")
async def widget_organizer(
    slug: str,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Карточка организатора события: бренд + основатель.

    Публичный профиль клиента (`/public/clients/{id}/profile`) для лендинга не
    годится — у него нет CORS-заголовков, браузер режет запрос с чужого домена.
    Здесь те же данные, но с открытым CORS.

    Владелец события — `event_owners (status='accepted')`; у `events` нет
    `client_id`. Если владельцев несколько (коллаб-событие) — берём того, кто
    принял приглашение раньше.
    """
    _set_cors(response)
    event = await _resolve_event(db, slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    row = await db.fetchrow(
        # ⚠️ Два РАЗНЫХ имени, не смешивать: `owner_name` — человек-основатель
        # (с фамилией, миграция 381), `brand_name` — название бренда, фамилия к
        # нему не относится. Поэтому имя человека берём отдельным выражением.
        """SELECT cl.id, cl.name, """ + DISPLAY_NAME_SQL("cl") + """ AS owner_full_name,
                  cl.brand_name, cl.brand_logo_url,
                  cl.profile_photo_url, cl.positioning, cl.achievements,
                  cl.owner_photo_url, cl.owner_positioning, cl.owner_achievements,
                  cl.bio, cl.social_links
             FROM event_owners eo
             JOIN clients cl ON cl.id = eo.client_id
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY eo.id
            LIMIT 1""",
        event["id"],
    )
    if not row:
        raise HTTPException(status_code=404, detail="Организатор не найден")

    social = row["social_links"]
    if isinstance(social, str):
        try:
            social = json.loads(social)
        except (ValueError, TypeError):
            social = {}

    return {
        "event_slug": event["slug"],
        "event_id": event["id"],
        "client_id": row["id"],
        # бренд
        "brand_name": row["brand_name"] or row["name"],
        "brand_logo_url": row["brand_logo_url"],
        "brand_photo_url": row["profile_photo_url"],
        "brand_positioning": row["positioning"],
        "brand_achievements": _parse_jsonb(row["achievements"]),
        # основатель
        "owner_name": row["owner_full_name"],
        "owner_photo_url": row["owner_photo_url"],
        "owner_positioning": row["owner_positioning"],
        "owner_achievements": _parse_jsonb(row["owner_achievements"]),
        "bio": row["bio"],
        "social_links": social if isinstance(social, dict) else {},
    }


def _media_total(media_assets: list) -> int:
    """Сумма подписчиков по всем медийным активам ([{platform, subscribers}])."""
    total = 0
    for a in (media_assets or []):
        if isinstance(a, dict):
            try:
                total += int(a.get("subscribers") or 0)
            except (ValueError, TypeError):
                pass
    return total


def _sort_group(rows: list, mode: str) -> list:
    """Сортировка группы коллабораторов.
    mode='media'      → по медийным активам (сумма подписчиков) DESC.
    mode='referrals'  (default) → по числу приведённых людей DESC.
    Тай-брейкеры одинаковые: priority ASC → id ASC (стабильно)."""
    if mode == "media":
        key = lambda d: (-_media_total(d.get("media_assets")),
                         d.get("priority") if d.get("priority") is not None else 60,
                         d.get("id") or 0)
    else:  # referrals (default)
        key = lambda d: (-int(d.get("referrals") or 0),
                         d.get("priority") if d.get("priority") is not None else 60,
                         d.get("id") or 0)
    return sorted(rows, key=key)


@router.get("/events/{slug}/collaborators", summary="Все коллабораторы события (для лендинга)")
async def widget_collaborators(
    slug: str,
    response: Response,
    sort_jury: str = "referrals",
    sort_speakers: str = "referrals",
    sort_partners: str = "referrals",
    db: asyncpg.Connection = Depends(get_db),
):
    """Плоский список коллабораторов события, сгруппированный по 4 ролям.

    Path-параметр `slug` принимает И slug, И числовой id события — id
    стабильный, лендинг можно завести на него и не бояться переименований.

    Группы: organizers / jury / speakers (headliner+speaker) /
    partners (general_partner+partner).

    ⚙️ GET-параметры сортировки внутри группы (каждый — 'referrals' или 'media'):
      • sort_jury      — как сортировать жюри (default 'referrals')
      • sort_speakers  — как сортировать спикеров (default 'referrals')
      • sort_partners  — как сортировать партнёров (default 'referrals')
    'referrals' = по числу приведённых людей (DESC), 'media' = по сумме
    подписчиков в медийных активах (DESC). Organizers всегда по referrals.
    Тай-брейкеры: priority ASC → id ASC.
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
                   -- Миграция 237: тумблер «не использовать индивидуальную афишу»
                   -- → лендинг получит null и отрисует обычное фото коллаба.
                   (SELECT url FROM collaborator_posters cp
                      WHERE NOT cse.use_photo_instead_of_poster
                        AND (cp.id = cse.poster_id OR
                             (cse.poster_id IS NULL AND cp.collaborator_id = c.id))
                      ORDER BY (cp.id = cse.poster_id) DESC, cp.sort_order, cp.id
                      LIMIT 1) AS poster_url,
                   cse.knowledge_base_title, cse.knowledge_base_url,
                   btrim(CASE WHEN COALESCE(btrim(c.last_name),'')='' THEN COALESCE(c.name,'') ELSE COALESCE(c.name,'')||' '||COALESCE(c.last_name,'') END) AS name, c.title, c.title AS position, c.achievements,
                   c.photo_url,
                   c.tg_channel_url, c.vk_url, c.max_url,
                   c.instagram_url, c.website_url,
                   c.media_assets,
                   ct.ref_code,
                   {_REFERRALS_COUNT} AS referrals
              FROM event_collaborators cse
              JOIN collaborators c ON c.id = cse.speaker_id
              LEFT JOIN contacts ct ON ct.id = c.contact_id
             -- is_visible=FALSE («Исключать из Mini App и лендинга» в карточке
             -- спикера) — человек не отдаётся ни на сторонний лендинг, ни в
             -- Mini App, ни на веб-страницу события.
             WHERE cse.event_id = $1 AND cse.is_visible = TRUE""",
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
        d["referrals"] = int(d.get("referrals") or 0)
        d["media_total"] = _media_total(d["media_assets"])
        bucket = _group_for(d.get("role"))
        if bucket in groups:
            groups[bucket].append(d)

    return {
        "event_slug": event["slug"],
        "event_id": event_id,
        "sort": {"jury": sort_jury, "speakers": sort_speakers, "partners": sort_partners},
        "organizers": _sort_group(groups["organizers"], "referrals"),
        "jury": _sort_group(groups["jury"], sort_jury),
        "speakers": _sort_group(groups["speakers"], sort_speakers),
        "partners": _sort_group(groups["partners"], sort_partners),
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
        """SELECT s.id, s.day, s.start_time, s.end_time,
                  COALESCE(NULLIF(cst.topic,''), (SELECT NULLIF(t.topic,'') FROM conf_speaker_topics t WHERE t.cse_id = s.speaker_id ORDER BY t.sort_order, t.id LIMIT 1), s.title) AS title,
                  s.gift_description, s.track_id, s.sort_order,
                  s.speaker_id AS speaker_event_id,
                  cse.role AS speaker_role,
                  col.id AS sp_id, btrim(CASE WHEN COALESCE(btrim(col.last_name),'')='' THEN COALESCE(col.name,'') ELSE COALESCE(col.name,'')||' '||COALESCE(col.last_name,'') END) AS sp_name, col.title AS sp_title,
                  col.photo_url AS sp_photo_url, col.achievements AS sp_achievements,
                  col.tg_channel_url AS sp_tg_channel_url,
                  col.vk_url AS sp_vk_url, col.max_url AS sp_max_url,
                  col.instagram_url AS sp_instagram_url, col.website_url AS sp_website_url,
                  col.media_assets AS sp_media_assets
             FROM conf_sessions s
             -- is_visible=FALSE → слот в программе остаётся (время не «схлопывается»),
             -- но данные скрытого спикера наружу не уходят.
             LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id AND cse.is_visible = TRUE
             LEFT JOIN collaborators col ON col.id = cse.speaker_id
             LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
            WHERE s.event_id = $1
            ORDER BY s.day, NULLIF(s.start_time,'') NULLS LAST, s.sort_order, s.id""",
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


# ─────────────────────────────────────────────────────────────────────────────
# Telegram-никнеймы участников события (для отдачи на сторону)
#
# Отдаёт ТОЛЬКО Telegram-username участников конкретного события —
# зарегистрированных ИЛИ незарегистрированных (параметр `registered`).
# Исключает всех коллабораторов ЭТОГО события (организаторы, жюри, спикеры,
# хедлайнеры, партнёры) и рабочий/личный аккаунт клиента.
#
# Персональные данные (телефон, email, числовые id) НЕ отдаются — только @ник.
# ─────────────────────────────────────────────────────────────────────────────
@router.options("/events/{slug}/participants-tg")
async def participants_tg_options(slug: str, response: Response):
    _set_cors(response)
    return {}


@router.get("/events/{slug}/participants-tg")
async def participants_tg(
    slug: str,
    response: Response,
    registered: str = "yes",   # yes | no | all
    in_chat: str = "all",      # yes | no | all — фильтр по членству в чате события
    db: asyncpg.Connection = Depends(get_db),
):
    """Telegram-никнеймы участников события.

    - `registered=yes`  — только зарегистрированные (default)
    - `registered=no`   — только незарегистрированные
    - `registered=all`  — все

    - `in_chat=all`     — без фильтра по чату (default)
    - `in_chat=yes`     — только те, кто в Telegram-чате события (`is_in_chat=TRUE`)
    - `in_chat=no`      — только те, кого нет в чате (`is_in_chat=FALSE`)

    Из выдачи исключены коллабораторы этого события (любая роль) и рабочие
    аккаунты клиента. Возвращаются только TG-username (без @ в поле `username`,
    плюс готовая ссылка `tg_url`). У каждого ника — флаг `in_chat`.
    Никаких персональных данных.
    """
    _set_cors(response)

    event = await _resolve_event(db, slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    event_id = event["id"]

    reg_filter = ""
    if registered == "yes":
        reg_filter = "AND ep.is_registered = TRUE"
    elif registered == "no":
        reg_filter = "AND ep.is_registered = FALSE"

    chat_filter = ""
    if in_chat == "yes":
        chat_filter = "AND ep.is_in_chat = TRUE"
    elif in_chat == "no":
        chat_filter = "AND ep.is_in_chat IS DISTINCT FROM TRUE"

    rows = await db.fetch(
        f"""
        SELECT DISTINCT pu.username,
               bool_or(ep.is_in_chat) AS in_chat
        FROM event_participants ep
        JOIN contacts c        ON c.id = ep.contact_id
        JOIN platform_users pu ON pu.contact_id = c.id AND pu.platform_slug = 'telegram'
        WHERE ep.event_id = $1
          {reg_filter}
          {chat_filter}
          AND pu.username IS NOT NULL AND pu.username <> ''
          AND pu.platform_user_id ~ '^[0-9]+$'          -- только реальные tg_id, не пустышки @username
          -- исключаем коллабораторов ЭТОГО события (любая роль)
          AND c.id NOT IN (
                SELECT col.contact_id
                FROM event_collaborators ec
                JOIN collaborators col ON col.id = ec.speaker_id
                WHERE ec.event_id = $1
          )
          -- исключаем рабочий/личный аккаунт клиента
          AND lower(pu.username) NOT IN (
                SELECT lower(u) FROM (
                  SELECT unnest(ARRAY[work_tg_username, telegram_username]) AS u
                  FROM clients WHERE id = (SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1)
                ) t WHERE u IS NOT NULL AND u <> ''
          )
        GROUP BY pu.username
        ORDER BY pu.username
        """,
        event_id,
    )

    usernames = [r["username"] for r in rows]
    return {
        "event_slug": event["slug"],
        "event_id": event_id,
        "registered": registered,
        "in_chat": in_chat,
        "count": len(usernames),
        "usernames": usernames,                                  # ["nick1", "nick2", ...]
        "tg_urls": [f"https://{TG_DOMAIN}/{u}" for u in usernames],     # готовые ссылки
        "mentions": [f"@{u}" for u in usernames],                # ["@nick1", "@nick2", ...]
        # по каждому нику — в чате он или нет (для смешанной выгрузки in_chat=all)
        "participants": [
            {"username": r["username"], "in_chat": bool(r["in_chat"])}
            for r in rows
        ],
    }


@router.options("/events/{slug}/participants-tg-in-chat")
async def participants_tg_in_chat_options(slug: str, response: Response):
    _set_cors(response)
    return {}


@router.get("/events/{slug}/participants-tg-in-chat")
async def participants_tg_in_chat(
    slug: str,
    response: Response,
    registered: str = "yes",   # yes | no | all
    db: asyncpg.Connection = Depends(get_db),
):
    """Алиас `participants-tg` с жёстким фильтром «только те, кто в чате события».

    Удобно дёргать из mailer одной ссылкой без параметра `in_chat`.
    По умолчанию — зарегистрированные И в чате (`registered=yes`, `in_chat=yes`).
    Те же исключения (коллабораторы, рабочий аккаунт), тот же формат ответа.
    """
    return await participants_tg(
        slug=slug,
        response=response,
        registered=registered,
        in_chat="yes",
        db=db,
    )
