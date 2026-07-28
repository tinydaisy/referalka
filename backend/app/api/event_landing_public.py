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
                  e.status, e.module_slug, e.seats_total, e.offer_url,
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
    if "seats" in kinds:
        taken = await db.fetchval(
            "SELECT COUNT(*) FROM event_participants "
            "WHERE event_id = $1 AND is_registered = TRUE",
            event["id"],
        ) or 0
        total = event["seats_total"]
        data["seats"] = {
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
            "SELECT id, code, title, description, price, pay_url, sort_order "
            "FROM event_tariffs WHERE event_id = $1 AND is_active = TRUE "
            "ORDER BY sort_order, id",
            event["id"],
        )
        data["tariffs"] = {
            "items": [dict(r) for r in rows],
            "offer_url": event["offer_url"],
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
        data["footer"] = {
            "legal_form": owner["legal_form"],
            "legal_name": owner["legal_name"],
            "legal_inn": owner["legal_inn"],
            "legal_inn_label": owner["legal_inn_label"] or "ИНН",
            "legal_ogrn": owner["legal_ogrn"],
            "legal_address": owner["legal_address"],
            "email": owner["legal_operator_email"],
            "phone": owner["legal_operator_phone"],
            # Публичная страница политики появляется только после публикации версии.
            "privacy_url": (
                f"/c/{owner['id']}/privacy" if owner["privacy_policy_version"] else None
            ),
            "offer_url": event["offer_url"],
            "brand_name": owner["brand_name"] or owner["name"],
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

    page_d = dict(page)
    page_d["font_heading_css"] = font_family_css(page["font_heading"])
    page_d["font_body_css"] = font_family_css(page["font_body"])
    page_d["font_heading"] = normalize_font(page["font_heading"])
    page_d["font_body"] = normalize_font(page["font_body"])
    # Готовая заливка фона: градиент под заданным углом либо сплошной цвет.
    # Считаем на бэке, чтобы страница не собирала CSS в трёх местах.
    if page_d.get("bg_gradient") and page_d.get("bg_color_2"):
        page_d["bg_css"] = (
            f"linear-gradient({page_d.get('bg_angle', 45)}deg, "
            f"{page_d.get('bg_color') or '#25455D'}, {page_d['bg_color_2']})"
        )
    else:
        page_d["bg_css"] = page_d.get("bg_color") or "#25455D"

    return {
        "event": {
            "id": event["id"],
            "slug": event["slug"],
            "title": event["title"],
            "description": event["description"],
            "start_at": event["start_at"],
            "end_at": event["end_at"],
            "poster_url": event["poster_url"],
            "module_slug": event["module_slug"],
        },
        "page": page_d,
        "blocks": [
            {**dict(b), "items": _jsonb(b["items"])} for b in blocks
        ],
        "data": data,
    }
