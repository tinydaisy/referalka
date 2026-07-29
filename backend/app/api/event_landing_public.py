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
`?preview=1` с валидным JWT владельца обслуживается кабинетом, здесь не
делается (превью в кабинете открывает ту же страницу с draft-токеном — см.
`preview_token`).
"""
from fastapi import APIRouter, Depends, HTTPException, Response, Query
from typing import Optional
import json
import asyncpg

from app.database import get_db
from app.services.landing_fonts import font_family_css, normalize_font
from app.services.collaborator_sort import order_by_sql

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
    db: asyncpg.Connection = Depends(get_db),
):
    _set_cors(response)

    event = await db.fetchrow(
        """SELECT e.id, e.slug, e.title, e.description, e.start_at, e.end_at,
                  e.status, e.module_slug, e.seats_total, e.offer_url, e.offer_id,
                  e.seats_label, e.seats_label_position, e.seats_size,
                  e.seats_count_mode, e.seats_base, e.skip_contact_form,
                  e.landing_require_registration,
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
    if not page or not page["is_published"]:
        raise HTTPException(status_code=404, detail="Лендинг не опубликован")

    blocks = await db.fetch(
        "SELECT * FROM event_landing_blocks WHERE page_id = $1 AND is_active = TRUE "
        "ORDER BY sort_order, id",
        page["id"],
    )
    kinds = {b["kind"] for b in blocks}

    # Владелец события — event_owners(accepted); у events нет client_id.
    owner = await db.fetchrow(
        """SELECT cl.id, cl.name, cl.brand_name, cl.brand_logo_url, cl.profile_photo_url,
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
                      c.name, c.title, c.achievements, c.photo_url,
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
                      c.name, c.title, c.photo_url, c.achievements,
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
        social = _jsonb(owner["social_links"])
        data["organizer"] = {
            "brand_name": owner["brand_name"] or owner["name"],
            "brand_logo_url": owner["brand_logo_url"],
            "brand_photo_url": owner["profile_photo_url"],
            "brand_positioning": owner["positioning"],
            "brand_achievements": _jsonb(owner["achievements"]),
            "owner_name": owner["name"],
            "owner_photo_url": owner["owner_photo_url"],
            "owner_positioning": owner["owner_positioning"],
            "owner_achievements": _jsonb(owner["owner_achievements"]),
            "bio": owner["bio"],
            "social_links": social if isinstance(social, dict) else {},
        }

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
                      c.name AS speaker_name, c.title AS speaker_position,
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
            "SELECT id, code, title, description, excluded_description, price, pay_url, "
            "order_hint, sort_order, is_featured "
            "FROM event_tariffs WHERE event_id = $1 AND is_active = TRUE "
            "ORDER BY sort_order, id",
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
        items = []
        for r in rows:
            d = dict(r)
            if featured:
                d["is_featured"] = d["id"] == featured
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
            "owner_name": owner["name"] if owner else None,
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
        # В поля поддержки клиент вписывает и голый ник, и готовую ссылку —
        # нормализуем, иначе получается «https://telegram.me/https://…».
        def _link(val: str | None, base: str) -> str | None:
            v = (val or "").strip()
            if not v:
                return None
            if v.startswith("http://") or v.startswith("https://"):
                return v
            return base + v.lstrip("@")

        data["support"] = {
            # ⚠️ telegram.me, не t.me — правило проекта
            "telegram": _link(owner["work_tg_username"], "https://telegram.me/"),
            "vk": _link(owner["work_vk"], "https://vk.com/"),
            "max": _link(owner["work_max"], "https://max.ru/"),
        }

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
                "telegram": f"https://telegram.me/{h}",
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

    page_d = dict(page)
    # ⚠️ JSONB из asyncpg приходит СТРОКОЙ. Без разбора фронт получал
    # nav_items текстом, Array.isArray давал false — и пункты меню молча
    # пропадали, оставалась одна кнопка.
    page_d["nav_items"] = _jsonb(page_d.get("nav_items"))
    page_d["font_heading_css"] = font_family_css(page["font_heading"])
    page_d["font_body_css"] = font_family_css(page["font_body"])
    page_d["font_heading"] = normalize_font(page["font_heading"])
    page_d["font_body"] = normalize_font(page["font_body"])
    # Готовая заливка фона: градиент под заданным углом либо сплошной цвет.
    # Считаем на бэке, чтобы страница не собирала CSS в трёх местах.
    if page_d.get("bg_gradient") and page_d.get("bg_color_2"):
        c1 = page_d.get("bg_color") or "#25455D"
        c2 = page_d["bg_color_2"]
        angle = page_d.get("bg_angle", 45)
        page_d["bg_css"] = f"linear-gradient({angle}deg, {c1}, {c2})"
        # Для режима «повторять на каждом экране» — ЗЕРКАЛЬНЫЙ градиент
        # (цвет1 → цвет2 → цвет1). Обычный при повторении даёт резкую полосу
        # на стыке: тёмный конец упирается в светлое начало следующего.
        page_d["bg_css_screen"] = (
            f"linear-gradient({angle}deg, {c1} 0%, {c2} 50%, {c1} 100%)"
        )
    else:
        page_d["bg_css"] = page_d.get("bg_color") or "#25455D"
        page_d["bg_css_screen"] = page_d["bg_css"]

    return {
        "event": {
            "id": ev["id"],
            "slug": ev["slug"],
            # Галочка «Регистрировать без ввода контактных данных»: у
            # бесплатного тарифа форму не показываем (миграция 079).
            "skip_contact_form": ev["skip_contact_form"],
            # Галочка «Требовать регистрацию» у нашего лендинга (миграция 262):
            # выключена → форму не показываем, ведём сразу к оплате.
            "landing_require_registration": ev["landing_require_registration"],
            "title": ev["title"],
            "description": ev["description"],
            "start_at": ev["start_at"],
            "end_at": ev.get("end_at"),
            "poster_url": ev["poster_url"],
            "module_slug": ev["module_slug"],
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
