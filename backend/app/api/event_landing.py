"""
Конструктор лендинга события — клиентский API (кабинет).

Клиент собирает продающую страницу из блоков: часть блоков он заполняет руками
(миссия, ценности, цифры), часть — тянет живые данные события (спикеры,
программа, тарифы, организатор). Копий контента не держим: поправил спикера в
кабинете → на лендинге обновилось само.

Две страницы на событие:
  main      → pluson.ru/e/{slug}
  post_pay  → pluson.ru/e/{slug}/thanks   (return-url платёжки)

Публичная отдача данных — в `event_landing_public.py`, вёрстка — в Next.js.

Гейт — фича `event_landing` (никогда по tariff_slug). Ассистент: чтение можно,
запись — по общим правилам middleware.

Миграция 240.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Any
import json
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.features import client_has_feature
from app.services.landing_fonts import FONTS, normalize_font

router = APIRouter(prefix="/events/{event_id}/landing", tags=["Конструктор лендинга"])


# Набор блоков новой страницы. Порядок = разумный дефолт продающей страницы:
# сначала обещание, потом доказательства, потом цена.
#
# ⚠️ ЗАГОЛОВКИ ЗДЕСЬ НЕ ЗАДАЮТСЯ. Никакого текста по умолчанию в коде: клиент
# вписывает свои формулировки в конструкторе, и они лежат в базе. Иначе на
# лендинге появлялся бы текст, которого нет в настройках, и править его негде.
DEFAULT_MAIN_BLOCKS: list[dict] = [
    {"kind": "hero",       "is_active": True},
    {"kind": "audience",   "is_active": True},
    {"kind": "benefits",   "is_active": True},
    {"kind": "seats",      "is_active": False},
    {"kind": "gifts",      "is_active": True},
    {"kind": "numbers",    "is_active": False},
    {"kind": "difference", "is_active": False},
    {"kind": "speakers",   "is_active": True},
    {"kind": "partners",   "is_active": False},
    {"kind": "program",    "is_active": True},
    {"kind": "gallery",    "is_active": False},
    {"kind": "values",     "is_active": False},
    {"kind": "mission",    "is_active": False},
    {"kind": "organizer",  "is_active": True},
    {"kind": "tariffs",    "is_active": True},
    {"kind": "support",    "is_active": True},
    {"kind": "footer",     "is_active": True},
]

DEFAULT_POST_PAY_BLOCKS: list[dict] = [
    {"kind": "hero",    "is_active": True},
    {"kind": "support", "is_active": True},
    {"kind": "footer",  "is_active": True},
]

# Блоки, которые сами тянут данные события — руками у них правится только
# заголовок и оформление, содержимое приходит из базы.
LIVE_KINDS = {"speakers", "partners", "program", "tariffs", "organizer",
              "gifts", "seats", "support", "footer"}

# `text` и `gallery` можно добавлять по кнопке сколько угодно раз — их нет
# в дефолтном наборе (gallery там есть, но выключенный) или он единичный.
VALID_KINDS = {b["kind"] for b in DEFAULT_MAIN_BLOCKS} | {"text", "gallery", "partners"}

# Блоки, которых на странице может быть много (кнопка «Добавить секцию»).
REPEATABLE_KINDS = {"text", "gallery"}


# ─────────────────────────────────────────────────────────────────────────────
# Доступ
# ─────────────────────────────────────────────────────────────────────────────
async def _check_event_access(db, client_id: int, event_id: int) -> None:
    row = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND id IN "
        "(SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


async def _assert_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "event_landing"):
        raise HTTPException(
            status_code=403,
            detail="Раздел «Лендинг» недоступен на вашем тарифе.",
        )


# ─────────────────────────────────────────────────────────────────────────────
# Модели
# ─────────────────────────────────────────────────────────────────────────────
class PagePatch(BaseModel):
    is_published: Optional[bool] = None
    bg_color: Optional[str] = None
    bg_color_2: Optional[str] = None
    bg_angle: Optional[int] = None
    bg_gradient: Optional[bool] = None
    bg_mode: Optional[str] = None
    bg_image_url: Optional[str] = None
    bg_overlay: Optional[str] = None
    bg_overlay_opacity: Optional[int] = None
    font_heading: Optional[str] = None
    font_body: Optional[str] = None
    color_heading: Optional[str] = None
    heading_metallic: Optional[bool] = None
    color_body: Optional[str] = None
    color_link: Optional[str] = None
    price_color: Optional[str] = None
    btn_color: Optional[str] = None
    btn_text_color: Optional[str] = None
    btn_metallic: Optional[bool] = None
    btn_color_2: Optional[str] = None
    btn_angle: Optional[int] = None
    btn_border_color: Optional[str] = None
    btn_border_width: Optional[int] = None
    btn_border_metallic: Optional[bool] = None
    border_color: Optional[str] = None
    border_metallic: Optional[bool] = None
    border_style: Optional[str] = None
    card_bg: Optional[str] = None
    card_bg_opacity: Optional[int] = None
    icon_color: Optional[str] = None
    icon_metallic: Optional[bool] = None
    radius: Optional[int] = None
    body_size: Optional[int] = None
    content_width: Optional[int] = None
    pad_x: Optional[int] = None
    section_gap: Optional[int] = None
    nav_enabled: Optional[bool] = None
    nav_button_label: Optional[str] = None
    nav_items: Optional[Any] = None
    post_pay_title: Optional[str] = None
    post_pay_text: Optional[str] = None


class BlockIn(BaseModel):
    kind: str
    title: Optional[str] = None
    subtitle: Optional[str] = None
    body: Optional[str] = None
    button_label: Optional[str] = None
    button_url: Optional[str] = None
    items: Optional[Any] = None
    is_active: bool = True


class BlockPatch(BaseModel):
    admin_name: Optional[str] = None
    title: Optional[str] = None
    subtitle: Optional[str] = None
    body: Optional[str] = None
    button_label: Optional[str] = None
    button_url: Optional[str] = None
    items: Optional[Any] = None
    is_active: Optional[bool] = None
    # Раскладка секции: заголовок сверху / слева / справа + картинка-контент.
    layout: Optional[str] = None
    image_url: Optional[str] = None
    image_position: Optional[str] = None
    image_width: Optional[int] = None
    split_ratio: Optional[int] = None
    pad_y: Optional[int] = None
    title_size: Optional[int] = None
    title_align: Optional[str] = None
    subtitle_size: Optional[int] = None
    text_size: Optional[int] = None
    title_color: Optional[str] = None
    title_metallic: Optional[bool] = None
    cards_bordered: Optional[bool] = None
    card_style: Optional[str] = None
    columns: Optional[int] = None
    display_mode: Optional[str] = None
    show_seats: Optional[bool] = None
    show_date: Optional[bool] = None
    show_divider: Optional[bool] = None
    cards_glow: Optional[bool] = None
    date_position: Optional[str] = None
    seats_position: Optional[str] = None
    bg_color: Optional[str] = None
    bg_image_url: Optional[str] = None
    bg_overlay: Optional[str] = None
    bg_overlay_opacity: Optional[int] = None
    border_color: Optional[str] = None
    border_width: Optional[int] = None
    border_radius: Optional[int] = None


class ReorderIn(BaseModel):
    ids: list[int]


# ─────────────────────────────────────────────────────────────────────────────
# Хелперы
# ─────────────────────────────────────────────────────────────────────────────
def _ser_block(r: asyncpg.Record) -> dict:
    d = dict(r)
    items = d.get("items")
    if isinstance(items, str):
        try:
            d["items"] = json.loads(items)
        except (ValueError, TypeError):
            d["items"] = []
    d["is_live"] = d["kind"] in LIVE_KINDS
    return d


def _ser_page(r) -> dict:
    """⚠️ JSONB из asyncpg приходит СТРОКОЙ. Без разбора фронт получает
    `nav_items` строкой и падает на `.map` — страница настроек лендинга
    выбрасывает Application error."""
    d = dict(r)
    nav = d.get("nav_items")
    if isinstance(nav, str):
        try:
            d["nav_items"] = json.loads(nav)
        except (ValueError, TypeError):
            d["nav_items"] = []
    if not isinstance(d.get("nav_items"), list):
        d["nav_items"] = []
    return d


async def _get_or_create_page(db, event_id: int, kind: str) -> asyncpg.Record:
    """Страница создаётся лениво — при первом заходе в раздел, с дефолтным
    набором блоков. Так у клиента сразу есть что редактировать, а у событий,
    где лендинг не нужен, лишних строк не появляется."""
    page = await db.fetchrow(
        "SELECT * FROM event_landing_pages WHERE event_id = $1 AND kind = $2",
        event_id, kind,
    )
    if page:
        return page

    # Оформление берём из ТЕМЫ КЛИЕНТА (миграция 241) — фирменный стиль
    # подставляется сам, клиенту не надо заново выставлять цвета под каждое
    # событие. Это именно копия-дефолт: дальше страница живёт своей жизнью,
    # правка темы задним числом уже созданные лендинги не трогает.
    theme = await db.fetchrow(
        """SELECT cl.lp_bg_color, cl.lp_bg_color_2, cl.lp_bg_angle, cl.lp_bg_gradient, cl.lp_bg_mode,
                  cl.lp_font_heading, cl.lp_color_heading, cl.lp_heading_metallic,
                  cl.lp_font_body, cl.lp_color_body, cl.lp_color_link, cl.lp_price_color,
                  cl.lp_btn_color, cl.lp_btn_text_color, cl.lp_btn_metallic,
                  cl.lp_btn_color_2, cl.lp_btn_angle, cl.lp_btn_border_color,
                  cl.lp_btn_border_width, cl.lp_btn_border_metallic,
                  cl.lp_border_color, cl.lp_border_metallic, cl.lp_border_style,
                  cl.lp_card_bg, cl.lp_card_bg_opacity,
                  cl.lp_icon_color, cl.lp_icon_metallic, cl.lp_radius, cl.lp_body_size,
                  cl.lp_content_width, cl.lp_pad_x, cl.lp_section_gap
             FROM event_owners eo
             JOIN clients cl ON cl.id = eo.client_id
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY eo.id LIMIT 1""",
        event_id,
    )
    t = dict(theme) if theme else {}

    async with db.transaction():
        page = await db.fetchrow(
            """INSERT INTO event_landing_pages
                 (event_id, kind, bg_color, bg_color_2, bg_angle, bg_gradient, bg_mode,
                  font_heading, color_heading, heading_metallic,
                  font_body, color_body, color_link, price_color,
                  btn_color, btn_text_color, btn_metallic,
                  btn_color_2, btn_angle, btn_border_color,
                  btn_border_width, btn_border_metallic,
                  border_color, border_metallic, border_style, card_bg, card_bg_opacity,
                  icon_color, icon_metallic, radius, body_size,
                  content_width, pad_x, section_gap)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
               ON CONFLICT (event_id, kind) DO UPDATE SET updated_at = NOW()
               RETURNING *""",
            event_id, kind,
            t.get("lp_bg_color") or "#25455D",
            t.get("lp_bg_color_2") or "#0a1520",
            t.get("lp_bg_angle") if t.get("lp_bg_angle") is not None else 45,
            t.get("lp_bg_gradient") if t.get("lp_bg_gradient") is not None else True,
            t.get("lp_bg_mode") or "screen",
            normalize_font(t.get("lp_font_heading")),
            t.get("lp_color_heading") or "#FFCFA4",
            bool(t.get("lp_heading_metallic", True)),
            normalize_font(t.get("lp_font_body")),
            t.get("lp_color_body") or "#FFFFFF",
            t.get("lp_color_link") or "#FFCFA4",
            t.get("lp_price_color"),
            t.get("lp_btn_color") or "#FFCFA4",
            t.get("lp_btn_text_color") or "#0a1520",
            bool(t.get("lp_btn_metallic", True)),
            t.get("lp_btn_color_2"),
            t.get("lp_btn_angle") if t.get("lp_btn_angle") is not None else 180,
            t.get("lp_btn_border_color"),
            t.get("lp_btn_border_width") if t.get("lp_btn_border_width") is not None else 0,
            bool(t.get("lp_btn_border_metallic", False)),
            t.get("lp_border_color") or "#FFCFA4",
            bool(t.get("lp_border_metallic", True)),
            t.get("lp_border_style") or "solid",
            t.get("lp_card_bg") or "#0F1E2E",
            t.get("lp_card_bg_opacity") if t.get("lp_card_bg_opacity") is not None else 55,
            t.get("lp_icon_color") or "#FFCFA4",
            bool(t.get("lp_icon_metallic", True)),
            t.get("lp_radius") if t.get("lp_radius") is not None else 5,
            t.get("lp_body_size") if t.get("lp_body_size") is not None else 16,
            t.get("lp_content_width") if t.get("lp_content_width") is not None else 1120,
            t.get("lp_pad_x") if t.get("lp_pad_x") is not None else 24,
            t.get("lp_section_gap") if t.get("lp_section_gap") is not None else 64,
        )
        preset = DEFAULT_MAIN_BLOCKS if kind == "main" else DEFAULT_POST_PAY_BLOCKS
        # ON CONFLICT выше мог отдать уже существующую страницу (гонка двух
        # вкладок) — тогда блоки второй раз не создаём.
        has_blocks = await db.fetchval(
            "SELECT 1 FROM event_landing_blocks WHERE page_id = $1 LIMIT 1", page["id"]
        )
        if not has_blocks:
            for i, b in enumerate(preset):
                await db.execute(
                    "INSERT INTO event_landing_blocks (page_id, kind, sort_order, is_active) "
                    "VALUES ($1, $2, $3, $4)",
                    page["id"], b["kind"], i * 10, b["is_active"],
                )
    return page


async def _page_for_write(db, event_id: int, page_id: int) -> asyncpg.Record:
    page = await db.fetchrow(
        "SELECT * FROM event_landing_pages WHERE id = $1 AND event_id = $2",
        page_id, event_id,
    )
    if not page:
        raise HTTPException(status_code=404, detail="Страница лендинга не найдена")
    return page


# ─────────────────────────────────────────────────────────────────────────────
# Эндпоинты
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/fonts", summary="Справочник доступных шрифтов")
async def list_fonts(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    return {"fonts": FONTS}


@router.get("", summary="Страницы лендинга события со всеми блоками")
async def get_landing(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)

    ev = await db.fetchrow(
        "SELECT slug, title, seats_total, seats_label, seats_label_position "
        "FROM events WHERE id = $1", event_id
    )

    pages = []
    for kind in ("main", "post_pay"):
        page = await _get_or_create_page(db, event_id, kind)
        blocks = await db.fetch(
            "SELECT * FROM event_landing_blocks WHERE page_id = $1 ORDER BY sort_order, id",
            page["id"],
        )
        pages.append({**_ser_page(page), "blocks": [_ser_block(b) for b in blocks]})

    # Сколько мест занято — считаем на лету, в базе не храним (иначе разъедется).
    taken = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id = $1 AND is_registered = TRUE",
        event_id,
    )
    return {
        "pages": pages,
        "event": {
            "slug": ev["slug"],
            "title": ev["title"],
            "seats_total": ev["seats_total"],
            "seats_label": ev["seats_label"],
            "seats_label_position": ev["seats_label_position"],
            "seats_taken": taken or 0,
        },
        "fonts": FONTS,
    }


@router.patch("/pages/{page_id}", summary="Настройки оформления страницы")
async def patch_page(
    event_id: int,
    page_id: int,
    data: PagePatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)
    await _page_for_write(db, event_id, page_id)

    fs = data.model_fields_set
    sets, vals = [], []
    for field in (
        "is_published", "bg_color", "bg_color_2", "bg_angle", "bg_gradient", "bg_mode",
        "bg_image_url", "bg_overlay", "bg_overlay_opacity",
        "font_heading", "font_body", "color_heading", "heading_metallic",
        "color_body", "color_link", "price_color",
        "btn_color", "btn_text_color", "btn_metallic",
        "btn_color_2", "btn_angle", "btn_border_color",
        "btn_border_width", "btn_border_metallic",
        "border_color", "border_metallic", "border_style",
        "card_bg", "card_bg_opacity",
        "icon_color", "icon_metallic", "radius",
        "body_size", "content_width", "pad_x", "section_gap",
        "nav_enabled", "nav_button_label",
        "post_pay_title", "post_pay_text",
    ):
        if field not in fs:
            continue
        val = getattr(data, field)
        # Неизвестный шрифт молча заменяем дефолтным — не роняем сохранение.
        if field in ("font_heading", "font_body"):
            val = normalize_font(val)
        if field == "bg_overlay_opacity" and val is not None:
            val = max(0, min(100, int(val)))
        if field == "bg_mode" and val not in ("page", "screen", "block"):
            val = "screen"
        if field == "btn_angle" and val is not None:
            val = max(0, min(360, int(val)))
        if field == "btn_border_width" and val is not None:
            val = max(0, min(12, int(val)))
        if field == "bg_angle" and val is not None:
            val = max(0, min(360, int(val)))
        if field == "border_style" and val not in ("solid", "fade"):
            val = "solid"
        if field == "card_bg_opacity" and val is not None:
            val = max(0, min(100, int(val)))
        if field == "radius" and val is not None:
            val = max(0, min(64, int(val)))
        if field == "body_size" and val is not None:
            val = max(12, min(28, int(val)))
        if field == "content_width" and val is not None:
            # 0 = во всю ширину; иначе разумный коридор.
            val = 0 if int(val) == 0 else max(480, min(2000, int(val)))
        if field == "pad_x" and val is not None:
            val = max(0, min(160, int(val)))
        if field == "section_gap" and val is not None:
            val = max(0, min(200, int(val)))
        vals.append(val)
        sets.append(f"{field} = ${len(vals)}")

    # nav_items — JSONB, пишем отдельно (как items у блока).
    if "nav_items" in fs:
        items = data.nav_items if isinstance(data.nav_items, list) else []
        clean = [
            {"label": str(i.get("label") or "")[:40],
             "block_kind": str(i.get("block_kind") or "")[:32]}
            for i in items
            if isinstance(i, dict) and i.get("label") and i.get("block_kind")
        ][:8]
        vals.append(json.dumps(clean, ensure_ascii=False))
        sets.append(f"nav_items = ${len(vals)}::jsonb")

    if not sets:
        return {"ok": True}

    # Правка ОФОРМЛЕНИЯ в самом событии помечает страницу как настроенную
    # вручную — тема из Настроек её больше не перезаписывает. Публикация и
    # тексты страницы к оформлению не относятся.
    STYLE_FIELDS = {
        "bg_color", "bg_color_2", "bg_angle", "bg_gradient", "bg_mode",
        "bg_image_url", "bg_overlay", "bg_overlay_opacity",
        "font_heading", "font_body", "color_heading", "heading_metallic",
        "color_body", "color_link", "price_color", "btn_color", "btn_text_color", "btn_metallic",
        "btn_color_2", "btn_angle", "btn_border_color", "btn_border_width",
        "btn_border_metallic", "border_color", "border_metallic", "border_style", "card_bg", "card_bg_opacity",
        "icon_color", "icon_metallic", "radius", "body_size",
        "content_width", "pad_x", "section_gap",
    }
    if fs & STYLE_FIELDS:
        sets.append("style_customized = TRUE")

    vals.append(page_id)
    row = await db.fetchrow(
        f"UPDATE event_landing_pages SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(vals)} RETURNING *",
        *vals,
    )
    return _ser_page(row)


@router.post("/pages/{page_id}/blocks", summary="Добавить блок")
async def create_block(
    event_id: int,
    page_id: int,
    data: BlockIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)
    await _page_for_write(db, event_id, page_id)

    if data.kind not in VALID_KINDS:
        raise HTTPException(status_code=400, detail=f"Неизвестный тип блока: {data.kind}")

    last = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), 0) FROM event_landing_blocks WHERE page_id = $1",
        page_id,
    )
    row = await db.fetchrow(
        """INSERT INTO event_landing_blocks
             (page_id, kind, title, subtitle, body, button_label, button_url, items,
              sort_order, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *""",
        page_id, data.kind, data.title, data.subtitle, data.body,
        data.button_label, data.button_url, json.dumps(data.items or []),
        last + 10, data.is_active,
    )
    return _ser_block(row)


@router.patch("/blocks/{block_id}", summary="Изменить блок")
async def patch_block(
    event_id: int,
    block_id: int,
    data: BlockPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)

    owns = await db.fetchrow(
        "SELECT b.kind FROM event_landing_blocks b JOIN event_landing_pages p ON p.id = b.page_id "
        "WHERE b.id = $1 AND p.event_id = $2",
        block_id, event_id,
    )
    if not owns:
        raise HTTPException(status_code=404, detail="Блок не найден")
    block_kind = owns["kind"]

    fs = data.model_fields_set
    sets, vals = [], []
    for field in (
        "admin_name", "title", "subtitle", "body", "button_label", "button_url", "is_active",
        "layout", "image_url", "image_position", "image_width", "split_ratio", "pad_y",
        "title_size", "title_align", "subtitle_size", "text_size",
        "title_color", "title_metallic",
        "cards_bordered", "card_style", "columns", "display_mode", "show_date", "date_position", "show_divider", "cards_glow", "show_seats", "seats_position",
        "bg_color", "bg_image_url", "bg_overlay", "bg_overlay_opacity",
        "border_color", "border_width", "border_radius",
    ):
        if field not in fs:
            continue
        val = getattr(data, field)
        # ⚠️ У ШАПКИ подзаголовка нет: там показывается «Описание для лендинга»
        # из настроек события. Отдельное поле дублировало бы его — клиент правил
        # бы текст в двух местах и не понимал, какое сработает.
        if field == "subtitle" and block_kind == "hero":
            val = None
        # Мусор в раскладке не пишем — CHECK в БД иначе отдаст 500 вместо
        # понятной реакции; молча приводим к разумному значению.
        if field == "layout" and val not in ("top", "left", "right"):
            val = "top"
        if field == "image_position" and val not in ("left", "right", "top", "bottom", "center"):
            val = "right"
        if field == "image_width" and val is not None:
            val = max(20, min(100, int(val)))
        if field == "split_ratio" and val is not None:
            val = max(20, min(80, int(val)))
        if field == "pad_y" and val is not None:
            val = max(0, min(200, int(val)))
        if field == "title_align" and val not in ("left", "center", "right"):
            val = "left"
        if field == "title_size" and val is not None:
            val = max(16, min(140, int(val)))
        if field == "subtitle_size" and val is not None:
            val = max(10, min(64, int(val)))
        if field == "text_size" and val is not None:
            val = max(10, min(48, int(val)))
        if field == "card_style" and val not in ("border", "divider", "plain"):
            val = "border"
        if field == "display_mode" and val not in ("grid", "scroll"):
            val = "grid"
        if field == "date_position" and val not in ("above", "below"):
            val = "above"
        if field == "columns" and val is not None:
            val = max(1, min(6, int(val)))
        if field == "seats_position" and val not in ("above", "side"):
            val = "above"
        if field == "bg_overlay_opacity" and val is not None:
            val = max(0, min(100, int(val)))
        if field == "border_width" and val is not None:
            val = max(0, min(12, int(val)))
        if field == "border_radius" and val is not None:
            val = max(0, min(64, int(val)))
        vals.append(val)
        sets.append(f"{field} = ${len(vals)}")

    if "items" in fs:
        vals.append(json.dumps(data.items or []))
        sets.append(f"items = ${len(vals)}::jsonb")

    if not sets:
        return {"ok": True}

    vals.append(block_id)
    row = await db.fetchrow(
        f"UPDATE event_landing_blocks SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(vals)} RETURNING *",
        *vals,
    )
    return _ser_block(row)


@router.post("/pages/{page_id}/reorder", summary="Порядок блоков (перетаскивание)")
async def reorder_blocks(
    event_id: int,
    page_id: int,
    data: ReorderIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)
    await _page_for_write(db, event_id, page_id)

    async with db.transaction():
        for i, block_id in enumerate(data.ids):
            await db.execute(
                "UPDATE event_landing_blocks SET sort_order = $1, updated_at = NOW() "
                "WHERE id = $2 AND page_id = $3",
                i * 10, block_id, page_id,
            )
    rows = await db.fetch(
        "SELECT * FROM event_landing_blocks WHERE page_id = $1 ORDER BY sort_order, id",
        page_id,
    )
    return {"blocks": [_ser_block(r) for r in rows]}


@router.delete("/blocks/{block_id}", summary="Удалить блок")
async def delete_block(
    event_id: int,
    block_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)

    deleted = await db.fetchval(
        "DELETE FROM event_landing_blocks b USING event_landing_pages p "
        "WHERE b.page_id = p.id AND b.id = $1 AND p.event_id = $2 RETURNING b.id",
        block_id, event_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Блок не найден")
    return {"ok": True}


@router.post("/pages/{page_id}/apply-theme", summary="Применить фирменную тему к странице")
async def apply_theme(
    event_id: int,
    page_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Перетянуть оформление из «Стили лендингов» в эту страницу.

    Тема копируется в страницу при её создании (см. `_get_or_create_page`) —
    чтобы правка темы не переоформляла задним числом уже собранные лендинги.
    Но клиент, настроив тему, ждёт, что увидит её на существующей странице,
    поэтому даём явную кнопку. Содержимое блоков не трогаем — только стиль.
    """
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)
    await _page_for_write(db, event_id, page_id)

    row = await db.fetchrow(
        """UPDATE event_landing_pages p SET
             bg_color = c.lp_bg_color, bg_color_2 = c.lp_bg_color_2,
             bg_angle = c.lp_bg_angle, bg_gradient = c.lp_bg_gradient,
             bg_mode = COALESCE(c.lp_bg_mode, 'screen'),
             font_heading = c.lp_font_heading, color_heading = c.lp_color_heading,
             heading_metallic = c.lp_heading_metallic,
             font_body = c.lp_font_body, color_body = c.lp_color_body,
             color_link = c.lp_color_link,
             price_color = c.lp_price_color,
             btn_color = c.lp_btn_color, btn_text_color = c.lp_btn_text_color,
             btn_metallic = c.lp_btn_metallic,
             btn_color_2 = c.lp_btn_color_2,
             btn_angle = COALESCE(c.lp_btn_angle, 180),
             btn_border_color = c.lp_btn_border_color,
             btn_border_width = COALESCE(c.lp_btn_border_width, 0),
             btn_border_metallic = COALESCE(c.lp_btn_border_metallic, FALSE),
             border_color = c.lp_border_color, border_metallic = c.lp_border_metallic,
             border_style = COALESCE(c.lp_border_style, 'solid'),
             card_bg = c.lp_card_bg,
             card_bg_opacity = COALESCE(c.lp_card_bg_opacity, 55),
             icon_color = c.lp_icon_color, icon_metallic = c.lp_icon_metallic,
             radius = COALESCE(c.lp_radius, 5),
             body_size = COALESCE(c.lp_body_size, 16),
             content_width = COALESCE(c.lp_content_width, 1120),
             pad_x = COALESCE(c.lp_pad_x, 24),
             section_gap = COALESCE(c.lp_section_gap, 64),
             style_customized = FALSE,
             updated_at = NOW()
           FROM clients c
          WHERE c.id = $1 AND p.id = $2
          RETURNING p.*""",
        client_id, page_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Страница не найдена")
    return _ser_page(row)


@router.patch("/seats", summary="Всего мест на событии")
async def set_seats(
    event_id: int,
    data: dict,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)
    total = data.get("seats_total")
    if total is not None:
        total = max(0, int(total))
    label = data.get("seats_label")
    pos = data.get("seats_label_position")
    if pos not in ("top", "left", "right"):
        pos = "top"
    await db.execute(
        "UPDATE events SET seats_total = $1, seats_label = $2, seats_label_position = $3 "
        "WHERE id = $4",
        total, (label or None), pos, event_id,
    )
    return {"ok": True, "seats_total": total, "seats_label": label,
            "seats_label_position": pos}
