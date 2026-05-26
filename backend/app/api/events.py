from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
from app.services import collaborator_sort
import asyncpg
import re
import secrets

router = APIRouter(prefix="/events", tags=["События"])

# Алфавит без визуально похожих символов (без 0/o, 1/l/i)
_SLUG_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'


def _short_code(n: int = 5) -> str:
    return ''.join(secrets.choice(_SLUG_CODE_ALPHABET) for _ in range(n))


async def _make_unique_short_slug(db: asyncpg.Connection) -> str:
    """Короткий случайный slug из 5 символов алфавита `_SLUG_CODE_ALPHABET`.
    Дефолт для новых событий — короткие, неугадываемые ссылки `/l/abcde`.
    Клиент при желании заменяет на свой `slug` через PATCH /events/{id}.
    Коллизия маловероятна (~1/33M), но повторяем до уникальности."""
    while True:
        candidate = _short_code(5)
        exists = await db.fetchval("SELECT 1 FROM events WHERE slug = $1", candidate)
        if not exists:
            return candidate


# Валидация пользовательского slug: только латиница, цифры, дефис.
# Длина 3..60. Не начинается и не заканчивается дефисом, нет двойных дефисов.
_SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$")


def _validate_custom_slug(slug: str) -> str:
    s = slug.strip().lower()
    if len(s) < 3 or len(s) > 60:
        raise HTTPException(status_code=400, detail="Код ссылки — от 3 до 60 символов")
    if not _SLUG_PATTERN.match(s):
        raise HTTPException(
            status_code=400,
            detail="Код ссылки: только латиница, цифры и дефис. Не должно начинаться/заканчиваться дефисом и не должно быть двойных дефисов."
        )
    return s


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
    slug: Optional[str] = None          # пользовательский код ссылки (или короткий по умолчанию)
    description: Optional[str] = None
    # Текст на вкладке «Программа» в Mini App (под плитками). См. миграцию 084.
    description_post_register: Optional[str] = None
    landing_url: Optional[str] = None
    address: Optional[str] = None
    start_at: Optional[str] = None
    end_at:   Optional[str] = None
    webhook_url: Optional[str] = None
    status: Optional[str] = None
    points_free: Optional[int] = None
    points_paid: Optional[int] = None
    require_subscription: Optional[bool] = None
    # VIP / Чат
    vip_url: Optional[str] = None
    vip_button_label: Optional[str] = None
    # Чат события — отдельная ссылка на каждую платформу + выбор главной.
    # chat_url оставлено как legacy shadow: при PATCH chat_url_* / primary
    # бэк сам пересчитывает его = chat_url_<primary>. Старые места кода
    # (broadcast templates, public landing) продолжают читать его как раньше.
    chat_url: Optional[str] = None
    chat_url_tg: Optional[str] = None
    chat_url_vk: Optional[str] = None
    chat_url_max: Optional[str] = None
    primary_chat_platform: Optional[str] = None   # 'telegram' | 'vk' | 'max'
    chat_subscriptions_required: Optional[bool] = None
    chat_member_count_label: Optional[str] = None
    # Заголовок кнопки чата в Mini App (миграция 117). NULL = дефолт «Чат события».
    chat_button_label: Optional[str] = None
    # Какая из главных кнопок красная: 'vip' | 'chat' | 'none' (миграция 117).
    # NULL = 'vip' (обратная совместимость).
    accent_button: Optional[str] = None
    telegram_chat_ids: Optional[str] = None  # ID чатов/каналов через запятую — общее для меропр и конференций
    # Чекбокс «Регистрировать без ввода контактных данных» — работает на встроенном
    # лендинге Mini App, если landing_url не задан. TRUE → клик «Хочу участвовать»
    # регистрирует по tg_id без формы (имя из Telegram, email/phone пустые).
    skip_contact_form: Optional[bool] = None
    stream_url: Optional[str] = None
    # Welcome-письмо при регистрации (миграция 099). См. event_welcome_email.py.
    welcome_enabled: Optional[bool] = None
    welcome_text: Optional[str] = None
    welcome_email_subject: Optional[str] = None
    # Общее видео события (миграция 113). Для скачивания спикерами на странице
    # самоправки → вкладка «Материалы».
    video_url: Optional[str] = None


@router.get("/", summary="Список событий клиента")
async def list_events(
    module_slug: str = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    # effective_start: для конференций fallback на минимальную дату из conf_days,
    # для остальных — собственный start_at
    # effective_start_at / effective_end_at для конференций:
    #   start = первый день + (open_time дня 1 ИЛИ MIN(start_time) сессий дня 1)
    #   end   = последний день + (close_time посл. дня ИЛИ MAX(end_time) сессий посл. дня)
    # если ничего не задано — fallback на day_date 00:00 / 23:59 чтобы вообще что-то показать.
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
               CASE WHEN e.module_slug IN ('conference','turnir') THEN
                 (SELECT (d.day_date + COALESCE(
                            NULLIF(d.open_time,'')::time,
                            (SELECT MIN(NULLIF(s.start_time,'')::time)
                               FROM conf_sessions s
                              WHERE s.event_id = e.id AND s.day = d.day_number),
                            '00:00'::time
                          )) AT TIME ZONE 'Europe/Moscow'
                    FROM conf_days d
                    WHERE d.event_id = e.id
                    ORDER BY d.day_number ASC LIMIT 1)
                 ELSE e.start_at
               END AS effective_start_at,
               CASE WHEN e.module_slug IN ('conference','turnir') THEN
                 (SELECT (d.day_date + COALESCE(
                            NULLIF(d.close_time,'')::time,
                            (SELECT MAX(NULLIF(s.end_time,'')::time)
                               FROM conf_sessions s
                              WHERE s.event_id = e.id AND s.day = d.day_number),
                            (SELECT MAX(NULLIF(s.start_time,'')::time)
                               FROM conf_sessions s
                              WHERE s.event_id = e.id AND s.day = d.day_number),
                            '23:59'::time
                          )) AT TIME ZONE 'Europe/Moscow'
                    FROM conf_days d
                    WHERE d.event_id = e.id
                    ORDER BY d.day_number DESC LIMIT 1)
                 ELSE e.end_at
               END AS effective_end_at,
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
    slug = await _make_unique_short_slug(db)

    from datetime import datetime as _dt
    def _parse_dt(s):
        return _dt.fromisoformat(s.replace('Z', '+00:00')) if s else None

    # Тип «Участие в конкурсах» по умолчанию идёт без сбора контактов
    # (клиент сам участник внешнего конкурса, ему нужны только голоса).
    default_skip_contact_form = (data.module_slug == "contest")

    event = await db.fetchrow(
        """
        INSERT INTO events (client_id, slug, title, description, landing_url, address,
                            start_at, end_at, webhook_url,
                            module_slug, points_free, points_paid, require_subscription,
                            skip_contact_form, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft')
        RETURNING *
        """,
        client_id, slug, data.title, data.description, data.landing_url, data.address,
        _parse_dt(data.start_at), _parse_dt(data.end_at), data.webhook_url,
        data.module_slug, data.points_free, data.points_paid, data.require_subscription,
        default_skip_contact_form,
    )

    # Конференции и турниры используют те же таблицы conf_* (программа, спикеры).
    # Создаём запись в conf_conferences для обоих типов.
    if data.module_slug in ("conference", "turnir"):
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


@router.get("/slug/{slug}/share-links", summary="Реф-ссылки события (публично, для Mini App)")
async def get_event_share_links_by_slug(
    slug: str,
    pid: str | None = None,
    tab: str | None = None,
    db: asyncpg.Connection = Depends(get_db),
):
    from ..services.share_links import build_share_links
    ev = await db.fetchrow("SELECT id, slug, client_id FROM events WHERE slug = $1", slug)
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    links = await build_share_links(
        db, client_id=ev["client_id"], event_slug=ev["slug"], partner_id=pid, tab=tab,
    )
    return {"event_id": ev["id"], "slug": ev["slug"], "links": links}


@router.get("/{event_id}/share-links", summary="Реф-ссылки события для всех активных платформ клиента")
async def get_event_share_links(
    event_id: int,
    pid: str | None = None,
    tab: str | None = None,
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает словарь {platform → url} с реф-ссылками для шеринга.

    Используется в дашборде (карточка события, страница соорганизатора/спикера)
    и в Mini App (вкладка «Игра» — показывает только ссылку текущей платформы).
    Если у клиента не подключены доп. площадки — возвращает только telegram+vk
    через системные ботов/сообщества.
    """
    from ..services.share_links import build_share_links
    ev = await db.fetchrow("SELECT slug, client_id FROM events WHERE id = $1", event_id)
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    links = await build_share_links(
        db, client_id=ev["client_id"], event_slug=ev["slug"], partner_id=pid, tab=tab,
    )
    return {"event_id": event_id, "slug": ev["slug"], "links": links}


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

    # exclude_unset — берём только реально присланные поля. Раньше было
    # `if v is not None`, из-за чего нельзя было ОБНУЛИТЬ поле (например,
    # стереть landing_url): null молча отбрасывался. PATCH-семантика —
    # «отсутствие поля = не трогать», «null = записать NULL».
    updates = data.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    # Диагностика welcome — что приходит в PATCH (для отладки welcome-полей)
    if any(k.startswith("welcome_") for k in updates.keys()):
        import logging as _l
        wlog = {k: (v if k != "welcome_text" else f"len={len(v or '')}") for k, v in updates.items() if k.startswith("welcome_")}
        _l.getLogger(__name__).info("PATCH /events/%s welcome fields: %s", event_id, wlog)

    # accent_button: допускаем только 'vip'|'chat'|'none' или null (= дефолт 'vip').
    if "accent_button" in updates:
        v = updates["accent_button"]
        if v is not None and v not in ("vip", "chat", "none"):
            raise HTTPException(status_code=400, detail="accent_button должен быть 'vip', 'chat' или 'none'")

    # Slug: валидация формата + проверка уникальности (если меняется)
    if "slug" in updates:
        new_slug = _validate_custom_slug(updates["slug"])
        taken_by = await db.fetchval(
            "SELECT id FROM events WHERE slug = $1 AND id <> $2",
            new_slug, event_id
        )
        if taken_by:
            raise HTTPException(status_code=409, detail="Этот код ссылки уже занят другим событием")
        updates["slug"] = new_slug

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

    # chat_url — legacy shadow поле. После PATCH chat_url_* / primary
    # пересчитываем его = chat_url_<primary>. Если primary пустой ИЛИ
    # соответствующее поле пустое — chat_url становится NULL.
    if any(k in updates for k in ("chat_url_tg", "chat_url_vk", "chat_url_max", "primary_chat_platform")):
        await _refresh_chat_url_shadow(db, event_id)

    updated = await db.fetchrow(f"SELECT e.*, {_POSTER_SUBQ} FROM events e WHERE e.id = $1", event_id)
    return {"event": dict(updated)}


async def _refresh_chat_url_shadow(db: asyncpg.Connection, event_id: int) -> None:
    """Синхронизирует events.chat_url с chat_url_<primary> для обратной
    совместимости. Вызывается после UPDATE chat_url_* / primary_chat_platform.
    """
    await db.execute(
        """UPDATE events
              SET chat_url = NULLIF(
                  CASE primary_chat_platform
                    WHEN 'telegram' THEN chat_url_tg
                    WHEN 'vk'       THEN chat_url_vk
                    WHEN 'max'      THEN chat_url_max
                    ELSE NULL
                  END, ''
              )
            WHERE id = $1""",
        event_id,
    )


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
    new_slug = await _make_unique_short_slug(db)

    # Копия события — всегда черновик, start_at/end_at не наследуем
    # (для конференций они вообще берутся из conf_days, для остальных
    # клиент задаст заново — старые даты всё равно неактуальны).
    async with db.transaction():
        # Копируем ВСЕ настройки события кроме start_at/end_at — даты
        # всегда задаются заново у копии.
        new_event = await db.fetchrow(
            """INSERT INTO events
                 (client_id, slug, title, description, description_post_register,
                  landing_url, address,
                  start_at, end_at,
                  webhook_url, module_slug, points_free, points_paid, points_scope,
                  require_subscription, status,
                  chat_url, chat_url_tg, chat_url_vk, chat_url_max, primary_chat_platform,
                  stream_url, vip_url, vip_button_label,
                  chat_subscriptions_required, chat_member_count_label,
                  chat_button_label, accent_button,
                  skip_contact_form)
               VALUES ($1,$2,$3,$4,$5,$6,$7,
                       NULL,NULL,
                       $8,$9,$10,$11,$12,
                       $13,'draft',
                       $14,$15,$16,$17,$18,
                       $19,$20,$21,
                       $22,$23,
                       $24,$25,
                       $26)
               RETURNING *""",
            client_id, new_slug, new_title, src['description'],
            src.get('description_post_register'),
            src['landing_url'],
            src.get('address'),
            src['webhook_url'], src['module_slug'],
            src['points_free'], src['points_paid'], src['points_scope'],
            src['require_subscription'],
            src.get('chat_url'),
            src.get('chat_url_tg'), src.get('chat_url_vk'), src.get('chat_url_max'),
            src.get('primary_chat_platform'),
            src.get('stream_url'), src.get('vip_url'),
            src.get('vip_button_label'),
            src.get('chat_subscriptions_required') or False,
            src.get('chat_member_count_label'),
            src.get('chat_button_label'),
            src.get('accent_button'),
            src.get('skip_contact_form') or False,
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
            "SELECT gift_count_mode, is_enabled FROM event_referral_settings WHERE event_id = $1",
            event_id
        )
        if srs:
            await db.execute(
                """INSERT INTO event_referral_settings (event_id, gift_count_mode, is_enabled)
                   VALUES ($1, $2, $3)""",
                new_id, srs['gift_count_mode'], srs['is_enabled']
            )

        # event_referral_share_texts
        share_texts = await db.fetch(
            "SELECT content, sort FROM event_referral_share_texts WHERE event_id = $1 ORDER BY sort, id",
            event_id
        )
        for st in share_texts:
            await db.execute(
                """INSERT INTO event_referral_share_texts (event_id, content, sort)
                   VALUES ($1, $2, $3)""",
                new_id, st['content'], st['sort']
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

        # Конференции и турниры используют те же таблицы conf_* — копируем для обоих.
        if src['module_slug'] in ('conference', 'turnir'):
            old_conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
            if old_conf:
                cols = [k for k in dict(old_conf).keys() if k not in ('id', 'event_id', 'editor_code')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO conf_conferences (event_id, {','.join(cols)}) VALUES ($1, {placeholders})",
                    new_id, *[old_conf[c] for c in cols]
                )

            # Маппинг event_collaborators для дальнейших таблиц
            cse_map: dict = {}
            old_cses = await db.fetch("SELECT * FROM event_collaborators WHERE event_id = $1", event_id)
            for cse in old_cses:
                cols = [k for k in dict(cse).keys() if k not in ('id', 'event_id')]
                placeholders = ",".join(f"${i+2}" for i in range(len(cols)))
                new_cse_id = await db.fetchval(
                    f"INSERT INTO event_collaborators (event_id, {','.join(cols)}) VALUES ($1, {placeholders}) RETURNING id",
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

            # conf_sessions (speaker_id → event_collaborators.id, mapping)
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
                  ep.link_clicked_at,
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
                  -- Платформенные идентичности — для иконок и клиабельных ссылок в UI
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_username,
                  (SELECT rc.id FROM contacts rc WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1) AS referrer_contact_id,
                  -- referrer_name: имя из platform_users (Telegram) актуальнее
                  -- и короче, чем contacts.name, в который при импорте из
                  -- Salebot могла попасть склеенная мусорная строка.
                  COALESCE(
                    NULLIF(TRIM(CONCAT_WS(' ',
                      (SELECT rpu.first_name FROM platform_users rpu
                         JOIN contacts rc ON rc.id = rpu.contact_id
                        WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1),
                      (SELECT rpu.last_name FROM platform_users rpu
                         JOIN contacts rc ON rc.id = rpu.contact_id
                        WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1)
                    )), ''),
                    (SELECT rc.name FROM contacts rc WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1)
                  ) AS referrer_name,
                  (SELECT rpu.username FROM platform_users rpu
                     JOIN contacts rc ON rc.id = rpu.contact_id
                    WHERE rc.ref_code = ep.referrer_ref_code LIMIT 1) AS referrer_username,
                  COUNT(re.id) FILTER (WHERE re.type IN ('free','paid')) as referral_count,
                  -- Архитектура G: подписан хотя бы на один TG-канал клиента (через client_channels)
                  EXISTS (
                    SELECT 1 FROM platform_user_channels puc
                      JOIN platform_users pu ON pu.id = puc.platform_user_id
                      JOIN client_channels cc ON cc.id = puc.client_channel_id
                      JOIN channels ch ON ch.id = cc.channel_id
                     WHERE pu.contact_id = c.id
                       AND cc.client_id = c.client_id
                       AND ch.platform_slug = 'telegram'
                       AND puc.is_unsubscribed = FALSE
                  ) AS is_subscribed,
                  -- Отписался: есть записи на каналы клиента, но все unsubscribed=TRUE
                  (
                    EXISTS (
                      SELECT 1 FROM platform_user_channels puc
                        JOIN platform_users pu ON pu.id = puc.platform_user_id
                        JOIN client_channels cc ON cc.id = puc.client_channel_id
                       WHERE pu.contact_id = c.id AND cc.client_id = c.client_id
                         AND puc.is_unsubscribed = TRUE
                    ) AND NOT EXISTS (
                      SELECT 1 FROM platform_user_channels puc
                        JOIN platform_users pu ON pu.id = puc.platform_user_id
                        JOIN client_channels cc ON cc.id = puc.client_channel_id
                       WHERE pu.contact_id = c.id AND cc.client_id = c.client_id
                         AND puc.is_unsubscribed = FALSE
                    )
                  ) AS is_unsubscribed
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


@router.delete("/{event_id}/participants/{participant_id}", summary="Удалить участника из события")
async def delete_event_participant(
    event_id: int,
    participant_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Удаляет строку из event_participants. Контакт остаётся, удаляется только участие в этом событии.

    Каскад: gift_issuances этого участника удаляются, у других участников снимается ссылка на этого
    как реферера (referrer_participant_id → NULL). raffle_tickets.pluson_participant_id → NULL по FK.
    """
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ep.id FROM event_participants ep
           JOIN events e ON e.id = ep.event_id
           WHERE ep.id = $1 AND ep.event_id = $2 AND e.client_id = $3""",
        participant_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Участник не найден")

    async with db.transaction():
        await db.execute(
            "DELETE FROM gift_issuances WHERE participant_id = $1",
            participant_id
        )
        await db.execute(
            "UPDATE event_participants SET referrer_participant_id = NULL WHERE referrer_participant_id = $1",
            participant_id
        )
        await db.execute(
            "DELETE FROM event_participants WHERE id = $1",
            participant_id
        )
    return {"deleted": True, "id": participant_id}


class AddParticipantFromContactRequest(BaseModel):
    contact_id: int
    is_registered: Optional[bool] = False


@router.post("/{event_id}/participants/from-contact", summary="Добавить участника из контактов (вручную)")
async def add_event_participant_from_contact(
    event_id: int,
    data: AddParticipantFromContactRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Организатор добавляет существующий контакт как участника события.
    Без рассылок/приветствий — это ручная запись. Если запись уже есть
    (повторное добавление того же контакта) — обновляет is_registered.
    """
    client_id = int(client["sub"])
    event = await db.fetchval(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    contact_ok = await db.fetchval(
        "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
        data.contact_id, client_id
    )
    if not contact_ok:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    is_registered = bool(data.is_registered)
    row = await db.fetchrow(
        """INSERT INTO event_participants (event_id, contact_id, is_registered, registered_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (event_id, contact_id)
           DO UPDATE SET is_registered = event_participants.is_registered OR EXCLUDED.is_registered
           RETURNING id, is_registered, (xmax = 0) AS is_new""",
        event_id, data.contact_id, is_registered
    )
    return {
        "id": row["id"],
        "is_registered": row["is_registered"],
        "is_new": bool(row["is_new"]),
    }


# ─── Соорганизаторы / Спикеры события (event_collaborators) ────────────────────
# Общая таблица: для мероприятий (module_slug != 'conference') используется как
# «Соорганизаторы» с role='organizer'. Для конференций есть отдельный конф-UI
# со своей логикой добавления спикеров с темами/подарками — он не трогается.

class CollaboratorAddRequest(BaseModel):
    collaborator_id: int
    role: str = "organizer"  # 'organizer' | 'speaker' | 'headliner' | 'partner'
    sort_order: Optional[int] = None


class CollaboratorReorderRequest(BaseModel):
    sort_order: int


@router.get("/{event_id}/collaborators", summary="Список коллабораторов события (с фильтром по роли)")
async def list_event_collaborators(
    event_id: int,
    role: Optional[str] = None,  # None = все роли; 'organizer'/'speaker'/etc.
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    # Проверяем что event принадлежит клиенту
    own = await db.fetchval(
        "SELECT 1 FROM events WHERE id = $1 AND client_id = $2",
        event_id, client_id
    )
    if not own:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    sql = """
        SELECT ec.id, ec.role, ec.sort_order, ec.is_visible, ec.priority,
               ec.bot_in_channel, ec.exclude_channel_from_subscription,
               co.id AS collaborator_id, co.name, co.title, co.photo_url,
               co.achievements, co.tg_channel_url, co.tg_channel_id,
               pu_tg.platform_user_id AS personal_tg_id,
               pu_tg.username         AS personal_tg_username,
               co.instagram_url, co.website_url, ct.ref_code
          FROM event_collaborators ec
          JOIN collaborators co ON co.id = ec.speaker_id
          LEFT JOIN contacts ct ON ct.id = co.contact_id
          LEFT JOIN platform_users pu_tg
            ON pu_tg.contact_id = co.contact_id AND pu_tg.platform_slug = 'telegram'
         WHERE ec.event_id = $1
    """
    args = [event_id]
    if role:
        args.append(role)
        sql += f" AND ec.role = ${len(args)}"
    sql += " ORDER BY " + collaborator_sort.order_by_sql("ec")
    rows = await db.fetch(sql, *args)

    # Бэкфилл реф-кодов для коллаба, у которого ещё нет contact_id (легаси).
    # ensure_collaborator_contact идемпотентен — создаст contact + ref_code и
    # привяжет к коллаборатору только если их ещё нет.
    from app.api.modules.conference import ensure_collaborator_contact
    items = []
    for r in rows:
        d = dict(r)
        if not d.get("ref_code"):
            try:
                d["ref_code"] = await ensure_collaborator_contact(d["collaborator_id"], db)
            except HTTPException:
                d["ref_code"] = None
        items.append(d)
    return {"items": items}


@router.post("/{event_id}/collaborators", summary="Добавить коллаборатора в событие")
async def add_event_collaborator(
    event_id: int,
    data: CollaboratorAddRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    own = await db.fetchval(
        "SELECT 1 FROM events WHERE id = $1 AND client_id = $2",
        event_id, client_id
    )
    if not own:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    # Проверяем что коллаборатор существует
    co = await db.fetchval(
        "SELECT id FROM collaborators WHERE id = $1",
        data.collaborator_id
    )
    if not co:
        raise HTTPException(status_code=404, detail="Коллаборатор не найден")

    # Если уже привязан — просто меняем роль/возвращаем существующую запись
    existing = await db.fetchrow(
        "SELECT id, role FROM event_collaborators WHERE event_id = $1 AND speaker_id = $2",
        event_id, data.collaborator_id
    )
    if existing:
        if existing["role"] != data.role:
            await db.execute(
                "UPDATE event_collaborators SET role = $1 WHERE id = $2",
                data.role, existing["id"]
            )
        return {"id": existing["id"], "role": data.role, "already_existed": True}

    # Сорт-индекс: либо переданный, либо в конец списка с этой ролью
    if data.sort_order is None:
        max_sort = await db.fetchval(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_collaborators WHERE event_id = $1 AND role = $2",
            event_id, data.role
        )
        sort_order = max_sort
    else:
        sort_order = data.sort_order

    new_id = await db.fetchval(
        """INSERT INTO event_collaborators (speaker_id, event_id, role, sort_order)
           VALUES ($1, $2, $3, $4) RETURNING id""",
        data.collaborator_id, event_id, data.role, sort_order
    )
    # Гарантируем контакт + ref_code у коллаборатора — нужно для отображения
    # его персональной партнёрской ссылки в карточке (frontend читает ref_code).
    from app.api.modules.conference import ensure_collaborator_contact
    try:
        await ensure_collaborator_contact(data.collaborator_id, db)
    except HTTPException:
        pass
    return {"id": new_id, "role": data.role, "already_existed": False}


@router.delete("/{event_id}/collaborators/{ec_id}", summary="Убрать коллаборатора из события")
async def remove_event_collaborator(
    event_id: int,
    ec_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ec.id FROM event_collaborators ec
             JOIN events e ON e.id = ec.event_id
            WHERE ec.id = $1 AND ec.event_id = $2 AND e.client_id = $3""",
        ec_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Не найдено")
    await db.execute("DELETE FROM event_collaborators WHERE id = $1", ec_id)
    return {"deleted": True}


@router.patch("/{event_id}/collaborators/{ec_id}/sort", summary="Изменить порядок")
async def reorder_event_collaborator(
    event_id: int,
    ec_id: int,
    data: CollaboratorReorderRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ec.id FROM event_collaborators ec
             JOIN events e ON e.id = ec.event_id
            WHERE ec.id = $1 AND ec.event_id = $2 AND e.client_id = $3""",
        ec_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Не найдено")
    await db.execute(
        "UPDATE event_collaborators SET sort_order = $1 WHERE id = $2",
        data.sort_order, ec_id
    )
    return {"sort_order": data.sort_order}


class CollaboratorPatchRequest(BaseModel):
    exclude_channel_from_subscription: Optional[bool] = None
    is_visible: Optional[bool] = None
    priority: Optional[int] = None


@router.patch("/{event_id}/collaborators/{ec_id}", summary="Обновить per-event настройки коллаборатора")
async def update_event_collaborator(
    event_id: int,
    ec_id: int,
    data: CollaboratorPatchRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ec.id FROM event_collaborators ec
             JOIN events e ON e.id = ec.event_id
            WHERE ec.id = $1 AND ec.event_id = $2 AND e.client_id = $3""",
        ec_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Не найдено")

    set_parts = []
    args: list = []
    if data.exclude_channel_from_subscription is not None:
        args.append(data.exclude_channel_from_subscription)
        set_parts.append(f"exclude_channel_from_subscription = ${len(args)}")
    if data.is_visible is not None:
        args.append(data.is_visible)
        set_parts.append(f"is_visible = ${len(args)}")
    if data.priority is not None:
        if data.priority < 1 or data.priority > 999:
            raise HTTPException(status_code=400, detail="Приоритет должен быть от 1 до 999")
        args.append(data.priority)
        set_parts.append(f"priority = ${len(args)}")
    if not set_parts:
        return {"updated": False}

    args.append(ec_id)
    await db.execute(
        f"UPDATE event_collaborators SET {', '.join(set_parts)} WHERE id = ${len(args)}",
        *args,
    )
    return {"updated": True}


@router.post("/{event_id}/collaborators/{ec_id}/verify-channel", summary="Проверить, что бот видит подписку коллаборатора на свой канал")
async def verify_event_collaborator_channel(
    event_id: int,
    ec_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Аналог verify-channel у спикеров конференции — для соорганизаторов
    обычного мероприятия. Делает getChatMember(channel, personal_tg_id).
    Если бот видит подписку — ставит bot_in_channel = TRUE."""
    import httpx
    from app.config import settings
    from app.services.channels import get_client_telegram_token

    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT co.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  co.name
             FROM event_collaborators ec
             JOIN events e ON e.id = ec.event_id
             JOIN collaborators co ON co.id = ec.speaker_id
             LEFT JOIN platform_users pu_tg
               ON pu_tg.contact_id = co.contact_id AND pu_tg.platform_slug = 'telegram'
            WHERE ec.id = $1 AND ec.event_id = $2 AND e.client_id = $3""",
        ec_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Не найдено")

    token = (await get_client_telegram_token(client_id, db)) or settings.telegram_bot_token
    if not token:
        raise HTTPException(status_code=400, detail="Не настроен главный бот клиента — подключите его в разделе «Каналы»")

    bot_handle = ""
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            br = await http.get(f"https://api.telegram.org/bot{token}/getMe")
        bot_handle = ((br.json() or {}).get("result") or {}).get("username", "") or ""
    except Exception:
        pass
    bot_ref = f"@{bot_handle}" if bot_handle else "главный бот"

    channel_id = (row["tg_channel_id"] or "").strip()
    if not channel_id:
        raise HTTPException(status_code=400, detail="Сначала укажите ID канала и сохраните профиль коллаборатора")

    personal_tg_id = row["personal_tg_id"]
    if not personal_tg_id:
        raise HTTPException(
            status_code=400,
            detail="Заполните «ID личного аккаунта» в профиле коллаборатора — без него не получится проверить канал автоматически"
        )

    try:
        async with httpx.AsyncClient(timeout=8) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel_id, "user_id": personal_tg_id}
            )
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ошибка Telegram API: {e}")

    if not data.get("ok"):
        desc = (data.get("description") or "").lower()
        if "member list is inaccessible" in desc:
            detail = f"Бот не админ канала. Добавьте {bot_ref} в администраторы канала (без прав публикации — достаточно нулевых прав)."
        elif "chat not found" in desc:
            if not channel_id.startswith("-100"):
                detail = f"Канал не найден. ID канала должен начинаться с «-100» (у вас: «{channel_id}»). Скопируйте правильный ID и сохраните профиль."
            else:
                detail = f"Канал не найден. Скорее всего {bot_ref} ещё не добавлен в канал. Откройте канал → Управление → Администраторы → добавьте {bot_ref}, и нажмите ещё раз."
        elif "user not found" in desc:
            detail = "Личный аккаунт не найден в Telegram. Проверьте «ID личного аккаунта»."
        elif "bot was kicked" in desc or "kicked" in desc:
            detail = f"Бот удалён из канала. Добавьте {bot_ref} обратно в администраторы."
        elif "not enough rights" in desc or "no rights" in desc:
            detail = f"У бота нет прав видеть подписчиков. Добавьте {bot_ref} как администратора."
        elif "forbidden" in desc:
            detail = f"Нет доступа к каналу. Убедитесь, что {bot_ref} добавлен в администраторы канала."
        else:
            detail = f"Не удалось проверить канал. Telegram ответил: {data.get('description') or 'неизвестная ошибка'}"
        raise HTTPException(status_code=400, detail=detail)

    status = (data.get("result") or {}).get("status", "")
    if status not in ("member", "administrator", "creator", "restricted"):
        name = row["name"] or "Коллаборатор"
        raise HTTPException(
            status_code=400,
            detail=f"Бот видит канал, но {name} НЕ подписан(а) на свой канал (статус: {status or 'нет данных'}). Подпишитесь и попробуйте снова."
        )

    await db.execute(
        "UPDATE event_collaborators SET bot_in_channel = TRUE WHERE id = $1",
        ec_id
    )
    name = row["name"] or "коллаборатор"
    return {"ok": True, "message": f"Бот видит подписку — {name} в канале (статус: {status}). Канал учитывается в проверке."}
