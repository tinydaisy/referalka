"""
Заказ тарифа события: оформление, оплата, страница благодарности (мигр. 257).

Схема связывания (заменяет старую с GET-параметрами в GetCourse):
  1. Форма заказа на нашем лендинге сама опознаёт человека — по email/телефону
     находит контакт или заводит новый. Скрытые поля и параметры в адресе
     больше не нужны.
  2. Создаём заказ в `event_participant_tariffs` (status='unpaid').
  3. У платёжной системы КЛИЕНТА просим ссылку, передавая ТОЛЬКО номер заказа.
     Ни контакт, ни событие наружу не уходят.
  4. После оплаты система дёргает вебхук с этим номером → ставим 'paid',
     регистрируем участника.

⚠️ Бесплатный тариф (цена 0 или пусто) заказа НЕ создаёт — сразу регистрация.
Иначе в «Заказах» копился бы мусор из нулевых оплат.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from typing import Optional
import logging
import asyncpg

from app.database import get_db
from app.services import client_payments
from app.services.contact_merge import find_or_create_contact
from app.services.participant_registration import finalize_participant_registration

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/public/event-orders", tags=["Заказы тарифов"])
webhook_router = APIRouter(prefix="/api/v1/integrations/client-pay",
                           tags=["Вебхук оплаты тарифа"])

_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _cors(response: Response) -> None:
    for k, v in _CORS.items():
        response.headers[k] = v


class OrderIn(BaseModel):
    tariff_id: int
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    contact_id: Optional[int] = None
    consent_pd: bool = False
    consent_marketing: bool = False


async def _load_tariff(db, tariff_id: int):
    """Тариф + событие + владелец с ключами платёжной системы."""
    return await db.fetchrow(
        """SELECT t.id, t.code, t.title, t.price, t.pay_url, t.pay_product_id,
                  t.is_active,
                  e.id AS event_id, e.slug AS event_slug, e.title AS event_title,
                  cl.id AS client_id, cl.name AS client_name,
                  cl.pay_provider, cl.pay_leadpay_login, cl.pay_leadpay_token
             FROM event_tariffs t
             JOIN events e ON e.id = t.event_id
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
             JOIN clients cl ON cl.id = eo.client_id
            WHERE t.id = $1
            ORDER BY eo.id LIMIT 1""",
        tariff_id,
    )


@router.options("/create", include_in_schema=False)
async def _opts(response: Response):
    _cors(response)
    return {}


@router.post("/create", summary="Оформить заказ тарифа")
async def create_order(
    data: OrderIn,
    request: Request,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)

    t = await _load_tariff(db, data.tariff_id)
    if not t or not t["is_active"]:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    # Согласия обязательны — это форма сбора контактных данных (152-ФЗ).
    if not data.consent_pd:
        raise HTTPException(
            status_code=400,
            detail="Без согласия на обработку персональных данных оформить заказ нельзя",
        )

    name = (data.name or "").strip()
    email = (data.email or "").strip() or None
    phone = (data.phone or "").strip() or None
    tg = (data.telegram_username or "").strip().lstrip("@") or None

    if not email and not phone:
        raise HTTPException(status_code=400, detail="Укажите email или телефон")

    # ── Кто заказывает ────────────────────────────────────────────────────
    # Контакт из ссылки бота (?c=) главнее: он уже проверен. Иначе ищем по
    # email/телефону/нику — это и есть замена скрытым полям GetCourse.
    contact_id = None
    if data.contact_id:
        contact_id = await db.fetchval(
            """SELECT id FROM contacts
                WHERE id = $1 AND client_id = $2 AND merged_into IS NULL""",
            data.contact_id, t["client_id"],
        )
    if not contact_id:
        contact_id, _is_new = await find_or_create_contact(
            db,
            client_id=t["client_id"],
            name=name or None,
            email=email,
            phone=phone,
            lookup_telegram_username=tg,
        )

    price = int(t["price"] or 0)

    # ── Бесплатный тариф: заказа нет, сразу регистрируем ─────────────────
    if price <= 0:
        await db.execute(
            """INSERT INTO event_participants (event_id, contact_id, is_registered)
               VALUES ($1, $2, TRUE)
               ON CONFLICT (event_id, contact_id)
               DO UPDATE SET is_registered = TRUE""",
            t["event_id"], contact_id,
        )
        await finalize_participant_registration(
            db, event_id=t["event_id"], contact_id=contact_id)
        return {
            "ok": True,
            "free": True,
            "redirect": f"/event/{t['event_slug']}?c={contact_id}",
        }

    # ── Платный тариф: заказ + ссылка на оплату ──────────────────────────
    participant_id = await db.fetchval(
        """INSERT INTO event_participants (event_id, contact_id)
           VALUES ($1, $2)
           ON CONFLICT (event_id, contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id
           RETURNING id""",
        t["event_id"], contact_id,
    )

    order_id = await db.fetchval(
        """INSERT INTO event_participant_tariffs
               (event_id, participant_id, tariff_id, contact_id, amount,
                status, source, ordered_at)
           VALUES ($1, $2, $3, $4, $5, 'unpaid', 'landing', NOW())
           ON CONFLICT (participant_id, tariff_id)
           DO UPDATE SET amount = EXCLUDED.amount, ordered_at = NOW()
           RETURNING id""",
        t["event_id"], participant_id, t["id"], contact_id, price,
    )

    client = {
        "id": t["client_id"],
        "pay_provider": t["pay_provider"],
        "pay_leadpay_login": t["pay_leadpay_login"],
        "pay_leadpay_token": t["pay_leadpay_token"],
    }

    # Платёжная система не подключена → ведём на внешнюю ссылку тарифа.
    # Оплату в этом случае клиент отмечает вручную в разделе «Заказы».
    if not client_payments.is_configured(client):
        if t["pay_url"]:
            return {"ok": True, "order_id": order_id, "payment_url": t["pay_url"],
                    "manual": True}
        raise HTTPException(
            status_code=400,
            detail="У этого тарифа не настроена оплата. Напишите организатору.",
        )

    base = str(request.base_url).rstrip("/")
    try:
        pay_url = await client_payments.create_payment_link(
            client=client,
            order_id=order_id,
            product_id=t["pay_product_id"],
            notification_url=f"{base}/api/v1/integrations/client-pay/leadpay",
            # ⚠️ Страница благодарности ОДНА на все события: она сама находит
            # заказ по номеру и показывает чаты нужного события.
            redirect_url_ok=f"{base}/thanks?order={order_id}",
            redirect_url_error=f"{base}/thanks?order={order_id}&fail=1",
            email=email,
            phone=phone,
            fio=name or None,
        )
    except RuntimeError as e:
        logger.error("Заказ %s: не удалось создать ссылку оплаты: %s", order_id, e)
        raise HTTPException(status_code=502, detail=str(e))

    await db.execute(
        "UPDATE event_participant_tariffs SET payment_url = $1, payment_provider = 'leadpay' "
        "WHERE id = $2",
        pay_url, order_id,
    )
    return {"ok": True, "order_id": order_id, "payment_url": pay_url}


@router.get("/prefill/{tariff_id}/{contact_id}", summary="Данные контакта для формы")
async def prefill(
    tariff_id: int,
    contact_id: int,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Человек пришёл из бота по ссылке с ?c= — подставляем его контакты в
    форму, чтобы не вводил заново. Поля остаются редактируемыми: телефон
    в базе может быть старый.

    Контакт обязан принадлежать клиенту события — иначе по чужому номеру в
    адресе можно было бы вытащить контакты из другой базы."""
    _cors(response)
    t = await _load_tariff(db, tariff_id)
    if not t:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    row = await db.fetchrow(
        """SELECT c.name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    LIMIT 1) AS email,
                  (SELECT pt.username FROM platform_users pt
                    WHERE pt.contact_id = c.id AND pt.platform_slug = 'telegram'
                      AND pt.username IS NOT NULL
                    LIMIT 1) AS tg_username
             FROM contacts c
            WHERE c.id = $1 AND c.client_id = $2 AND c.merged_into IS NULL""",
        contact_id, t["client_id"],
    )
    if not row:
        return {}
    return dict(row)


@router.get("/{order_id}", summary="Заказ для страницы благодарности")
async def get_order(
    order_id: int,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Одна страница благодарности на все события: по номеру заказа находим
    событие и отдаём его чаты. Ничего настраивать не нужно."""
    _cors(response)
    row = await db.fetchrow(
        """SELECT o.id, o.status, o.amount, o.contact_id,
                  t.title AS tariff_title,
                  e.slug AS event_slug, e.title AS event_title,
                  e.tg_chat_ref, e.vk_chat_ref, e.max_chat_ref,
                  (SELECT url FROM event_posters
                    WHERE event_id = e.id AND day IS NULL
                    ORDER BY CASE orientation
                               WHEN 'horizontal' THEN 1
                               WHEN 'square' THEN 2 ELSE 3 END, sort, id
                    LIMIT 1) AS poster_url
             FROM event_participant_tariffs o
             JOIN event_tariffs t ON t.id = o.tariff_id
             JOIN events e ON e.id = o.event_id
            WHERE o.id = $1""",
        order_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Заказ не найден")
    d = dict(row)
    d["chats"] = [
        {"platform": p, "url": u}
        for p, u in (("telegram", d.pop("tg_chat_ref", None)),
                     ("vk", d.pop("vk_chat_ref", None)),
                     ("max", d.pop("max_chat_ref", None)))
        if u
    ]
    return d


# ─────────────────────────────────────────────────────────────────────────────
# Вебхук оплаты
# ─────────────────────────────────────────────────────────────────────────────
@webhook_router.post("/leadpay", summary="Оплата тарифа события (LeadPay)")
async def leadpay_order_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """LeadPay возвращает наш `order_id` в виде `evt-<id>` — по нему находим
    заказ. Ключи для проверки подписи берём у ВЛАДЕЛЬЦА события, а не из
    переменных окружения: у каждого клиента своя платёжная система."""
    form = await request.form()
    data = {k: str(v) for k, v in form.items()}
    if not data:
        try:
            data = await request.json()
        except Exception:
            data = {}

    raw_id = str(data.get("order_id") or "").strip()
    if not raw_id.startswith("evt-"):
        # Не наш заказ (подписка платформы обрабатывается другим роутером).
        return {"ok": True, "skipped": True}

    try:
        order_id = int(raw_id[4:])
    except ValueError:
        raise HTTPException(status_code=400, detail="Неверный номер заказа")

    order = await db.fetchrow(
        """SELECT o.id, o.status, o.event_id, o.contact_id, o.participant_id,
                  cl.pay_leadpay_token
             FROM event_participant_tariffs o
             JOIN events e ON e.id = o.event_id
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status = 'accepted'
             JOIN clients cl ON cl.id = eo.client_id
            WHERE o.id = $1
            ORDER BY eo.id LIMIT 1""",
        order_id,
    )
    if not order:
        raise HTTPException(status_code=404, detail="Заказ не найден")

    if not client_payments.verify_leadpay_webhook(data, order["pay_leadpay_token"] or ""):
        logger.error("Вебхук заказа %s: подпись не сошлась", order_id)
        raise HTTPException(status_code=403, detail="Подпись неверна")

    if str(data.get("status") or "").lower() != "success":
        logger.info("Заказ %s: оплата не прошла (%s)", order_id, data.get("status"))
        return {"ok": True, "paid": False}

    # Идемпотентность: повторный вебхук не должен ничего ломать.
    if order["status"] == "paid":
        return {"ok": True, "paid": True, "already": True}

    await db.execute(
        """UPDATE event_participant_tariffs
              SET status = 'paid', paid_at = NOW(), source = 'leadpay',
                  external_payment_id = $2
            WHERE id = $1""",
        order_id, str(data.get("payment_id") or data.get("id") or "") or None,
    )

    # Оплата = регистрация на событие.
    if order["contact_id"]:
        await db.execute(
            """INSERT INTO event_participants (event_id, contact_id, is_registered)
               VALUES ($1, $2, TRUE)
               ON CONFLICT (event_id, contact_id)
               DO UPDATE SET is_registered = TRUE""",
            order["event_id"], order["contact_id"],
        )
        await finalize_participant_registration(
            db, event_id=order["event_id"], contact_id=order["contact_id"])

    logger.info("Заказ %s оплачен", order_id)
    return {"ok": True, "paid": True}
