"""
Заказ тарифа продукта: оформление, оплата, выдача доступа (миграция 290).

Зеркало `event_orders.py`, но постэффект другой: у события оплата = регистрация
участника, у продукта = ВЫДАЧА ДОСТУПА (`product_access`), после которой
человек видит материалы в своём кабинете.

⚠️ Номер заказа уходит в платёжку с префиксом `prd-<id>` (у событий `evt-`).
Вебхуки у обеих сущностей приходят на ОДИН роут — `webhook_path` в
client_payments жёстко один, — поэтому обработчик различает их по префиксу и
чужой тихо пропускает. Так же отсекается оплата подписки на саму платформу.

⚠️ Бесплатный тариф (цена 0 или пусто) заказа НЕ создаёт — доступ выдаётся
сразу. Иначе в заказах копился бы мусор из нулевых оплат.

Роуты:
  POST /api/v1/public/product-orders/create
  GET  /api/v1/public/product-orders/known/{tariff_id}/{contact_id}
  GET  /api/v1/public/product-orders/{order_id}
"""
import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from app.database import get_db
from app.services import client_payments
from app.services.client_domains import (
    client_public_url, public_url_for, platform_base_url,
)
from app.services.contact_merge import (
    find_or_create_contact, create_new_contact, resolve_or_ask,
    known_contact_fields, resolve_ref_code,
    sync_email_identity_and_subscription,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/public/product-orders", tags=["Заказы продуктов"])

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
    # Контакт известен из ссылки (пришёл из бота или письма).
    contact_id: Optional[int] = None
    # Человек выбрал себя на экране «Это вы?» (нашлось несколько совпадений).
    chosen_contact_id: Optional[int] = None
    # Ничего из найденного не подошло — создаём новый контакт.
    force_new: bool = False
    ref_code: Optional[str] = None
    utm_source: Optional[str] = None
    # ⚠️ Согласие на обработку ПД обязательно: без него форму не принимаем
    # (правило проекта — любая форма сбора данных с галочками согласий).
    consent_pd: bool = False
    consent_marketing: bool = False


async def load_product_tariff(db, tariff_id: int):
    """Тариф + продукт + владелец с ключами его платёжной системы.

    ⚠️ Ключи берутся у ВЛАДЕЛЬЦА продукта, а не из переменных окружения: там
    лежат ключи самого ПЛЮСОНа, которыми клиенты оплачивают подписку.
    Перепутать их — значит принять чужую оплату за свою.
    """
    return await db.fetchrow(
        """SELECT t.id, t.code, t.title, t.price, t.pay_url, t.pay_product_id,
                  t.is_active,
                  p.id AS product_id, p.slug AS product_slug,
                  p.title AS product_title, p.status AS product_status,
                  cl.id AS client_id, cl.name AS client_name,
                  cl.pay_provider, cl.pay_leadpay_login, cl.pay_leadpay_token,
                  cl.pay_prodamus_url, cl.pay_prodamus_secret,
                  cl.pay_tbank_terminal_key, cl.pay_tbank_password,
                  cl.pay_tbank_test_terminal_key, cl.pay_tbank_test_password,
                  cl.pay_tbank_test_mode,
                  cl.pay_tbank_taxation, cl.pay_tbank_vat
             FROM product_tariffs t
             JOIN products p ON p.id = t.product_id
             JOIN clients cl ON cl.id = p.client_id
            WHERE t.id = $1""",
        tariff_id,
    )


@router.options("/create", include_in_schema=False)
async def _opts(response: Response):
    _cors(response)
    return {}


@router.get("/known/{tariff_id}/{contact_id}", summary="Что мы уже знаем о заказчике")
async def order_known(
    tariff_id: int, contact_id: int, response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    """Подстановка в форму для того, кто уже есть в базе.

    ⚠️ Данные собирает общая `known_contact_fields` — та же, что питает анкету,
    заказ тарифа события и авторизацию вебинарной комнаты. Своего SELECT тут
    быть не должно: разъедется с остальными формами.
    """
    _cors(response)
    t = await load_product_tariff(db, tariff_id)
    if not t:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    return {"ok": True,
            "known": await known_contact_fields(db, t["client_id"], contact_id)}


async def grant_product_access(db, *, product_id: int, contact_id: int,
                               tariff_id: Optional[int], order_id: Optional[int],
                               source: str = "order") -> None:
    """Открыть человеку доступ к продукту.

    Идемпотентно: повторная выдача обновляет тариф, а не плодит строки.
    ⚠️ Доступ — отдельная сущность от заказа: его можно выдать и вручную
    (подарок, бартер, перенос базы), поэтому пишем сюда, а не помечаем заказ.
    """
    await db.execute(
        """INSERT INTO product_access
               (product_id, contact_id, tariff_id, order_id, source)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (product_id, contact_id)
           DO UPDATE SET tariff_id = EXCLUDED.tariff_id,
                         order_id  = COALESCE(EXCLUDED.order_id, product_access.order_id)""",
        product_id, contact_id, tariff_id, order_id, source,
    )


@router.post("/create", summary="Оформить заказ продукта")
async def create_order(
    data: OrderIn,
    response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)

    t = await load_product_tariff(db, data.tariff_id)
    if not t:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    if not t["is_active"]:
        raise HTTPException(status_code=400, detail="Этот тариф сейчас недоступен")
    if t["product_status"] != "published":
        raise HTTPException(status_code=404, detail="Продукт недоступен")

    if not data.consent_pd:
        raise HTTPException(
            status_code=400,
            detail="Нужно согласие на обработку персональных данных",
        )

    client_id = t["client_id"]
    product_id = t["product_id"]

    # ── Кого записываем ──
    # ⚠️ Единая точка резолва (contact_merge). Своих SELECT по email тут быть
    # не должно: каждая самодельная версия по-своему решает, кто есть кто,
    # и плодит дубли людей.
    contact_id: Optional[int] = None

    if data.contact_id:
        # Контакт зашит в ссылку — проверяем, что он принадлежит этому клиенту.
        ok = await db.fetchval(
            "SELECT id FROM contacts WHERE id = $1 AND client_id = $2 "
            "AND merged_into IS NULL",
            data.contact_id, client_id,
        )
        contact_id = ok or None

    if not contact_id and data.chosen_contact_id:
        ok = await db.fetchval(
            "SELECT id FROM contacts WHERE id = $1 AND client_id = $2 "
            "AND merged_into IS NULL",
            data.chosen_contact_id, client_id,
        )
        if not ok:
            raise HTTPException(status_code=400, detail="Контакт не найден")
        contact_id = ok
        # Человек подтвердил, что это он — дописываем то, чего у нас не было.
        if data.email:
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=contact_id,
                email=data.email, first_name=data.name,
            )
        if data.phone:
            # ⚠️ Только через set_contact_phone — см. contact_merge.
            from app.services.contact_merge import set_contact_phone
            await set_contact_phone(db, contact_id, data.phone)

    if not contact_id and data.force_new:
        contact_id = await create_new_contact(
            db, client_id=client_id, name=data.name, email=data.email,
            phone=data.phone, utm_source=data.utm_source,
        )

    if not contact_id:
        found, cands, can_new = await resolve_or_ask(
            db, client_id, data.email, data.phone, data.telegram_username,
        )
        if not found and cands:
            # ⚠️ Данные указывают на РАЗНЫХ людей — спрашиваем человека, а не
            # решаем за него: иначе заказ уйдёт не тому. Кандидаты приходят из
            # contact_merge уже с замаскированными email и телефоном — по
            # чужому адресу нельзя подсмотреть чужой номер.
            return {"ok": False, "need_choice": True,
                    "candidates": cands, "can_create_new": can_new}
        if not found:
            # ⚠️ find_or_create_contact возвращает ПАРУ (id, создан ли новый).
            # Раньше пара целиком уезжала в contact_id и дальше в SQL —
            # заказ падал 500 «tuple object cannot be interpreted as an
            # integer», и кнопка «Выбрать» не открывала оплату.
            found, _ = await find_or_create_contact(
                db, client_id=client_id, name=data.name, email=data.email,
                phone=data.phone, lookup_telegram_username=data.telegram_username,
                utm_source=data.utm_source,
            )
        contact_id = found

    # Кто привёл (?pid= в адресе страницы) — фиксируем у контакта.
    if data.ref_code:
        try:
            ref = await resolve_ref_code(db, client_id, data.ref_code)
            if ref and ref != contact_id:
                await db.execute(
                    "UPDATE contacts SET first_referrer_contact_id = "
                    "COALESCE(first_referrer_contact_id, $2) WHERE id = $1",
                    contact_id, ref,
                )
        except Exception as e:
            logger.warning("Реф-код %s не разобран: %s", data.ref_code, e)

    # Партнёрка: закрепление + получатель вознаграждения (миграции 346–348).
    #
    # ⚠️ Закрепление пишется В ОБОИХ режимах выплат. Даже в активном: иначе
    # при переключении кабинета на пассивный у всех окажется пусто, и он
    # включится «с нуля».
    #
    # ⚠️ Это НЕ то же, что first_referrer_contact_id выше. Там «кто привёл»
    # (любой человек), здесь — «кому платим» (только партнёр).
    partner_ref_code = None
    if contact_id:
        try:
            from app.services.partner_binding import try_bind_by_ref_code
            from app.services.partner_accrual import resolve_reward_recipient

            await try_bind_by_ref_code(
                db, client_id=client_id, contact_id=contact_id,
                ref_code=data.ref_code)
            partner_ref_code = await resolve_reward_recipient(
                db, client_id=client_id, buyer_contact_id=contact_id,
                referrer_ref_code=data.ref_code)
        except Exception as e:  # noqa: BLE001
            logger.warning("Партнёрка: получатель по продукту не определён: %s", e)

    price = t["price"] or 0

    # ── Бесплатный тариф: заказа нет, доступ сразу ──
    if price <= 0:
        await grant_product_access(
            db, product_id=product_id, contact_id=contact_id,
            tariff_id=t["id"], order_id=None, source="order",
        )
        base = await client_public_url(db, client_id)
        await _notify_access_granted(db, client_id, contact_id, product_id, t["id"])
        return {
            "ok": True, "free": True, "contact_id": contact_id,
            "redirect": public_url_for(base, f"/my/{t['product_slug']}"),
        }

    # ── Платный: создаём заказ ──
    order_id = await db.fetchval(
        """INSERT INTO product_orders
               (product_id, tariff_id, contact_id, status, source, amount,
                referrer_ref_code)
           VALUES ($1, $2, $3, 'unpaid', 'landing', $4, $5)
           ON CONFLICT (contact_id, tariff_id)
           DO UPDATE SET ordered_at = NOW(), amount = EXCLUDED.amount,
                         -- ⚠️ Получателя НЕ перетираем: заказ мог быть создан
                         -- раньше по чужой ссылке, и подменять того, кому
                         -- платить, повторным заходом нельзя (№ 13).
                         referrer_ref_code =
                             COALESCE(product_orders.referrer_ref_code,
                                      EXCLUDED.referrer_ref_code)
           RETURNING id""",
        product_id, t["id"], contact_id, price, partner_ref_code,
    )

    client = dict(t)
    base = await client_public_url(db, client_id)

    # Платёжка не подключена → внешняя ссылка тарифа, оплату клиент отмечает
    # руками. Так фича не блокируется отсутствием интеграции.
    if not client_payments.is_configured(client):
        if t["pay_url"]:
            await db.execute(
                "UPDATE product_orders SET payment_url = $2 WHERE id = $1",
                order_id, t["pay_url"],
            )
            return {"ok": True, "order_id": order_id,
                    "payment_url": t["pay_url"], "manual": True}
        raise HTTPException(
            status_code=400,
            detail="Оплата пока не настроена. Напишите организатору.",
        )

    try:
        pay_url, provider = await client_payments.create_payment_link(
            client=client,
            order_id=f"prd-{order_id}",          # ⚠️ свой префикс, см. шапку
            product_id=t["pay_product_id"],
            # ⚠️ Адрес вебхука — ВСЕГДА наш домен, не клиентский: оповещение
            # об оплате должно долетать независимо от того, что у клиента с
            # его доменом и сертификатом.
            base_url=platform_base_url(),
            redirect_url_ok=public_url_for(base, f"/thanks/product-order/{order_id}"),
            redirect_url_error=public_url_for(base, f"/pr/{t['product_slug']}"),
            title=f"{t['product_title']} — {t['title']}",
            price=price,
            email=data.email,
            phone=data.phone,
            fio=data.name,
        )
    except Exception as e:
        logger.error("Ссылка на оплату заказа %s не создана: %s", order_id, e)
        raise HTTPException(status_code=502, detail="Не удалось создать ссылку на оплату")

    await db.execute(
        "UPDATE product_orders SET payment_url = $2, payment_provider = $3 WHERE id = $1",
        order_id, pay_url, provider,
    )
    return {"ok": True, "order_id": order_id, "payment_url": pay_url}


@router.get("/{order_id}", summary="Страница «спасибо» по заказу")
async def order_thanks(
    order_id: int, response: Response,
    db: asyncpg.Connection = Depends(get_db),
):
    _cors(response)
    row = await db.fetchrow(
        """SELECT o.id, o.status, o.amount,
                  p.title AS product_title, p.slug AS product_slug,
                  p.client_id, t.title AS tariff_title
             FROM product_orders o
             JOIN products p        ON p.id = o.product_id
             JOIN product_tariffs t ON t.id = o.tariff_id
            WHERE o.id = $1""",
        order_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Заказ не найден")

    base = await client_public_url(db, row["client_id"])
    return {
        "ok": True,
        "status": row["status"],
        "product_title": row["product_title"],
        "tariff_title": row["tariff_title"],
        "amount": float(row["amount"]) if row["amount"] is not None else None,
        "cabinet_url": public_url_for(base, "/my"),
    }


async def _notify_access_granted(db, client_id: int, contact_id: int,
                                 product_id: int, tariff_id: Optional[int]) -> None:
    """Сообщить человеку, что доступ открыт — во все каналы сразу.

    Решение владельца: и в бот той площадки, откуда он пришёл, и на почту.
    ⚠️ Ссылка собирается через домен клиента, не литералом: иначе клиент
    раздаёт наш адрес вместо своего.
    """
    try:
        from app.services.product_notify import notify_product_access
        await notify_product_access(
            db, client_id=client_id, contact_id=contact_id,
            product_id=product_id, tariff_id=tariff_id,
        )
    except Exception as e:
        logger.warning("Уведомление о доступе к продукту %s не ушло: %s", product_id, e)


# ── Постэффект оплаты (зовётся из общего вебхука в event_orders) ──────────

async def mark_product_order_paid(db, order_id: int, provider: str,
                                  payment_id: Optional[str]) -> dict:
    """Заказ оплачен → выдаём доступ и уведомляем.

    Идемпотентно: платёжные системы шлют оповещение по нескольку раз.
    """
    order = await db.fetchrow(
        """SELECT o.id, o.status, o.product_id, o.tariff_id, o.contact_id,
                  o.amount, o.referrer_ref_code, p.client_id
             FROM product_orders o
             JOIN products p ON p.id = o.product_id
            WHERE o.id = $1""",
        order_id,
    )
    if not order:
        raise HTTPException(status_code=404, detail="Заказ не найден")
    if order["status"] == "paid":
        return {"ok": True, "paid": True, "already": True}

    await db.execute(
        """UPDATE product_orders
              SET status = 'paid', paid_at = NOW(), source = $2,
                  external_payment_id = $3
            WHERE id = $1""",
        order_id, provider, payment_id or None,
    )

    if order["contact_id"]:
        await grant_product_access(
            db, product_id=order["product_id"], contact_id=order["contact_id"],
            tariff_id=order["tariff_id"], order_id=order_id, source="order",
        )
        await _notify_access_granted(
            db, order["client_id"], order["contact_id"],
            order["product_id"], order["tariff_id"],
        )

    # Партнёрское вознаграждение (миграция 348).
    # ⚠️ Только здесь, в момент подтверждения оплаты (№ 27). Получатель уже
    # записан в product_orders.referrer_ref_code при создании заказа — там
    # жила развилка по режиму выплат, здесь только читаем (№ 36).
    # ⚠️ Смысл поля НЕ ТОТ, что у события: тут «кому платим» (только партнёр),
    # а не «кто привёл».
    try:
        from app.services.partner_accrual import accrue_for_order
        await accrue_for_order(
            db, client_id=order["client_id"], source_kind="product",
            source_order_id=order_id, buyer_contact_id=order["contact_id"],
            amount=order["amount"], tariff_id=order["tariff_id"],
            recipient_ref_code=order["referrer_ref_code"],
        )
    except Exception as e:
        logger.warning("Партнёрское начисление по заказу продукта %s не создано: %s",
                       order_id, e)

    logger.info("Заказ продукта %s оплачен (%s)", order_id, provider)
    return {"ok": True, "paid": True}


async def load_product_order_for_webhook(db, order_id: int):
    """Заказ + секреты владельца продукта — для проверки подписи вебхука."""
    return await db.fetchrow(
        """SELECT o.id, o.status, o.product_id, o.contact_id,
                  cl.pay_leadpay_token, cl.pay_prodamus_secret,
                  cl.pay_tbank_password, cl.pay_tbank_test_password
             FROM product_orders o
             JOIN products p ON p.id = o.product_id
             JOIN clients cl ON cl.id = p.client_id
            WHERE o.id = $1""",
        order_id,
    )
