"""
Публичная отдача лендинга продукта (миграция 293) — `/pr/{slug}`.

Контракт ответа повторяет событийный (`event_landing_public.py`):
`{owner, page, blocks, data}` — чтобы фронт мог рисовать обе страницы одним
рендерером, а не заводить вторую вёрстку.

⚠️ Живые блоки продукта: `product_content` (состав), `tariffs` (тарифы),
`organizer` (бренд клиента), `footer` (реквизиты и оферта). Блоков события —
программы, спикеров, мест — здесь нет.

⚠️ В составе на витрине только названия и описания, БЕЗ ссылок на файлы:
ссылка появляется в кабинете, у того, кто купил.
"""
import json
import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.database import get_db
from app.services.client_domains import client_id_by_domain

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/public/product-landing", tags=["Лендинг продукта — публично"])

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _cors(response: Response) -> None:
    for k, v in _CORS.items():
        response.headers[k] = v


def _jsonb(value):
    """asyncpg отдаёт JSONB строкой — разворачиваем, иначе фронт падает на .map."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return []
    return value if value is not None else []


@router.options("/{slug}", include_in_schema=False)
async def _opts(slug: str, response: Response):
    _cors(response)
    return {}


@router.get("/{slug}", summary="Лендинг продукта одним запросом")
async def get_product_landing(
    slug: str,
    request: Request,
    response: Response,
    kind: str = "main",
    client_id: Optional[int] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)
    if kind not in ("main", "post_pay"):
        kind = "main"

    # ⚠️ slug уникален в пределах КАБИНЕТА, не глобально: у разных клиентов
    # может быть свой /pr/mentoring. Клиента берём по домену, на общем
    # pluson.ru — из параметра.
    cid = client_id
    host = (request.headers.get("host") or "").split(":")[0].lower()
    if host:
        try:
            cid = await client_id_by_domain(db, host) or cid
        except Exception:
            pass

    if cid:
        product = await db.fetchrow(
            "SELECT * FROM products WHERE slug = $1 AND client_id = $2", slug, cid)
    else:
        rows = await db.fetch("SELECT * FROM products WHERE slug = $1 LIMIT 2", slug)
        if len(rows) > 1:
            raise HTTPException(status_code=404, detail="Уточните адрес кабинета")
        product = rows[0] if rows else None

    if not product or product["status"] != "published":
        raise HTTPException(status_code=404, detail="Страница не найдена")

    page = await db.fetchrow(
        """SELECT * FROM event_landing_pages
            WHERE owner_type = 'product' AND owner_id = $1 AND kind = $2""",
        product["id"], kind,
    )
    if not page or not page["is_published"]:
        raise HTTPException(status_code=404, detail="Страница не опубликована")

    blocks = await db.fetch(
        "SELECT * FROM event_landing_blocks WHERE page_id = $1 AND is_active "
        "ORDER BY sort_order, id",
        page["id"],
    )
    kinds = {b["kind"] for b in blocks}

    data: dict = {}

    # ── Состав продукта ──
    if "product_content" in kinds:
        sections = await db.fetch(
            "SELECT id, parent_id, title, description, sort_order "
            "FROM product_sections WHERE product_id = $1 ORDER BY sort_order, id",
            product["id"],
        )
        items = await db.fetch(
            """SELECT pm.id AS link_id, pm.section_id, pm.sort_order, pm.min_tariff_id,
                      COALESCE(pm.title_override, m.title) AS title,
                      m.description, m.kind, m.duration_sec
                 FROM product_materials pm
                 JOIN materials m ON m.id = pm.material_id
                WHERE pm.product_id = $1 AND pm.show_on_landing
                ORDER BY pm.sort_order, pm.id""",
            product["id"],
        )
        data["product_content"] = {
            "sections": [dict(s) for s in sections],
            "items": [dict(i) for i in items],
        }

    # ── Организатор: нужен и тарифам (бренд в согласиях), поэтому выше ──
    client = None
    if kinds & {"organizer", "footer", "support", "tariffs"}:
        client = await db.fetchrow(
            """SELECT id, name, brand_name, brand_logo_url, profile_photo_url,
                      owner_photo_url, owner_positioning, positioning, bio,
                      work_tg_username, work_vk, work_max, phone,
                      legal_name, legal_inn, privacy_policy_version
                 FROM clients WHERE id = $1""",
            product["client_id"],
        )

    # ── Тарифы ──
    if "tariffs" in kinds:
        tariffs = await db.fetch(
            """SELECT id, code, title, description, excluded_description, price,
                      order_hint, is_featured, sort_order
                 FROM product_tariffs
                WHERE product_id = $1 AND is_active
                ORDER BY sort_order, id""",
            product["id"],
        )
        # ⚠️ Тот же формат, что у события ({items, offer_url, ...}) — рендерер
        # общий, массив он бы не понял.
        data["tariffs"] = {
            "items": [dict(t) for t in tariffs],
            "offer_url": product["offer_url"],
            "privacy_url": (
                f"/c/{client['id']}/privacy"
                if client and client["privacy_policy_version"] else None
            ),
            "brand_name": (client["brand_name"] or client["name"]) if client else None,
            "owner_name": client["name"] if client else None,
        }

    # ── Организатор и реквизиты ──
    if kinds & {"organizer", "footer", "support"}:
        if client:
            c = dict(client)
            data["organizer"] = c
            data["footer"] = {
                "brand": c.get("brand_name") or c.get("name"),
                "legal_name": c.get("legal_name"),
                "legal_inn": c.get("legal_inn"),
                "offer_url": product["offer_url"],
            }
            data["support"] = {
                "tg": c.get("work_tg_username"),
                "vk": c.get("work_vk"),
                "max": c.get("work_max"),
                "phone": c.get("phone"),
            }

    return {
        "owner_type": "product",
        "product": {
            "id": product["id"],
            "slug": product["slug"],
            "title": product["title"],
            "subtitle": product["subtitle"],
            "description": product["description"],
            "cover_url": product["cover_url"],
            "offer_url": product["offer_url"],
            "wording_preset": product["wording_preset"],
        },
        "page": {**dict(page), "nav_items": _jsonb(page["nav_items"])},
        "blocks": [{**dict(b), "items": _jsonb(b["items"])} for b in blocks],
        "data": data,
    }
