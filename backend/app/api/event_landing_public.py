"""
Публичная отдача собранного лендинга события — данные для страницы
`pluson.ru/e/{slug}` (и `/e/{slug}/thanks`).

Один эндпоинт отдаёт ВСЁ, что нужно странице: настройки оформления, список
блоков в заданном порядке и содержимое живых блоков (спикеры, программа,
тарифы, организатор, подарки, места, контакты поддержки, реквизиты футера).
Одним запросом, чтобы страница не мигала подгрузками.

⚠️ Живые блоки читают те же таблицы, что и кабинет — копии контента нигде нет.
Поправил спикера / сдвинул программу / поменял цену тарифа → на лендинге
обновилось само, повторно «пересобирать» лендинг не нужно.

Черновик (`is_published = FALSE`) публично не отдаём — 404. Исключение:
`?preview=<токен>` — подписанная ссылка владельца ([preview_token.py]).
Токен идёт ПАРАМЕТРОМ АДРЕСА, а не заголовком: страница `/e/{slug}`
рендерится на сервере Next.js, и заголовка `Authorization` из браузера у
него нет — прежняя проверка по заголовку не срабатывала никогда.
"""
from fastapi import APIRouter, Depends, HTTPException, Response, Query
from typing import Optional
import json
import asyncpg

from app.database import get_db
from app.services.landing_fonts import font_family_css, normalize_font
from app.services.landing_theme import apply_theme_fields
from app.services.landing_support import support_links
from app.services.collaborator_sort import order_by_sql
from app.services.preview_token import preview_client_id
from app.services.tariff_discount import with_discount
from app.services.share_links import TG_DOMAIN
from app.services.person_name import DISPLAY_NAME_SQL

router = APIRouter(prefix="/api/v1/public/event-landing", tags=["Лендинг события (публично)"])

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=30",
}


def _set_cors(response: Response) -> None:
    for k, v in _CORS.items():
        response.headers[k] = v


def _jsonb(value) -> list | dict:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return []
    return value if value is not None else []


def _fmt_time(val) -> Optional[str]:
    """Время программы — строка "HH:MM" (правило проекта, без astimezone)."""
    return str(val)[:5] if val else None


@router.options("/{slug}", include_in_schema=False)
async def _opts(slug: str, response: Response):
    _set_cors(response)
    return {}


@router.get("/{slug}", summary="Собранный лендинг события")
async def get_public_landing(
    slug: str,
    response: Response,
    kind: str = Query("main", pattern="^(main|post_pay)$"),
    preview: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    _set_cors(response)

    event = await db.fetchrow(
        # ⚠️ `address` — для блока «Место проведения» с картой. Поле общее с
        # Mini App и ботом: адрес живёт в одном месте, а не копируется в блок.
        """SELECT e.id, e.slug, e.title, e.description, e.start_at, e.end_at,
                  e.status, e.module_slug, e.is_collab, e.address,
                  -- Координаты (мигр. 398): по ним карта ставит МЕТКУ.
                  -- Поиск по тексту показывает район, но точку не рисует.
                  e.geo_lat, e.geo_lon,
                  e.seats_total, e.offer_url, e.offer_id,
                  e.seats_label, e.seats_label_position, e.seats_size,
                  e.seats_count_mode, e.seats_base, e.skip_contact_form,
                  (SELECT url FROM event_posters
                    WHERE event_id = e.id AND day IS NULL
                    ORDER BY CASE orientation
                               WHEN 'horizontal' THEN 1
                               WHEN 'square'     THEN 2
                               WHEN 'vertical'   THEN 3
                               ELSE 4 END, sort, id
                    LIMIT 1) AS poster_url
             FROM events e
            WHERE e.slug = $1""",
        slug,
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    # ⚠️ У конференции/турнира даты — в программе (conf_days), а events.start_at
    # обычно пуст (правило проекта: источник истины — программа). Без этого
    # шапка лендинга оставалась без даты.
    ev = dict(event)
    if not ev.get("start_at"):
        days = await db.fetchrow(
            """SELECT MIN(day_date) AS d1, MAX(day_date) AS d2
                 FROM conf_days WHERE event_id = $1 AND day_date IS NOT NULL""",
            ev["id"],
        )
        if days and days["d1"]:
            ev["start_at"] = days["d1"]
            ev["end_at"] = days["d2"]
            ev["dates_from_program"] = True

    page = await db.fetchrow(
        "SELECT * FROM event_landing_pages WHERE event_id = $1 AND kind = $2",
        event["id"], kind,
    )
    # ⚠️ Неопубликованный лендинг открыт ВЛАДЕЛЬЦУ по ссылке-предпросмотру:
    # собрать страницу вслепую нельзя, а обычный вход в кабинете сюда токен
    # не донесёт — страница `/e/{slug}` рендерится на сервере, заголовка
    # `Authorization` у него нет. Поэтому токен идёт параметром адреса.
    #
    # ⚠️ Владелец события — `event_owners (status='accepted')`: у `events`
    # своего `client_id` нет (правило проекта, у коллаб-события владельцев
    # несколько, и каждый вправе смотреть черновик).
    owner = False
    cid = preview_client_id(preview)
    if cid is not None:
        owner = bool(await db.fetchval(
            "SELECT 1 FROM event_owners WHERE event_id = $1 AND client_id = $2 "
            "AND status = 'accepted'",
            event["id"], cid,
        ))
    if not page or (not page["is_published"] and not owner):
        raise HTTPException(status_code=404, detail="Лендинг не опубликован")

    blocks = await db.fetch(
        "SELECT * FROM event_landing_blocks WHERE page_id = $1 AND is_active = TRUE "
        "ORDER BY sort_order, id",
        page["id"],
    )
    # ⚠️ Секция «Описание» живая: текст берётся из `events.description`. Пустое
    # описание → секции нет вовсе, иначе на странице остался бы голый заголовок
    # «ПОДРОБНОСТИ» без текста — это читается как поломка. Отсекаем ЗДЕСЬ, а не
    # во фронте: иначе пустая секция всё равно попала бы в меню навигации.
    if not (event["description"] or "").strip():
        blocks = [b for b in blocks if b["kind"] != "description"]

    kinds = {b["kind"] for b in blocks}

    # Владелец события — event_owners(accepted); у events нет client_id.
    owner = await db.fetchrow(
        # ⚠️ `owner_full_name` — имя основателя С ФАМИЛИЕЙ (миграция 381).
        # Отдельным выражением, потому что `cl.name` тут используется ещё и как
        # фолбэк для НАЗВАНИЯ БРЕНДА, а бренду фамилия не нужна.
        """SELECT cl.id, cl.name, """ + DISPLAY_NAME_SQL("cl") + """ AS owner_full_name,
                  cl.brand_name, cl.brand_logo_url, cl.profile_photo_url,
                  cl.positioning, cl.achievements, cl.owner_photo_url, cl.owner_positioning,
                  cl.owner_achievements, cl.bio, cl.social_links,
                  cl.work_tg_username, cl.work_vk, cl.work_max,
                  cl.legal_form, cl.legal_name, cl.legal_inn, cl.legal_inn_label,
                  cl.legal_ogrn, cl.legal_address, cl.legal_operator_email,
                  cl.legal_operator_phone, cl.privacy_policy_version
             FROM event_owners eo
             JOIN clients cl ON cl.id = eo.client_id
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY eo.id LIMIT 1""",
        event["id"],
    )

    data: dict = {}

    # ── Анкета прямо на странице ──────────────────────────────────────────
    # ⚠️ Общая точка сбора с лендингом продукта — рендерер один.
    #
    # ⚠️⚠️ У КОЛЛАБ-СОБЫТИЯ БЛОКА НЕТ ВОВСЕ (решение владельца). Лендинг там
    # общий, а базы у организаторов РАЗНЫЕ: заявка с общей страницы упала бы в
    # базу того, кто поставил форму, — то есть человек, пришедший по ссылке
    # партнёра, оказался бы контактом другого организатора, и уведомление ушло
    # бы не тому. Договориться, «чья форма», нечем: организаторы равноправны.
    # Проверка стоит и здесь: блок мог остаться на странице от копирования
    # лендинга или от события, ставшего коллабой позже.
    if "survey" in kinds and not event["is_collab"] and owner:
        from app.services.landing_survey import collect_landing_surveys
        # Событие не коллаба — владелец ровно один, и анкета может быть только
        # его (при сохранении блока это проверено `assert_survey_owned`).
        # ⚠️ Владельца передаём, чтобы анкета взялась из ФОРМЫ ЗАЯВКИ
        # события (мигр. 363) — в блоке её больше не выбирают.
        data["surveys"] = await collect_landing_surveys(
            db, blocks, owner["id"], "event", event["id"])

    # ── Осталось мест ─────────────────────────────────────────────────────
    # Считаем и для отдельной секции `seats`, и когда счётчик встроен в шапку
    # (галочка show_seats у блока hero) — иначе в шапке показывать нечего.
    seats_in_hero = any(b["kind"] == "hero" and b["show_seats"] for b in blocks)
    if "seats" in kinds or seats_in_hero:
        # Что считать: подтверждённые регистрации (по умолчанию) или всех, кто
        # открыл событие — второе показывает интерес, а не только записи.
        if (event["seats_count_mode"] or "registered") == "visited":
            taken = await db.fetchval(
                "SELECT COUNT(*) FROM event_participants WHERE event_id = $1",
                event["id"],
            ) or 0
        else:
            taken = await db.fetchval(
                "SELECT COUNT(*) FROM event_participants "
                "WHERE event_id = $1 AND is_registered = TRUE",
                event["id"],
            ) or 0
        # Стартовое смещение: у клиента уже есть аудитория (например, чат на
        # 1100 человек), и счётчик идёт от неё, а не с нуля.
        taken += event["seats_base"] or 0
        total = event["seats_total"]
        data["seats"] = {
            "label": event["seats_label"],
            "label_position": event["seats_label_position"] or "top",
            "size": event["seats_size"],
            "total": total,
            "taken": taken,
            "left": max(0, total - taken) if total is not None else None,
        }

    # ── Спикеры ───────────────────────────────────────────────────────────
    if "speakers" in kinds:
        # Порядок — общая функция проекта (order_by_sql), та же, что в Mini App,
        # дашборде и рассылках. Своя сортировка дала бы другой порядок спикеров
        # на лендинге, чем везде — это путает клиента.
        rows = await db.fetch(
            # ⚠️ В карточке спикера — ФОТО (`collaborators.photo_url`), не афиша.
            # Афиша — вертикальный баннер под анонс, в сетке карточек она ломает
            # раскладку. Афиши остаются в рассылках и материалах спикера.
            #
            # ⚠️ Связь с карточкой коллаба — `event_collaborators.speaker_id`
            # (не collaborator_id), тема — `speaker_topic`. Проверено по схеме.
            f"""SELECT cse.id, cse.role, cse.speaker_topic AS topic,
                      btrim(CASE WHEN COALESCE(btrim(c.last_name),'')='' THEN COALESCE(c.name,'') ELSE COALESCE(c.name,'')||' '||COALESCE(c.last_name,'') END) AS name, c.title, c.achievements, c.photo_url,
                      c.tg_channel_url, c.vk_url, c.max_url, c.instagram_url, c.website_url
                 FROM event_collaborators cse
                 JOIN collaborators c ON c.id = cse.speaker_id
                WHERE cse.event_id = $1
                  AND cse.role IN ('speaker', 'headliner')
                ORDER BY {order_by_sql('cse')}""",
            event["id"],
        )
        data["speakers"] = [
            {**dict(r), "achievements": _jsonb(r["achievements"])} for r in rows
        ]

    # ── Галереи из базы отзывов ───────────────────────────────────────────
    # Блок галереи может брать содержимое не из своих items, а из общей базы
    # отзывов по тегам — тогда один и тот же отзыв переиспользуется на разных
    # лендингах и правится в одном месте.
    gal_blocks = [b for b in blocks
                  if b["kind"] == "gallery" and b["gallery_source"] == "testimonials"]
    if gal_blocks and owner:
        data["testimonials"] = {}
        for b in gal_blocks:
            tags = list(b["gallery_tags"] or [])
            rows = await db.fetch(
                """SELECT kind, url, preview_url, title, caption
                     FROM client_testimonials
                    WHERE client_id = $1 AND is_active
                      AND ($2::text[] = '{}' OR tags && $2::text[])
                    ORDER BY sort_order, id""",
                owner["id"], tags,
            )
            data["testimonials"][str(b["id"])] = [dict(r) for r in rows]

    # ── Партнёры ──────────────────────────────────────────────────────────
    # Те же карточки коллабораторов, что и спикеры, но роли партнёрские.
    # Порядок — общая order_by_sql, как везде в проекте.
    if "partners" in kinds:
        rows = await db.fetch(
            f"""SELECT cse.id, cse.role, cse.partner_url,
                      btrim(CASE WHEN COALESCE(btrim(c.last_name),'')='' THEN COALESCE(c.name,'') ELSE COALESCE(c.name,'')||' '||COALESCE(c.last_name,'') END) AS name, c.title, c.photo_url, c.achievements,
                      -- ⚠️ Фамилия отдаётся ОТДЕЛЬНО (хотя уже склеена в name):
                      -- по ней страница понимает, что партнёр — человек, и
                      -- показывает фото как у спикера, а не вписывает его в
                      -- белое поле под логотип компании.
                      c.last_name,
                      c.tg_channel_url, c.vk_url, c.max_url, c.website_url
                 FROM event_collaborators cse
                 JOIN collaborators c ON c.id = cse.speaker_id
                WHERE cse.event_id = $1
                  AND cse.role IN ('general_partner', 'partner')
                ORDER BY {order_by_sql('cse')}""",
            event["id"],
        )
        # Регалии — JSONB, из asyncpg приходят строкой (см. _jsonb).
        data["partners"] = [
            {**dict(r), "achievements": _jsonb(r["achievements"])} for r in rows
        ]

    # ── Организатор ───────────────────────────────────────────────────────
    if "organizer" in kinds and owner:
        def _org_card(row) -> dict:
            social = _jsonb(row["social_links"])
            # ⚠️ Название кабинета (`clients.name`) и имя человека — РАЗНЫЕ вещи.
            # У коллабы `name` в выборке — это имя из карточки коллаба, поэтому
            # бренд подставляем из отдельного поля, иначе в шапке вместо бренда
            # оказалось бы имя спикера.
            # ⚠️⚠️ `Record.keys()` у asyncpg — ИТЕРАТОР, а не список: первая же
            # проверка `x in keys` его ИСЧЕРПЫВАЕТ, и все следующие дают False.
            # Из-за этого фамилия организатора пропадала на лендинге, хотя
            # запрос её выбирал. Приводим к множеству ОДИН раз.
            keys = set(row.keys())
            client_name = row["client_name"] if "client_name" in keys else row["name"]
            # ⚠️ Имя человека — с фамилией (миграция 381). У КОЛЛАБЫ в `name`
            # уже лежит склейка из карточки коллаба, у обычного события фамилию
            # приносит `owner_full_name`. Поэтому берём его, когда оно есть.
            owner_name = row["owner_full_name"] if "owner_full_name" in keys else row["name"]
            return {
                "brand_name": row["brand_name"] or client_name,
                "brand_logo_url": row["brand_logo_url"],
                "brand_photo_url": row["profile_photo_url"],
                "brand_positioning": row["positioning"],
                "brand_achievements": _jsonb(row["achievements"]),
                "owner_name": owner_name,
                "owner_photo_url": row["owner_photo_url"],
                "owner_positioning": row["owner_positioning"],
                "owner_achievements": _jsonb(row["owner_achievements"]),
                "bio": row["bio"],
                "social_links": social if isinstance(social, dict) else {},
            }

        data["organizer"] = _org_card(owner)

        # ⚠️ У КОЛЛАБЫ организаторов НЕСКОЛЬКО и они равноправны — блок обязан
        # показать всех. Раньше отдавался только «первый владелец» (LIMIT 1 в
        # выборке выше), то есть тот, кто раньше принял приглашение: партнёра
        # на общем лендинге не было вовсе (прод, 2026-08-18).
        # Одиночному событию поле не нужно — там организатор один.
        if ev.get("is_collab"):
            # ⚠️ Имя, фото и регалии организатора берём из КАРТОЧКИ КОЛЛАБА
            # этого события (`event_collaborators` → `collaborators`), а не из
            # профиля клиента. Это то же самое, что человек правит в кабинете
            # спикера, — и то, что показывают все остальные блоки лендинга
            # (спикеры, партнёры). Пока читали `clients`, правка карточки на
            # общий лендинг не доезжала вовсе, и организатор не понимал, где
            # вообще меняется его блок.
            #
            # ⚠️ Профиль клиента остаётся ЗАПАСНЫМ вариантом (COALESCE): карточку
            # коллаба заполняют не все, и без подстановки блок у такого
            # организатора оказался бы пустым. Бренд, логотип и соцсети — всегда
            # из `clients`: это свойства кабинета, а не карточки человека.
            #
            # Связь карточки — `event_collaborators.speaker_id` (не
            # collaborator_id), карточка самого клиента — `self_collaborator_id`.
            rows = await db.fetch(
                """SELECT cl.id, cl.name AS client_name, cl.brand_name, cl.brand_logo_url,
                          cl.profile_photo_url, cl.positioning, cl.achievements,
                          cl.social_links,
                          -- ⚠️ Регалии карточки идут в `bio`, а НЕ в
                          -- owner_achievements: блок организатора на лендинге
                          -- рисует построчно именно bio, а owner_achievements —
                          -- это «факты в цифрах» профиля ({label, value}), другая
                          -- сущность. Положить строки туда — значит показать
                          -- пустые плашки вместо регалий.
                          COALESCE(
                            CASE WHEN COALESCE(array_length(c.achievements, 1), 0) > 0
                                 THEN array_to_string(c.achievements, E'\\n') END,
                            cl.bio
                          ) AS bio,
                          -- ⚠️ Склейка — хелпером, не руками. Фолбэк тоже с
                          -- фамилией: у clients она есть с миграции 381.
                          COALESCE(
                            NULLIF(""" + DISPLAY_NAME_SQL("c") + """, ''),
                            """ + DISPLAY_NAME_SQL("cl") + """
                          ) AS name,
                          COALESCE(NULLIF(c.photo_url, ''), cl.owner_photo_url) AS owner_photo_url,
                          COALESCE(NULLIF(c.title, ''), cl.owner_positioning)  AS owner_positioning,
                          -- «Факты в цифрах» ({label, value}) остаются из профиля:
                          -- в карточке коллаба такой сущности нет вовсе.
                          cl.owner_achievements
                     FROM event_owners eo
                     JOIN clients cl ON cl.id = eo.client_id
                     -- Карточка этого клиента в ЭТОМ событии; нет её — берём
                     -- его self-карточку, она же используется в каталоге Хаба.
                     LEFT JOIN event_collaborators ec
                            ON ec.event_id = $1
                           AND ec.speaker_id = cl.self_collaborator_id
                     LEFT JOIN collaborators c
                            ON c.id = COALESCE(ec.speaker_id, cl.self_collaborator_id)
                    WHERE eo.event_id = $1 AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id""",
                event["id"],
            )
            data["organizer_cards"] = [_org_card(r) for r in rows]

    # ── Программа (этапы → дни → слоты) ───────────────────────────────────
    if "program" in kinds:
        days = await db.fetch(
            "SELECT id, day_number, title, day_date, open_time, close_time, stage_id "
            "FROM conf_days WHERE event_id = $1 ORDER BY day_date NULLS LAST, day_number",
            event["id"],
        )
        # Название слота — live из темы спикера (topic_id), title лишь fallback.
        sessions = await db.fetch(
            """SELECT s.id, s.day, s.start_time, s.end_time, s.speaker_id,
                      COALESCE(cst.topic, s.title) AS title,
                      btrim(CASE WHEN COALESCE(btrim(c.last_name),'')='' THEN COALESCE(c.name,'') ELSE COALESCE(c.name,'')||' '||COALESCE(c.last_name,'') END) AS speaker_name, c.title AS speaker_position,
                      c.photo_url AS speaker_photo_url
                 FROM conf_sessions s
                 LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
                 LEFT JOIN event_collaborators ec ON ec.id = s.speaker_id
                 LEFT JOIN collaborators c ON c.id = ec.speaker_id
                WHERE s.event_id = $1
                ORDER BY s.day, s.start_time NULLS LAST, s.id""",
            event["id"],
        )
        stages = await db.fetch(
            "SELECT id, title, subtitle, description, start_date, end_date, sort_order "
            "FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id",
            event["id"],
        )
        data["program"] = {
            "stages": [dict(s) for s in stages],
            "days": [
                {
                    **dict(d),
                    "open_time": _fmt_time(d["open_time"]),
                    "close_time": _fmt_time(d["close_time"]),
                }
                for d in days
            ],
            "sessions": [
                {
                    **dict(s),
                    "start_time": _fmt_time(s["start_time"]),
                    "end_time": _fmt_time(s["end_time"]),
                }
                for s in sessions
            ],
        }

    # ── Тарифы ────────────────────────────────────────────────────────────
    if "tariffs" in kinds:
        rows = await db.fetch(
            "SELECT t.id, t.code, t.title, t.description, t.excluded_description, t.price, "
            "t.discount_kind, t.discount_value, t.pay_url, "
            "t.order_hint, t.sort_order, t.is_featured, "
            "t.bonus_feature_id, COALESCE(t.bonus_days, 30) AS bonus_days, COALESCE(t.bonus_line_auto, TRUE) AS bonus_line_auto, "
            "f.name AS bonus_feature_name "
            "FROM event_tariffs t "
            "LEFT JOIN features f ON f.id = t.bonus_feature_id "
            "WHERE t.event_id = $1 AND t.is_active = TRUE "
            "ORDER BY t.sort_order, t.id",
            event["id"],
        )
        # Оферта: привязанный документ из базы приоритетнее старой ссылки.
        offer_url = event["offer_url"]
        if event["offer_id"]:
            o = await db.fetchrow(
                "SELECT slug, external_url FROM client_offers WHERE id = $1 AND is_active",
                event["offer_id"],
            )
            if o:
                offer_url = o["external_url"] or f"/o/{o['slug']}"
        # Какой тариф подсветить — выбирается в самом блоке лендинга.
        # Не задан → как раньше, признак из карточки тарифа (is_featured).
        featured = next(
            (b["featured_tariff_id"] for b in blocks if b["kind"] == "tariffs"), None
        )
        # Промокоды (миграция 397) работают не со всеми платёжными системами:
        # ⚠️ у LeadPay цена лежит в его карточке товара, произвольную сумму мы
        # передать не можем — значит поле промокода там показывать нельзя,
        # оно ничего не сделает.
        # ⚠️ Здесь «первый владелец» ДОПУСТИМ (в отличие от resolve_event_client):
        # решается только показ поля, а не то, в чью базу попадёт человек.
        # У коллабы платёжки организаторов могут различаться — тогда поле
        # покажется по владельцу, а настоящую проверку сделает сервер при
        # заказе и вернёт понятный отказ.
        from app.services.promo_codes import supported_by_provider
        _pay_provider = await db.fetchval(
            """SELECT cl.pay_provider FROM event_owners eo
                 JOIN clients cl ON cl.id = eo.client_id
                WHERE eo.event_id = $1 AND eo.status = 'accepted'
                ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1""",
            event["id"],
        )
        promo_allowed = supported_by_provider(_pay_provider)

        items = []
        for r in rows:
            # with_discount дописывает old_price / discount_percent —
            # зачёркнутую цену считаем в одном месте, а не в каждом рендерере.
            d = with_discount(r)
            d["promo_allowed"] = promo_allowed
            if featured:
                d["is_featured"] = d["id"] == featured
            # ⚠️ Строка «Бонус:» собирается ЗДЕСЬ, а не пишется клиентом в
            # описании: руками написанный текст врёт, как только меняется
            # срок в настройке тарифа. Названы оба случая — «для новых» и
            # «для действующих», иначе человек с кабинетом решит, что его
            # обманули (ждал 30 дней, получил 3).
            # ⚠️ ТОЛЬКО если бонус включён явно (выбран модуль или
            # отмечен триал). Проверять bonus_days нельзя: у колонки
            # значение по умолчанию, и строка вылезала у всех тарифов
            # подряд — включая те, где бонуса нет.
            # ⚠️ Галочка (мигр. 311): клиент может писать бонус сам в
            # описании тарифа — тогда автостроку не рисуем, иначе в
            # карточке получится дубль.
            if d.get("bonus_feature_id") and d.get("bonus_line_auto"):
                from app.services.plusson_bonus_texts import tariff_bonus_line
                from app.services.plusson_bonus_days import bonus_day_numbers
                _trial, _extra = await bonus_day_numbers(db)
                d["bonus_line"] = tariff_bonus_line(
                    feature_name=d.get("bonus_feature_name"),
                    days=int(d.get("bonus_days") or 30),
                    trial_days=_trial, extra_days=_extra,
                )
            d.pop("bonus_feature_id", None)
            d.pop("bonus_line_auto", None)
            items.append(d)
        # Данные для согласий на странице заказа: чья политика и от чьего
        # имени рассылки. Формулировки те же, что на странице регистрации.
        data["tariffs"] = {
            "items": items,
            "offer_url": offer_url,
            "privacy_url": (
                f"/c/{owner['id']}/privacy"
                if owner and owner["privacy_policy_version"] else None
            ),
            "brand_name": (owner["brand_name"] or owner["name"]) if owner else None,
            # ⚠️ Уходит в текст согласия на странице заказа — там имя человека
            # должно быть полным (с фамилией, миграция 381).
            "owner_name": owner["owner_full_name"] if owner else None,
        }

    # ── Подарки за регистрацию ────────────────────────────────────────────
    if "gifts" in kinds:
        rows = await db.fetch(
            """SELECT t.threshold_count, t.certificate_url,
                      lm.name AS title, lm.description
                 FROM event_referral_thresholds t
                 LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
                WHERE t.event_id = $1
                ORDER BY t.threshold_count""",
            event["id"],
        )
        data["gifts"] = [dict(r) for r in rows]

    # ── Есть вопросы → каналы поддержки клиента ───────────────────────────
    if "support" in kinds and owner:
        # Формат общий для всех лендингов — см. landing_support.py.
        data["support"] = support_links(owner)

    # ── Футер: реквизиты + политика + оферта ──────────────────────────────
    if "footer" in kinds and owner:
        # Оферта подвала: выбранная в самом блоке (база оферт) → привязанная
        # к событию → старая ссылка events.offer_url. Раньше был только
        # последний вариант, и при пустом поле оферты в подвале не было вовсе.
        footer_block = next((b for b in blocks if b["kind"] == "footer"), None)
        footer_offer_url = event["offer_url"]
        offer_ref = (footer_block["offer_id"] if footer_block else None) or event["offer_id"]
        if offer_ref:
            o = await db.fetchrow(
                "SELECT slug, external_url FROM client_offers WHERE id = $1 AND is_active",
                offer_ref,
            )
            if o:
                footer_offer_url = o["external_url"] or f"/o/{o['slug']}"

        # ⚠️ В подвале лендинга — только «кто продаёт» (ИП с ФИО + ИНН) и
        # документы. Адрес, ОГРНИП, email и телефон не выносим: они есть в
        # оферте и политике, на продающей странице это лишний шум.
        data["footer"] = {
            "legal_name": owner["legal_name"],
            "legal_inn": owner["legal_inn"],
            "legal_inn_label": owner["legal_inn_label"] or "ИНН",
            # Публичная страница политики появляется только после публикации версии.
            "privacy_url": (
                f"/c/{owner['id']}/privacy" if owner["privacy_policy_version"] else None
            ),
            "offer_url": footer_offer_url,
            "brand_name": owner["brand_name"] or owner["name"],
            "brand_logo_url": owner["brand_logo_url"],
        }

    # ── Кнопки ботов на странице «после оплаты» ───────────────────────────
    if kind == "post_pay" and owner:
        chans = await db.fetch(
            """SELECT ch.platform_slug, ch.handle, ch.display_name
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1 AND cc.is_active = TRUE
                  AND ch.handle IS NOT NULL AND ch.handle <> ''
                  AND ch.platform_slug IN ('telegram', 'vk', 'max')""",
            owner["id"],
        )
        bots = []
        for c in chans:
            h = c["handle"].lstrip("@")
            url = {
                "telegram": f"https://{TG_DOMAIN}/{h}",
                "vk": f"https://vk.me/{h}",
                "max": f"https://max.ru/{h}",
            }.get(c["platform_slug"])
            if url:
                bots.append({
                    "platform": c["platform_slug"],
                    "label": c["display_name"] or h,
                    "url": url,
                })
        data["bots"] = bots

    # Логотип и имя бренда нужны шапке-меню независимо от того, включён
    # ли блок подвала.
    if owner:
        data.setdefault("brand", {
            "name": owner["brand_name"] or owner["name"],
            "logo_url": owner["brand_logo_url"],
        })

    # ⚠️ У КОЛЛАБЫ организаторов НЕСКОЛЬКО, и логотип в шапке должен быть у
    # каждого. Раньше отдавался один (`ORDER BY eo.id LIMIT 1`) — общее
    # событие выглядело как мероприятие того партнёра, чья строка в
    # `event_owners` оказалась первой, а остальные со своей аудиторией
    # приходили на страницу без единого своего знака.
    if ev.get("is_collab"):
        rows = await db.fetch(
            """SELECT cl.id,
                      COALESCE(NULLIF(cl.brand_name, ''), cl.name) AS name,
                      cl.brand_logo_url, cl.profile_photo_url
                 FROM event_owners eo
                 JOIN clients cl ON cl.id = eo.client_id
                WHERE eo.event_id = $1 AND eo.status = 'accepted'
                ORDER BY eo.id""",
            event["id"],
        )
        # Организатор без логотипа — норма (не все его загрузили): вместо
        # картинки шапка покажет название бренда текстом.
        data["organizers"] = [
            {
                "id": r["id"],
                "name": r["name"],
                "logo_url": r["brand_logo_url"],
                "photo_url": r["profile_photo_url"],
            }
            for r in rows
        ]

    page_d = dict(page)
    # ⚠️ JSONB из asyncpg приходит СТРОКОЙ. Без разбора фронт получал
    # nav_items текстом, Array.isArray давал false — и пункты меню молча
    # пропадали, оставалась одна кнопка.
    page_d["nav_items"] = _jsonb(page_d.get("nav_items"))
    # ⚠️ Шрифты и заливка фона считаются ОБЩИМ хелпером (см. landing_theme.py):
    # раньше этот код жил только здесь, и лендинг продукта остался без темы —
    # цвета в базе есть, а страница белая.
    apply_theme_fields(page_d)

    return {
        "event": {
            "id": ev["id"],
            "slug": ev["slug"],
            # Галочка «Регистрировать без ввода контактных данных»: у
            # бесплатного тарифа форму не показываем (миграция 079).
            "skip_contact_form": ev["skip_contact_form"],
            "title": ev["title"],
            "description": ev["description"],
            "start_at": ev["start_at"],
            "end_at": ev.get("end_at"),
            "poster_url": ev["poster_url"],
            "module_slug": ev["module_slug"],
            # ⚠️ Одно поле на всё: сюда клиент пишет либо офлайн-адрес, либо
            # ссылку на эфир. Блок «Место проведения» сам решает, показывать
            # карту (адрес) или ничего (ссылка) — второго поля не заводим.
            "address": ev.get("address"),
            "geo_lat": ev.get("geo_lat"),
            "geo_lon": ev.get("geo_lon"),
            # Даты взяты из программы → на странице показываем только даты,
            # без времени: у дня программы своё расписание по слотам.
            "dates_from_program": bool(ev.get("dates_from_program")),
        },
        "page": page_d,
        "blocks": [
            {**dict(b), "items": _jsonb(b["items"])} for b in blocks
        ],
        "data": data,
    }
