"""Материалы платформы — те, что открывает КУПЛЕННЫЙ МОДУЛЬ.

Сейчас это материалы Коллабораторной, дальше так же лягут материалы других
модулей: строка в `MODULE_MATERIALS` — и раздел появился, без нового кода.

⚠️⚠️ ЗАЧЕМ ОТДЕЛЬНЫЙ СЛОЙ, А НЕ `products.py` И НЕ `products_public.py`.
Оба существующих читателя материалов не подходят, и подпереть их нельзя:

  • `products.py` жёстко фильтрует `WHERE client_id = $2` (`_get_product`,
    `_get_material`) — смотрящий не владеет этим продуктом и получил бы 404.
    Ослабить фильтр нельзя: через него же идут все 30+ ручек ЗАПИСИ.
  • `products_public.py` требует JWT кабинета покупателя и живой строки в
    `product_access` — то есть контакт, второй вход по коду на почту и срок.
    Клиент ПЛЮСОНа уже авторизован, и гонять его во второй кабинет незачем.

Здесь третий случай: смотрящий — КЛИЕНТ ПЛАТФОРМЫ, право смотреть даёт ФИЧА
модуля, а материалы принадлежат СИСТЕМНОМУ кабинету. Ни контактов, ни
`product_access`, ни тарифов продукта.

⚠️ ТОЛЬКО ЧТЕНИЕ. Правка остаётся в `products.py`, в кабинете владельца
материалов — туда сотруднику выдаётся доступ помощником (`assistant_grants`),
и право правки решается там, а не здесь. Так редактор один на всю платформу, а
не вторая копия.

⚠️ Показ на фронте — теми же `MaterialBlockView` и деревом, что у покупателя:
второй вёрстки блоков в проекте быть не должно.
"""

from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_current_client
from app.database import get_db
from app.services.features import client_has_feature

router = APIRouter(prefix="/module-materials", tags=["Материалы модулей"])

# Какая ФИЧА какой продукт открывает.
# ⚠️ Ключ — slug фичи, значение — slug продукта в СИСТЕМНОМ кабинете. Новый
# набор материалов под модуль = одна строка сюда, без правок кода.
MODULE_MATERIALS: dict[str, str] = {
    "collab_hub": "collab-hub",
}


async def _resolve(db: asyncpg.Connection, viewer_id: int, module: str) -> dict:
    """Продукт по слагу модуля — с проверкой права смотреть.

    ⚠️ Проверка ЗДЕСЬ, на сервере, а не только замком в интерфейсе: страница
    открывается по прямой ссылке, и запрос к API повторяется мимо неё.
    """
    product_slug = MODULE_MATERIALS.get(module)
    if not product_slug:
        raise HTTPException(404, "Такого раздела нет")

    if not await client_has_feature(db, viewer_id, module):
        raise HTTPException(403, "Раздел открывается вместе с модулем")

    row = await db.fetchrow(
        """SELECT p.id, p.title, p.subtitle, p.description, p.wording_preset
             FROM products p JOIN clients c ON c.id = p.client_id
            WHERE c.is_system_service = TRUE AND p.slug = $1
              AND p.status <> 'archived'
            LIMIT 1""",
        product_slug,
    )
    if not row:
        # Материалы ещё не завели — это не ошибка смотрящего.
        raise HTTPException(404, "Материалы пока не опубликованы")
    return dict(row)


@router.get("/{module}", summary="Материалы модуля: состав деревом")
async def get_module_materials(
    module: str,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Оглавление: разделы и материалы, без содержимого.

    ⚠️ Блоки здесь НЕ отдаются: их у полного набора сотни, а на оглавлении не
    показывается ни один. Содержимое приезжает при открытии материала.
    """
    viewer_id = int(user["sub"])
    product = await _resolve(db, viewer_id, module)

    rows = await db.fetch(
        """SELECT pm.id AS link_id, pm.sort_order, pm.section_id,
                  m.id AS material_id,
                  COALESCE(NULLIF(pm.title_override, ''), m.title) AS title,
                  m.description,
                  (SELECT COUNT(*) FROM material_blocks mb
                    WHERE mb.material_id = m.id) AS blocks_count
             FROM product_materials pm
             JOIN materials m ON m.id = pm.material_id
            WHERE pm.product_id = $1
            ORDER BY pm.sort_order, pm.id""",
        product["id"],
    )
    sections = await db.fetch(
        "SELECT * FROM product_sections WHERE product_id = $1 ORDER BY sort_order, id",
        product["id"],
    )

    # ⚠️ Дерево собирает ТА ЖЕ функция, что у владельца продукта. Своей копии
    # быть не должно: в проекте уже три реализации дерева, четвёртая разошлась
    # бы с ними порядком узлов.
    from app.api.products import _build_tree

    items = [dict(r) for r in rows]
    return {
        "product": product,
        "items": items,
        "sections": [dict(s) for s in sections],
        "tree": _build_tree(sections, items),
    }


@router.get("/{module}/{link_id}", summary="Материал модуля: содержимое")
async def get_module_material(
    module: str,
    link_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Один материал с блоками.

    ⚠️ Адресуемся по `link_id` (строка `product_materials`), а не по
    `material_id`: материал живёт в общей библиотеке кабинета и может быть
    подключён к нескольким продуктам. По `material_id` открылось бы и то, что
    к этому модулю не подключали.
    """
    viewer_id = int(user["sub"])
    product = await _resolve(db, viewer_id, module)

    row = await db.fetchrow(
        """SELECT pm.id AS link_id, pm.sort_order, pm.section_id,
                  m.id AS material_id,
                  COALESCE(NULLIF(pm.title_override, ''), m.title) AS title,
                  m.description
             FROM product_materials pm
             JOIN materials m ON m.id = pm.material_id
            WHERE pm.product_id = $1 AND pm.id = $2""",
        product["id"], link_id,
    )
    if not row:
        raise HTTPException(404, "Материал не найден")

    blocks = await db.fetch(
        """SELECT id, kind, title, body, url, size_bytes, duration_sec, sort_order
             FROM material_blocks WHERE material_id = $1
            ORDER BY sort_order, id""",
        row["material_id"],
    )

    # Соседи для кнопок «назад / дальше» — в том же порядке, что в оглавлении.
    nav = await db.fetch(
        """SELECT pm.id AS link_id,
                  COALESCE(NULLIF(pm.title_override, ''), m.title) AS title
             FROM product_materials pm
             JOIN materials m ON m.id = pm.material_id
            WHERE pm.product_id = $1
            ORDER BY pm.sort_order, pm.id""",
        product["id"],
    )
    order = [dict(n) for n in nav]
    pos = next((i for i, n in enumerate(order) if n["link_id"] == link_id), None)

    return {
        "product": product,
        "material": {**dict(row), "blocks": [dict(b) for b in blocks]},
        "prev": order[pos - 1] if pos not in (None, 0) else None,
        "next": order[pos + 1] if pos is not None and pos + 1 < len(order) else None,
    }
