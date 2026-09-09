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
from app.services.client_domains import client_public_link
from app.services.preview_token import make_preview_token
from app.services.landing_pdf_response import pdf_response

router = APIRouter(prefix="/events/{event_id}/landing", tags=["Конструктор лендинга"])


# Набор блоков новой страницы. Порядок = разумный дефолт продающей страницы:
# сначала обещание, потом доказательства, потом цена.
#
# ⚠️ ЗАГОЛОВКИ ЗДЕСЬ НЕ ЗАДАЮТСЯ. Никакого текста по умолчанию в коде: клиент
# вписывает свои формулировки в конструкторе, и они лежат в базе. Иначе на
# лендинге появлялся бы текст, которого нет в настройках, и править его негде.
DEFAULT_MAIN_BLOCKS: list[dict] = [
    {"kind": "hero",       "is_active": True},
    # ⚠️ ОПИСАНИЕ СОБЫТИЯ — отдельной секцией СРАЗУ ПОСЛЕ ШАПКИ, а не в
    # подзаголовке. В `events.description` пишут большой текст (его же
    # показывает Mini App), и в шапке он выглядел простынёй под названием.
    # Здесь у него есть заголовок, своё место в порядке секций и оформление.
    {"kind": "description", "is_active": True},
    {"kind": "audience",   "is_active": True},
    {"kind": "benefits",   "is_active": True},
    {"kind": "seats",      "is_active": False},
    {"kind": "gifts",      "is_active": True},
    {"kind": "numbers",    "is_active": False},
    {"kind": "difference", "is_active": False},
    # Этапы по вертикальной линии: «приём заявок → эфиры → финал». Нужен
    # премиям и турнирам, где важна последовательность, а не набор карточек.
    {"kind": "process",    "is_active": False},
    {"kind": "speakers",   "is_active": True},
    {"kind": "partners",   "is_active": False},
    {"kind": "program",    "is_active": True},
    {"kind": "gallery",    "is_active": False},
    {"kind": "values",     "is_active": False},
    {"kind": "mission",    "is_active": False},
    {"kind": "organizer",  "is_active": True},
    {"kind": "tariffs",    "is_active": True},
    # Анкета прямо на странице: заявка, отбор, сбор вопросов. Выключена —
    # включают, когда продают не тарифом, а разговором.
    {"kind": "survey",     "is_active": False},
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
# ⚠️ `survey` здесь же: вопросы, варианты и кнопка приходят ИЗ САМОЙ АНКЕТЫ.
# В блоке правится только заголовок секции, оформление и вид показа — иначе
# текст вопроса пришлось бы держать в двух местах и он бы разъехался.
LIVE_KINDS = {"speakers", "partners", "program", "tariffs", "organizer",
              "gifts", "seats", "support", "footer", "survey",
              # ⚠️ `description` — живой: текст приходит из `events.description`
              # (то же поле, что у Mini App). Руками правятся только заголовок
              # и оформление, иначе описание пришлось бы держать в двух местах.
              "description"}

# `text` и `gallery` можно добавлять по кнопке сколько угодно раз — их нет
# в дефолтном наборе (gallery там есть, но выключенный) или он единичный.
VALID_KINDS = {b["kind"] for b in DEFAULT_MAIN_BLOCKS} | {"text", "gallery", "partners", "el_button", "el_heading", "el_text", "el_image", "el_heading_text"}

# Блоки, которых на странице может быть много (кнопка «Добавить секцию»).
# ⚠️ `survey` повторяемый: анкет у клиента несколько, и на длинной странице
# одну и ту же форму ставят и в середине, и в конце — чтобы не искать её
# прокруткой.
REPEATABLE_KINDS = {"text", "gallery", "el_button", "el_heading", "el_text",
                    "el_image", "el_heading_text", "survey"}


# ⚠️ Списки полей вынесены в константы: их переиспользует конструктор
# лендинга ПРОДУКТА (product_landing.py). Копия там разъехалась бы с
# этой при добавлении новой настройки оформления.
PAGE_PATCH_FIELDS: tuple = (
        "is_published", "bg_color", "bg_color_2", "bg_angle", "bg_gradient", "bg_mode",
        "bg_image_url", "bg_overlay", "bg_overlay_opacity",
        "font_heading", "font_body", "color_heading", "heading_metallic",
        "color_body", "color_link", "price_color",
        "day_tab_color", "day_tab_text_color",
        "btn_color", "btn_text_color", "btn_metallic",
        "btn_color_2", "btn_angle", "btn_border_color",
        "btn_border_width", "btn_border_metallic", "btn_radius",
        "border_color", "border_metallic", "border_style",
        "card_bg", "card_bg_opacity", "card_text_color",
        "bg_position", "bg_position_mobile", "bg_scale", "bg_scale_mobile",
        "icon_color", "icon_metallic", "radius",
        "body_size", "content_width", "pad_x", "section_gap",
        "nav_enabled", "nav_button_label", "nav_button_target",
        "post_pay_title", "post_pay_text",
    )

def normalize_block_button(field: str, val):
    """Значения настроек кнопки блока — общая проверка для события и продукта.

    ⚠️ Сверяем в коде, а не CHECK-ом в БД: новый вариант раскладки тогда
    добавляется кодом, без миграции (как у `title_align` и `card_style`).
    Мусор приводим к дефолту, а не роняем запрос: настройка оформления не
    повод отдать клиенту ошибку.

    ⚠️ Зовётся из ОБЕИХ точек записи блока — у продукта своя ветка UPDATE, и
    без этого вызова туда прошло бы любое значение.
    """
    if field == "btn_width" and val is not None:
        return val if val in ("full", "auto") else "full"
    if field == "btn_align" and val is not None:
        return val if val in ("left", "center", "right") else "center"
    return val


def normalize_block_survey(field: str, val):
    """Настройки блока «Анкета» — общая проверка для события и продукта.

    ⚠️ Как и у кнопки: значение сверяем в коде, а не CHECK-ом в БД, чтобы новый
    вид показа добавлялся без миграции. Мусор приводим к 'form' — блок при этом
    покажет анкету обычным списком, а не отдаст клиенту ошибку.

    ⚠️ Зовётся из ОБЕИХ точек записи (у продукта своя ветка UPDATE) — иначе
    туда прошло бы любое значение, и страница получила бы неизвестный режим.
    """
    if field == "survey_view" and val is not None:
        return val if val in ("form", "quiz") else "form"
    if field == "survey_id" and val is not None:
        # 0 приходит от селектора как «не выбрана» — это NULL, а не анкета №0.
        return int(val) or None
    return val


async def assert_survey_owned(db, client_id: int, survey_id: int | None) -> None:
    """Анкета блока обязана принадлежать этому кабинету.

    ⚠️ Без проверки, зная чужой id, можно было бы поставить себе на лендинг
    ЧУЖУЮ анкету: заявки уходили бы постороннему клиенту в базу, а его
    уведомления — о людях, которых он не звал. `survey_id` приходит из
    браузера, поэтому доверять ему нельзя.
    """
    if not survey_id:
        return
    ok = await db.fetchval(
        "SELECT 1 FROM surveys WHERE id = $1 AND client_id = $2",
        survey_id, client_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Анкета не найдена")


BLOCK_PATCH_FIELDS: tuple = (
        "admin_name", "title", "subtitle", "body", "button_label", "button_url", "is_active",
        "layout", "image_url", "image_position", "image_width", "split_ratio", "pad_y",
        "title_size", "title_align", "subtitle_size", "text_size",
        "title_color", "title_metallic",
        "cards_bordered", "card_style", "columns", "display_mode", "show_date", "date_position", "show_divider", "cards_glow", "icon_size", "gallery_source", "marker",
        "card_img_radius_x", "card_img_radius_y", "card_img_ratio", "card_img_size", "card_img_fit",
        "media_size", "show_captions", "featured_tariff_id", "offer_id", "date_size", "kicker",
        "overline", "overline_size", "hero_align",
        "featured_glow",
        "btn_width", "btn_align",
        # Блок «Анкета»: какая анкета и как показана (списком / по шагам).
        "survey_id", "survey_view",
        "show_seats", "seats_position",
        "bg_color", "bg_image_url", "bg_overlay", "bg_overlay_opacity",
        "border_color", "border_width", "border_radius",
    )


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
    day_tab_color: Optional[str] = None
    day_tab_text_color: Optional[str] = None
    btn_color: Optional[str] = None
    btn_text_color: Optional[str] = None
    btn_metallic: Optional[bool] = None
    btn_color_2: Optional[str] = None
    btn_angle: Optional[int] = None
    btn_border_color: Optional[str] = None
    btn_border_width: Optional[int] = None
    btn_border_metallic: Optional[bool] = None
    btn_radius: Optional[int] = None
    border_color: Optional[str] = None
    border_metallic: Optional[bool] = None
    border_style: Optional[str] = None
    card_bg: Optional[str] = None
    card_bg_opacity: Optional[int] = None
    # Свой цвет текста ВНУТРИ карточек. Пусто → берётся общий color_body.
    card_text_color: Optional[str] = None
    # Точка фокуса фоновой картинки (CSS object-position), своя для телефона:
    # на узком экране обрезаются бока и объект сбоку уходит за край.
    bg_position: Optional[str] = None
    bg_position_mobile: Optional[str] = None
    # Масштаб фона в %: 100 — как есть, больше — приблизить, меньше — отдалить.
    bg_scale: Optional[int] = None
    bg_scale_mobile: Optional[int] = None
    icon_color: Optional[str] = None
    icon_metallic: Optional[bool] = None
    radius: Optional[int] = None
    body_size: Optional[int] = None
    content_width: Optional[int] = None
    pad_x: Optional[int] = None
    section_gap: Optional[int] = None
    nav_enabled: Optional[bool] = None
    nav_button_label: Optional[str] = None
    nav_button_target: Optional[str] = None
    nav_items: Optional[Any] = None
    post_pay_title: Optional[str] = None
    post_pay_text: Optional[str] = None


class BlockIn(BaseModel):
    kind: str
    admin_name: Optional[str] = None
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
    icon_size: Optional[int] = None
    gallery_source: Optional[str] = None
    gallery_tags: Optional[list] = None
    card_img_fit: Optional[str] = None
    card_img_radius_x: Optional[int] = None
    card_img_radius_y: Optional[int] = None
    card_img_ratio: Optional[float] = None
    card_img_size: Optional[int] = None
    media_size: Optional[int] = None
    show_captions: Optional[bool] = None
    featured_tariff_id: Optional[int] = None
    offer_id: Optional[int] = None
    date_position: Optional[str] = None
    date_size: Optional[int] = None
    kicker: Optional[str] = None
    # Шапка: строка НАД названием события (тип события) + куда прижат текст.
    overline: Optional[str] = None
    overline_size: Optional[int] = None
    hero_align: Optional[str] = None
    featured_glow: Optional[int] = None
    # Кнопка в карточке тарифа: во всю ширину или по тексту, и куда прижата.
    btn_width: Optional[str] = None
    btn_align: Optional[str] = None
    # Блок «Анкета»: какую анкету показываем и каким видом.
    survey_id: Optional[int] = None
    survey_view: Optional[str] = None
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
    #
    # ⚠️ У КОЛЛАБ-СОБЫТИЯ тему клиента НЕ берём — ставим стандартную
    # (дефолты колонок из миграции 241, они же ниже по тексту COALESCE-ов).
    # Организаторы коллабы равноправны, а запрос `ORDER BY eo.id LIMIT 1`
    # молча отдавал оформление того, кто раньше попал в `event_owners`:
    # лендинг общего события оказывался в фирменных цветах одного из
    # партнёров, причём выбранного не человеком, а порядком строк в базе.
    # Чей стиль взять — решает организатор кнопкой «Взять стиль организатора».
    is_collab = await db.fetchval(
        "SELECT is_collab FROM events WHERE id = $1", event_id
    )
    theme = None
    if not is_collab:
        theme = await db.fetchrow(
            """SELECT cl.lp_bg_color, cl.lp_bg_color_2, cl.lp_bg_angle, cl.lp_bg_gradient, cl.lp_bg_mode,
                      cl.lp_font_heading, cl.lp_color_heading, cl.lp_heading_metallic,
                      cl.lp_font_body, cl.lp_color_body, cl.lp_color_link, cl.lp_price_color,
                      cl.lp_day_tab_color, cl.lp_day_tab_text_color,
                      cl.lp_btn_color, cl.lp_btn_text_color, cl.lp_btn_metallic,
                      cl.lp_btn_color_2, cl.lp_btn_angle, cl.lp_btn_border_color,
                      cl.lp_btn_border_width, cl.lp_btn_border_metallic, cl.lp_btn_radius,
                      cl.lp_border_color, cl.lp_border_metallic, cl.lp_border_style,
                      cl.lp_card_bg, cl.lp_card_bg_opacity, cl.lp_card_text_color,
                      cl.lp_icon_color, cl.lp_icon_metallic, cl.lp_radius, cl.lp_body_size,
                      cl.lp_content_width, cl.lp_pad_x, cl.lp_section_gap
                 FROM event_owners eo
                 JOIN clients cl ON cl.id = eo.client_id
                WHERE eo.event_id = $1 AND eo.status = 'accepted'
                ORDER BY eo.id LIMIT 1""",
            event_id,
        )
    t = dict(theme) if theme else {}

    # ⚠️ В ON CONFLICT ниже условие `WHERE owner_type = 'event'` ОБЯЗАТЕЛЬНО.
    # Миграция 293 (полиморфизм: страница принадлежит событию ИЛИ продукту)
    # заменила обычный UNIQUE(event_id, kind) на ЧАСТИЧНЫЙ индекс
    # `event_landing_pages_event_kind_uniq ... WHERE owner_type = 'event'`.
    # Postgres не сопоставляет ON CONFLICT с частичным индексом, если в запросе
    # нет того же условия, — и падает с InvalidColumnReferenceError
    # «no unique or exclusion constraint matching the ON CONFLICT specification».
    # Ловилось это не сразу: у событий, где страница создана ДО миграции, вкладка
    # открывалась как ни в чём не бывало, а любое событие с ещё не созданным
    # лендингом отдавало 500 (найдено 2026-08-17 на коллабе клиентов 62 и 112).
    async with db.transaction():
        page = await db.fetchrow(
            """INSERT INTO event_landing_pages
                 (event_id, kind, bg_color, bg_color_2, bg_angle, bg_gradient, bg_mode,
                  font_heading, color_heading, heading_metallic,
                  font_body, color_body, color_link, price_color,
                  day_tab_color, day_tab_text_color,
                  btn_color, btn_text_color, btn_metallic,
                  btn_color_2, btn_angle, btn_border_color,
                  btn_border_width, btn_border_metallic, btn_radius,
                  border_color, border_metallic, border_style, card_bg, card_bg_opacity,
                  card_text_color,
                  icon_color, icon_metallic, radius, body_size,
                  content_width, pad_x, section_gap)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38)
               ON CONFLICT (event_id, kind) WHERE owner_type = 'event'
                 DO UPDATE SET updated_at = NOW()
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
            t.get("lp_day_tab_color"),
            t.get("lp_day_tab_text_color"),
            t.get("lp_btn_color") or "#FFCFA4",
            t.get("lp_btn_text_color") or "#0a1520",
            bool(t.get("lp_btn_metallic", True)),
            t.get("lp_btn_color_2"),
            t.get("lp_btn_angle") if t.get("lp_btn_angle") is not None else 180,
            t.get("lp_btn_border_color"),
            t.get("lp_btn_border_width") if t.get("lp_btn_border_width") is not None else 0,
            bool(t.get("lp_btn_border_metallic", False)),
            t.get("lp_btn_radius"),
            t.get("lp_border_color") or "#FFCFA4",
            bool(t.get("lp_border_metallic", True)),
            t.get("lp_border_style") or "solid",
            t.get("lp_card_bg") or "#0F1E2E",
            t.get("lp_card_bg_opacity") if t.get("lp_card_bg_opacity") is not None else 55,
            t.get("lp_card_text_color"),  # NULL → текст карточек наследует color_body
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
                    # ⚠️ Заголовки НОВЫХ лендингов — ПО ЦЕНТРУ. В колонке
                    # умолчание 'left' (так собраны уже существующие страницы,
                    # и менять его нельзя — сдвинуло бы их задним числом),
                    # поэтому центр проставляем здесь, при создании блоков.
                    # ⚠️ Ширина колонки: у ШАПКИ 100% (во всю полосу), у секции
                    # 50% (пропорция двух колонок). Поле одно, смысл разный.
                    "INSERT INTO event_landing_blocks (page_id, kind, sort_order, is_active, title_align, split_ratio) "
                    "VALUES ($1, $2, $3, $4, 'center', $5)",
                    page["id"], b["kind"], i * 10, b["is_active"],
                    100 if b["kind"] == "hero" else 50,
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
        "SELECT slug, title, seats_total, seats_label, seats_label_position, seats_size, "
        "seats_count_mode, seats_base "
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
            "seats_size": ev["seats_size"],
            "seats_count_mode": ev["seats_count_mode"],
            "seats_base": ev["seats_base"],
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
    for field in PAGE_PATCH_FIELDS:
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
        if field == "btn_radius" and val is not None:
            val = max(0, min(64, int(val)))
        if field == "btn_border_width" and val is not None:
            val = max(0, min(12, int(val)))
        if field == "bg_angle" and val is not None:
            val = max(0, min(360, int(val)))
        if field == "border_style" and val not in ("solid", "fade"):
            val = "solid"
        if field == "card_bg_opacity" and val is not None:
            val = max(0, min(100, int(val)))
        # Масштаб фона. ⚠️ Минимум 100: ниже картинка перестаёт покрывать
        # экран и по краям появляются пустые поля (фон выглядит «карточкой»).
        if field in ("bg_scale", "bg_scale_mobile") and val is not None:
            val = max(100, min(500, int(val)))
        # Пустая строка = ЯВНЫЙ сброс на наследование общего цвета текста.
        # Без этого вернуть «как у всей страницы» было бы нечем.
        if field == "card_text_color" and not (val or "").strip():
            val = None
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
        "card_text_color",
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

    # ⚠️⚠️ У КОЛЛАБ-СОБЫТИЯ БЛОКА «АНКЕТА» НЕТ (решение владельца). Лендинг там
    # общий, а базы у организаторов РАЗНЫЕ: заявка с общей страницы упала бы в
    # базу того, кто поставил форму, — человек, пришедший по ссылке партнёра,
    # стал бы контактом другого организатора, и уведомление ушло бы не тому.
    # Договориться, «чья форма», нечем: организаторы равноправны.
    if data.kind == "survey" and await db.fetchval(
        "SELECT is_collab FROM events WHERE id = $1", event_id
    ):
        raise HTTPException(
            status_code=400,
            detail="В совместном событии блок «Анкета / Заявка» недоступен: "
                   "лендинг общий, а базы контактов у организаторов разные.",
        )

    last = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), 0) FROM event_landing_blocks WHERE page_id = $1",
        page_id,
    )
    # ⚠️ Новая секция встаёт так же, как СОСЕДНИЕ на этой странице: иначе на
    # лендинге с центрированными заголовками добавленная села бы влево и
    # выбивалась из ряда. Берём самое частое значение среди уже стоящих;
    # страница пустая — центр (умолчание новых лендингов).
    align = await db.fetchval(
        "SELECT title_align FROM event_landing_blocks WHERE page_id = $1 "
        " GROUP BY title_align ORDER BY count(*) DESC LIMIT 1",
        page_id,
    ) or "center"
    # ⚠️ У ШАПКИ ширина колонки по умолчанию 100% (во всю полосу), у обычной
    # секции — 50% (пропорция двух колонок). Поле одно, смысл разный, поэтому
    # умолчание колонки в БД не трогаем: тип блока знает только код.
    ratio = 100 if data.kind == "hero" else 50
    row = await db.fetchrow(
        """INSERT INTO event_landing_blocks
             (page_id, kind, admin_name, title, subtitle, body, button_label, button_url,
              items, sort_order, is_active, title_align, split_ratio)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) RETURNING *""",
        page_id, data.kind, data.admin_name, data.title, data.subtitle, data.body,
        data.button_label, data.button_url, json.dumps(data.items or []),
        last + 10, data.is_active, align, ratio,
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
    if "survey_id" in fs:
        await assert_survey_owned(db, client_id, data.survey_id)
    sets, vals = [], []
    for field in BLOCK_PATCH_FIELDS:
        if field not in fs:
            continue
        val = getattr(data, field)
        # ⚠️ Здесь стояло принудительное зануление подзаголовка у шапки — по
        # прежнему правилу «в шапке показывается описание события». Правило
        # отменено: описание переехало в свою секцию, а подзаголовок шапки стал
        # собственным полем (короткая строка под названием). Пока зануление
        # оставалось, клиент вводил текст, а на сервере он превращался в NULL —
        # поле выглядело «не принимающим ввод».
        # Мусор в раскладке не пишем — CHECK в БД иначе отдаст 500 вместо
        # понятной реакции; молча приводим к разумному значению.
        if field == "layout" and val not in ("top", "left", "right"):
            val = "top"
        if field == "image_position" and val not in ("left", "right", "top", "bottom", "center"):
            val = "right"
        if field == "image_width" and val is not None:
            val = max(20, min(100, int(val)))
        if field == "split_ratio" and val is not None:
            # ⚠️ У ШАПКИ потолок 100%: там это ширина колонки с текстом, и её
            # штатно ставят во всю полосу (сдвиг влево при широком заголовке —
            # обычная раскладка). У обычных секций это ПРОПОРЦИЯ двух колонок,
            # и 100% означало бы, что второй колонке не осталось места.
            val = max(20, min(100 if block_kind == "hero" else 80, int(val)))
        if field == "pad_y" and val is not None:
            val = max(0, min(200, int(val)))
        # Мусорное значение сломало бы вёрстку шапки — приводим к центру.
        if field == "hero_align" and val not in ("left", "center", "right"):
            val = "center"
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
        if field == "gallery_source" and val not in ("manual", "testimonials"):
            val = "manual"
        if field == "card_img_size" and val is not None:
            val = max(20, min(100, int(val)))
        if field == "media_size" and val is not None:
            val = max(160, min(900, int(val)))
        if field == "date_size" and val is not None:
            val = max(10, min(80, int(val)))
        if field == "featured_glow" and val is not None:
            val = max(0, min(90, int(val)))
        val = normalize_block_button(field, val)
        val = normalize_block_survey(field, val)
        if field == "icon_size" and val is not None:
            val = max(24, min(200, int(val)))
        if field in ("card_img_radius_x", "card_img_radius_y") and val is not None:
            val = max(0, min(50, int(val)))
        if field == "card_img_ratio" and val is not None:
            val = max(0.4, min(3.0, float(val)))
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

    if "gallery_tags" in fs:
        tags = [str(t).strip().lower()[:40] for t in (data.gallery_tags or []) if str(t).strip()]
        vals.append(tags[:20])
        sets.append(f"gallery_tags = ${len(vals)}")

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


async def _reset_page_theme(db, page_id: int):
    """Вернуть странице СТАНДАРТНЫЙ стиль платформы.

    Те же значения, что получает новая страница коллаб-события: фирменные
    цвета проекта из миграции 241. Нужен, чтобы из чужой темы можно было
    выйти — иначе применённое оформление партнёра снималось бы только
    вручную, по одному полю из трёх десятков.
    """
    row = await db.fetchrow(
        """UPDATE event_landing_pages SET
             bg_color = '#25455D', bg_color_2 = '#0a1520',
             bg_angle = 45, bg_gradient = TRUE, bg_mode = 'screen',
             font_heading = 'BebasNeue', color_heading = '#FFCFA4',
             heading_metallic = TRUE,
             font_body = 'Roboto', color_body = '#FFFFFF',
             color_link = '#FFCFA4',
             price_color = NULL, day_tab_color = NULL, day_tab_text_color = NULL,
             btn_color = '#FFCFA4', btn_text_color = '#0a1520', btn_metallic = TRUE,
             btn_color_2 = NULL, btn_angle = 180,
             btn_border_color = NULL, btn_border_width = 0,
             btn_border_metallic = FALSE, btn_radius = NULL,
             border_color = '#FFCFA4', border_metallic = TRUE, border_style = 'solid',
             card_bg = '#0F1E2E', card_bg_opacity = 55, card_text_color = NULL,
             icon_color = '#FFCFA4', icon_metallic = TRUE,
             radius = 5, body_size = 16,
             content_width = 1120, pad_x = 24, section_gap = 64,
             style_customized = FALSE, updated_at = NOW()
           WHERE id = $1
           RETURNING *""",
        page_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Страница не найдена")
    return row


@router.get("/theme-sources", summary="Чьи стили можно применить к странице")
async def theme_sources(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Организаторы события — источники оформления для выпадающего списка.

    У обычного события в списке один пункт (сам владелец), у коллабы — все
    принявшие приглашение. Нужен, потому что у коллаб-события своей темы нет
    (страница создаётся в стандартных цветах), и стиль выбирается явно.
    """
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)

    rows = await db.fetch(
        """SELECT cl.id, COALESCE(NULLIF(cl.brand_name, ''), cl.name) AS title,
                  cl.name AS owner_name, cl.brand_logo_url,
                  cl.lp_bg_color, cl.lp_bg_color_2, cl.lp_color_heading, cl.lp_btn_color
             FROM event_owners eo
             JOIN clients cl ON cl.id = eo.client_id
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY eo.id""",
        event_id,
    )
    return {
        "sources": [dict(r) for r in rows],
        # Стандартный стиль платформы — отдельным пунктом: к нему нужно
        # уметь вернуться, если чужая тема не подошла.
        "has_default": True,
    }


class ApplyThemeRequest(BaseModel):
    # Чью тему брать. Пусто → свою (прежнее поведение кнопки).
    source_client_id: Optional[int] = None
    # TRUE → стандартный стиль платформы, а не чей-либо фирменный.
    reset_to_default: bool = False


@router.post("/pages/{page_id}/apply-theme", summary="Применить фирменную тему к странице")
async def apply_theme(
    event_id: int,
    page_id: int,
    data: Optional[ApplyThemeRequest] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Перетянуть оформление из «Стили бренда и лендинга» в эту страницу.

    Тема копируется в страницу при её создании (см. `_get_or_create_page`) —
    чтобы правка темы не переоформляла задним числом уже собранные лендинги.
    Но клиент, настроив тему, ждёт, что увидит её на существующей странице,
    поэтому даём явную кнопку. Содержимое блоков не трогаем — только стиль.

    ⚠️ У КОЛЛАБЫ источник выбирается явно (`source_client_id`) — тема любого
    из организаторов либо стандартный стиль платформы (`reset_to_default`).
    Без выбора берётся своя, как было у обычного события.
    """
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)
    await _page_for_write(db, event_id, page_id)

    req = data or ApplyThemeRequest()

    if req.reset_to_default:
        return _ser_page(await _reset_page_theme(db, page_id))

    # Источник — либо явно выбранный организатор, либо сам клиент.
    if req.source_client_id and req.source_client_id != client_id:
        # ⚠️ Тему берём ТОЛЬКО у организатора ЭТОГО события: иначе, зная
        # id, можно было бы утащить фирменное оформление чужого кабинета.
        allowed = await db.fetchval(
            "SELECT 1 FROM event_owners WHERE event_id = $1 AND client_id = $2 "
            "AND status = 'accepted'",
            event_id, req.source_client_id,
        )
        if not allowed:
            raise HTTPException(
                status_code=404,
                detail="Этот организатор не участвует в событии",
            )
        client_id = req.source_client_id

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
             day_tab_color = c.lp_day_tab_color,
             day_tab_text_color = c.lp_day_tab_text_color,
             btn_color = c.lp_btn_color, btn_text_color = c.lp_btn_text_color,
             btn_metallic = c.lp_btn_metallic,
             btn_color_2 = c.lp_btn_color_2,
             btn_angle = COALESCE(c.lp_btn_angle, 180),
             btn_border_color = c.lp_btn_border_color,
             btn_border_width = COALESCE(c.lp_btn_border_width, 0),
             btn_border_metallic = COALESCE(c.lp_btn_border_metallic, FALSE),
             btn_radius = c.lp_btn_radius,
             border_color = c.lp_border_color, border_metallic = c.lp_border_metallic,
             border_style = COALESCE(c.lp_border_style, 'solid'),
             card_bg = c.lp_card_bg,
             card_bg_opacity = COALESCE(c.lp_card_bg_opacity, 55),
             card_text_color = c.lp_card_text_color,
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
    size = data.get("seats_size")
    if size is not None:
        size = max(12, min(120, int(size)))
    pos = data.get("seats_label_position")
    if pos not in ("top", "left", "right"):
        pos = "top"
    # Что считать занятыми: подтверждённые регистрации или всех зашедших.
    mode = data.get("seats_count_mode")
    if mode not in ("registered", "visited"):
        mode = "registered"
    # Стартовое смещение: счётчик идёт от уже имеющейся аудитории клиента.
    base = data.get("seats_base")
    if base is not None:
        base = max(0, int(base))
    await db.execute(
        "UPDATE events SET seats_total = $1, seats_label = $2, seats_label_position = $3, "
        "seats_size = $4, seats_count_mode = $5, seats_base = $6 WHERE id = $7",
        total, (label or None), pos, size, mode, base, event_id,
    )
    return {"ok": True, "seats_total": total, "seats_label": label,
            "seats_label_position": pos, "seats_size": size,
            "seats_count_mode": mode, "seats_base": base}


@router.get("/copy-sources", summary="События, из которых можно скопировать лендинг")
async def landing_copy_sources(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список СВОИХ событий с непустым лендингом (кроме текущего).

    Пустые лендинги не показываем: копировать оттуда нечего, а в списке они
    только сбивают с толку.
    """
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)

    rows = await db.fetch(
        """
        SELECT e.id, e.title, e.slug, e.start_at,
               (SELECT COUNT(*) FROM event_landing_blocks b
                  JOIN event_landing_pages p ON p.id = b.page_id
                 WHERE p.event_id = e.id) AS blocks_count,
               (SELECT COUNT(*) FROM event_tariffs t WHERE t.event_id = e.id) AS tariffs_count
          FROM events e
         WHERE e.id <> $1
           AND EXISTS (SELECT 1 FROM event_owners eo
                        WHERE eo.event_id = e.id AND eo.client_id = $2
                          AND eo.status = 'accepted')
           AND EXISTS (SELECT 1 FROM event_landing_blocks b
                         JOIN event_landing_pages p ON p.id = b.page_id
                        WHERE p.event_id = e.id)
         ORDER BY COALESCE(e.start_at, e.created_at) DESC NULLS LAST, e.id DESC
        """,
        event_id, client_id,
    )
    return {"events": [dict(r) for r in rows]}


@router.post("/copy-from/{source_event_id}", summary="Скопировать лендинг из другого события")
async def landing_copy_from(
    event_id: int,
    source_event_id: int,
    data: dict | None = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Перенести лендинг события-донора в ТЕКУЩЕЕ событие.

    Копируются: блоки с оформлением (обе страницы — основная и «Спасибо») и,
    по галочке, тарифы. Всё делается в одной транзакции: наполовину
    перенесённый лендинг хуже, чем неперенесённый.

    ⚠️ Замещает, а не дополняет: старые блоки текущего лендинга удаляются.
    Иначе при повторном копировании секции задвоятся.

    ⚠️ Что НЕ переносим:
      • адрес страницы (`slug`) и факт публикации — у события свои;
      • `featured_tariff_id` у блоков — там номера тарифов ДОНОРА;
      • ЧУЖУЮ анкету в блоке «Анкета» (`survey_id` другого кабинета) — иначе
        заявки собирались бы в базу постороннего клиента;
      • заказы и оплаты — они принадлежат людям, а не событию.
    Живые блоки (спикеры, программа, организатор) копию контента не хранят —
    подтянут данные уже нового события сами.
    """
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _check_event_access(db, client_id, source_event_id)
    await _assert_feature(db, client_id)

    with_tariffs = bool((data or {}).get("with_tariffs", True))
    copied_pages = 0
    copied_blocks = 0
    copied_tariffs = 0

    async with db.transaction():
        for kind in ("main", "post_pay"):
            src_page = await db.fetchrow(
                "SELECT * FROM event_landing_pages WHERE event_id = $1 AND kind = $2",
                source_event_id, kind,
            )
            if not src_page:
                continue
            dst_page = await _get_or_create_page(db, event_id, kind)

            # Оформление страницы: всё, кроме адреса и признака публикации —
            # ссылка и статус у каждого события свои.
            skip_page = {"id", "event_id", "kind", "created_at", "updated_at",
                         "is_published", "slug"}
            pcols = [k for k in dict(src_page).keys() if k not in skip_page]
            if pcols:
                sets = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(pcols))
                await db.execute(
                    f"UPDATE event_landing_pages SET {sets} WHERE id = $1",
                    dst_page["id"], *[src_page[c] for c in pcols],
                )
            copied_pages += 1

            # Замещаем блоки целиком — иначе секции задвоятся.
            await db.execute(
                "DELETE FROM event_landing_blocks WHERE page_id = $1", dst_page["id"])
            for blk in await db.fetch(
                "SELECT * FROM event_landing_blocks WHERE page_id = $1 ORDER BY sort_order, id",
                src_page["id"],
            ):
                bcols = [k for k in dict(blk).keys()
                         if k not in ("id", "page_id", "created_at", "updated_at",
                                      "featured_tariff_id")]
                vals_by_col = dict(blk)
                # ⚠️ Анкету донора переносим ТОЛЬКО если она принадлежит этому
                # же кабинету. В коллабе донором бывает общее событие, где
                # анкету поставил партнёр: скопировав её id, клиент собирал бы
                # заявки в ЧУЖУЮ базу, а партнёр получал уведомления о людях,
                # которых не звал. Чужая — оставляем блок с пустым выбором,
                # он просто не рисуется, пока клиент не выберет свою.
                if vals_by_col.get("survey_id") and not await db.fetchval(
                    "SELECT 1 FROM surveys WHERE id = $1 AND client_id = $2",
                    vals_by_col["survey_id"], client_id,
                ):
                    vals_by_col["survey_id"] = None
                bph = ",".join(f"${i + 2}" for i in range(len(bcols)))
                await db.execute(
                    f"INSERT INTO event_landing_blocks (page_id, {','.join(bcols)}) "
                    f"VALUES ($1, {bph})",
                    dst_page["id"], *[vals_by_col[c] for c in bcols],
                )
                copied_blocks += 1

        if with_tariffs:
            # Тарифы тоже замещаем: блок «Тарифы» на лендинге показывает их из
            # события, и смесь старых с новыми выглядела бы мусором.
            await db.execute("DELETE FROM event_tariffs WHERE event_id = $1", event_id)
            for row in await db.fetch(
                "SELECT * FROM event_tariffs WHERE event_id = $1 ORDER BY sort_order, id",
                source_event_id,
            ):
                cols = [k for k in dict(row).keys()
                        if k not in ("id", "event_id", "created_at", "updated_at")]
                ph = ",".join(f"${i + 2}" for i in range(len(cols)))
                await db.execute(
                    f"INSERT INTO event_tariffs (event_id, {','.join(cols)}) VALUES ($1, {ph})",
                    event_id, *[row[c] for c in cols],
                )
                copied_tariffs += 1

    return {"ok": True, "pages": copied_pages, "blocks": copied_blocks,
            "tariffs": copied_tariffs}


# ─────────────────────────────────────────────────────────────────────────────
# PDF страницы
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/pages/{page_id}/pdf", summary="Лендинг файлом PDF (мобильная версия)")
async def landing_pdf(
    event_id: int,
    page_id: int,
    user=Depends(get_current_client),
    db=Depends(get_db),
):
    """Отдать лендинг одним PDF — «как на телефоне».

    ⚠️ Зачем вообще: у части аудитории ссылка не открывается (корпоративная
    сеть режет домен, встроенный браузер мессенджера падает, нет интернета).
    Таким людям организатор отправляет файл — иначе показать страницу нечем.

    ⚠️ Печатаем ПО ПУБЛИЧНОМУ АДРЕСУ на домене клиента, а не по внутреннему:
    так в файл попадает ровно то, что видит посетитель, вместе с темой и
    живыми данными. Домен берём хелпером — литералов `pluson.ru` в коде нет.

    ⚠️ Черновик открываем себе сами — подписанным токеном предпросмотра
    (`?preview=`). Без него неопубликованная страница отдала бы 404, а PDF
    нужен как раз на согласовании, до публикации.
    """
    client_id = int(user["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_feature(db, client_id)

    page = await db.fetchrow(
        """SELECT p.id, p.kind, p.is_published, e.slug, e.title
             FROM event_landing_pages p
             JOIN events e ON e.id = p.event_id
            WHERE p.id = $1 AND p.event_id = $2""",
        page_id, event_id,
    )
    if not page:
        raise HTTPException(status_code=404, detail="Страница лендинга не найдена")

    path = f"/e/{page['slug']}" + ("/thanks" if page["kind"] == "post_pay" else "")
    url = await client_public_link(db, client_id, path)
    if not page["is_published"]:
        url += f"?preview={make_preview_token(client_id)}"

    return await pdf_response(url, filename_base=page["title"] or page["slug"])
