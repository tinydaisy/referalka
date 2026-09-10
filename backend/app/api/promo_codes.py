"""
Промокоды клиента — ведение (миграция 397).

Публичная проверка кода покупателем живёт НЕ здесь, а в самих формах заказа
(event_orders / product_orders): там уже известны тариф, цена и контакт, и
второй эндпоинт «проверь код» отдал бы наружу лишнее — по нему можно было бы
перебирать чужие коды.

⚠️ Расчёт и правила — только в services/promo_codes.py. Здесь CRUD и списки.
"""
from datetime import datetime
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.auth import get_current_client
from app.database import get_db
from app.services import promo_codes as svc
from app.services.assistant_access import assistant_is_restricted

router = APIRouter(prefix="/promo-codes", tags=["Промокоды"])

# Сколько кодов разрешаем создать за один раз. Больше — это уже не «раздать
# участникам», а выгрузка, и такой запрос надолго занимает соединение с БД.
MAX_BATCH = 500


class PromoCreate(BaseModel):
    code: Optional[str] = None            # пусто → генерируем (для пачки)
    discount_kind: str = Field(pattern="^(percent|amount)$")
    discount_value: int = Field(gt=0)

    scope_event_id: Optional[int] = None
    scope_product_id: Optional[int] = None
    scope_tariff_id: Optional[int] = None
    scope_tariff_kind: Optional[str] = None
    plusson_subscription: bool = False
    scope_plan_slug: Optional[str] = None

    recipient_contact_id: Optional[int] = None

    max_uses: Optional[int] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    comment: Optional[str] = None

    # Пакетное создание: сколько кодов и с каким префиксом.
    batch_count: Optional[int] = None
    batch_prefix: Optional[str] = None
    batch_title: Optional[str] = None
    # Готовый список кодов (по строке) — альтернатива генерации.
    codes: Optional[list[str]] = None


class PromoUpdate(BaseModel):
    discount_kind: Optional[str] = Field(default=None, pattern="^(percent|amount)$")
    discount_value: Optional[int] = Field(default=None, gt=0)
    max_uses: Optional[int] = None
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    is_active: Optional[bool] = None
    comment: Optional[str] = None


async def _assert_owner(db, client_id: int, promo_id: int) -> asyncpg.Record:
    row = await db.fetchrow(
        "SELECT * FROM promo_codes WHERE id = $1 AND client_id = $2",
        promo_id, client_id)
    if not row:
        raise HTTPException(404, "Промокод не найден")
    return row


async def _assert_scope_owned(db, client_id: int, data: PromoCreate) -> None:
    """Событие, продукт и тариф — только свои.

    ⚠️ Номера приходят из браузера: без проверки можно завести себе промокод
    на ЧУЖОЕ событие и раздать скидку за счёт другого клиента.
    """
    if data.scope_event_id:
        ok = await db.fetchval(
            """SELECT 1 FROM event_owners
                WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
            data.scope_event_id, client_id)
        if not ok:
            raise HTTPException(403, "Это событие не ваше")

    if data.scope_product_id:
        ok = await db.fetchval(
            "SELECT 1 FROM products WHERE id = $1 AND client_id = $2",
            data.scope_product_id, client_id)
        if not ok:
            raise HTTPException(403, "Этот продукт не ваш")

    if data.scope_tariff_id:
        if data.scope_tariff_kind == "event":
            ok = await db.fetchval(
                """SELECT 1 FROM event_tariffs t
                     JOIN event_owners eo ON eo.event_id = t.event_id
                                         AND eo.status = 'accepted'
                    WHERE t.id = $1 AND eo.client_id = $2""",
                data.scope_tariff_id, client_id)
        elif data.scope_tariff_kind == "product":
            ok = await db.fetchval(
                """SELECT 1 FROM product_tariffs t
                     JOIN products p ON p.id = t.product_id
                    WHERE t.id = $1 AND p.client_id = $2""",
                data.scope_tariff_id, client_id)
        else:
            raise HTTPException(400, "Не указано, тариф события это или продукта")
        if not ok:
            raise HTTPException(403, "Этот тариф не ваш")

    if data.recipient_contact_id:
        ok = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
            data.recipient_contact_id, client_id)
        if not ok:
            raise HTTPException(403, "Этот человек не из вашей базы")


@router.get("", summary="Список промокодов")
async def list_promo_codes(
    event_id: Optional[int] = Query(None, description="Только коды этого события"),
    product_id: Optional[int] = Query(None, description="Только коды этого продукта"),
    archived: bool = Query(False, description="Показать истёкшие и исчерпанные"),
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список кодов клиента.

    ⚠️ По умолчанию отдаём ТОЛЬКО действующие: истёкшие копятся годами, и
    сплошной список превращается в свалку, где не видно живых кодов.
    Исчерпанные и просроченные приходят по `archived=true`.
    """
    # ⚠️ КАЖДОЙ колонке — префикс таблицы `p.`: ниже идут JOIN на products и
    # contacts, а `client_id` есть и у них. Без префикса Postgres отвечает
    # «column reference "client_id" is ambiguous», и страница падает целиком.
    where = ["p.client_id = $1"]
    args: list = [int(client["sub"])]

    if event_id:
        args.append(event_id)
        where.append(f"p.scope_event_id = ${len(args)}")
    if product_id:
        args.append(product_id)
        where.append(f"p.scope_product_id = ${len(args)}")

    alive = ("p.is_active AND (p.ends_at IS NULL OR p.ends_at > NOW()) "
             "AND (p.max_uses IS NULL OR p.used_count < p.max_uses)")
    where.append(alive if not archived else f"NOT ({alive})")

    rows = await db.fetch(
        f"""SELECT p.*,
                   e.title  AS event_title,
                   pr.title AS product_title,
                   c.name   AS recipient_name
              FROM promo_codes p
              LEFT JOIN events   e  ON e.id  = p.scope_event_id
              LEFT JOIN products pr ON pr.id = p.scope_product_id
              LEFT JOIN contacts c  ON c.id  = p.recipient_contact_id
             WHERE {' AND '.join(where)}
             ORDER BY p.batch_id NULLS FIRST, p.id DESC""",
        *args,
    )

    # ⚠️ Пачку именных кодов сворачиваем в ОДНУ строку: 200 строк ZHIVU-A7K2
    # погребли бы под собой три обычных промокода — это и есть «помойка»,
    # от которой владелец отдельно предостерегала.
    singles: list[dict] = []
    batches: dict[str, dict] = {}
    for r in rows:
        d = dict(r)
        bid = d.get("batch_id")
        if not bid:
            singles.append(d)
            continue
        b = batches.setdefault(bid, {
            "batch_id": bid,
            "batch_title": d.get("batch_title"),
            "discount_kind": d["discount_kind"],
            "discount_value": d["discount_value"],
            "event_title": d.get("event_title"),
            "product_title": d.get("product_title"),
            "ends_at": d.get("ends_at"),
            "total": 0, "used": 0, "codes": [],
        })
        b["total"] += 1
        b["used"] += 1 if (d["used_count"] or 0) > 0 else 0
        b["codes"].append(d)

    return {"promo_codes": singles, "batches": list(batches.values())}


@router.post("", summary="Создать промокод или пачку")
async def create_promo_codes(
    data: PromoCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Один код, список готовых кодов или сгенерированная пачка."""
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Промокоды доступны только владельцу кабинета")

    await _assert_scope_owned(db, int(client["sub"]), data)

    # ⚠️ Именной код бессмыслен пачкой без списка получателей: у всех кодов
    # оказался бы один владелец, и 199 из 200 не сработали бы ни у кого.
    if data.recipient_contact_id and (data.batch_count or 0) > 1:
        raise HTTPException(
            400, "Именной код выдаётся одному человеку — пачкой его не создать")

    wanted: list[str] = []
    if data.codes:
        wanted = [c.strip() for c in data.codes if c and c.strip()]
    elif data.batch_count:
        if data.batch_count > MAX_BATCH:
            raise HTTPException(400, f"За один раз можно создать не больше {MAX_BATCH} кодов")
        wanted = []  # сгенерируем ниже
    elif data.code:
        wanted = [data.code.strip()]
    else:
        raise HTTPException(400, "Укажите промокод")

    for c in wanted:
        if not svc.is_valid_code(c):
            raise HTTPException(400, f"Промокод «{c}» содержит недопустимые символы")

    batch_id = None
    if data.batch_count or (data.codes and len(data.codes) > 1):
        import secrets
        batch_id = secrets.token_hex(8)

    created: list[dict] = []
    async with db.transaction():
        count = data.batch_count or len(wanted)
        for i in range(count):
            # Генерация — с повтором при коллизии: код случайный, и раз в
            # сколько-то тысяч он совпадёт с уже существующим.
            for _attempt in range(10):
                code = wanted[i] if i < len(wanted) else svc.generate_code(
                    data.batch_prefix or "")
                try:
                    row = await db.fetchrow(
                        """INSERT INTO promo_codes
                               (client_id, code, code_norm, discount_kind, discount_value,
                                scope_event_id, scope_product_id, scope_tariff_id,
                                scope_tariff_kind, plusson_subscription, scope_plan_slug,
                                recipient_contact_id, max_uses, starts_at, ends_at,
                                comment, batch_id, batch_title)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                           RETURNING *""",
                        int(client["sub"]), code, svc.normalize_code(code),
                        data.discount_kind, data.discount_value,
                        data.scope_event_id, data.scope_product_id,
                        data.scope_tariff_id, data.scope_tariff_kind,
                        data.plusson_subscription, data.scope_plan_slug,
                        data.recipient_contact_id, data.max_uses,
                        data.starts_at, data.ends_at, data.comment,
                        batch_id, data.batch_title,
                    )
                    created.append(dict(row))
                    break
                except asyncpg.UniqueViolationError:
                    if i < len(wanted):
                        raise HTTPException(409, f"Промокод «{code}» у вас уже есть")
                    continue  # сгенерированный — пробуем другой
            else:
                raise HTTPException(500, "Не удалось сгенерировать уникальный код")

    return {"ok": True, "created": len(created), "promo_codes": created}


@router.patch("/{promo_id}", summary="Изменить промокод")
async def update_promo_code(
    promo_id: int,
    data: PromoUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Промокоды доступны только владельцу кабинета")
    await _assert_owner(db, int(client["sub"]), promo_id)

    # ⚠️ Сам КОД не меняем: его уже раздали людям, и переименование сделало бы
    # выданные коды нерабочими молча. Нужен другой код — создаётся новый.
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        return {"ok": True}

    sets, args = [], []
    for k, v in fields.items():
        args.append(v)
        sets.append(f"{k} = ${len(args)}")
    args.append(promo_id)

    row = await db.fetchrow(
        f"UPDATE promo_codes SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING *", *args)
    return {"ok": True, "promo_code": dict(row)}


@router.delete("/{promo_id}", summary="Удалить промокод")
async def delete_promo_code(
    promo_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Применения (`promo_code_uses`) уходят каскадом, но в самих ЗАКАЗАХ
    остаётся `promo_code` строкой — иначе в отчёте была бы скидка без
    объяснения, откуда она взялась."""
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Промокоды доступны только владельцу кабинета")
    await _assert_owner(db, int(client["sub"]), promo_id)
    await db.execute("DELETE FROM promo_codes WHERE id = $1", promo_id)
    return {"ok": True}


@router.delete("/batch/{batch_id}", summary="Удалить пачку кодов")
async def delete_batch(
    batch_id: str,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Промокоды доступны только владельцу кабинета")
    rows = await db.fetch(
        "DELETE FROM promo_codes WHERE batch_id = $1 AND client_id = $2 RETURNING id",
        batch_id, int(client["sub"]))
    return {"ok": True, "deleted": len(rows)}


@router.get("/{promo_id}/uses", summary="Кто применил промокод")
async def promo_uses(
    promo_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Главный вопрос по именным кодам: воспользовался ли человек.
    Без этого списка именной код теряет смысл."""
    await _assert_owner(db, int(client["sub"]), promo_id)
    rows = await db.fetch(
        """SELECT u.*, c.name AS contact_name
             FROM promo_code_uses u
             LEFT JOIN contacts c ON c.id = u.contact_id
            WHERE u.promo_code_id = $1 AND u.status <> 'released'
            ORDER BY u.id DESC""",
        promo_id)
    return {"uses": [dict(r) for r in rows]}
