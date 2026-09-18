"""
Персональные заказы: произвольная услуга, произвольная цена.

⚠️⚠️ ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ЗАКАЗА ПРОДУКТА. У продукта цена задана карточкой
тарифа: сколько написано, столько и платят. Здесь объём работы заранее
НЕИЗВЕСТЕН — человек пишет «нужна личная настройка», мы созваниваемся, и только
после разговора понятно, домен это подключить или вебинар вести месяц. Поэтому
перечень работ и сумма живут в самом заказе, а прайс — только подсказка.

⚠️ РЕКВИЗИТЫ НАШИ, ПЛЮСОНА. Услугу оказывает компания; техспецу потом
начисляется его доля по ставкам. Значит платёжка берётся из переменных
окружения (services/leadpay.py), а не из карточки клиента, как у событий.

⚠️ ПРЕФИКС В ПЛАТЁЖКЕ — `ord-`, рядом с evt- / prd- / svc- / addon-. У нас свой
адрес вебхука (`/integrations/leadpay/custom-order-webhook`), как у автонастройки,
поэтому в чужие обработчики лезть не нужно.
"""
import json
import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from app.auth import get_current_admin, get_current_tech
from app.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/custom-orders", tags=["Персональные заказы"])
tech_router = APIRouter(prefix="/tech/custom-orders", tags=["Персональные заказы"])
public_router = APIRouter(prefix="/api/v1/public/custom-orders", tags=["Персональные заказы"])
price_router = APIRouter(prefix="/admin/service-prices", tags=["Персональные заказы"])
leadpay_webhook_router = APIRouter(prefix="/integrations/leadpay", tags=["Персональные заказы"])
prodamus_webhook_router = APIRouter(prefix="/integrations/prodamus", tags=["Персональные заказы"])

# Статусы, при которых человек ещё может оплатить.
_PAYABLE = ("draft", "sent")


# ─────────────────────────────────────────────────────────────────────────
# Модели
# ─────────────────────────────────────────────────────────────────────────

class OrderIn(BaseModel):
    title: Optional[str] = None
    items: str = ""
    amount: int = 0
    client_name: Optional[str] = None
    client_email: Optional[str] = None
    client_phone: Optional[str] = None
    note: Optional[str] = None
    request_text: Optional[str] = None
    contact_id: Optional[int] = None
    # ⚠️ Чей лид — от этого зависит СТАВКА техспеца: 60 % клиент из базы
    # ПЛЮСОНА, 80 % свой приведённый. По умолчанию 'pluson' — меньшая ставка:
    # ошибка в сторону занижения исправима доплатой, в сторону завышения —
    # только спором с человеком.
    lead_source: str = 'pluson'


class OrderPatch(BaseModel):
    """⚠️ Отдельная модель для правки: model_fields_set показывает, какие поля
    человек ДЕЙСТВИТЕЛЬНО прислал. Общая модель с OrderIn затирала бы
    неприсланные поля значениями по умолчанию."""
    title: Optional[str] = None
    items: Optional[str] = None
    amount: Optional[int] = None
    client_name: Optional[str] = None
    client_email: Optional[str] = None
    client_phone: Optional[str] = None
    note: Optional[str] = None
    status: Optional[str] = None
    is_done: Optional[bool] = None
    lead_source: Optional[str] = None


class PriceIn(BaseModel):
    title: str
    description: Optional[str] = None
    price: int = 0
    sort_order: int = 0
    is_active: bool = True


class PricePatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    price: Optional[int] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


class PayIn(BaseModel):
    """Контакты и согласия со страницы оплаты."""
    name: str
    email: str
    phone: Optional[str] = None
    consent_pd: bool = False
    consent_offer: bool = False
    consent_marketing: bool = False


# ─────────────────────────────────────────────────────────────────────────
# Общее
# ─────────────────────────────────────────────────────────────────────────

_FIELDS = """id, number, title, items, amount, status, contact_id,
             client_name, client_email, client_phone, tech_specialist_id,
             lead_source, payment_url, payment_provider, external_payment_id,
             paid_at, is_done, done_at, note, request_text,
             created_at, updated_at"""


def _order_number(order_id: int) -> str:
    """Номер для человека. Не путать с `ord-<id>`, который уходит в платёжку."""
    return f"PZ-{order_id:06d}"


async def _create(db, data: OrderIn, tech_id: Optional[int]) -> dict:
    row = await db.fetchrow(
        f"""INSERT INTO custom_orders
                (title, items, amount, client_name, client_email, client_phone,
                 note, request_text, contact_id, tech_specialist_id, lead_source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING {_FIELDS}""",
        (data.title or "").strip() or "Персональный заказ",
        (data.items or "").strip(),
        max(0, int(data.amount or 0)),
        data.client_name, data.client_email, data.client_phone,
        data.note, data.request_text, data.contact_id, tech_id,
        data.lead_source if data.lead_source in ("pluson", "own") else "pluson",
    )
    # Номер ставим после вставки: он строится из id, которого до неё нет.
    await db.execute(
        "UPDATE custom_orders SET number=$2 WHERE id=$1",
        row["id"], _order_number(row["id"]),
    )
    out = dict(row)
    out["number"] = _order_number(row["id"])
    return out


async def _patch(db, order_id: int, data: OrderPatch, *, tech_id: Optional[int]) -> dict:
    # ⚠️ `$1` занят order_id, а args идут со второго места — поэтому номер
    # считается как len(args) + 1 УЖЕ ПОСЛЕ append: первое значение получает $2.
    sets, args = [], []

    def add(field: str, value):
        args.append(value)
        sets.append(f"{field} = ${len(args) + 1}")

    fields = data.model_fields_set
    if "title" in fields:
        add("title", (data.title or "").strip() or "Персональный заказ")
    if "items" in fields:
        add("items", (data.items or "").strip())
    if "amount" in fields:
        add("amount", max(0, int(data.amount or 0)))
    if "client_name" in fields:
        add("client_name", data.client_name)
    if "client_email" in fields:
        add("client_email", data.client_email)
    if "client_phone" in fields:
        add("client_phone", data.client_phone)
    if "note" in fields:
        add("note", data.note)
    if "lead_source" in fields and data.lead_source in ("pluson", "own"):
        # ⚠️ Менять можно только ДО оплаты: после неё начисление уже сделано по
        # прежней ставке, и смена источника разошлась бы с выплатой.
        add("lead_source", data.lead_source)
    if "status" in fields and data.status in ("draft", "sent", "cancelled"):
        # ⚠️ `paid` руками не ставим: этот статус приходит только от платёжной
        # системы. Иначе заказ можно «оплатить» кнопкой, и деньги разойдутся
        # с тем, что показывает отчёт.
        add("status", data.status)
    if "is_done" in fields:
        add("is_done", bool(data.is_done))
        args.append(bool(data.is_done))
        sets.append(f"done_at = CASE WHEN ${len(args) + 1} THEN COALESCE(done_at, NOW()) ELSE NULL END")

    if not sets:
        raise HTTPException(400, "Нечего менять")

    where_tech = ""
    if tech_id is not None:
        args.append(tech_id)
        where_tech = f" AND tech_specialist_id = ${len(args) + 1}"

    row = await db.fetchrow(
        f"""UPDATE custom_orders SET {', '.join(sets)}, updated_at = NOW()
             WHERE id = $1{where_tech}
         RETURNING {_FIELDS}""",
        order_id, *args,
    )
    if not row:
        raise HTTPException(404, "Заказ не найден")
    return dict(row)


async def _list(db, *, tech_id: Optional[int], status: Optional[str], limit: int):
    where, args = [], []
    if tech_id is not None:
        args.append(tech_id)
        where.append(f"tech_specialist_id = ${len(args)}")
    if status:
        args.append(status)
        where.append(f"status = ${len(args)}")
    args.append(limit)

    rows = await db.fetch(
        f"""SELECT {_FIELDS} FROM custom_orders
             {'WHERE ' + ' AND '.join(where) if where else ''}
             ORDER BY created_at DESC LIMIT ${len(args)}""",
        *args,
    )
    return [dict(r) for r in rows]


# ─────────────────────────────────────────────────────────────────────────
# Админка
# ─────────────────────────────────────────────────────────────────────────

@router.get("", summary="Список персональных заказов")
async def admin_list(
    status: Optional[str] = Query(None),
    limit: int = Query(200, le=1000),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    return {"orders": await _list(db, tech_id=None, status=status, limit=limit)}


@router.post("", summary="Создать персональный заказ")
async def admin_create(
    data: OrderIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _create(db, data, None)


@router.patch("/{order_id}", summary="Изменить заказ")
async def admin_patch(
    order_id: int,
    data: OrderPatch,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _patch(db, order_id, data, tech_id=None)


@router.delete("/{order_id}", summary="Удалить заказ")
async def admin_delete(
    order_id: int,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # ⚠️ Оплаченный заказ не удаляем: это след денег. Его можно только
    # отметить выполненным или отменить до оплаты.
    row = await db.fetchrow("SELECT status FROM custom_orders WHERE id=$1", order_id)
    if not row:
        raise HTTPException(404, "Заказ не найден")
    if row["status"] == "paid":
        raise HTTPException(400, "Оплаченный заказ удалить нельзя")
    await db.execute("DELETE FROM custom_orders WHERE id=$1", order_id)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────
# Прайс услуг
# ─────────────────────────────────────────────────────────────────────────

@price_router.get("", summary="Прайс услуг")
async def prices_list(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        "SELECT id, title, description, price, sort_order, is_active "
        "  FROM service_price_items ORDER BY sort_order, id"
    )
    return {"items": [dict(r) for r in rows]}


@price_router.post("", summary="Добавить услугу в прайс")
async def prices_create(
    data: PriceIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # ⚠️ `title` уникален (нужно для идемпотентности миграции) — повтор отдаём
    # понятной ошибкой, а не 500: иначе владелец видит «что-то пошло не так» и
    # не понимает, что услуга с таким названием уже в прайсе.
    try:
        row = await db.fetchrow(
            """INSERT INTO service_price_items (title, description, price, sort_order, is_active)
               VALUES ($1, $2, $3, $4, $5)
            RETURNING id, title, description, price, sort_order, is_active""",
            data.title.strip(), data.description, max(0, int(data.price or 0)),
            int(data.sort_order or 0), bool(data.is_active),
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(400, "Услуга с таким названием уже есть в прайсе")
    return dict(row)


@price_router.patch("/{item_id}", summary="Изменить услугу в прайсе")
async def prices_patch(
    item_id: int,
    data: PricePatch,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    sets, args = [], []
    for field in ("title", "description", "price", "sort_order", "is_active"):
        if field in data.model_fields_set:
            args.append(getattr(data, field))
            sets.append(f"{field} = ${len(args) + 1}")
    if not sets:
        raise HTTPException(400, "Нечего менять")
    try:
        row = await db.fetchrow(
            f"""UPDATE service_price_items SET {', '.join(sets)}, updated_at = NOW()
                 WHERE id = $1
             RETURNING id, title, description, price, sort_order, is_active""",
            item_id, *args,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(400, "Услуга с таким названием уже есть в прайсе")
    if not row:
        raise HTTPException(404, "Услуга не найдена")
    return dict(row)


@price_router.delete("/{item_id}", summary="Удалить услугу из прайса")
async def prices_delete(
    item_id: int,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    await db.execute("DELETE FROM service_price_items WHERE id=$1", item_id)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────
# Кабинет техспеца
# ─────────────────────────────────────────────────────────────────────────
#
# ⚠️ Техспец видит ТОЛЬКО свои заказы — фильтр по tech_specialist_id стоит в
# SQL, а не в интерфейсе. Спрятанный пункт меню защитой не является.

@tech_router.get("", summary="Мои персональные заказы")
async def tech_list(
    status: Optional[str] = Query(None),
    limit: int = Query(200, le=1000),
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    return {"orders": await _list(db, tech_id=user["id"], status=status, limit=limit)}


@tech_router.get("/prices", summary="Прайс услуг для сборки заказа")
async def tech_prices(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        "SELECT id, title, description, price FROM service_price_items "
        " WHERE is_active = TRUE ORDER BY sort_order, id"
    )
    return {"items": [dict(r) for r in rows]}


@tech_router.post("", summary="Создать персональный заказ")
async def tech_create(
    data: OrderIn,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _create(db, data, user["id"])


@tech_router.patch("/{order_id}", summary="Изменить свой заказ")
async def tech_patch(
    order_id: int,
    data: OrderPatch,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _patch(db, order_id, data, tech_id=user["id"])


# ─────────────────────────────────────────────────────────────────────────
# Публичная страница заказа
# ─────────────────────────────────────────────────────────────────────────

@public_router.get("/prices/list", summary="Прайс услуг для лендинга")
async def public_prices(db: asyncpg.Connection = Depends(get_db)):
    """⚠️ Путь `/prices/list`, а не `/prices`: иначе он спорит с `/{number}`
    ниже — FastAPI разобрал бы «prices» как номер заказа."""
    rows = await db.fetch(
        "SELECT title, description, price FROM service_price_items "
        " WHERE is_active = TRUE ORDER BY sort_order, id"
    )
    return {"items": [dict(r) for r in rows]}


@public_router.get("/{number}", summary="Данные заказа для страницы оплаты")
async def public_order(number: str, db: asyncpg.Connection = Depends(get_db)):
    """⚠️ Отдаём ТОЛЬКО то, что человек и так должен видеть: что заказано,
    сколько стоит, оплачено ли. Никаких заметок, id техспеца и чужих данных —
    страница открыта по ссылке, без входа."""
    row = await db.fetchrow(
        "SELECT number, title, items, amount, status, paid_at, "
        "       client_name, client_email, client_phone "
        "  FROM custom_orders WHERE number = $1", number.strip().upper(),
    )
    if not row:
        raise HTTPException(404, "Заказ не найден")
    return {
        "number": row["number"],
        "title": row["title"],
        "items": [s.strip() for s in (row["items"] or "").split("\n") if s.strip()],
        "amount": row["amount"],
        "paid": row["status"] == "paid",
        "name": row["client_name"],
        "email": row["client_email"],
        "phone": row["client_phone"],
    }


@public_router.post("/{number}/pay", summary="Получить ссылку на оплату")
async def public_pay(
    number: str,
    data: PayIn,
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    from app.services import leadpay
    from app.services.client_domains import platform_base_url
    from app.services.consents import client_ip, save_consents

    if not data.consent_pd:
        raise HTTPException(400, "Без согласия на обработку персональных данных оформить заказ нельзя")
    if not data.consent_offer:
        raise HTTPException(400, "Нужно принять условия оферты")
    if not (data.email or "").strip():
        # ⚠️ У LeadPay v2 почта обязательна — без неё запрос отвергается без
        # внятного объяснения.
        raise HTTPException(400, "Нужна почта — на неё придёт чек")

    order = await db.fetchrow(
        "SELECT id, number, title, amount, status FROM custom_orders WHERE number=$1",
        number.strip().upper(),
    )
    if not order:
        raise HTTPException(404, "Заказ не найден")
    if order["status"] == "paid":
        return {"ok": True, "paid": True}
    if order["status"] not in _PAYABLE:
        raise HTTPException(400, "Заказ отменён")
    if int(order["amount"] or 0) <= 0:
        raise HTTPException(400, "В заказе не указана сумма")

    # Контакты человека сохраняем в заказ: иначе после оплаты непонятно, с кем
    # мы вообще имели дело.
    await db.execute(
        """UPDATE custom_orders
              SET client_name=$2, client_email=$3, client_phone=$4,
                  status = CASE WHEN status='draft' THEN 'sent' ELSE status END,
                  updated_at=NOW()
            WHERE id=$1""",
        order["id"], data.name.strip(), data.email.strip(),
        (data.phone or "").strip() or None,
    )

    base = platform_base_url().rstrip("/")
    try:
        pay_url = await leadpay.create_payment_link(
            order_id=order["id"],
            product_id=None,                    # v2: название и цена из запроса
            order_id_prefix="ord-",
            title=order["title"] or "Персональный заказ",
            price=order["amount"],
            email=data.email.strip(),
            phone=(data.phone or "").strip() or None,
            fio=data.name.strip(),
            notification_url=f"{base}/api/v1/integrations/leadpay/custom-order-webhook",
            redirect_url_ok=f"{base}/order/{order['number']}?paid=1",
            redirect_url_error=f"{base}/order/{order['number']}?error=1",
        )
    except RuntimeError as e:
        logger.error("custom order %s: платёжка не создалась: %s", order["number"], e)
        raise HTTPException(500, "Оплата временно недоступна")

    await db.execute(
        "UPDATE custom_orders SET payment_url=$2, payment_provider='leadpay', "
        "       updated_at=NOW() WHERE id=$1",
        order["id"], pay_url,
    )

    # Согласия пишем в контакт, если он есть: правило одной точки записи.
    # ⚠️ Ищем по `email_normalized`, а не по `LOWER(email)`: в проекте это
    # принятая форма сравнения (lowercase + trim), и под неё есть индекс.
    # Сравнение через LOWER() индекс не использует и разойдётся с автомерджем.
    #
    # ⚠️ Только в базе СЕРВИСНОГО клиента: контакт живёт внутри чьего-то
    # кабинета, и та же почта есть у десятка организаторов. Без этого условия мы
    # записали бы согласие человеку из чужой базы — он нам его не давал.
    try:
        contact = await db.fetchrow(
            """SELECT c.id FROM contacts c
                 JOIN clients cl ON cl.id = c.client_id
                WHERE c.email_normalized = $1
                  AND c.merged_into IS NULL
                  AND cl.is_system_service = TRUE
                ORDER BY c.id LIMIT 1""",
            data.email.strip().lower(),
        )
        if contact:
            await save_consents(
                db, contact_id=contact["id"],
                consent_pd=True, consent_marketing=bool(data.consent_marketing),
                ip=client_ip(request),
            )
            await db.execute(
                "UPDATE custom_orders SET contact_id=$2 WHERE id=$1 AND contact_id IS NULL",
                order["id"], contact["id"],
            )
    except Exception as e:  # согласия не должны ронять оплату
        logger.warning("custom order %s: согласия не записались: %s", order["number"], e)

    return {"ok": True, "payment_url": pay_url}


# ─────────────────────────────────────────────────────────────────────────
# Вебхуки оплаты
# ─────────────────────────────────────────────────────────────────────────
#
# ⚠️ Свой адрес, как у автонастройки: `/integrations/leadpay/custom-order-webhook`.
# Значит чужие обработчики трогать не нужно, и префикс `ord-` ни с чем не
# сталкивается.

def _parse_order_id(raw: str) -> Optional[int]:
    raw = (raw or "").strip()
    if not raw.startswith("ord-"):
        return None
    tail = raw[4:].split("-")[0]
    return int(tail) if tail.isdigit() else None


async def _accrue_to_tech(db, order: dict) -> None:
    """Начисляет техспецу его долю за выполненную услугу.

    ⚠️⚠️ СТАВКА ЗАВИСИТ ОТ ТОГО, ЧЕЙ ЛИД — это правило из листа «Ставки и KPI»:
    клиент из базы ПЛЮСОНА даёт 60 % (`setup_pluson`), свой приведённый — 80 %
    (`setup_own`). Проценты берём из `tech_rates`, а не из кода: они меняются в
    админке, и зашитое число разошлось бы с таблицей молча.

    ⚠️ Двойное начисление гасит УНИКАЛЬНЫЙ ИНДЕКС в базе (`custom_order_id`), а
    не проверка здесь: вебхук платёжной системы приходит повторно штатно.
    """
    if not order["tech_specialist_id"]:
        return                       # заказ оформил владелец — делить нечего

    kind_rate = "setup_own" if order["lead_source"] == "own" else "setup_pluson"
    rate = await db.fetchrow(
        "SELECT percent, is_active FROM tech_rates WHERE kind=$1", kind_rate,
    )
    if not rate or not rate["is_active"] or not rate["percent"]:
        logger.warning("custom order %s: ставка %s не задана — не начисляем",
                       order["number"], kind_rate)
        return

    amount_kopecks = int(round(int(order["amount"]) * 100 * float(rate["percent"]) / 100))
    if amount_kopecks <= 0:
        return

    try:
        await db.execute(
            """INSERT INTO tech_accruals
                   (spec_id, client_id, kind, amount_kopecks, period,
                    custom_order_id, note)
               VALUES ($1, NULL, 'setup', $2, to_char(NOW(), 'YYYY-MM'), $3, $4)
               ON CONFLICT DO NOTHING""",
            order["tech_specialist_id"], amount_kopecks, order["id"],
            f"Персональный заказ {order['number']} — "
            f"{rate['percent']}% от {order['amount']} ₽ "
            f"({'свой лид' if order['lead_source'] == 'own' else 'лид ПЛЮСОНА'})",
        )
        logger.info("custom order %s: начислено техспецу %s — %s коп.",
                    order["number"], order["tech_specialist_id"], amount_kopecks)
    except Exception as e:
        # Начисление не должно ронять приём оплаты: деньги уже пришли, а
        # начисление восстановимо руками и видно в логах.
        logger.error("custom order %s: начисление не прошло: %s",
                     order["number"], e)


async def _mark_paid(db, order_id: int, *, provider: str,
                     payment_id: str = "", raw: dict | None = None) -> dict:
    """Идемпотентно: повторный вебхук — норма для платёжных систем."""
    order = await db.fetchrow(
        "SELECT id, number, status, amount, tech_specialist_id, lead_source "
        "  FROM custom_orders WHERE id=$1", order_id,
    )
    if not order:
        return {"ok": True, "ignored": "order not found"}
    if order["status"] == "paid":
        return {"ok": True, "already_paid": True}

    await db.execute(
        """UPDATE custom_orders
              SET status='paid', paid_at=NOW(), payment_provider=$2,
                  external_payment_id=$3, updated_at=NOW()
            WHERE id=$1""",
        order_id, provider, payment_id or None,
    )
    logger.info("custom order %s paid via %s (%s ₽)",
                order["number"], provider, order["amount"])

    await _accrue_to_tech(db, order)

    # Уведомляем владельца во все его каналы — заказ оплачен, пора делать.
    # ⚠️ Клиента берём по флагу is_system_service, а не числом: id сервисного
    # кабинета — не константа, на которую можно опираться в коде.
    try:
        from app.services.channels import notify_organizer_all_channels

        service_id = await db.fetchval(
            "SELECT id FROM clients WHERE is_system_service = TRUE ORDER BY id LIMIT 1"
        )
        if service_id:
            who = "техспециалистом" if order["tech_specialist_id"] else "вами"
            await notify_organizer_all_channels(
                client_id=service_id,
                text_html=(f"💰 <b>Персональный заказ оплачен</b>\n"
                           f"{order['number']} — {order['amount']} ₽\n"
                           f"Оформлен {who}."),
                db=db, kind="payments",
            )
    except Exception as e:
        logger.warning("custom order %s: уведомление не ушло: %s", order["number"], e)

    return {"ok": True, "status": "paid"}


@leadpay_webhook_router.post("/custom-order-webhook", summary="Оплата персонального заказа (LeadPay)")
async def leadpay_custom_order_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    from app.services import leadpay

    form = await request.form()
    data = {k: str(v) for k, v in form.items()}
    order_id_raw = (data.get("order_id") or "").strip()
    status = (data.get("status") or "").strip().lower()

    logger.info("LeadPay custom order webhook: order_id=%s status=%s", order_id_raw, status)

    if not leadpay.verify_webhook(data):
        logger.warning("LeadPay custom order webhook: invalid hash (%s)", order_id_raw)
        raise HTTPException(status_code=401, detail="Invalid hash")

    order_id = _parse_order_id(order_id_raw)
    if order_id is None:
        # ⚠️ Чужой префикс — отвечаем «ок, не наше», а не ошибкой: иначе
        # платёжная система будет слать повторы сутки.
        return {"ok": True, "ignored": "not a custom order"}

    if status not in ("success", "ok", "paid", "completed"):
        return {"ok": True, "status": "not paid"}

    return await _mark_paid(
        db, order_id, provider="leadpay",
        payment_id=data.get("card_id") or "", raw=data,
    )


@prodamus_webhook_router.post("/custom-order-webhook", summary="Оплата персонального заказа (Продамус)")
async def prodamus_custom_order_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    from app.api.subscriptions import (
        PRODAMUS_VERIFY_SIGNATURE, _verify_prodamus_signature,
    )

    # ⚠️ Подпись Продамуса считается по СЫРОМУ телу: пересборка формы меняет
    # порядок и экранирование, и подпись не сходится.
    raw_body = await request.body()
    form = await request.form()
    data = {k: str(v) for k, v in form.items()}
    order_id_raw = (data.get("order_num") or data.get("order_id") or "").strip()

    if PRODAMUS_VERIFY_SIGNATURE:
        sign = request.headers.get("Sign") or request.headers.get("sign") or ""
        if not _verify_prodamus_signature(raw_body, sign):
            raise HTTPException(status_code=401, detail="Invalid signature")

    order_id = _parse_order_id(order_id_raw)
    if order_id is None:
        return {"ok": True, "ignored": "not a custom order"}

    if (data.get("payment_status") or "").strip().lower() != "success":
        return {"ok": True, "status": "not paid"}

    return await _mark_paid(
        db, order_id, provider="prodamus",
        payment_id=data.get("payment_id") or "", raw=data,
    )
