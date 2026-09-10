"""
Промокоды — ОДНА точка проверки и применения (миграция 397).

⚠️ ПРОВЕРКА ТОЛЬКО ЗДЕСЬ И ТОЛЬКО НА СЕРВЕРЕ. Скидка, посчитанная в браузере,
обходится обычным запросом мимо формы — на этом уже обжигались (два заказа
по 10 000 ₽ прошли из-за замка, который жил только в интерфейсе).

⚠️ ИМЕННОЙ И ОДНОРАЗОВЫЙ — ОДНА СУЩНОСТЬ. Разница в поле recipient_contact_id:
заполнено — примет только этот человек, пусто — любой, пока есть применения.
Двух механизмов рядом быть не должно, они разъедутся.

⚠️ ПРИМЕНЕНИЕ СЧИТАЕТСЯ ПО ОПЛАТЕ, а не по вводу кода. У LeadPay наоборот —
активация списывается при вводе, и лимит выгорает без единой продажи.
Порядок у нас: reserve (заказ создан) → apply (оплата подтверждена).
Отменённый заказ возвращает применение в лимит (release).

Как считается цена — см. tariff_discount.py. Промокод применяется К ЦЕНЕ,
которая УЖЕ содержит скидку тарифа (`price` в БД — цена к оплате).
"""
from __future__ import annotations

import logging
import re
import secrets
from typing import Any, Mapping, Optional

import asyncpg

logger = logging.getLogger(__name__)

# Алфавит генерации без похожих символов (0/O, 1/I/l) — коды диктуют голосом
# и переписывают руками, и «PLUS0N» вместо «PLUSON» станет вечным вопросом
# в поддержку. Тот же приём, что у коротких slug событий.
_GEN_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

MAX_CODE_LEN = 64

# Платёжные системы, с которыми наши промокоды работают.
# ⚠️ LeadPay в старом методе getLink цену не принимает — она лежит в его
# карточке товара. Работает через rest/v3/salebot/link, где product_price
# передаётся в запросе; при промокоде уходим туда (см. client_payments).
SUPPORTED_PROVIDERS = {"prodamus", "tbank", "leadpay"}


def normalize_code(code: str) -> str:
    """Как код лежит для сравнения: без пробелов, в верхнем регистре.

    Человек введёт «pluson20», « PLUSON20 » и «Pluson20» — это один код.
    Показываем при этом то написание, которое задал клиент.
    """
    return re.sub(r"\s+", "", (code or "")).upper()


def is_valid_code(code: str) -> bool:
    """Годится ли строка как промокод.

    Разрешаем латиницу, кириллицу, цифры, дефис и подчёркивание — как у
    LeadPay. Пробелы внутри запрещены: код диктуют и вводят руками.

    ⚠️ Проверяем ИСХОДНУЮ строку (только края обрезаем), а не нормализованную:
    normalize_code вырезает пробелы, и «SALE 20» молча стал бы «SALE20» —
    клиент диктовал бы людям одно, а в базе лежало бы другое.
    """
    raw = (code or "").strip()
    if not raw or len(raw) > MAX_CODE_LEN:
        return False
    return bool(re.fullmatch(r"[0-9A-Za-zА-Яа-яЁё_\-]+", raw))


def generate_code(prefix: str = "", length: int = 6) -> str:
    """Один случайный код для пачки именных/одноразовых."""
    body = "".join(secrets.choice(_GEN_ALPHABET) for _ in range(length))
    prefix = normalize_code(prefix)
    return f"{prefix}-{body}" if prefix else body


# ─────────────────────────────────────────────────────────────────────────────
# Расчёт
# ─────────────────────────────────────────────────────────────────────────────
def apply_discount(price: int, kind: str, value: int) -> int:
    """Цена после промокода. Никогда не ниже нуля.

    ⚠️ Ноль — законный результат, а не ошибка: код на 100% отдаёт доступ
    бесплатно, и платёжная система в этом случае НЕ дёргается (обе, Продамус
    и Т-Банк, нулевую сумму отвергают).
    """
    if price <= 0:
        return 0
    if kind == "percent":
        # Округляем В ПОЛЬЗУ ПОКУПАТЕЛЯ: обещали −20%, значит человек не должен
        # заплатить на рубль больше из-за округления вверх.
        discounted = price - int(price * value / 100)
    elif kind == "amount":
        discounted = price - value
    else:
        return price
    return max(0, discounted)


# ─────────────────────────────────────────────────────────────────────────────
# Проверка
# ─────────────────────────────────────────────────────────────────────────────
class PromoError(Exception):
    """Причина отказа, понятная покупателю. Текст показывается как есть."""


async def resolve(
    db: asyncpg.Connection,
    *,
    code: str,
    client_id: Optional[int],
    price: int,
    event_id: Optional[int] = None,
    product_id: Optional[int] = None,
    tariff_id: Optional[int] = None,
    tariff_kind: Optional[str] = None,
    contact_id: Optional[int] = None,
    email: Optional[str] = None,
    plan_slug: Optional[str] = None,
    for_plusson: bool = False,
) -> dict:
    """Проверить код и посчитать цену. Не пишет ничего — только читает.

    Возвращает {promo_id, code, price_before, price_after, discount_*}.
    Бросает PromoError с текстом для человека, если код не годится.

    ⚠️ `contact_id` приходит из браузера и НЕ является доказательством
    личности — по нему мы лишь узнаём человека, если он уже опознан ссылкой
    (?c=) или формой «Это вы?». Для ИМЕННОГО кода этого достаточно только
    вместе с проверкой принадлежности контакта этому клиенту (см. ниже).
    """
    norm = normalize_code(code)
    if not norm:
        raise PromoError("Введите промокод")

    row = await db.fetchrow(
        """SELECT * FROM promo_codes
            WHERE code_norm = $1
              AND (($2::int IS NULL AND client_id IS NULL)
                   OR client_id = $2)""",
        norm, client_id if not for_plusson else None,
    )
    if not row:
        raise PromoError("Такого промокода нет")

    _assert_alive(row)
    _assert_scope(row, event_id=event_id, product_id=product_id,
                  tariff_id=tariff_id, tariff_kind=tariff_kind,
                  plan_slug=plan_slug, for_plusson=for_plusson)
    await _assert_recipient(db, row, contact_id=contact_id, email=email,
                            client_id=client_id, for_plusson=for_plusson)

    price_after = apply_discount(price, row["discount_kind"], row["discount_value"])
    if price_after >= price:
        # Скидка ничего не меняет (например −0 или код на сумму больше цены,
        # уже нулевой). Молча пропускать нельзя — человек ждёт скидку.
        raise PromoError("Этот промокод не даёт скидки на выбранный тариф")

    return {
        "promo_id": row["id"],
        "code": row["code"],
        "discount_kind": row["discount_kind"],
        "discount_value": row["discount_value"],
        "price_before": price,
        "price_after": price_after,
        "is_free": price_after <= 0,
    }


def _assert_alive(row: Mapping[str, Any]) -> None:
    """Жив ли код: включён, в сроке, не исчерпан."""
    if not row["is_active"]:
        raise PromoError("Промокод больше не действует")

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    if row["starts_at"] and row["starts_at"] > now:
        raise PromoError("Промокод ещё не начал действовать")
    if row["ends_at"] and row["ends_at"] <= now:
        raise PromoError("Срок действия промокода истёк")

    if row["max_uses"] is not None and (row["used_count"] or 0) >= row["max_uses"]:
        raise PromoError("Промокод уже использован")


def _assert_scope(
    row: Mapping[str, Any], *,
    event_id: Optional[int], product_id: Optional[int],
    tariff_id: Optional[int], tariff_kind: Optional[str],
    plan_slug: Optional[str], for_plusson: bool,
) -> None:
    """На то ли он действует.

    ⚠️ Проверка идёт от УЗКОГО к ШИРОКОМУ: тариф → продукт/событие → всё.
    Заданный тариф означает, что событие и продукт проверять уже не нужно —
    тариф им и принадлежит.
    """
    # Код на подписку самого ПЛЮСОНа и код клиента — разные миры.
    if bool(row["plusson_subscription"]) != bool(for_plusson):
        raise PromoError("Этот промокод не подходит для этой покупки")

    if for_plusson:
        if row["scope_plan_slug"] and row["scope_plan_slug"] != plan_slug:
            raise PromoError("Этот промокод не действует на выбранный тариф")
        return

    if row["scope_tariff_id"] is not None:
        if row["scope_tariff_id"] != tariff_id or row["scope_tariff_kind"] != tariff_kind:
            raise PromoError("Этот промокод не действует на выбранный тариф")
        return

    if row["scope_event_id"] is not None:
        if row["scope_event_id"] != event_id:
            raise PromoError("Этот промокод не действует на это событие")
        return

    if row["scope_product_id"] is not None:
        if row["scope_product_id"] != product_id:
            raise PromoError("Этот промокод не действует на этот продукт")
        return

    # Ничего не задано — код «на всё».


async def _assert_recipient(
    db: asyncpg.Connection, row: Mapping[str, Any], *,
    contact_id: Optional[int], email: Optional[str],
    client_id: Optional[int], for_plusson: bool,
) -> None:
    """ИМЕННОЙ код — только своему человеку.

    ⚠️ Именно это отличает нас от всех трёх платёжек: у них код общий, и
    попавший в чужие руки сработает у любого.

    Человека опознаём двумя способами:
      • по contact_id — если он уже опознан ссылкой (?c=) или формой «Это вы?»;
      • по почте — решение владельца: незнакомого просим ввести почту, на
        которую выдан код (иначе именной код нельзя применить вовсе тому, кто
        пришёл по пересланной ссылке).
    """
    if for_plusson:
        target = row["recipient_client_id"]
        if target and target != client_id:
            raise PromoError("Этот промокод выдан другому пользователю")
        return

    target = row["recipient_contact_id"]
    if not target:
        return  # код не именной

    if contact_id and contact_id == target:
        return

    if email:
        # Почта — идентичность, а не колонка контакта (миграция 282).
        owner = await db.fetchval(
            """SELECT pu.contact_id FROM platform_users pu
                JOIN contacts c ON c.id = pu.contact_id
               WHERE pu.platform_slug = 'email'
                 AND LOWER(pu.platform_user_id) = LOWER($1)
                 AND c.client_id = $2
               ORDER BY pu.id LIMIT 1""",
            email.strip(), row["client_id"],
        )
        if owner == target:
            return

    raise PromoError(
        "Этот промокод выдан другому человеку. "
        "Если код ваш — укажите почту, на которую его выдали."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Резерв / списание / возврат
# ─────────────────────────────────────────────────────────────────────────────
async def reserve(
    db: asyncpg.Connection, *,
    promo_id: int,
    price_before: int,
    price_after: int,
    contact_id: Optional[int] = None,
    client_id: Optional[int] = None,
    event_order_id: Optional[int] = None,
    product_order_id: Optional[int] = None,
    subscription_order_id: Optional[int] = None,
    apply_now: bool = False,
) -> Optional[int]:
    """Занять применение под создаваемый заказ.

    ⚠️ Счётчик поднимается ПОД FOR UPDATE и с перепроверкой лимита: без этого
    два одновременных заказа проскочат мимо `max_uses = 1`, и одноразовый код
    сработает дважды. Тот же приём, что у промо-акций при регистрации.

    apply_now=True — цена стала нулевой, оплаты не будет: списываем сразу.
    """
    async with db.transaction():
        row = await db.fetchrow(
            "SELECT max_uses, used_count FROM promo_codes WHERE id = $1 FOR UPDATE",
            promo_id,
        )
        if not row:
            raise PromoError("Промокод больше не действует")
        if row["max_uses"] is not None and (row["used_count"] or 0) >= row["max_uses"]:
            raise PromoError("Промокод уже использован")

        await db.execute(
            "UPDATE promo_codes SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1",
            promo_id,
        )
        # applied_at заполняем только когда применение уже состоялось
        # (нулевая цена — оплаты не будет, ждать нечего).
        use_id = await db.fetchval(
            """INSERT INTO promo_code_uses
                   (promo_code_id, contact_id, client_id, event_order_id,
                    product_order_id, subscription_order_id,
                    price_before, price_after, status, applied_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                       CASE WHEN $9 = 'applied' THEN NOW() END)
               RETURNING id""",
            promo_id, contact_id, client_id, event_order_id,
            product_order_id, subscription_order_id,
            price_before, price_after,
            "applied" if apply_now else "reserved",
        )
        return use_id


async def mark_applied(
    db: asyncpg.Connection, *,
    event_order_id: Optional[int] = None,
    product_order_id: Optional[int] = None,
    subscription_order_id: Optional[int] = None,
) -> None:
    """Оплата подтверждена — резерв становится применением.

    ⚠️ Идемпотентно: повторный вебхук (норма для платёжек) ничего не ломает,
    счётчик уже поднят при резерве и второй раз не трогается.
    """
    if event_order_id:
        where, val = "event_order_id = $1", event_order_id
    elif product_order_id:
        where, val = "product_order_id = $1", product_order_id
    elif subscription_order_id:
        where, val = "subscription_order_id = $1", subscription_order_id
    else:
        return

    await db.execute(
        f"""UPDATE promo_code_uses
               SET status = 'applied', applied_at = COALESCE(applied_at, NOW())
             WHERE {where} AND status = 'reserved'""",
        val,
    )


async def release(
    db: asyncpg.Connection, *,
    event_order_id: Optional[int] = None,
    product_order_id: Optional[int] = None,
    subscription_order_id: Optional[int] = None,
) -> None:
    """Заказ отменён — применение возвращается в лимит.

    ⚠️ Возвращаем ТОЛЬКО из 'reserved'. Уже применённый (оплаченный) код
    вернуть нельзя: деньги прошли, скидка состоялась.
    """
    if event_order_id:
        where, val = "event_order_id = $1", event_order_id
    elif product_order_id:
        where, val = "product_order_id = $1", product_order_id
    elif subscription_order_id:
        where, val = "subscription_order_id = $1", subscription_order_id
    else:
        return

    async with db.transaction():
        rows = await db.fetch(
            f"""UPDATE promo_code_uses SET status = 'released'
                 WHERE {where} AND status = 'reserved'
             RETURNING promo_code_id""",
            val,
        )
        for r in rows:
            await db.execute(
                """UPDATE promo_codes
                      SET used_count = GREATEST(0, used_count - 1), updated_at = NOW()
                    WHERE id = $1""",
                r["promo_code_id"],
            )


def supported_by_provider(provider: Optional[str]) -> bool:
    """Работают ли наши промокоды с этой платёжной системой.

    ⚠️ Нужно, чтобы НЕ показывать покупателю поле промокода там, где оно
    ничего не сделает — пустое поле хуже отсутствующего.
    """
    return (provider or "").strip().lower() in SUPPORTED_PROVIDERS
