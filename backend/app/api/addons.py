"""Модули-аддоны клиента — покупка фич поверх тарифа (расширение над базой).

Концепция (миграция 165): тариф = база, аддон = фича, докупленная лично
клиентом (client_addons). client_has_feature = фича в тарифе ИЛИ активный аддон.

Модули-аддоны (features.is_addon=TRUE): collab_hub, conference, tournaments.
Покупка доступна только при тарифе Профи и выше (features.min_tariff_slug).
Оплата — Продамус (addon_orders + webhook, зеркало subscription_orders).

API (JWT владельца):
  GET  /api/v1/addons                 — список модулей + статус (куплен/доступен)
  POST /api/v1/addons/order           — заказ на оплату модуля → ссылка Prodamus
  GET  /api/v1/addons/orders/{id}     — статус заказа
Webhook:
  POST /api/v1/integrations/prodamus/addon-webhook
"""
import os
import json
import logging
from datetime import timedelta
from typing import Optional
from urllib.parse import urlencode

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.database import get_db
from app.auth import get_current_client as get_current_user
from app.api.subscriptions import (
    _verify_prodamus_signature,
    PRODAMUS_VERIFY_SIGNATURE,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/addons", tags=["Модули-аддоны"])

# Порядок тарифов для проверки «Профи и выше».
TARIFF_RANK = {"trial": 0, "start": 1, "pro": 2, "vip": 3, "admin": 99}


async def _client_tariff_slug(db, client_id: int) -> Optional[str]:
    return await db.fetchval(
        """SELECT t.slug
             FROM clients c
             JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.id = $1""",
        client_id,
    )


def _meets_min_tariff(client_slug: Optional[str], min_slug: Optional[str]) -> bool:
    """True если тариф клиента >= минимального требуемого для модуля."""
    if not min_slug:
        return True
    return TARIFF_RANK.get(client_slug or "", -1) >= TARIFF_RANK.get(min_slug, 99)


@router.get("", summary="Список модулей-аддонов со статусом для клиента")
async def list_addons(
    user=Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    """Все покупаемые модули + признаки: куплен ли, доступен ли по тарифу."""
    client_id = int(user["sub"])
    client_slug = await _client_tariff_slug(db, client_id)

    feats = await db.fetch(
        """SELECT id, slug, name, description, tagline, bullet_points,
                  price_monthly, price_6mo, min_tariff_slug
             FROM features
            WHERE is_addon = TRUE
            ORDER BY price_monthly NULLS LAST, sort"""
    )
    # Активные аддоны клиента.
    owned = await db.fetch(
        """SELECT ca.feature_id, ca.expires_at, ca.status
             FROM client_addons ca
            WHERE ca.client_id = $1 AND ca.status = 'active' AND ca.expires_at > NOW()""",
        client_id,
    )
    owned_map = {r["feature_id"]: r for r in owned}
    # Фичи, уже входящие в тариф (тогда докупать не надо).
    in_tariff = set(await db.fetch(
        """SELECT f.slug
             FROM client_subscriptions cs
             JOIN tariff_features tf ON tf.tariff_id = cs.tariff_id
             JOIN features f ON f.id = tf.feature_id
            WHERE cs.client_id = $1 AND cs.status = 'active' AND cs.expires_at > NOW()""",
        client_id,
    ))
    in_tariff_slugs = {r["slug"] for r in in_tariff} if in_tariff else set()

    out = []
    for f in feats:
        d = dict(f)
        bp = d.get("bullet_points")
        if isinstance(bp, str):
            try:
                d["bullet_points"] = json.loads(bp)
            except Exception:
                d["bullet_points"] = []
        ow = owned_map.get(f["id"])
        d["owned"] = bool(ow)
        d["expires_at"] = ow["expires_at"] if ow else None
        d["included_in_tariff"] = f["slug"] in in_tariff_slugs
        d["available"] = _meets_min_tariff(client_slug, f["min_tariff_slug"])
        out.append(d)
    return {"addons": out, "client_tariff": client_slug}


class AddonOrderRequest(BaseModel):
    feature_slug: str
    months: int = 1            # 1 или 6 (6 = цена со скидкой)


@router.post("/order", summary="Создать заказ на оплату модуля")
async def create_addon_order(
    data: AddonOrderRequest,
    user=Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    if user.get("role") == "assistant":
        raise HTTPException(status_code=403, detail="Покупка модулей доступна только владельцу кабинета")

    client_id = int(user["sub"])
    months = 6 if data.months >= 6 else 1

    feat = await db.fetchrow(
        """SELECT id, slug, name, is_addon, price_monthly, price_6mo, min_tariff_slug,
                  prodamus_payment_url, prodamus_payment_url_6mo
             FROM features WHERE slug = $1""",
        data.feature_slug,
    )
    if not feat or not feat["is_addon"]:
        raise HTTPException(status_code=404, detail="Модуль не найден")

    client_slug = await _client_tariff_slug(db, client_id)
    if not _meets_min_tariff(client_slug, feat["min_tariff_slug"]):
        raise HTTPException(
            status_code=403,
            detail=f"Модуль «{feat['name']}» доступен только на тарифе Профи и выше.",
        )

    if months == 6:
        price_month = feat["price_6mo"] or feat["price_monthly"]
        pay_url = feat["prodamus_payment_url_6mo"] or feat["prodamus_payment_url"]
    else:
        price_month = feat["price_monthly"]
        pay_url = feat["prodamus_payment_url"]

    if not price_month or price_month <= 0:
        raise HTTPException(status_code=400, detail="У модуля не задана цена")
    if not pay_url:
        raise HTTPException(status_code=400, detail="Для модуля не настроена ссылка оплаты Prodamus")

    amount_rub = int(price_month) * months
    amount_kopecks = amount_rub * 100

    client = await db.fetchrow("SELECT email, phone, name FROM clients WHERE id = $1", client_id)

    order_id = await db.fetchval(
        """INSERT INTO addon_orders (client_id, feature_id, months, amount_total_kopecks, status)
           VALUES ($1, $2, $3, $4, 'created') RETURNING id""",
        client_id, feat["id"], months, amount_kopecks,
    )

    params = {"order_id": f"addon-{order_id}", "customer_email": client["email"] or ""}
    if client["phone"]:
        params["customer_phone"] = client["phone"]
    params["customer_extra"] = f"client:{client_id};addon:{feat['slug']};months:{months}"

    base_url = pay_url.rstrip("/")
    payment_url = f"{base_url}/?{urlencode(params)}"

    return {
        "order_id": order_id,
        "payment_url": payment_url,
        "amount_rub": amount_rub,
        "months": months,
        "feature_name": feat["name"],
    }


@router.get("/orders/{order_id}", summary="Статус заказа на модуль")
async def get_addon_order(
    order_id: int,
    user=Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(user["sub"])
    row = await db.fetchrow(
        """SELECT ao.id, ao.status, ao.months, ao.amount_total_kopecks, ao.paid_at, ao.created_at,
                  f.slug AS feature_slug, f.name AS feature_name
             FROM addon_orders ao JOIN features f ON f.id = ao.feature_id
            WHERE ao.id = $1 AND ao.client_id = $2""",
        order_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Заказ не найден")
    return {"order": dict(row)}


# ─── Webhook Prodamus для аддонов ─────────────────────────────────────────────

webhook_router = APIRouter(prefix="/integrations/prodamus", tags=["Webhook Prodamus (модули)"])


@webhook_router.post("/addon-webhook", summary="Webhook оплаты модуля Prodamus")
async def prodamus_addon_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """Активирует купленный модуль (client_addons) после оплаты.

    order_id приходит в формате `addon-{id}` — отличает от заказов подписки.
    """
    raw_body = await request.body()
    signature = request.headers.get("Sign") or request.headers.get("sign") or request.headers.get("Signature")
    if PRODAMUS_VERIFY_SIGNATURE and not _verify_prodamus_signature(raw_body, signature):
        logger.warning("Prodamus addon webhook: invalid signature")
        raise HTTPException(status_code=401, detail="Invalid signature")

    form = await request.form()
    data = {k: v for k, v in form.items()}
    order_id_raw = (data.get("order_id") or "").strip()
    payment_status = (data.get("payment_status") or "").strip()

    logger.info("Prodamus addon webhook: order_id=%s status=%s", order_id_raw, payment_status)

    if not order_id_raw.startswith("addon-"):
        return {"ok": True, "ignored": "not an addon order"}
    try:
        order_id = int(order_id_raw[len("addon-"):])
    except (ValueError, TypeError):
        return {"ok": True, "ignored": "bad order_id"}

    order = await db.fetchrow(
        "SELECT id, client_id, feature_id, months, status FROM addon_orders WHERE id = $1",
        order_id,
    )
    if not order:
        return {"ok": True, "ignored": "order not found"}
    if order["status"] == "paid":
        return {"ok": True, "already_paid": True}

    is_success = payment_status.lower() in ("success", "ok", "paid", "completed")
    if not is_success:
        await db.execute(
            "UPDATE addon_orders SET status='failed', prodamus_raw=$2::jsonb, updated_at=NOW() WHERE id=$1",
            order_id, json.dumps(data, ensure_ascii=False),
        )
        return {"ok": True, "status": "failed"}

    months = int(order["months"] or 1)
    add_days = 30 * months

    async with db.transaction():
        await db.execute(
            """UPDATE addon_orders
                  SET status='paid', prodamus_order_num=$2, prodamus_payment_type=$3,
                      prodamus_raw=$4::jsonb, paid_at=NOW(), updated_at=NOW()
                WHERE id=$1""",
            order_id, data.get("order_num"), data.get("payment_type"),
            json.dumps(data, ensure_ascii=False),
        )
        # Продлеваем существующий активный аддон или создаём новый.
        existing = await db.fetchrow(
            """SELECT id, expires_at FROM client_addons
                WHERE client_id=$1 AND feature_id=$2 AND status='active' AND expires_at > NOW()
                ORDER BY expires_at DESC LIMIT 1""",
            order["client_id"], order["feature_id"],
        )
        if existing:
            new_expires = existing["expires_at"] + timedelta(days=add_days)
            await db.execute(
                "UPDATE client_addons SET expires_at=$2, months=months+$3, updated_at=NOW() WHERE id=$1",
                existing["id"], new_expires, months,
            )
            addon_id = existing["id"]
        else:
            addon_id = await db.fetchval(
                """INSERT INTO client_addons
                     (client_id, feature_id, started_at, expires_at, status, source, months)
                   VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'paid', $4)
                   RETURNING id""",
                order["client_id"], order["feature_id"], str(add_days), months,
            )

    return {"ok": True, "status": "paid", "addon_id": addon_id}
