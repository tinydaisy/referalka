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
# ⚠️ Имя человека — только общим хелпером (правило проекта, person_name.py).
from app.services.person_name import display_name
from app.auth import get_current_client as get_current_user
from app.services.assistant_access import assistant_is_restricted
from app.api.subscriptions import (
    _verify_prodamus_signature,
    PRODAMUS_VERIFY_SIGNATURE,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/addons", tags=["Модули-аддоны"])

# Порядок тарифов для проверки «Профи и выше».
# Триал = демо Профи: по фичам идентичен pro, поэтому и модули-аддоны с него
# должны покупаться как с Профи. Даём триалу ранг pro (не 0), иначе _meets_min_tariff
# режет покупку модулей у триальных клиентов. См. правило «триал ВСЕГДА = Профи».
# ⚠️ Новый тариф ОБЯЗАН попасть сюда. Незнакомый slug получает ранг -1 и не
# проходит проверку «Профи и выше» — на самом дорогом тарифе нельзя было бы
# купить ни один модуль (Конференции, Турниры, Коллабораторную).
TARIFF_RANK = {"trial": 2, "start": 1, "pro": 2, "vip": 3, "business_beta": 4,
               "admin": 99}

# ⚠️ Отменено 08.09.2026. До этого «Коллабораторная» выдавалась не на 30 дней, а ДО
# ОДНОЙ ДАТЫ (10.09.2026) — модуль был в активной доработке. Дата не накапливалась,
# и оплата ПЕРЕЗАПИСЫВАЛА срок: клиент с оплаченным месяцем, заплатив ещё раз,
# получал бы срок КОРОЧЕ прежнего, а после 10.09 — сразу истёкший аддон.
# Теперь модуль живёт по общему правилу: месяц от даты оплаты, а при продлении
# действующего — месяц к уже имеющемуся сроку.
COLLAB_HUB_SLUG = "collab_hub"

async def _active_price_lock_promo(db, feature_slug: str):
    """Действующая акция «заморозка цены» для этого модуля — или None.

    ⚠️ Настройки НЕ в коде: живут в promotions (правятся в /admin/promotions).
      value   — сколько МЕСЯЦЕВ держать цену
      ends_at — до какой даты надо успеть оплатить
    """
    return await db.fetchrow(
        """SELECT id, value AS months, ends_at
             FROM promotions
            WHERE type = 'price_lock' AND is_active = TRUE
              AND target_feature_slug = $1
              AND (ends_at IS NULL OR ends_at > NOW())
            ORDER BY id DESC LIMIT 1""",
        feature_slug,
    )


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
    # ЧЁРНЫЙ СПИСОК (миграция 228) — запрет покупки Коллабораторной, ставит админ.
    from app.services.blacklist import is_collab_hub_blocked
    collab_blocked = await is_collab_hub_blocked(db, client_id)

    feats = await db.fetch(
        """SELECT id, slug, name, description, tagline, bullet_points,
                  price_monthly, price_6mo, promo_old_monthly, promo_old_6mo,
                  min_tariff_slug, coming_soon, leadpay_bundle_pro_product_id,
                  prodamus_payment_url, prodamus_payment_url_6mo,
                  leadpay_product_id, leadpay_product_id_6mo
             FROM features
            WHERE is_addon = TRUE
            ORDER BY coming_soon ASC, price_monthly NULLS LAST, sort"""
    )
    pro_price = int(await db.fetchval("SELECT price FROM tariffs WHERE slug='pro'") or 0)
    # Активные аддоны клиента.
    owned = await db.fetch(
        """SELECT ca.feature_id, ca.expires_at, ca.status
             FROM client_addons ca
            WHERE ca.client_id = $1 AND ca.status = 'active' AND ca.expires_at > NOW()""",
        client_id,
    )
    owned_map = {r["feature_id"]: r for r in owned}
    # 🔒 Активные «заморозки цены» клиента — чтобы показать ЕГО цену, а не новую.
    locks = await db.fetch(
        """SELECT feature_id, locked_price, expires_at FROM client_price_locks
            WHERE client_id = $1 AND expires_at > NOW()""",
        client_id,
    )
    lock_map = {r["feature_id"]: r for r in locks}
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
        d["coming_soon"] = bool(f["coming_soon"])
        # ЧЁРНЫЙ СПИСОК (миграция 228): клиенту закрыта покупка Коллабораторной —
        # карточка не показывается вовсе (не «недоступна», а её нет в списке).
        if collab_blocked and f["slug"] == COLLAB_HUB_SLUG and not owned_map.get(f["id"]):
            continue
        # «Скоро будет» — купить нельзя, показываем без цены/кнопки.
        d["available"] = (not f["coming_soon"]) and _meets_min_tariff(client_slug, f["min_tariff_slug"])
        # Комплект «Профи + модуль» одной оплатой — доступен, только если клиенту НЕ хватает тарифа
        # и у модуля настроена bundle-карточка LeadPay.
        d["bundle_available"] = bool(
            (not f["coming_soon"]) and not d["available"] and f["leadpay_bundle_pro_product_id"]
        )
        d["bundle_price"] = (int(f["price_monthly"] or 0) + pro_price) if d["bundle_available"] else None
        # Можно ли реально оплатить помесячно / за 6 мес — есть ли Prodamus-ссылка ИЛИ карточка LeadPay.
        # Фронт по этим флагам показывает/прячет кнопки, чтобы не открывать нерабочую оплату.
        # Зафиксированная цена: клиент платит её, а не price_monthly.
        _lk = lock_map.get(f["id"])
        d["locked_price"] = int(_lk["locked_price"]) if _lk else None
        d["locked_until"] = _lk["expires_at"] if _lk else None
        d["monthly_payable"] = bool(f["prodamus_payment_url"] or f["leadpay_product_id"])
        d["sixmo_payable"] = bool(f["prodamus_payment_url_6mo"] or f["leadpay_product_id_6mo"])
        # Предпочтительный провайдер помесячной оплаты (Prodamus если есть ссылка, иначе LeadPay).
        d["monthly_provider"] = "prodamus" if f["prodamus_payment_url"] else ("leadpay" if f["leadpay_product_id"] else None)
        d["sixmo_provider"] = "prodamus" if f["prodamus_payment_url_6mo"] else ("leadpay" if f["leadpay_product_id_6mo"] else None)
        for k in ("leadpay_bundle_pro_product_id", "prodamus_payment_url", "prodamus_payment_url_6mo",
                  "leadpay_product_id", "leadpay_product_id_6mo"):
            d.pop(k, None)
        out.append(d)
    return {"addons": out, "client_tariff": client_slug}


class AddonOrderRequest(BaseModel):
    feature_slug: str
    months: int = 1            # 1 или 6 (6 = цена со скидкой)
    provider: str = "prodamus"  # 'prodamus' | 'leadpay'
    bundle: bool = False        # True = комплект «тариф Профи + модуль» одной оплатой (для клиента без Профи)


@router.post("/order", summary="Создать заказ на оплату модуля")
async def create_addon_order(
    data: AddonOrderRequest,
    user=Depends(get_current_user),
    db: asyncpg.Connection = Depends(get_db),
):
    if await assistant_is_restricted(user):
        raise HTTPException(status_code=403, detail="Покупка модулей доступна только владельцу кабинета")

    provider = (data.provider or "prodamus").strip().lower()
    if provider not in ("prodamus", "leadpay"):
        raise HTTPException(status_code=400, detail="Неизвестный способ оплаты")

    client_id = int(user["sub"])
    months = 6 if data.months >= 6 else 1
    bundle = bool(data.bundle)
    if bundle:
        # Комплект «Профи + модуль» — только LeadPay-карточка, только на месяц.
        provider = "leadpay"
        months = 1

    feat = await db.fetchrow(
        """SELECT id, slug, name, is_addon, coming_soon, price_monthly, price_6mo, min_tariff_slug,
                  prodamus_payment_url, prodamus_payment_url_6mo,
                  leadpay_product_id, leadpay_product_id_6mo, leadpay_bundle_pro_product_id,
                  leadpay_product_id_locked, price_monthly_locked
             FROM features WHERE slug = $1""",
        data.feature_slug,
    )
    if not feat or not feat["is_addon"]:
        raise HTTPException(status_code=404, detail="Модуль не найден")
    if feat["coming_soon"]:
        raise HTTPException(status_code=400, detail="Этот модуль скоро будет доступен")

    # ЧЁРНЫЙ СПИСОК (миграция 228) — запрет покупки Коллабораторной.
    # Дублирует скрытие карточки в списке: прямой POST мимо UI тоже отклоняем.
    if feat["slug"] == COLLAB_HUB_SLUG:
        from app.services.blacklist import is_collab_hub_blocked
        if await is_collab_hub_blocked(db, client_id):
            raise HTTPException(
                status_code=403,
                detail="Покупка этого модуля недоступна. Обратитесь в службу поддержки.",
            )

    client_slug = await _client_tariff_slug(db, client_id)
    # Для комплекта проверку тарифа НЕ делаем — клиент как раз покупает Профи вместе с модулем.
    if not bundle and not _meets_min_tariff(client_slug, feat["min_tariff_slug"]):
        raise HTTPException(
            status_code=403,
            detail=f"Модуль «{feat['name']}» доступен только на тарифе Профи и выше.",
        )

    if bundle:
        leadpay_pid = feat["leadpay_bundle_pro_product_id"]
        if not leadpay_pid:
            raise HTTPException(status_code=400, detail="Для этого модуля не настроена карточка-комплект LeadPay")
        # Цена комплекта = месяц модуля + цена тарифа Профи.
        pro_price = await db.fetchval("SELECT price FROM tariffs WHERE slug='pro'")
        price_month = int(feat["price_monthly"] or 0) + int(pro_price or 0)
        pay_url = None
    elif months == 6:
        price_month = feat["price_6mo"] or feat["price_monthly"]
        pay_url = feat["prodamus_payment_url_6mo"] or feat["prodamus_payment_url"]
        leadpay_pid = feat["leadpay_product_id_6mo"] or feat["leadpay_product_id"]
    else:
        price_month = feat["price_monthly"]
        pay_url = feat["prodamus_payment_url"]
        leadpay_pid = feat["leadpay_product_id"]

    # 🔒 Заморозка цены: у клиента есть активный лок на этот модуль → платит по СТАРОЙ
    # цене и уходит на СТАРУЮ карточку LeadPay. ⚠️ Карточка обязательна: сумму задаёт
    # LeadPay на своей стороне, подменить её в нашем коде нельзя. Нет старой карточки —
    # лок молча не применяем (лучше обычная цена, чем битая оплата).
    if not bundle and months == 1:
        lock = await db.fetchrow(
            """SELECT locked_price FROM client_price_locks
                WHERE client_id = $1 AND feature_id = $2 AND expires_at > NOW()""",
            client_id, feat["id"],
        )
        if lock and feat["leadpay_product_id_locked"]:
            price_month = int(lock["locked_price"])
            leadpay_pid = feat["leadpay_product_id_locked"]
            pay_url = None          # у «замороженной» цены только LeadPay-карточка
            provider = "leadpay"

    if not price_month or price_month <= 0:
        raise HTTPException(status_code=400, detail="У модуля не задана цена")
    if provider == "prodamus" and not pay_url:
        raise HTTPException(status_code=400, detail="Для модуля не настроена ссылка оплаты Prodamus")
    if provider == "leadpay" and not leadpay_pid:
        raise HTTPException(status_code=400, detail="Для модуля не настроена карточка LeadPay (product_id)")

    amount_rub = int(price_month) * months
    amount_kopecks = amount_rub * 100

    client = await db.fetchrow("SELECT email, phone, name FROM clients WHERE id = $1", client_id)

    order_id = await db.fetchval(
        """INSERT INTO addon_orders (client_id, feature_id, months, amount_total_kopecks, status, payment_provider, bundle_with_pro)
           VALUES ($1, $2, $3, $4, 'created', $5, $6) RETURNING id""",
        client_id, feat["id"], months, amount_kopecks, provider, bundle,
    )

    if provider == "leadpay":
        from app.services import leadpay
        from app.config import settings
        base = (settings.app_url or "https://pluson.ru").rstrip("/")
        try:
            payment_url = await leadpay.create_payment_link(
                order_id=order_id,
                product_id=leadpay_pid,
                notification_url=f"{base}/api/v1/integrations/leadpay/addon-webhook",
                order_id_prefix="addon-",
                email=client["email"] or None,
                phone=client["phone"] or None,
                fio=client["name"] or None,
                redirect_url_ok="https://pluson.ru/dashboard/subscription?paid=1",
                redirect_url_error="https://pluson.ru/dashboard/subscription?paid=0",
            )
        except RuntimeError as e:
            await db.execute("UPDATE addon_orders SET status='failed', updated_at=NOW() WHERE id=$1", order_id)
            raise HTTPException(status_code=502, detail=f"Не удалось создать ссылку оплаты LeadPay: {e}")
    else:
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
        "provider": provider,
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
        "SELECT id, client_id, feature_id, months, status, bundle_with_pro, amount_total_kopecks "
        "FROM addon_orders WHERE id = $1",
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

    return await _apply_paid_addon_order(
        db, order=order, raw=data,
        order_num=data.get("order_num"), payment_type=data.get("payment_type"),
    )


async def _apply_paid_addon_order(
    db: asyncpg.Connection,
    *,
    order: asyncpg.Record,
    raw: dict,
    order_num: Optional[str] = None,
    payment_type: Optional[str] = None,
) -> dict:
    """Помечает addon_order оплаченным + продлевает/создаёт client_addons.

    Переиспользуется вебхуками Prodamus и LeadPay. order — строка addon_orders
    (id, client_id, feature_id, months, status). Идемпотентность на статусе paid
    проверяется вызывающим (в вебхуке до вызова)."""
    order_id = order["id"]
    months = int(order["months"] or 1)
    add_days = 30 * months

    _feature_slug = await db.fetchval(
        "SELECT slug FROM features WHERE id = $1", order["feature_id"])
    if _feature_slug == COLLAB_HUB_SLUG:
        # ЧЁРНЫЙ СПИСОК (миграция 228) — последний рубеж. Сюда можно попасть, если
        # клиента заблокировали ПОСЛЕ создания заказа (ссылка на оплату уже была).
        # Деньги списаны — модуль не выдаём, но заказ помечаем и громко логируем,
        # чтобы платёж не потерялся молча и его можно было вернуть.
        from app.services.blacklist import is_collab_hub_blocked
        if await is_collab_hub_blocked(db, order["client_id"]):
            await db.execute(
                """UPDATE addon_orders
                      SET status='failed', prodamus_raw=$2::jsonb, updated_at=NOW()
                    WHERE id=$1""",
                order_id, json.dumps(raw, ensure_ascii=False),
            )
            logger.error(
                "ADDON BLOCKED: клиент %s в чёрном списке, оплата пришла (order %s), "
                "модуль collab_hub НЕ выдан — требуется возврат",
                order["client_id"], order_id,
            )
            return {"ok": False, "blocked": True, "order_id": order_id}

    # Сумма оплаты в рублях — пишем её в client_addons.price, чтобы модуль в
    # отчётах не выглядел бесплатным. В заказе сумма хранится в копейках.
    paid_rub = int((order["amount_total_kopecks"] or 0) / 100) or None

    async with db.transaction():
        await db.execute(
            """UPDATE addon_orders
                  SET status='paid', prodamus_order_num=$2, prodamus_payment_type=$3,
                      prodamus_raw=$4::jsonb, paid_at=NOW(), updated_at=NOW()
                WHERE id=$1""",
            order_id, order_num, payment_type, json.dumps(raw, ensure_ascii=False),
        )
        existing = await db.fetchrow(
            """SELECT id, expires_at FROM client_addons
                WHERE client_id=$1 AND feature_id=$2 AND status='active' AND expires_at > NOW()
                ORDER BY expires_at DESC LIMIT 1""",
            order["client_id"], order["feature_id"],
        )
        if existing:
            # Продление действующего модуля — месяц К УЖЕ ИМЕЮЩЕМУСЯ сроку, а не от
            # даты оплаты: иначе клиент, заплативший заранее, терял бы оставшиеся дни.
            new_expires = existing["expires_at"] + timedelta(days=add_days)
            # ⚠️ price — сумма ПОСЛЕДНЕЙ оплаты (в рублях). Раньше колонка не
            # заполнялась вовсе, и в отчётах по выручке модуль был без суммы,
            # хотя деньги прошли.
            # ⚠️ Флаги предупреждений сбрасываем при продлении (миграция 276):
            # продление — это UPDATE той же строки, и без сброса клиент больше
            # никогда не получил бы предупреждений об истечении — таск считал бы,
            # что уже уведомлял.
            await db.execute(
                "UPDATE client_addons SET expires_at=$2, months=months+$3, price=$4, "
                "notified_7d=FALSE, notified_3d=FALSE, notified_1d=FALSE, "
                "updated_at=NOW() WHERE id=$1",
                existing["id"], new_expires, months, paid_rub,
            )
            addon_id = existing["id"]
        else:
            addon_id = await db.fetchval(
                """INSERT INTO client_addons
                     (client_id, feature_id, started_at, expires_at, status, source, months, price)
                   VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval,
                           'active', 'paid', $4, $5)
                   RETURNING id""",
                order["client_id"], order["feature_id"], str(add_days), months,
                paid_rub,
            )

        # 🔒 Заморозка цены: оплатил в акционный период → фиксируем цену на N месяцев
        # ОТ ДАТЫ ОПЛАТЫ. Повторная оплата в акцию продлевает лок (UPSERT), не дублирует.
        promo = await _active_price_lock_promo(db, _feature_slug or "")
        if promo:
            lock_months = int(promo["months"] or 0)
            locked_price = await db.fetchval(
                "SELECT COALESCE(price_monthly_locked, price_monthly) FROM features WHERE id = $1",
                order["feature_id"],
            )
            if lock_months > 0 and locked_price:
                await db.execute(
                    """INSERT INTO client_price_locks (client_id, feature_id, locked_price, expires_at)
                       VALUES ($1, $2, $3, NOW() + ($4 || ' months')::interval)
                       ON CONFLICT (client_id, feature_id) DO UPDATE
                         SET locked_price = EXCLUDED.locked_price,
                             expires_at   = GREATEST(client_price_locks.expires_at, EXCLUDED.expires_at)""",
                    order["client_id"], order["feature_id"], int(locked_price), str(lock_months),
                )

        # Комплект «Профи + модуль» — вместе с модулем активируем/продлеваем тариф Профи.
        if order.get("bundle_with_pro"):
            pro = await db.fetchrow(
                "SELECT id, COALESCE(default_duration_days, 30) AS dur FROM tariffs WHERE slug='pro'"
            )
            if pro:
                pro_days = int(pro["dur"] or 30)
                ex_sub = await db.fetchrow(
                    """SELECT id, expires_at FROM client_subscriptions
                        WHERE client_id=$1 AND tariff_id=$2 AND status='active' AND expires_at > NOW()
                        ORDER BY expires_at DESC LIMIT 1""",
                    order["client_id"], pro["id"],
                )
                if ex_sub:
                    await db.execute(
                        "UPDATE client_subscriptions SET expires_at=$2 WHERE id=$1",
                        ex_sub["id"], ex_sub["expires_at"] + timedelta(days=pro_days),
                    )
                else:
                    sub_id = await db.fetchval(
                        """INSERT INTO client_subscriptions
                             (client_id, tariff_id, started_at, expires_at, status, source)
                           VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'paid')
                           RETURNING id""",
                        order["client_id"], pro["id"], str(pro_days),
                    )
                    await db.execute(
                        "UPDATE clients SET current_subscription_id=$1 WHERE id=$2",
                        sub_id, order["client_id"],
                    )

    # Кэшбэк рефоводу — со ВСЕГО, что купил приведённый клиент, а не только с
    # тарифов. Раньше модули начисление не давали вовсе: клиент мог купить
    # Турниры за 5000 ₽, и рефовод не получал ничего.
    # ⚠️ Вне транзакции выдачи модуля: credit_bonus открывает свою (FOR UPDATE
    # на балансе), а сбой начисления не должен откатывать оплаченный модуль.
    try:
        await _credit_addon_referral_cashback(
            db,
            payer_client_id=order["client_id"],
            amount_paid_kopecks=int(order["amount_total_kopecks"] or 0),
            feature_slug=_feature_slug,
        )
    except Exception as e:  # noqa: BLE001 — деньги за модуль уже приняты
        logger.exception("addon referral cashback failed (order %s): %s", order_id, e)

    return {"ok": True, "status": "paid", "addon_id": addon_id}


async def _credit_addon_referral_cashback(
    db: asyncpg.Connection,
    *,
    payer_client_id: int,
    amount_paid_kopecks: int,
    feature_slug: Optional[str],
) -> None:
    """Кэшбэк рефоводу с покупки МОДУЛЯ + уведомление ему.

    Зеркало `_credit_referral_cashback` из subscriptions.py, с одним отличием:
    ⚠️ `client_bonus_transactions.source_order_id` имеет FK на `subscription_orders`,
    поэтому id заказа модуля туда передавать НЕЛЬЗЯ — вставка упала бы по FK и
    утащила бы за собой начисление. Заказ модуля называем в description.
    """
    if amount_paid_kopecks <= 0:
        return

    payer = await db.fetchrow(
        # ⚠️ `last_name` нужен для уведомления: с 09.09.2026 фамилия у
        # клиента есть, а в сообщении рефоводу шло только имя.
        "SELECT name, last_name, referred_by_client_id, referral_rate_percent, "
        "       referral_accrual_until "
        "FROM clients WHERE id = $1",
        payer_client_id,
    )
    if not payer or not payer["referred_by_client_id"]:
        return

    payer_full_name = display_name(payer["name"], payer["last_name"])

    # Ставка ЗАМОРОЖЕНА на плательщике при регистрации (миграция 227).
    from app.services.referral_rate import effective_percent
    percent = effective_percent(payer)
    if percent <= 0:
        return

    from app.services.bonuses import credit_bonus, calc_cashback_kopecks
    cashback = calc_cashback_kopecks(amount_paid_kopecks, percent=percent)
    if cashback <= 0:
        return

    # ⚠️ У features колонка называется `name`, колонки `title` нет.
    title = await db.fetchval(
        "SELECT COALESCE(name, slug) FROM features WHERE slug = $1", feature_slug
    ) if feature_slug else None
    what = f"модуль «{title}»" if title else "модуль"

    referrer_id = payer["referred_by_client_id"]
    new_balance = await credit_bonus(
        db,
        client_id=referrer_id,
        amount_kopecks=cashback,
        source_payer_id=payer_client_id,
        description=f"{percent}% от оплаты: {what}, клиент «{payer_full_name}»",
    )

    from app.services.plusson_referral_notify import notify_referrer_about_purchase
    await notify_referrer_about_purchase(
        db,
        referrer_client_id=referrer_id,
        payer_client_id=payer_client_id,
        payer_name=payer_full_name,
        what_paid=what,
        amount_kopecks=amount_paid_kopecks,
        percent=percent,
        cashback_kopecks=cashback,
        balance_kopecks=new_balance,
    )


# ─── Webhook LeadPay для аддонов ──────────────────────────────────────────────
# order_id приходит как `addon-{id}` (тот же id, что мы передали в getLink).

leadpay_webhook_router = APIRouter(prefix="/integrations/leadpay", tags=["Webhook LeadPay (модули)"])


@leadpay_webhook_router.post("/addon-webhook", summary="Webhook оплаты модуля LeadPay")
async def leadpay_addon_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    from app.services import leadpay

    form = await request.form()
    data = {k: str(v) for k, v in form.items()}
    order_id_raw = (data.get("order_id") or "").strip()
    status = (data.get("status") or "").strip().lower()

    logger.info("LeadPay addon webhook: order_id=%s status=%s", order_id_raw, status)

    if not leadpay.verify_webhook(data):
        logger.warning("LeadPay addon webhook: invalid hash (order_id=%s)", order_id_raw)
        raise HTTPException(status_code=401, detail="Invalid hash")

    if not order_id_raw.startswith("addon-"):
        return {"ok": True, "ignored": "not an addon order"}
    try:
        order_id = int(order_id_raw[len("addon-"):])
    except (ValueError, TypeError):
        return {"ok": True, "ignored": "bad order_id"}

    order = await db.fetchrow(
        "SELECT id, client_id, feature_id, months, status, bundle_with_pro, amount_total_kopecks "
        "FROM addon_orders WHERE id = $1",
        order_id,
    )
    if not order:
        return {"ok": True, "ignored": "order not found"}
    if order["status"] == "paid":
        return {"ok": True, "already_paid": True}

    is_success = status in ("success", "ok", "paid", "completed")
    if not is_success:
        await db.execute(
            "UPDATE addon_orders SET status='failed', prodamus_raw=$2::jsonb, updated_at=NOW() WHERE id=$1",
            order_id, json.dumps(data, ensure_ascii=False),
        )
        return {"ok": True, "status": "failed"}

    return await _apply_paid_addon_order(
        db, order=order, raw=data,
        order_num=data.get("card_id"), payment_type="leadpay",
    )
