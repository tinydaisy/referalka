"""Управление подписками клиентов ПЛЮСОНа.

Включает:
- `POST /api/v1/subscriptions/order` — создание заказа на оплату Prodamus.
  Клиент выбирает тариф, бэк формирует Prodamus-ссылку с `order_id` и
  редиректит клиента туда.
- `POST /api/v1/integrations/prodamus/webhook` — callback от Prodamus после
  оплаты. Верифицирует подпись HMAC, помечает заказ оплаченным, продлевает
  client_subscriptions на `tariffs.default_duration_days`.
- `GET /api/v1/subscriptions/orders/{id}` — статус заказа (для UI после
  возврата с Prodamus).
- `GET /api/v1/subscriptions/orders` — история оплат клиента.

Этап 3 расширит webhook начислением 10% реферу (см. project_subscriptions_features_arch.md).
"""
import os
import hmac
import hashlib
import logging
import json
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlencode

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.database import get_db
from app.auth import get_current_client as get_current_user, get_current_admin
from app.services.assistant_access import assistant_is_restricted

logger = logging.getLogger(__name__)

PRODAMUS_SECRET_KEY = (os.getenv("PRODAMUS_SECRET_KEY") or "").strip()
PRODAMUS_VERIFY_SIGNATURE = os.getenv("PRODAMUS_VERIFY_SIGNATURE", "true").lower() not in ("0", "false", "no")


# ─── Клиентский API: создание заказа ──────────────────────────────────────────

router = APIRouter(prefix="/subscriptions", tags=["Подписка клиента"])


class CreateOrderRequest(BaseModel):
    tariff_slug: str  # 'start' | 'pro' | 'vip'
    provider: str = "prodamus"  # 'prodamus' | 'leadpay'


@router.post("/order", summary="Создать заказ на оплату подписки")
async def create_order(
    data: CreateOrderRequest,
    user=Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    """Создаёт subscription_order и возвращает ссылку оплаты.

    provider='prodamus' — приклеиваем order_id к готовой Prodamus-ссылке.
    provider='leadpay'  — создаём ссылку через LeadPay getLink (product_id из tariffs).
    Цена и duration берутся из tariffs в момент создания заказа.
    """
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403, detail="Оплата подписки доступна только владельцу кабинета")

    provider = (data.provider or "prodamus").strip().lower()
    if provider not in ("prodamus", "leadpay"):
        raise HTTPException(status_code=400, detail="Неизвестный способ оплаты")

    client_id = int(user["sub"])

    tariff = await db.fetchrow(
        """SELECT id, slug, name, price, default_duration_days,
                  prodamus_payment_url, leadpay_product_id, is_active
             FROM tariffs WHERE slug = $1""",
        data.tariff_slug,
    )
    if not tariff:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    if not tariff["is_active"]:
        raise HTTPException(status_code=400, detail="Тариф неактивен")
    if float(tariff["price"]) <= 0:
        raise HTTPException(status_code=400, detail="Бесплатный тариф не оплачивается")
    if provider == "prodamus" and not tariff["prodamus_payment_url"]:
        raise HTTPException(status_code=400, detail="Для этого тарифа не настроена ссылка оплаты Prodamus")
    if provider == "leadpay" and not tariff["leadpay_product_id"]:
        raise HTTPException(status_code=400, detail="Для этого тарифа не настроена карточка LeadPay (product_id)")

    amount_kopecks = int(round(float(tariff["price"]) * 100))

    client = await db.fetchrow(
        "SELECT email, phone, name FROM clients WHERE id = $1",
        client_id,
    )

    order_id = await db.fetchval(
        """INSERT INTO subscription_orders
             (client_id, tariff_id, amount_total_kopecks, status, payment_provider)
           VALUES ($1, $2, $3, 'created', $4)
           RETURNING id""",
        client_id, tariff["id"], amount_kopecks, provider,
    )

    if provider == "leadpay":
        from app.services import leadpay
        from app.config import settings
        base = (settings.app_url or "https://pluson.ru").rstrip("/")
        try:
            payment_url = await leadpay.create_payment_link(
                order_id=order_id,
                product_id=tariff["leadpay_product_id"],
                notification_url=f"{base}/api/v1/integrations/leadpay/webhook",
                email=client["email"] or None,
                phone=client["phone"] or None,
                fio=client["name"] or None,
                redirect_url_ok="https://pluson.ru/dashboard/settings?tab=subscription&paid=1",
                redirect_url_error="https://pluson.ru/dashboard/settings?tab=subscription&paid=0",
            )
        except RuntimeError as e:
            # Заказ создан, но ссылку получить не удалось — помечаем failed.
            await db.execute("UPDATE subscription_orders SET status='failed', updated_at=NOW() WHERE id=$1", order_id)
            raise HTTPException(status_code=502, detail=f"Не удалось создать ссылку оплаты LeadPay: {e}")
    else:
        # Prodamus: цена зашита внутри короткой ссылки, приклеиваем order_id + контакты.
        params = {
            "order_id": str(order_id),
            "customer_email": client["email"] or "",
        }
        if client["phone"]:
            params["customer_phone"] = client["phone"]
        if client["name"]:
            params["customer_extra"] = f"client:{client_id};tariff:{tariff['slug']}"
        base_url = tariff["prodamus_payment_url"].rstrip("/")
        payment_url = f"{base_url}/?{urlencode(params)}"

    return {
        "order_id": order_id,
        "payment_url": payment_url,
        "amount_rub": float(tariff["price"]),
        "tariff_name": tariff["name"],
        "provider": provider,
    }


@router.get("/orders/{order_id}", summary="Статус заказа")
async def get_order(
    order_id: int,
    user=Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    row = await db.fetchrow(
        """SELECT so.id, so.status, so.amount_total_kopecks, so.amount_paid_card_kopecks,
                  so.paid_at, so.created_at, t.slug AS tariff_slug, t.name AS tariff_name
             FROM subscription_orders so
             JOIN tariffs t ON t.id = so.tariff_id
            WHERE so.id = $1 AND so.client_id = $2""",
        order_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Заказ не найден")
    return {"order": dict(row)}


@router.get("/orders", summary="История заказов клиента")
async def list_orders(
    user=Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    rows = await db.fetch(
        """SELECT so.id, so.status, so.amount_total_kopecks, so.amount_paid_card_kopecks,
                  so.paid_at, so.created_at, t.slug AS tariff_slug, t.name AS tariff_name
             FROM subscription_orders so
             JOIN tariffs t ON t.id = so.tariff_id
            WHERE so.client_id = $1
            ORDER BY so.created_at DESC
            LIMIT 50""",
        client_id,
    )
    return {"orders": [dict(r) for r in rows]}


# ─── Админ: список всех оплат подписок ────────────────────────────────────────

admin_router = APIRouter(prefix="/admin", tags=["Админ: оплаты подписок"])


@admin_router.get("/orders", summary="Все оплаты подписок (для админки)")
async def list_all_orders(
    status: Optional[str] = None,           # 'created'|'paid'|'failed'|'cancelled'
    search: Optional[str] = None,           # по имени/email клиента
    limit: int = 100,
    offset: int = 0,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    where = ["1=1"]
    args: list = []
    if status:
        args.append(status)
        where.append(f"so.status = ${len(args)}")
    if search:
        args.append(f"%{search}%")
        where.append(f"(c.name ILIKE ${len(args)} OR c.email ILIKE ${len(args)})")

    args.extend([limit, offset])
    where_sql = " AND ".join(where)

    rows = await db.fetch(
        f"""SELECT so.id, so.status,
                   so.amount_total_kopecks, so.amount_paid_card_kopecks, so.amount_paid_bonus_kopecks,
                   so.prodamus_order_num, so.prodamus_payment_type, so.paid_at, so.created_at,
                   t.slug AS tariff_slug, t.name AS tariff_name,
                   c.id AS client_id, c.name AS client_name, c.email AS client_email,
                   c.telegram_username,
                   -- Все ники клиента (TG/VK/MAX) — резолв через контакты с тем же email.
                   -- clients не связан с platform_users напрямую, единственная связка — email.
                   (SELECT json_agg(json_build_object(
                              'platform', x.platform_slug,
                              'username', x.username,
                              'platform_user_id', x.platform_user_id))
                      FROM (
                        SELECT DISTINCT ON (pu.platform_slug)
                               pu.platform_slug, pu.username, pu.platform_user_id
                          FROM contacts ct
                          JOIN platform_users pu ON pu.contact_id = ct.id
                         WHERE ct.email_normalized = lower(c.email)
                           AND pu.platform_slug <> 'email'
                         ORDER BY pu.platform_slug, pu.id
                      ) x) AS identities,
                   ref.id AS referrer_id, ref.name AS referrer_name
              FROM subscription_orders so
              JOIN clients c ON c.id = so.client_id
              JOIN tariffs t ON t.id = so.tariff_id
              LEFT JOIN clients ref ON ref.id = c.referred_by_client_id
             WHERE {where_sql}
             ORDER BY so.created_at DESC
             LIMIT ${len(args) - 1} OFFSET ${len(args)}""",
        *args,
    )
    total = await db.fetchval(
        f"""SELECT COUNT(*) FROM subscription_orders so
              JOIN clients c ON c.id = so.client_id
             WHERE {where_sql}""",
        *args[:-2],
    )

    # Сводка по статусам (без учёта search/status фильтров — полная картина)
    summary = await db.fetchrow(
        """SELECT
             COUNT(*) FILTER (WHERE status='paid') AS paid_count,
             COALESCE(SUM(amount_paid_card_kopecks) FILTER (WHERE status='paid'), 0) AS total_card_paid,
             COALESCE(SUM(amount_paid_bonus_kopecks) FILTER (WHERE status='paid'), 0) AS total_bonus_paid,
             COUNT(*) FILTER (WHERE status='created') AS pending_count
           FROM subscription_orders"""
    )

    orders = []
    for r in rows:
        o = dict(r)
        # identities приходит JSON-строкой от json_agg — парсим в список словарей.
        raw = o.get("identities")
        o["identities"] = json.loads(raw) if isinstance(raw, str) else (raw or [])
        orders.append(o)

    return {
        "orders": orders,
        "total": total,
        "summary": dict(summary) if summary else {},
    }


# ─── Общая выдача подписки по оплаченному заказу ──────────────────────────────
# Переиспользуется вебхуками ОБЕИХ платёжек (Prodamus и LeadPay). Вся логика
# «пометить оплаченным + продлить/создать client_subscriptions + уведомить +
# начислить кэшбэк реферу» — здесь, чтобы не дублировать между провайдерами.


async def _apply_paid_subscription_order(
    db: asyncpg.Connection,
    *,
    order: asyncpg.Record,
    amount_paid_kopecks: int,
    raw: dict,
    order_num: Optional[str] = None,
    payment_type: Optional[str] = None,
) -> dict:
    """order — строка subscription_orders + join tariffs (id, client_id, tariff_id,
    status, default_duration_days, tariff_slug). Идемпотентность: если уже paid —
    возвращает already_paid. Иначе помечает оплаченным и выдаёт подписку."""
    order_id = order["id"]
    if order["status"] == "paid":
        return {"ok": True, "already_paid": True}

    duration_days = int(order["default_duration_days"] or 30)

    async with db.transaction():
        await db.execute(
            """UPDATE subscription_orders
                  SET status = 'paid',
                      amount_paid_card_kopecks = $2,
                      prodamus_order_num       = $3,
                      prodamus_payment_type    = $4,
                      prodamus_raw             = $5::jsonb,
                      paid_at                  = NOW(),
                      updated_at               = NOW()
                WHERE id = $1""",
            order_id, amount_paid_kopecks, order_num, payment_type,
            json.dumps(raw, ensure_ascii=False),
        )

        # Если у клиента уже активна подписка того же тарифа — продлеваем от её
        # expires_at; иначе считаем с NOW().
        existing = await db.fetchrow(
            """SELECT id, expires_at FROM client_subscriptions
                WHERE client_id = $1 AND tariff_id = $2
                  AND status = 'active' AND expires_at > NOW()
                ORDER BY expires_at DESC LIMIT 1""",
            order["client_id"], order["tariff_id"],
        )
        if existing:
            new_expires = existing["expires_at"] + timedelta(days=duration_days)
            await db.execute(
                "UPDATE client_subscriptions SET expires_at = $2, subscription_order_id = $3 WHERE id = $1",
                existing["id"], new_expires, order_id,
            )
            sub_id = existing["id"]
        else:
            sub_id = await db.fetchval(
                """INSERT INTO client_subscriptions
                     (client_id, tariff_id, started_at, expires_at, status, source, subscription_order_id)
                   VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'paid', $4)
                   RETURNING id""",
                order["client_id"], order["tariff_id"], str(duration_days), order_id,
            )
            await db.execute(
                "UPDATE clients SET current_subscription_id = $1 WHERE id = $2",
                sub_id, order["client_id"],
            )

    try:
        await _send_subscription_extended_notification(db, order["client_id"], order["tariff_slug"], duration_days)
    except Exception as e:
        logger.exception("Failed to send TG notification about subscription: %s", e)

    try:
        await _credit_referral_cashback(
            db,
            payer_client_id=order["client_id"],
            order_id=order_id,
            amount_paid_card_kopecks=amount_paid_kopecks,
            tariff_name=order["tariff_slug"],
        )
    except Exception as e:
        logger.exception("Failed to credit referral cashback: %s", e)

    return {"ok": True, "status": "paid", "subscription_id": sub_id}


# ─── Webhook от Prodamus ──────────────────────────────────────────────────────

webhook_router = APIRouter(prefix="/integrations/prodamus", tags=["Webhook Prodamus"])


def _verify_prodamus_signature(body: bytes, signature_header: Optional[str]) -> bool:
    """Проверяет HMAC-SHA256 подпись webhook'а Prodamus.

    Алгоритм Prodamus: HMAC-SHA256 от тела запроса (как байты) с секретным
    ключом. Подпись приходит в заголовке `Sign` в hex.
    """
    if not PRODAMUS_SECRET_KEY:
        logger.warning("Prodamus webhook: PRODAMUS_SECRET_KEY не задан, пропускаем проверку")
        return True
    if not signature_header:
        return False
    expected = hmac.new(PRODAMUS_SECRET_KEY.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.lower(), signature_header.lower())


@webhook_router.post("/webhook", summary="Webhook оплаты Prodamus")
async def prodamus_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """Принимает POST multipart/form-data от Prodamus.

    Поля payload: order_id, order_num, sum, customer_email, payment_status,
    payment_type, attempt, sys, products[...], date.
    Подпись HMAC-SHA256 — в заголовке `Sign`.
    """
    raw_body = await request.body()
    signature = request.headers.get("Sign") or request.headers.get("sign") or request.headers.get("Signature")

    if PRODAMUS_VERIFY_SIGNATURE and not _verify_prodamus_signature(raw_body, signature):
        logger.warning("Prodamus webhook: invalid signature (header=%s)", signature)
        raise HTTPException(status_code=401, detail="Invalid signature")

    form = await request.form()
    data = {k: v for k, v in form.items()}

    order_id_raw = data.get("order_id")
    payment_status = (data.get("payment_status") or "").strip()
    sum_str = data.get("sum") or "0"

    logger.info("Prodamus webhook: order_id=%s status=%s sum=%s", order_id_raw, payment_status, sum_str)

    if not order_id_raw:
        return {"ok": True, "ignored": "no order_id"}

    try:
        order_id = int(order_id_raw)
    except (ValueError, TypeError):
        return {"ok": True, "ignored": "order_id is not an integer"}

    order = await db.fetchrow(
        """SELECT so.id, so.client_id, so.tariff_id, so.status, t.default_duration_days, t.slug AS tariff_slug
             FROM subscription_orders so
             JOIN tariffs t ON t.id = so.tariff_id
            WHERE so.id = $1""",
        order_id,
    )
    if not order:
        logger.warning("Prodamus webhook: order %s not found", order_id)
        return {"ok": True, "ignored": "order not found"}

    if order["status"] == "paid":
        # Идемпотентность: уже обработали раньше — просто 200 ОК.
        return {"ok": True, "already_paid": True}

    is_success = payment_status.lower() in ("success", "ok", "paid", "completed")

    try:
        amount_paid_kopecks = int(round(float(sum_str) * 100))
    except (ValueError, TypeError):
        amount_paid_kopecks = 0

    if not is_success:
        # Зафиксируем неудачу
        await db.execute(
            """UPDATE subscription_orders
                  SET status = 'failed', prodamus_raw = $2::jsonb, updated_at = NOW()
                WHERE id = $1""",
            order_id, json.dumps(data, ensure_ascii=False),
        )
        return {"ok": True, "status": "failed"}

    # Успех: общая выдача подписки (переиспользуется LeadPay-вебхуком).
    return await _apply_paid_subscription_order(
        db,
        order=order,
        amount_paid_kopecks=amount_paid_kopecks,
        raw=data,
        order_num=data.get("order_num"),
        payment_type=data.get("payment_type"),
    )


# ─── Webhook от LeadPay ───────────────────────────────────────────────────────
# Отдельная платёжка РЯДОМ с Prodamus. Способ — API getLink (см. services/leadpay.py).
# LeadPay при оплате шлёт POST на notification_url:
#   {status, summa, commission_sum, payable, order_id, hash [, card_id]}
# Проверка подлинности — hash (HMAC-SHA256 по ksort значений с токеном LeadPay).

leadpay_webhook_router = APIRouter(prefix="/integrations/leadpay", tags=["Webhook LeadPay"])


@leadpay_webhook_router.post("/webhook", summary="Webhook оплаты подписки LeadPay")
async def leadpay_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    from app.services import leadpay

    form = await request.form()
    data = {k: str(v) for k, v in form.items()}

    order_id_raw = data.get("order_id")
    status = (data.get("status") or "").strip().lower()
    sum_str = data.get("summa") or data.get("sum") or "0"

    logger.info("LeadPay webhook: order_id=%s status=%s summa=%s", order_id_raw, status, sum_str)

    # Проверка подписи
    if not leadpay.verify_webhook(data):
        logger.warning("LeadPay webhook: invalid hash (order_id=%s)", order_id_raw)
        raise HTTPException(status_code=401, detail="Invalid hash")

    if not order_id_raw:
        return {"ok": True, "ignored": "no order_id"}
    try:
        order_id = int(order_id_raw)
    except (ValueError, TypeError):
        return {"ok": True, "ignored": "order_id is not an integer"}

    order = await db.fetchrow(
        """SELECT so.id, so.client_id, so.tariff_id, so.status,
                  t.default_duration_days, t.slug AS tariff_slug
             FROM subscription_orders so
             JOIN tariffs t ON t.id = so.tariff_id
            WHERE so.id = $1""",
        order_id,
    )
    if not order:
        logger.warning("LeadPay webhook: order %s not found", order_id)
        return {"ok": True, "ignored": "order not found"}

    is_success = status in ("success", "ok", "paid", "completed")
    try:
        amount_paid_kopecks = int(round(float(sum_str) * 100))
    except (ValueError, TypeError):
        amount_paid_kopecks = 0

    if not is_success:
        await db.execute(
            """UPDATE subscription_orders
                  SET status = 'failed', prodamus_raw = $2::jsonb, updated_at = NOW()
                WHERE id = $1""",
            order_id, json.dumps(data, ensure_ascii=False),
        )
        return {"ok": True, "status": "failed"}

    return await _apply_paid_subscription_order(
        db,
        order=order,
        amount_paid_kopecks=amount_paid_kopecks,
        raw=data,
        order_num=data.get("card_id"),   # для подписки LeadPay шлёт card_id
        payment_type="leadpay",
    )


async def _credit_referral_cashback(
    db,
    *,
    payer_client_id: int,
    order_id: int,
    amount_paid_card_kopecks: int,
    tariff_name: str,
):
    """10% от карточной части → бонусный баланс рефера. Уведомление в его TG."""
    from app.services.bonuses import credit_bonus, calc_cashback_kopecks

    if amount_paid_card_kopecks <= 0:
        return

    payer = await db.fetchrow(
        "SELECT name, referred_by_client_id FROM clients WHERE id = $1",
        payer_client_id,
    )
    if not payer or not payer["referred_by_client_id"]:
        return

    referrer_id = payer["referred_by_client_id"]
    cashback = calc_cashback_kopecks(amount_paid_card_kopecks, percent=10)
    if cashback <= 0:
        return

    new_balance = await credit_bonus(
        db,
        client_id=referrer_id,
        amount_kopecks=cashback,
        source_order_id=order_id,
        source_payer_id=payer_client_id,
        description=f"10% от оплаты {tariff_name} клиентом «{payer['name']}»",
    )

    # Уведомляем рефера в его TG (если настроен notifications_telegram_chat_id).
    try:
        await _notify_referrer_about_cashback(
            db,
            referrer_id=referrer_id,
            cashback_kopecks=cashback,
            payer_name=payer["name"],
            tariff_name=tariff_name,
            new_balance_kopecks=new_balance,
        )
    except Exception as e:
        logger.exception("Failed to notify referrer: %s", e)


async def _notify_referrer_about_cashback(
    db,
    *,
    referrer_id: int,
    cashback_kopecks: int,
    payer_name: str,
    tariff_name: str,
    new_balance_kopecks: int,
):
    row = await db.fetchrow(
        "SELECT notifications_telegram_chat_id FROM clients WHERE id = $1",
        referrer_id,
    )
    if not row or not row["notifications_telegram_chat_id"]:
        return

    text = (
        f"🎉 <b>+{cashback_kopecks / 100:.0f}₽ на бонусный баланс</b>\n\n"
        f"Ваш реферал «{payer_name}» оплатил тариф <b>{tariff_name}</b>.\n"
        f"Ваш текущий баланс: <b>{new_balance_kopecks / 100:.0f}₽</b>\n\n"
        f"Подробнее в /dashboard/referrals"
    )

    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        return

    import httpx
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={
                    "chat_id": row["notifications_telegram_chat_id"],
                    "text": text,
                    "parse_mode": "HTML",
                },
            )
        except Exception as e:
            logger.warning("Telegram cashback notification failed: %s", e)


async def _send_subscription_extended_notification(db, client_id: int, tariff_slug: str, days: int):
    """Шлёт в TG-канал клиента сообщение о продлении подписки.

    Использует @pluson_bot (или dev-аналог) и `clients.notifications_telegram_chat_id`.
    """
    row = await db.fetchrow(
        """SELECT c.notifications_telegram_chat_id, c.name, t.name AS tariff_name,
                  cs.expires_at
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             LEFT JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.id = $1""",
        client_id,
    )
    if not row or not row["notifications_telegram_chat_id"]:
        return
    expires = row["expires_at"]
    tariff_name = row["tariff_name"] or tariff_slug
    expires_str = expires.strftime("%d.%m.%Y") if expires else "—"

    text = (
        f"✅ <b>Подписка продлена</b>\n\n"
        f"Тариф: <b>{tariff_name}</b>\n"
        f"Действует до: <b>{expires_str}</b>\n"
        f"Срок: {days} дн.\n\n"
        f"Спасибо за оплату! 🎉"
    )

    # Используем системный бот @pluson_bot (для прода — реальный токен из ENV).
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        logger.warning("TELEGRAM_BOT_TOKEN не задан, уведомление не отправлено")
        return

    import httpx
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={
                    "chat_id": row["notifications_telegram_chat_id"],
                    "text": text,
                    "parse_mode": "HTML",
                },
            )
        except Exception as e:
            logger.warning("Telegram sendMessage failed: %s", e)
