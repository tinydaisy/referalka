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
from app.services.preview_token import is_preview_owner
from app.services.landing_theme import apply_theme_fields
from app.services.landing_support import support_links
from app.services.tariff_discount import with_discount

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
    preview: Optional[str] = None,
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

    if not product:
        raise HTTPException(status_code=404, detail="Страница не найдена")

    # ⚠️ Владелец с токеном предпросмотра видит и черновик продукта, и
    # неопубликованный лендинг: собрать страницу вслепую невозможно.
    owner = is_preview_owner(preview, product["client_id"])

    # Статус продукта саму ссылку не закрывает — внешнего каталога продуктов
    # нет, публиковать нечего (см. products_public.py). Закрыт только архив.
    if product["status"] == "archived" and not owner:
        raise HTTPException(status_code=404, detail="Страница не найдена")

    page = await db.fetchrow(
        """SELECT * FROM event_landing_pages
            WHERE owner_type = 'product' AND owner_id = $1 AND kind = $2""",
        product["id"], kind,
    )
    # ⚠️ А вот ЛЕНДИНГ публикуется по-настоящему: пока он черновик, посетитель
    # должен видеть простую витрину продукта, а не полусобранную страницу.
    # Поэтому здесь замок остаётся — снимает его только предпросмотр.
    if not page or (not page["is_published"] and not owner):
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
                      m.description
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
    # ⚠️ Грузим ВСЕГДА (без условия по блокам): логотип бренда нужен
    # шапке-меню, а она не зависит от того, какие секции включены.
    client = None
    if True:
        client = await db.fetchrow(
            """SELECT id, name, brand_name, brand_logo_url, profile_photo_url,
                      owner_photo_url, owner_positioning, positioning, bio,
                      work_tg_username, work_vk, work_max, phone,
                      legal_name, legal_inn, privacy_policy_version
                 FROM clients WHERE id = $1""",
            product["client_id"],
        )

    # ── Тарифы ──
    # ── Галереи из базы отзывов ───────────────────────────────────────────
    # ⚠️ Тот же механизм, что у события: блок галереи может брать содержимое
    # не из своих items, а из общей базы отзывов по тегам — один и тот же
    # набор фото переиспользуется на разных лендингах и правится в одном месте.
    # У продукта этого сбора не было вовсе, и галерея выходила пустой.
    gal_blocks = [b for b in blocks
                  if b["kind"] == "gallery" and b["gallery_source"] == "testimonials"]
    if gal_blocks:
        data["testimonials"] = {}
        for b in gal_blocks:
            tags = list(b["gallery_tags"] or [])
            rows = await db.fetch(
                """SELECT kind, url, preview_url, title, caption
                     FROM client_testimonials
                    WHERE client_id = $1 AND is_active
                      AND ($2::text[] = '{}' OR tags && $2::text[])
                    ORDER BY sort_order, id""",
                product["client_id"], tags,
            )
            data["testimonials"][str(b["id"])] = [dict(r) for r in rows]

    if "tariffs" in kinds:
        tariffs = await db.fetch(
            """SELECT id, code, title, description, excluded_description, price,
                      discount_kind, discount_value,
                      order_hint, is_featured, sort_order
                 FROM product_tariffs
                WHERE product_id = $1 AND is_active
                ORDER BY sort_order, id""",
            product["id"],
        )
        # ⚠️ Тот же формат, что у события ({items, offer_url, ...}) — рендерер
        # общий, массив он бы не понял.
        data["tariffs"] = {
            "items": [with_discount(t) for t in tariffs],
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
            # ⚠️ Формат ОДИН на все лендинги (см. landing_support.py). Здесь
            # была своя сборка с ключом `tg` и сырыми никами — фронт общий и
            # ждёт `telegram` со ссылкой, поэтому Telegram на странице продукта
            # пропадал, а остальные контакты вели в никуда.
            data["support"] = support_links(c)

    # ⚠️ Логотип и имя бренда нужны ШАПКЕ-МЕНЮ (плавающей панели сверху) —
    # независимо от того, включён ли блок подвала или организатора. У продукта
    # этого не отдавали вовсе, и в меню логотипа не было. Так же, как у события.
    if client:
        data.setdefault("brand", {
            "name": client["brand_name"] or client["name"],
            "logo_url": client["brand_logo_url"],
        })

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
        # ⚠️ apply_theme_fields ОБЯЗАТЕЛЕН: без него страница получает bg_css и
        # font_*_css пустыми и выходит белой, хотя цвета в базе правильные.
        # Ровно так и было — вычисление жило только в лендинге события.
        "page": apply_theme_fields({**dict(page), "nav_items": _jsonb(page["nav_items"])}),
        "blocks": [{**dict(b), "items": _jsonb(b["items"])} for b in blocks],
        "data": data,
    }
