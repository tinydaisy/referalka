"""
Продукты/услуги вне событий — CRUD продуктов, тарифов, библиотеки материалов
и состава продукта.

Зачем: клиент продаёт то, что не является событием — программа наставничества,
мастер-класс, консультация, «выступление спикером». У каждого свой лендинг,
свои тарифы, приём оплаты и материалы, которые человек получает после покупки.

⚠️ Библиотека материалов ОБЩАЯ на кабинет. Материал живёт в одном месте и
подключается в несколько продуктов — правка расходится везде. Копирование
(«Взять копией») — осознанное действие клиента, а не механизм по умолчанию:
из разошедшихся копий обратно один материал уже не собрать.

⚠️ Название и порядок материала живут в СВЯЗКЕ (product_materials), не в самом
материале: один и тот же материал в разных продуктах называется по-разному и
стоит на разных местах.

API (JWT владельца кабинета; ассистенту write — 403):
  GET/POST         /api/v1/products
  GET/PATCH/DELETE /api/v1/products/{product_id}
  GET/POST         /api/v1/products/{product_id}/tariffs
  PATCH/DELETE     /api/v1/products/{product_id}/tariffs/{tariff_id}
  GET/POST         /api/v1/products/{product_id}/materials      ← состав
  PATCH/DELETE     /api/v1/products/{product_id}/materials/{link_id}
  POST             /api/v1/products/{product_id}/materials/reorder
  GET/POST         /api/v1/materials                            ← библиотека
  GET/PATCH/DELETE /api/v1/materials/{material_id}
  POST             /api/v1/materials/{material_id}/copy

Гейт — фича `products` (сейчас только у тарифа admin, миграция 290).
"""
import json
import re
import secrets
from typing import Optional, List

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.auth import get_current_client
from app.services.features import client_has_feature
from app.services.assistant_access import assistant_is_restricted

router = APIRouter(tags=["Продукты/услуги"])

# Алфавит без визуально похожих символов (0/o, 1/l/i) — как у slug событий.
_SLUG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"
_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$")

WORDING_PRESETS = ("consulting", "education")
MATERIAL_KINDS = ("video", "file", "link", "text")


# ── Доступ ────────────────────────────────────────────────────────────────

async def _assert_feature(db, client_id: int):
    """Раздел доступен только при включённой фиче `products`.

    Гейтим по фиче, а не по slug тарифа: перенос в продаваемый тариф — строка
    в tariff_features, без правок кода.
    """
    if not await client_has_feature(db, client_id, "products"):
        raise HTTPException(
            status_code=403,
            detail="Раздел «Продукты/услуги» недоступен на вашем тарифе.",
        )


async def _assert_can_write(user: dict):
    """Ассистенту с ограниченными правами запись запрещена."""
    if await assistant_is_restricted(user):
        raise HTTPException(
            status_code=403,
            detail="Ассистенту недоступно редактирование продуктов.",
        )


async def _get_product(db, client_id: int, product_id: int) -> asyncpg.Record:
    row = await db.fetchrow(
        "SELECT * FROM products WHERE id = $1 AND client_id = $2",
        product_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Продукт не найден")
    return row


async def _get_material(db, client_id: int, material_id: int) -> asyncpg.Record:
    row = await db.fetchrow(
        "SELECT * FROM materials WHERE id = $1 AND client_id = $2",
        material_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Материал не найден")
    return row


# ── Slug ──────────────────────────────────────────────────────────────────

async def _unique_slug(db, client_id: int) -> str:
    """Короткий случайный адрес, уникальный в пределах кабинета."""
    for _ in range(20):
        code = "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(5))
        exists = await db.fetchval(
            "SELECT 1 FROM products WHERE client_id = $1 AND slug = $2",
            client_id, code,
        )
        if not exists:
            return code
    raise HTTPException(status_code=500, detail="Не удалось подобрать адрес")


def _validate_slug(slug: str) -> str:
    s = (slug or "").strip().lower()
    if not (3 <= len(s) <= 60) or not _SLUG_RE.match(s):
        raise HTTPException(
            status_code=400,
            detail="Адрес: латиница, цифры и дефис, от 3 до 60 символов.",
        )
    return s


# ── Модели ────────────────────────────────────────────────────────────────

class ProductIn(BaseModel):
    title: str
    subtitle: Optional[str] = None
    description: Optional[str] = None


class ProductPatch(BaseModel):
    slug: Optional[str] = None
    title: Optional[str] = None
    subtitle: Optional[str] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    offer_url: Optional[str] = None
    status: Optional[str] = None
    wording_preset: Optional[str] = None
    wording: Optional[dict] = None
    sort_order: Optional[int] = None


class TariffIn(BaseModel):
    code: str
    title: str
    description: Optional[str] = None
    excluded_description: Optional[str] = None
    price: Optional[int] = None
    pay_url: Optional[str] = None
    # Код товара нужен только LeadPay — у Продамуса и Т-Банка его нет.
    pay_product_id: Optional[str] = None
    order_hint: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True
    is_featured: bool = False


class TariffPatch(BaseModel):
    code: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    excluded_description: Optional[str] = None
    price: Optional[int] = None
    pay_url: Optional[str] = None
    pay_product_id: Optional[str] = None
    order_hint: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None
    is_featured: Optional[bool] = None


class MaterialIn(BaseModel):
    kind: str = "file"
    title: str
    description: Optional[str] = None
    url: Optional[str] = None
    body: Optional[str] = None
    duration_sec: Optional[int] = None
    size_bytes: Optional[int] = None


class MaterialPatch(BaseModel):
    kind: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    body: Optional[str] = None
    duration_sec: Optional[int] = None
    size_bytes: Optional[int] = None


class AttachIn(BaseModel):
    """Подключение материала в состав продукта.

    material_id — существующий из библиотеки; либо new_* для загрузки на месте.
    copy=True — взять копией: в библиотеке появится независимая запись, правки
    в ней не заденут оригинал.
    """
    material_id: Optional[int] = None
    copy: bool = False
    new_material: Optional[MaterialIn] = None
    title_override: Optional[str] = None
    min_tariff_id: Optional[int] = None
    show_on_landing: bool = True


class AttachPatch(BaseModel):
    title_override: Optional[str] = None
    min_tariff_id: Optional[int] = None
    show_on_landing: Optional[bool] = None
    sort_order: Optional[int] = None


class ReorderIn(BaseModel):
    ids: List[int]


# ══ Продукты ══════════════════════════════════════════════════════════════

@router.get("/products", summary="Список продуктов кабинета")
async def list_products(
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    rows = await db.fetch(
        """
        SELECT p.*,
               (SELECT COUNT(*) FROM product_tariffs t
                 WHERE t.product_id = p.id AND t.is_active) AS tariffs_count,
               (SELECT COUNT(*) FROM product_materials pm
                 WHERE pm.product_id = p.id)                AS materials_count,
               (SELECT COUNT(*) FROM product_access pa
                 WHERE pa.product_id = p.id)                AS buyers_count
          FROM products p
         WHERE p.client_id = $1
         ORDER BY p.sort_order, p.id DESC
        """,
        client_id,
    )
    return {"products": [dict(r) for r in rows]}


@router.post("/products", summary="Создать продукт")
async def create_product(
    data: ProductIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)

    title = (data.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Укажите название продукта")

    slug = await _unique_slug(db, client_id)
    row = await db.fetchrow(
        """
        INSERT INTO products (client_id, slug, title, subtitle, description)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        """,
        client_id, slug, title, data.subtitle, data.description,
    )
    return dict(row)


@router.get("/products/{product_id}", summary="Карточка продукта")
async def get_product(
    product_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    row = await _get_product(db, client_id, product_id)
    return dict(row)


@router.patch("/products/{product_id}", summary="Изменить продукт")
async def update_product(
    product_id: int,
    data: ProductPatch,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    fs = data.model_fields_set
    sets, args = [], []

    def put(col: str, val):
        args.append(val)
        sets.append(f"{col} = ${len(args)}")

    if "slug" in fs:
        slug = _validate_slug(data.slug or "")
        busy = await db.fetchval(
            "SELECT 1 FROM products WHERE client_id = $1 AND slug = $2 AND id <> $3",
            client_id, slug, product_id,
        )
        if busy:
            raise HTTPException(status_code=409, detail="Такой адрес уже занят")
        put("slug", slug)

    # ⚠️ model_fields_set, а не `is not None`: иначе нельзя очистить поле
    # (обложку, оферту, подзаголовок) — тот же паттерн, что в профиле клиента.
    for col in ("title", "subtitle", "description", "cover_url",
                "offer_url", "sort_order"):
        if col in fs:
            put(col, getattr(data, col))

    if "status" in fs:
        if data.status not in ("draft", "published", "archived"):
            raise HTTPException(status_code=400, detail="Неизвестный статус")
        # ⚠️ Оферта обязательна перед публикацией: продажа без неё создаёт
        # клиенту проблему, о которой он вспомнит поздно.
        if data.status == "published":
            cur = await _get_product(db, client_id, product_id)
            offer = data.offer_url if "offer_url" in fs else cur["offer_url"]
            if not (offer or "").strip():
                raise HTTPException(
                    status_code=400,
                    detail="Добавьте ссылку на оферту — без неё продукт нельзя опубликовать.",
                )
        put("status", data.status)

    if "wording_preset" in fs:
        if data.wording_preset not in WORDING_PRESETS:
            raise HTTPException(status_code=400, detail="Неизвестный набор формулировок")
        put("wording_preset", data.wording_preset)

    if "wording" in fs:
        put("wording", json.dumps(data.wording or {}, ensure_ascii=False))

    if not sets:
        return dict(await _get_product(db, client_id, product_id))

    args.append(product_id)
    row = await db.fetchrow(
        f"UPDATE products SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    return dict(row)


@router.delete("/products/{product_id}", summary="Удалить продукт")
async def delete_product(
    product_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    # ⚠️ У продукта с покупателями удаление отбираем: люди потеряют доступ к
    # оплаченному. Архив прячет продукт, не трогая доступы.
    buyers = await db.fetchval(
        "SELECT COUNT(*) FROM product_access WHERE product_id = $1", product_id
    )
    if buyers:
        raise HTTPException(
            status_code=409,
            detail=f"У продукта {buyers} покупателей — удалить нельзя. "
                   f"Переведите его в архив.",
        )

    await db.execute("DELETE FROM products WHERE id = $1", product_id)
    return {"ok": True}


# ══ Тарифы продукта ═══════════════════════════════════════════════════════

@router.get("/products/{product_id}/tariffs", summary="Тарифы продукта")
async def list_tariffs(
    product_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _get_product(db, client_id, product_id)

    rows = await db.fetch(
        """
        SELECT t.*,
               (SELECT COUNT(*) FROM product_orders o
                 WHERE o.tariff_id = t.id AND o.status = 'paid') AS paid_count
          FROM product_tariffs t
         WHERE t.product_id = $1
         ORDER BY t.sort_order, t.id
        """,
        product_id,
    )
    return {"tariffs": [dict(r) for r in rows]}


@router.post("/products/{product_id}/tariffs", summary="Создать тариф")
async def create_tariff(
    product_id: int,
    data: TariffIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    code = (data.code or "").strip().lower()
    if not code:
        raise HTTPException(status_code=400, detail="Укажите код тарифа")

    busy = await db.fetchval(
        "SELECT 1 FROM product_tariffs WHERE product_id = $1 AND code = $2",
        product_id, code,
    )
    if busy:
        raise HTTPException(status_code=409, detail="Тариф с таким кодом уже есть")

    row = await db.fetchrow(
        """
        INSERT INTO product_tariffs
            (product_id, code, title, description, excluded_description,
             price, pay_url, pay_product_id, order_hint,
             sort_order, is_active, is_featured)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *
        """,
        product_id, code, data.title, data.description, data.excluded_description,
        data.price, data.pay_url, data.pay_product_id, data.order_hint,
        data.sort_order, data.is_active, data.is_featured,
    )
    return dict(row)


@router.patch("/products/{product_id}/tariffs/{tariff_id}", summary="Изменить тариф")
async def update_tariff(
    product_id: int,
    tariff_id: int,
    data: TariffPatch,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    cur = await db.fetchrow(
        "SELECT * FROM product_tariffs WHERE id = $1 AND product_id = $2",
        tariff_id, product_id,
    )
    if not cur:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    fs = data.model_fields_set
    sets, args = [], []

    def put(col: str, val):
        args.append(val)
        sets.append(f"{col} = ${len(args)}")

    if "code" in fs:
        code = (data.code or "").strip().lower()
        if not code:
            raise HTTPException(status_code=400, detail="Код тарифа не может быть пустым")
        busy = await db.fetchval(
            "SELECT 1 FROM product_tariffs WHERE product_id = $1 AND code = $2 AND id <> $3",
            product_id, code, tariff_id,
        )
        if busy:
            raise HTTPException(status_code=409, detail="Тариф с таким кодом уже есть")
        put("code", code)

    for col in ("title", "description", "excluded_description", "price",
                "pay_url", "pay_product_id", "order_hint", "sort_order",
                "is_active", "is_featured"):
        if col in fs:
            put(col, getattr(data, col))

    if not sets:
        return dict(cur)

    args.append(tariff_id)
    row = await db.fetchrow(
        f"UPDATE product_tariffs SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    return dict(row)


@router.delete("/products/{product_id}/tariffs/{tariff_id}", summary="Удалить тариф")
async def delete_tariff(
    product_id: int,
    tariff_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    paid = await db.fetchval(
        "SELECT COUNT(*) FROM product_orders WHERE tariff_id = $1 AND status = 'paid'",
        tariff_id,
    )
    if paid:
        raise HTTPException(
            status_code=409,
            detail=f"По тарифу {paid} оплат — удалить нельзя. Выключите его.",
        )

    await db.execute(
        "DELETE FROM product_tariffs WHERE id = $1 AND product_id = $2",
        tariff_id, product_id,
    )
    return {"ok": True}


# ══ Покупатели и заказы ═══════════════════════════════════════════════════

@router.get("/products/{product_id}/buyers", summary="Кому открыт доступ")
async def list_buyers(
    product_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _get_product(db, client_id, product_id)

    rows = await db.fetch(
        """
        SELECT pa.id, pa.granted_at, pa.source, pa.order_id,
               c.id AS contact_id, c.name, c.phone,
               (SELECT pe.platform_user_id FROM platform_users pe
                 WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                 ORDER BY pe.id LIMIT 1) AS email,
               t.id AS tariff_id, t.title AS tariff_title,
               o.status AS order_status, o.amount
          FROM product_access pa
          JOIN contacts c            ON c.id = pa.contact_id
     LEFT JOIN product_tariffs t     ON t.id = pa.tariff_id
     LEFT JOIN product_orders o      ON o.id = pa.order_id
         WHERE pa.product_id = $1
         ORDER BY pa.granted_at DESC
        """,
        product_id,
    )
    return {"buyers": [dict(r) for r in rows]}


@router.get("/products/{product_id}/orders", summary="Заказы продукта")
async def list_orders(
    product_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _get_product(db, client_id, product_id)

    rows = await db.fetch(
        """
        SELECT o.*, t.title AS tariff_title, c.name AS contact_name,
               (SELECT pe.platform_user_id FROM platform_users pe
                 WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                 ORDER BY pe.id LIMIT 1) AS email
          FROM product_orders o
          JOIN product_tariffs t ON t.id = o.tariff_id
     LEFT JOIN contacts c        ON c.id = o.contact_id
         WHERE o.product_id = $1
         ORDER BY (o.status = 'unpaid') DESC, o.id DESC
        """,
        product_id,
    )
    return {"orders": [dict(r) for r in rows]}


class GrantIn(BaseModel):
    contact_id: int
    tariff_id: Optional[int] = None


@router.post("/products/{product_id}/buyers", summary="Выдать доступ вручную")
async def grant_access(
    product_id: int,
    data: GrantIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Доступ без заказа и без денег: подарок, бартер, перенос базы из GetCourse."""
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    ok = await db.fetchval(
        "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
        data.contact_id, client_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    if data.tariff_id:
        t_ok = await db.fetchval(
            "SELECT 1 FROM product_tariffs WHERE id = $1 AND product_id = $2",
            data.tariff_id, product_id,
        )
        if not t_ok:
            raise HTTPException(status_code=400, detail="Тариф не найден в этом продукте")

    row = await db.fetchrow(
        """
        INSERT INTO product_access (product_id, contact_id, tariff_id, source)
        VALUES ($1, $2, $3, 'manual')
        ON CONFLICT (product_id, contact_id)
        DO UPDATE SET tariff_id = EXCLUDED.tariff_id
        RETURNING *
        """,
        product_id, data.contact_id, data.tariff_id,
    )
    return dict(row)


@router.delete("/products/{product_id}/buyers/{access_id}", summary="Забрать доступ")
async def revoke_access(
    product_id: int,
    access_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    await db.execute(
        "DELETE FROM product_access WHERE id = $1 AND product_id = $2",
        access_id, product_id,
    )
    return {"ok": True}


# ══ Библиотека материалов ═════════════════════════════════════════════════

@router.get("/materials", summary="Библиотека материалов кабинета")
async def list_materials(
    q: Optional[str] = None,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)

    where = ["m.client_id = $1"]
    args = [client_id]
    if (q or "").strip():
        args.append(f"%{q.strip()}%")
        where.append(f"m.title ILIKE ${len(args)}")

    rows = await db.fetch(
        f"""
        SELECT m.*,
               (SELECT COUNT(*) FROM product_materials pm
                 WHERE pm.material_id = m.id) AS used_count
          FROM materials m
         WHERE {' AND '.join(where)}
         ORDER BY m.id DESC
        """,
        *args,
    )
    return {"materials": [dict(r) for r in rows]}


@router.post("/materials", summary="Добавить материал в библиотеку")
async def create_material(
    data: MaterialIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    return dict(await _insert_material(db, client_id, data))


async def _insert_material(db, client_id: int, data: MaterialIn) -> asyncpg.Record:
    kind = (data.kind or "file").strip()
    if kind not in MATERIAL_KINDS:
        raise HTTPException(status_code=400, detail="Неизвестный тип материала")
    title = (data.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Укажите название материала")
    if kind != "text" and not (data.url or "").strip():
        raise HTTPException(status_code=400, detail="Нужна ссылка или файл")

    return await db.fetchrow(
        """
        INSERT INTO materials
            (client_id, kind, title, description, url, body, duration_sec, size_bytes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        """,
        client_id, kind, title, data.description, data.url, data.body,
        data.duration_sec, data.size_bytes,
    )


@router.get("/materials/{material_id}", summary="Материал + где используется")
async def get_material(
    material_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    row = await _get_material(db, client_id, material_id)

    used = await db.fetch(
        """
        SELECT p.id, p.title
          FROM product_materials pm
          JOIN products p ON p.id = pm.product_id
         WHERE pm.material_id = $1
         ORDER BY p.title
        """,
        material_id,
    )
    return {**dict(row), "used_in": [dict(u) for u in used]}


@router.patch("/materials/{material_id}", summary="Изменить материал")
async def update_material(
    material_id: int,
    data: MaterialPatch,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_material(db, client_id, material_id)

    fs = data.model_fields_set
    sets, args = [], []

    def put(col: str, val):
        args.append(val)
        sets.append(f"{col} = ${len(args)}")

    if "kind" in fs:
        if data.kind not in MATERIAL_KINDS:
            raise HTTPException(status_code=400, detail="Неизвестный тип материала")
        put("kind", data.kind)

    for col in ("title", "description", "url", "body", "duration_sec", "size_bytes"):
        if col in fs:
            put(col, getattr(data, col))

    if not sets:
        return dict(await _get_material(db, client_id, material_id))

    args.append(material_id)
    row = await db.fetchrow(
        f"UPDATE materials SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    return dict(row)


@router.delete("/materials/{material_id}", summary="Удалить материал из библиотеки")
async def delete_material(
    material_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_material(db, client_id, material_id)

    # ⚠️ Используемый материал молча удалять нельзя — у купивших отвалится
    # доступ. Показываем, где он стоит, и просим сначала отвязать.
    used = await db.fetch(
        """
        SELECT p.title FROM product_materials pm
          JOIN products p ON p.id = pm.product_id
         WHERE pm.material_id = $1 ORDER BY p.title
        """,
        material_id,
    )
    if used:
        names = ", ".join(u["title"] for u in used)
        raise HTTPException(
            status_code=409,
            detail=f"Материал используется в: {names}. Сначала уберите его оттуда.",
        )

    await db.execute("DELETE FROM materials WHERE id = $1", material_id)
    return {"ok": True}


@router.post("/materials/{material_id}/copy", summary="Сделать независимую копию материала")
async def copy_material(
    material_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Копия для случая, когда материал нужно переписать под другой контекст.

    Осознанное действие: правки копии не задевают оригинал и наоборот.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    src = await _get_material(db, client_id, material_id)

    row = await db.fetchrow(
        """
        INSERT INTO materials
            (client_id, kind, title, description, url, body, duration_sec, size_bytes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        """,
        client_id, src["kind"], f"{src['title']} (копия)", src["description"],
        src["url"], src["body"], src["duration_sec"], src["size_bytes"],
    )
    return dict(row)


# ══ Состав продукта ═══════════════════════════════════════════════════════

@router.get("/products/{product_id}/materials", summary="Состав продукта")
async def list_product_materials(
    product_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _get_product(db, client_id, product_id)

    rows = await db.fetch(
        """
        SELECT pm.id AS link_id, pm.sort_order, pm.title_override,
               pm.min_tariff_id, pm.show_on_landing,
               m.id AS material_id, m.kind, m.title, m.description,
               m.url, m.body, m.duration_sec, m.size_bytes,
               -- Сколько ДРУГИХ продуктов использует этот материал: чтобы никто
               -- не правил общее, думая, что правит своё.
               (SELECT COUNT(*) FROM product_materials x
                 WHERE x.material_id = m.id AND x.product_id <> $1) AS used_elsewhere
          FROM product_materials pm
          JOIN materials m ON m.id = pm.material_id
         WHERE pm.product_id = $1
         ORDER BY pm.sort_order, pm.id
        """,
        product_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/products/{product_id}/materials", summary="Добавить материал в продукт")
async def attach_material(
    product_id: int,
    data: AttachIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Три пути добавления:

    1. `new_material`    — загрузить новый (молча попадёт в библиотеку);
    2. `material_id`     — подключить существующий: правки расходятся везде;
    3. `material_id` + `copy=true` — взять копией: независимая запись.
    """
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    async with db.transaction():
        if data.new_material is not None:
            mat = await _insert_material(db, client_id, data.new_material)
            material_id = mat["id"]
        elif data.material_id:
            src = await _get_material(db, client_id, data.material_id)
            if data.copy:
                mat = await db.fetchrow(
                    """
                    INSERT INTO materials
                        (client_id, kind, title, description, url, body,
                         duration_sec, size_bytes)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    RETURNING *
                    """,
                    client_id, src["kind"], f"{src['title']} (копия)",
                    src["description"], src["url"], src["body"],
                    src["duration_sec"], src["size_bytes"],
                )
                material_id = mat["id"]
            else:
                material_id = src["id"]
        else:
            raise HTTPException(
                status_code=400,
                detail="Укажите материал из библиотеки или данные нового",
            )

        if data.min_tariff_id:
            ok = await db.fetchval(
                "SELECT 1 FROM product_tariffs WHERE id = $1 AND product_id = $2",
                data.min_tariff_id, product_id,
            )
            if not ok:
                raise HTTPException(status_code=400, detail="Тариф не найден в этом продукте")

        nxt = await db.fetchval(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM product_materials WHERE product_id = $1",
            product_id,
        )

        try:
            link = await db.fetchrow(
                """
                INSERT INTO product_materials
                    (product_id, material_id, title_override, sort_order,
                     min_tariff_id, show_on_landing)
                VALUES ($1,$2,$3,$4,$5,$6)
                RETURNING *
                """,
                product_id, material_id, data.title_override, nxt,
                data.min_tariff_id, data.show_on_landing,
            )
        except asyncpg.UniqueViolationError:
            raise HTTPException(
                status_code=409,
                detail="Этот материал уже есть в продукте. "
                       "Чтобы добавить его второй раз — возьмите копией.",
            )

    return dict(link)


@router.patch("/products/{product_id}/materials/{link_id}", summary="Настройки материала в продукте")
async def update_product_material(
    product_id: int,
    link_id: int,
    data: AttachPatch,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    cur = await db.fetchrow(
        "SELECT * FROM product_materials WHERE id = $1 AND product_id = $2",
        link_id, product_id,
    )
    if not cur:
        raise HTTPException(status_code=404, detail="Материал не найден в продукте")

    fs = data.model_fields_set
    sets, args = [], []

    def put(col: str, val):
        args.append(val)
        sets.append(f"{col} = ${len(args)}")

    if "min_tariff_id" in fs and data.min_tariff_id:
        ok = await db.fetchval(
            "SELECT 1 FROM product_tariffs WHERE id = $1 AND product_id = $2",
            data.min_tariff_id, product_id,
        )
        if not ok:
            raise HTTPException(status_code=400, detail="Тариф не найден в этом продукте")

    # ⚠️ model_fields_set: `title_override = null` и `min_tariff_id = null` —
    # осмысленные значения (вернуть исходное название / открыть на всех тарифах).
    for col in ("title_override", "min_tariff_id", "show_on_landing", "sort_order"):
        if col in fs:
            put(col, getattr(data, col))

    if not sets:
        return dict(cur)

    args.append(link_id)
    row = await db.fetchrow(
        f"UPDATE product_materials SET {', '.join(sets)} WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    return dict(row)


@router.post("/products/{product_id}/materials/reorder", summary="Порядок материалов")
async def reorder_product_materials(
    product_id: int,
    data: ReorderIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    async with db.transaction():
        for i, link_id in enumerate(data.ids):
            await db.execute(
                "UPDATE product_materials SET sort_order = $1 "
                "WHERE id = $2 AND product_id = $3",
                i, link_id, product_id,
            )
    return {"ok": True}


@router.delete("/products/{product_id}/materials/{link_id}", summary="Убрать материал из продукта")
async def detach_material(
    product_id: int,
    link_id: int,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Убирает материал ИЗ ПРОДУКТА. Сам материал остаётся в библиотеке —
    он может использоваться в других продуктах."""
    client_id = int(user["sub"])
    await _assert_feature(db, client_id)
    await _assert_can_write(user)
    await _get_product(db, client_id, product_id)

    await db.execute(
        "DELETE FROM product_materials WHERE id = $1 AND product_id = $2",
        link_id, product_id,
    )
    return {"ok": True}
