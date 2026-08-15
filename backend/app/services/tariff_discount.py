"""Скидка тарифа — одна точка расчёта (миграция 305).

⚠️ `price` в БД — это ЦЕНА К ОПЛАТЕ (уже со скидкой). Именно она уходит
в платёжную систему и в `amount` заказа. Старая (зачёркнутая) цена НЕ хранится,
а вычисляется здесь — иначе при смене цены она молча разъехалась бы с реальностью.

Формула живёт только тут: точек отдачи тарифа наружу девять (лендинг события,
лендинг продукта, витрина продукта, виджет для внешних сайтов, форма заказа,
кабинет…), и посчитанная на месте скидка неминуемо разошлась бы между ними.
"""

from typing import Any, Mapping, Optional


def old_price(price: Optional[int], kind: Optional[str], value: Optional[int]) -> Optional[int]:
    """Цена ДО скидки — та, что показывается зачёркнутой.

    Возвращает None, если скидки нет или она бессмысленна: считать «старой»
    цену, равную нынешней (или меньше её), нельзя — на лендинге появились бы
    две одинаковые цифры, одна зачёркнутая.
    """
    if not kind or not value or value <= 0:
        return None
    if price is None or price < 0:
        return None

    if kind == "percent":
        if value >= 100:
            return None
        # price = old * (100 - value) / 100  →  old = price * 100 / (100 - value)
        old = round(price * 100 / (100 - value))
    elif kind == "amount":
        old = price + value
    else:
        return None

    return old if old > price else None


def discount_percent(price: Optional[int], kind: Optional[str], value: Optional[int]) -> Optional[int]:
    """Скидка в процентах — для бейджа «−20%» независимо от способа ввода."""
    old = old_price(price, kind, value)
    if old is None or old <= 0:
        return None
    pct = round((old - (price or 0)) * 100 / old)
    return pct if pct > 0 else None


def with_discount(row: Mapping[str, Any]) -> dict:
    """Дописать в отданный наружу тариф вычисляемые поля скидки.

    Зовётся во ВСЕХ точках, где тариф уходит клиенту или покупателю.
    Считает по своим же ключам, поэтому безопасна для любого SELECT,
    где есть price / discount_kind / discount_value.
    """
    d = dict(row)
    price = d.get("price")
    kind = d.get("discount_kind")
    value = d.get("discount_value")
    d["old_price"] = old_price(price, kind, value)
    d["discount_percent"] = discount_percent(price, kind, value)
    return d
