"""Периоды оплаты подписки: 1, 6 или 12 месяцев (миграция 360).

Одна точка расчёта на все места, где фигурирует цена периода: оплата картой
([subscriptions.py](../api/subscriptions.py)), оплата бонусами
([referrals.py](../api/referrals.py)) и витрина цен для кабинета
([pricing_public.py](../api/pricing_public.py)).

⚠️ Считать цену на месте нельзя — разъедется. Ровно на этом уже ошиблись
с процентами: «19 104 ₽» назвали скидкой 25%, хотя это 20%, и цифра в тексте
жила отдельно от суммы, которую человек платит.

Как устроено:
  • В тарифе хранится цена ЗА МЕСЯЦ для каждого периода (`price`, `price_6mo`,
    `price_12mo`) — её и показывают человеку («2 392 ₽/мес»).
  • Итог к оплате = цена за месяц × число месяцев.
  • Процент скидки НЕ хранится, а считается из цен. Поэтому подпись «−20%»
    физически не может разойтись с суммой.
  • У каждого периода своя карточка LeadPay: цена лежит в ней, а не в запросе.

⚠️ Продамус длинные периоды не поддерживает: у него ссылка на форму заводится
заранее под конкретную сумму, отдельных ссылок на 6 и 12 месяцев нет. Поэтому
`period_of` для него отдаёт только месячный вариант, а `assert_payable`
объясняет это по-русски.
"""
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

# Какие периоды вообще продаём. Порядок важен: в таком виде их показывает кабинет.
ALLOWED_MONTHS = (1, 6, 12)

# Колонки тарифа под каждый период: (цена за месяц, карточка LeadPay).
_COLUMNS = {
    1:  ("price",       "leadpay_product_id"),
    6:  ("price_6mo",   "leadpay_product_id_6mo"),
    12: ("price_12mo",  "leadpay_product_id_12mo"),
}


def normalize_months(value) -> int:
    """Приводит присланное значение к разрешённому периоду.

    ⚠️ Мусор и неизвестные периоды → 1 месяц, а не ошибка: клиент не должен
    упереться в отказ оплаты из-за кривого параметра. Оплата за месяц — самый
    безопасный исход, деньги не спишутся сверх ожидаемого.
    """
    try:
        m = int(value)
    except (TypeError, ValueError):
        return 1
    return m if m in ALLOWED_MONTHS else 1


def month_price(tariff, months: int) -> Optional[Decimal]:
    """Цена ЗА МЕСЯЦ при оплате за `months`. None — период у тарифа не заведён."""
    col = _COLUMNS.get(months, _COLUMNS[1])[0]
    raw = tariff[col] if col in tariff else None
    if raw is None:
        return None
    price = Decimal(str(raw))
    return price if price > 0 else None


def leadpay_product_id(tariff, months: int) -> Optional[str]:
    """Карточка LeadPay для этого периода. У каждого периода своя — в ней цена."""
    col = _COLUMNS.get(months, _COLUMNS[1])[1]
    val = tariff[col] if col in tariff else None
    val = (val or "").strip() if isinstance(val, str) else val
    return val or None


def total_kopecks(tariff, months: int) -> Optional[int]:
    """Сколько списать всего, в копейках.

    ⚠️ Только Decimal: у 6-месячных тарифов цена дробная (1751.20), и на float
    1751.20 * 6 * 100 даёт 1050719.9999… — заказ ушёл бы на копейку дешевле.
    """
    price = month_price(tariff, months)
    if price is None:
        return None
    total = (price * months * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(total)


def discount_percent(tariff, months: int) -> int:
    """На сколько процентов месяц дешевле, чем при помесячной оплате.

    Считается из цен, а не берётся из настройки — см. предупреждение в шапке.
    Округляется до целого: «−12%», «−20%».
    """
    base = month_price(tariff, 1)
    price = month_price(tariff, months)
    if not base or not price or months == 1:
        return 0
    pct = (Decimal(1) - price / base) * 100
    return int(pct.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def period_of(tariff, months: int, provider: str) -> dict:
    """Всё о выбранном периоде разом: цена, итог, карточка, скидка, продаётся ли.

    `payable` — можно ли оплатить период этим провайдером ПРЯМО СЕЙЧАС.

    ⚠️ Провайдер `bonus` (оплата бонусами) карточку LeadPay не требует — деньги
    наружу не уходят. Приравнять его к Продамусу нельзя: тогда бонусами
    нельзя было бы купить год, хотя картой — можно.
    """
    months = normalize_months(months)
    price = month_price(tariff, months)
    lp = leadpay_product_id(tariff, months)
    if provider == "leadpay":
        # ⚠️ Карточка больше НЕ обязательна (15.09.2026): сумма уходит в
        # запросе через api/v2/getLink. Прежнее `and bool(lp)` прятало период
        # от клиента, если карточка не заведена, — теперь достаточно цены.
        payable = price is not None
    elif provider == "bonus":
        payable = price is not None
    else:  # prodamus и всё остальное — только помесячно
        payable = price is not None and months == 1
    return {
        "months": months,
        "month_price": float(price) if price is not None else None,
        "total_kopecks": total_kopecks(tariff, months),
        "discount_percent": discount_percent(tariff, months),
        "leadpay_product_id": lp,
        "payable": payable,
    }


def periods_for(tariff, provider: str) -> list:
    """Все продаваемые периоды тарифа — для витрины кабинета.

    Отдаёт только те, что реально можно оплатить: период без цены или без
    карточки в списке не показывается, иначе клиент упрётся в отказ уже после
    выбора срока.
    """
    return [
        p for p in (period_of(tariff, m, provider) for m in ALLOWED_MONTHS)
        if p["payable"]
    ]


def affordable_months(tariff, balance_kopecks: int, provider: str):
    """Самый ДЛИННЫЙ период, который влезает в указанную сумму. None — никакой.

    Нужен подсказке при нехватке бонусов: правило «оплата только целиком»
    остаётся, но человеку называем срок, который ему уже доступен.
    """
    best = None
    for p in periods_for(tariff, provider):
        total = p["total_kopecks"]
        if total is not None and total <= balance_kopecks:
            best = p["months"]
    return best


def assert_payable(tariff, months: int, provider: str) -> dict:
    """То же, что `period_of`, но с понятным клиенту отказом. Бросает ValueError."""
    period = period_of(tariff, months, provider)
    if period["month_price"] is None:
        raise ValueError(
            f"Оплата за {months} мес. для этого тарифа не настроена — "
            "выберите другой срок."
        )
    if not period["payable"]:
        if provider == "prodamus" and months > 1:
            raise ValueError(
                "Оплата за несколько месяцев доступна только картой через LeadPay. "
                "Выберите оплату за 1 месяц."
            )
        raise ValueError(
            f"Для срока {months} мес. не настроена карточка оплаты — "
            "напишите в поддержку."
        )
    return period
