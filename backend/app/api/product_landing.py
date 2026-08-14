"""
Конструктор лендинга продукта (миграция 293) — тот же, что у события.

Блоки живут в `event_landing_blocks` и висят на `page_id`, а страница получила
владельца (`owner_type='product'`). Отдельного набора таблиц и второй вёрстки
нет намеренно: развёл бы — и чинить пришлось бы в двух местах.

⚠️ Пресет блоков у продукта СВОЙ: «Программа», «Спикеры», «Места» и «Подарки»
тянут данные события, которых у продукта нет. Вместо них — блок `product_content`
(«Что входит»), который читает состав продукта.

API (JWT владельца; гейт — фича `products`):
  GET   /api/v1/products/{product_id}/landing
  PATCH /api/v1/products/{product_id}/landing/pages/{page_id}
  POST  /api/v1/products/{product_id}/landing/pages/{page_id}/blocks
  PATCH /api/v1/products/{product_id}/landing/blocks/{block_id}
  POST  /api/v1/products/{product_id}/landing/pages/{page_id}/reorder
  DELETE/api/v1/products/{product_id}/landing/blocks/{block_id}
  POST  /api/v1/products/{product_id}/landing/pages/{page_id}/apply-theme
"""
import json
import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.auth import get_current_client
from app.services.features import client_has_feature
from app.services.assistant_access import assistant_is_restricted
from app.api.event_landing import PagePatch, BlockPatch

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/products/{product_id}/landing", tags=["Лендинг продукта"])

# ⚠️ Пресет продукта: без «программы», «спикеров», «мест» и «подарков» —
# это живые блоки события. Их место занимает `product_content` («Что входит»),
# который читает состав продукта.
DEFAULT_PRODUCT_BLOCKS: list[dict] = [
    {"kind": "hero",            "is_active": True},
    {"kind": "audience",        "is_active": True},
    {"kind": "benefits",        "is_active": True},
    {"kind": "values",          "is_active": False},
    {"kind": "numbers",         "is_active": False},
    {"kind": "difference",      "is_active": False},
    # Этапы по вертикальной линии — «как всё происходит по шагам».
    {"kind": "process",         "is_active": False},
    {"kind": "product_content", "is_active": True},
    {"kind": "organizer",       "is_active": True},
    {"kind": "gallery",         "is_active": False},
    {"kind": "mission",         "is_active": False},
    {"kind": "tariffs",         "is_active": True},
    {"kind": "support",         "is_active": True},
    {"kind": "footer",          "is_active": True},
]

DEFAULT_PRODUCT_POST_PAY: list[dict] = [
    {"kind": "hero",    "is_active": True},
    {"kind": "support", "is_active": True},
    {"kind": "footer",  "is_active": True},
]

# Блоки, которые сами тянут данные — руками правится только заголовок и вид.
LIVE_KINDS_PRODUCT = {"product_content", "tariffs", "organizer", "support", "footer"}

VALID_KINDS_PRODUCT = (
    {b["kind"] for b in DEFAULT_PRODUCT_BLOCKS}
    | {"text", "gallery", "el_button", "el_heading", "el_text", "el_image"}
)

REPEATABLE_KINDS = {"text", "gallery", "el_button", "el_heading", "el_text", "el_image"}


def _ser_product_block(r: asyncpg.Record) -> dict:
    """Как `_ser_block` у события, но `is_live` считается по блокам ПРОДУКТА.

    Разворачивать JSONB обязательно: asyncpg отдаёт `items` строкой, и фронт
    падает на `.map` — страница конструктора выбрасывает ошибку.
    """
    from app.api.event_landing import _ser_block
    d = _ser_block(r)
    d["is_live"] = d["kind"] in LIVE_KINDS_PRODUCT
    return d


# ── Доступ ────────────────────────────────────────────────────────────────

async def _check(db, user: dict, product_id: int, *, write: bool = False):
    client_id = int(user["sub"])
    if not await client_has_feature(db, client_id, "products"):
        raise HTTPException(status_code=403,
                            detail="Раздел «Продукты/услуги» недоступен на вашем тарифе.")
    if write and await assistant_is_restricted(user):
        raise HTTPException(status_code=403,
                            detail="Ассистенту недоступно редактирование продуктов.")
    row = await db.fetchrow(
        "SELECT id, slug, title FROM products WHERE id = $1 AND client_id = $2",
        product_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Продукт не найден")
    return client_id, row


# ── Страница ──────────────────────────────────────────────────────────────

async def get_or_create_product_page(db, *, client_id: int, product_id: int,
                                     kind: str = "main") -> asyncpg.Record:
    """Страница создаётся лениво, с темой клиента и пресетом продукта.

    ⚠️ Тема КОПИРУЕТСЯ, а не привязывается: правка стилей задним числом уже
    собранные лендинги не трогает — так же, как у событий.
    """
    page = await db.fetchrow(
        """SELECT * FROM event_landing_pages
            WHERE owner_type = 'product' AND owner_id = $1 AND kind = $2""",
        product_id, kind,
    )
    if page:
        return page

    from app.services.landing_fonts import normalize_font

    theme = await db.fetchrow(
        """SELECT lp_bg_color, lp_bg_color_2, lp_bg_angle, lp_bg_gradient, lp_bg_mode,
                  lp_font_heading, lp_color_heading, lp_heading_metallic,
                  lp_font_body, lp_color_body, lp_color_link, lp_price_color,
                  lp_btn_color, lp_btn_text_color, lp_btn_metallic,
                  lp_btn_color_2, lp_btn_angle, lp_btn_border_color,
                  lp_btn_border_width, lp_btn_border_metallic, lp_btn_radius,
                  lp_border_color, lp_border_metallic, lp_border_style,
                  lp_card_bg, lp_card_bg_opacity, lp_card_text_color,
                  lp_icon_color, lp_icon_metallic, lp_radius, lp_body_size,
                  lp_content_width, lp_pad_x, lp_section_gap
             FROM clients WHERE id = $1""",
        client_id,
    )
    t = dict(theme) if theme else {}

    async with db.transaction():
        page = await db.fetchrow(
            """INSERT INTO event_landing_pages
                 (owner_type, owner_id, client_id, kind,
                  bg_color, bg_color_2, bg_angle, bg_gradient, bg_mode,
                  font_heading, color_heading, heading_metallic,
                  font_body, color_body, color_link, price_color,
                  btn_color, btn_text_color, btn_metallic,
                  btn_color_2, btn_angle, btn_border_color,
                  btn_border_width, btn_border_metallic, btn_radius,
                  border_color, border_metallic, border_style, card_bg, card_bg_opacity,
                  card_text_color, icon_color, icon_metallic, radius, body_size,
                  content_width, pad_x, section_gap)
               VALUES ('product',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                       $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
                       $31,$32,$33,$34,$35,$36,$37)
               RETURNING *""",
            product_id, client_id, kind,
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
            t.get("lp_btn_radius"),
            t.get("lp_border_color") or "#FFCFA4",
            bool(t.get("lp_border_metallic", True)),
            t.get("lp_border_style") or "solid",
            t.get("lp_card_bg") or "#0F1E2E",
            t.get("lp_card_bg_opacity") if t.get("lp_card_bg_opacity") is not None else 55,
            t.get("lp_card_text_color"),
            t.get("lp_icon_color") or "#FFCFA4",
            bool(t.get("lp_icon_metallic", True)),
            t.get("lp_radius") if t.get("lp_radius") is not None else 5,
            t.get("lp_body_size") if t.get("lp_body_size") is not None else 16,
            t.get("lp_content_width") if t.get("lp_content_width") is not None else 1120,
            t.get("lp_pad_x") if t.get("lp_pad_x") is not None else 24,
            t.get("lp_section_gap") if t.get("lp_section_gap") is not None else 64,
        )
        preset = DEFAULT_PRODUCT_BLOCKS if kind == "main" else DEFAULT_PRODUCT_POST_PAY
        for i, b in enumerate(preset):
            await db.execute(
                "INSERT INTO event_landing_blocks (page_id, kind, sort_order, is_active) "
                "VALUES ($1,$2,$3,$4)",
                page["id"], b["kind"], i, b["is_active"],
            )
    return page


@router.get("", summary="Лендинг продукта: страницы и блоки")
async def get_landing(
    product_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id, product = await _check(db, user, product_id)

    from app.api.event_landing import _ser_block, _ser_page

    out = {}
    for kind in ("main", "post_pay"):
        page = await get_or_create_product_page(
            db, client_id=client_id, product_id=product_id, kind=kind)
        blocks = await db.fetch(
            "SELECT * FROM event_landing_blocks WHERE page_id = $1 ORDER BY sort_order, id",
            page["id"],
        )
        out[kind] = {
            "page": _ser_page(page),
            "blocks": [_ser_product_block(b) for b in blocks],
        }

    from app.services.landing_fonts import FONTS

    return {
        "product": dict(product),
        "pages": out,
        # Список шрифтов — тот же, что у события: селектор оформления общий.
        "fonts": FONTS,
        "valid_kinds": sorted(VALID_KINDS_PRODUCT),
        "repeatable_kinds": sorted(REPEATABLE_KINDS),
    }


class BlockIn(BaseModel):
    kind: str
    after_block_id: Optional[int] = None


@router.post("/pages/{page_id}/blocks", summary="Добавить секцию")
async def add_block(
    product_id: int, page_id: int, data: BlockIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check(db, user, product_id, write=True)
    await _assert_page(db, page_id, product_id)

    if data.kind not in VALID_KINDS_PRODUCT:
        raise HTTPException(status_code=400, detail="Неизвестный тип секции")
    if data.kind not in REPEATABLE_KINDS:
        exists = await db.fetchval(
            "SELECT 1 FROM event_landing_blocks WHERE page_id = $1 AND kind = $2",
            page_id, data.kind,
        )
        if exists:
            raise HTTPException(status_code=409, detail="Такая секция уже есть на странице")

    nxt = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM event_landing_blocks WHERE page_id = $1",
        page_id,
    )
    row = await db.fetchrow(
        "INSERT INTO event_landing_blocks (page_id, kind, sort_order, is_active) "
        "VALUES ($1,$2,$3,TRUE) RETURNING *",
        page_id, data.kind, nxt,
    )
    return _ser_product_block(row)


async def _assert_page(db, page_id: int, product_id: int):
    ok = await db.fetchval(
        """SELECT 1 FROM event_landing_pages
            WHERE id = $1 AND owner_type = 'product' AND owner_id = $2""",
        page_id, product_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Страница не найдена")


@router.patch("/pages/{page_id}", summary="Оформление страницы")
async def update_page(
    product_id: int, page_id: int, data: PagePatch,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Оформление правится теми же полями, что у события — модель общая."""
    await _check(db, user, product_id, write=True)
    await _assert_page(db, page_id, product_id)

    from app.api.event_landing import PAGE_PATCH_FIELDS, _ser_page

    fs = data.model_fields_set
    sets, vals = [], []
    for field in PAGE_PATCH_FIELDS:
        if field in fs:
            vals.append(getattr(data, field))
            sets.append(f"{field} = ${len(vals)}")
    if not sets:
        row = await db.fetchrow("SELECT * FROM event_landing_pages WHERE id = $1", page_id)
        return _ser_page(row)

    vals.append(page_id)
    row = await db.fetchrow(
        f"UPDATE event_landing_pages SET {', '.join(sets)}, style_customized = TRUE, "
        f"updated_at = NOW() WHERE id = ${len(vals)} RETURNING *",
        *vals,
    )
    return _ser_page(row)


@router.patch("/blocks/{block_id}", summary="Изменить секцию")
async def update_block(
    product_id: int, block_id: int, data: BlockPatch,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check(db, user, product_id, write=True)
    ok = await db.fetchval(
        """SELECT 1 FROM event_landing_blocks b
             JOIN event_landing_pages p ON p.id = b.page_id
            WHERE b.id = $1 AND p.owner_type = 'product' AND p.owner_id = $2""",
        block_id, product_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Секция не найдена")

    from app.api.event_landing import BLOCK_PATCH_FIELDS

    fs = data.model_fields_set
    sets, vals = [], []
    for field in BLOCK_PATCH_FIELDS:
        if field in fs:
            v = getattr(data, field)
            # ⚠️ items — JSONB: asyncpg не примет список как есть.
            if field == "items":
                v = json.dumps(v or [], ensure_ascii=False)
            vals.append(v)
            sets.append(f"{field} = ${len(vals)}")
    if not sets:
        row = await db.fetchrow("SELECT * FROM event_landing_blocks WHERE id = $1", block_id)
        return _ser_product_block(row)

    vals.append(block_id)
    row = await db.fetchrow(
        f"UPDATE event_landing_blocks SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(vals)} RETURNING *",
        *vals,
    )
    return _ser_product_block(row)


class ReorderIn(BaseModel):
    ids: list[int]


@router.post("/pages/{page_id}/reorder", summary="Порядок секций")
async def reorder(
    product_id: int, page_id: int, data: ReorderIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check(db, user, product_id, write=True)
    await _assert_page(db, page_id, product_id)
    async with db.transaction():
        for i, bid in enumerate(data.ids):
            await db.execute(
                "UPDATE event_landing_blocks SET sort_order = $1 WHERE id = $2 AND page_id = $3",
                i, bid, page_id,
            )
    return {"ok": True}


@router.delete("/blocks/{block_id}", summary="Удалить секцию")
async def delete_block(
    product_id: int, block_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check(db, user, product_id, write=True)
    await db.execute(
        """DELETE FROM event_landing_blocks b
            USING event_landing_pages p
            WHERE b.page_id = p.id AND b.id = $1
              AND p.owner_type = 'product' AND p.owner_id = $2""",
        block_id, product_id,
    )
    return {"ok": True}
