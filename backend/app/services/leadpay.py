"""Интеграция LeadPay — вторая платёжка для оплаты подписок/модулей ПЛЮСОНа.

Работает РЯДОМ с Prodamus (не заменяет его). Способ — API getLink.
Документация: https://leadpay.gitbook.io/api/dokumentaciya/api

Поток:
  1. `create_payment_link(...)` → POST https://app.leadpay.ru/api/v1/getLink/
     с параметрами login, id (наш order_id), product_id, count, notification_url,
     email/phone/fio + hash. Возвращает URL оплаты.
  2. LeadPay при оплате шлёт POST на notification_url:
     {status, summa, commission_sum, payable, order_id, hash [, card_id]}.
  3. `verify_webhook(payload)` проверяет hash → True/False.

Хэш (и для запроса, и для вебхука) — HMAC-SHA256:
  - собрать словарь параметров БЕЗ ключа `hash`
  - отсортировать ключи по алфавиту (ksort)
  - склеить значения БЕЗ разделителей
  - hmac_sha256(строка, LEADPAY_TOKEN).hexdigest()
"""
import os
import hmac
import hashlib
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Адрес лендинга в системе LeadPay (поле «Логин» в Настройки → Для внешних систем),
# например "https://app.leadpay.ru/23382/". Токен — «Секретный ключ» оттуда же.
LEADPAY_LOGIN = (os.getenv("LEADPAY_LOGIN") or "").strip()
LEADPAY_TOKEN = (os.getenv("LEADPAY_TOKEN") or "").strip()
LEADPAY_GETLINK_URL = os.getenv("LEADPAY_GETLINK_URL", "https://app.leadpay.ru/api/v1/getLink/").strip()
# ⚠️⚠️ ВСЕ НАШИ ОПЛАТЫ ИДУТ ЧЕРЕЗ v2 (15.09.2026). Он принимает название и
# сумму прямо в запросе — карточки товара заводить не нужно, а значит цена
# в ПЛЮСОНе не может разойтись с тем, что видит человек на странице оплаты.
# Проверено живым вызовом нашими платформенными ключами.
#
# ⚠️ Для работы v2 в кабинете LeadPay должны быть один раз выбраны способы
# приёма денег: Настройки → Варианты оплаты. Без них он отвечает «нет
# подходящих форм оплаты» — раньше способы брались из карточки товара.
LEADPAY_GETLINK_V2_URL = os.getenv(
    "LEADPAY_GETLINK_V2_URL", "https://app.leadpay.ru/api/v2/getLink/").strip()
# Проверку подписи вебхука можно временно выключить (LEADPAY_VERIFY_SIGNATURE=false).
LEADPAY_VERIFY_SIGNATURE = os.getenv("LEADPAY_VERIFY_SIGNATURE", "true").lower() not in ("0", "false", "no")


def is_configured() -> bool:
    """LeadPay готов к работе (задан логин и токен)."""
    return bool(LEADPAY_LOGIN and LEADPAY_TOKEN)


def compute_hash(params: dict) -> str:
    """HMAC-SHA256 по алгоритму LeadPay.

    Ключ `hash` (если есть) исключается. Остальные ключи сортируются по
    алфавиту, значения склеиваются без разделителей, подписываются токеном.
    """
    data = {k: v for k, v in params.items() if k != "hash" and v is not None}
    data_string = "".join(str(data[k]) for k in sorted(data.keys()))
    return hmac.new(
        LEADPAY_TOKEN.encode("utf-8"),
        data_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_webhook(payload: dict) -> bool:
    """Проверяет `hash` из вебхука LeadPay.

    payload — все поля запроса (dict). Считаем HMAC от остальных полей и
    сравниваем с присланным `hash`.
    """
    if not LEADPAY_VERIFY_SIGNATURE:
        logger.warning("LeadPay webhook: проверка подписи отключена (LEADPAY_VERIFY_SIGNATURE=false)")
        return True
    if not LEADPAY_TOKEN:
        logger.warning("LeadPay webhook: LEADPAY_TOKEN не задан — пропускаем проверку")
        return True
    received = (payload.get("hash") or "").strip()
    if not received:
        return False
    expected = compute_hash(payload)
    return hmac.compare_digest(expected.lower(), received.lower())


async def create_payment_link(
    *,
    order_id: int,
    product_id: Optional[str] = None,
    notification_url: str,
    count: int = 1,
    order_id_prefix: str = "",
    # Для v2: что и почём. Без карточки товара LeadPay берёт их из запроса.
    title: Optional[str] = None,
    price=None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    fio: Optional[str] = None,
    redirect_url_ok: Optional[str] = None,
    redirect_url_error: Optional[str] = None,
) -> str:
    """Создаёт платёжную ссылку через getLink LeadPay. Возвращает URL оплаты.

    order_id_prefix — префикс к нашему id в поле `id` LeadPay (для аддонов
    "addon-", чтобы вебхук различал заказ модуля от заказа подписки). Тот же
    префикс LeadPay вернёт в поле order_id вебхука.

    Бросает RuntimeError при ошибке (не сконфигурировано / LeadPay вернул error).
    """
    if not is_configured():
        raise RuntimeError("LeadPay не настроен (нет LEADPAY_LOGIN / LEADPAY_TOKEN)")

    # ⚠️⚠️ ДВЕ ВЕТКИ, и выбирает их наличие КАРТОЧКИ:
    #
    #   карточки НЕТ (норма с 15.09.2026) → v2: название и сумма идут в
    #       запросе. Так цена в ПЛЮСОНе не может разойтись с тем, что видит
    #       человек, и работают длинные периоды со скидкой.
    #   карточка ЕСТЬ → v1 по ней: цену задаёт LeadPay. Осталось для комплекта
    #       «Профи + модуль» и для заморозки цены, где карточка и есть носитель
    #       старой цены.
    #
    # ⚠️ У v2 `email` ОБЯЗАТЕЛЕН. У наших оплат он всегда есть — это почта
    # кабинета клиента, — но проверку оставляем явной: без неё запрос отвергнут
    # без внятного объяснения.
    use_v2 = not product_id
    if use_v2:
        if price is None:
            raise RuntimeError("Не задана цена — LeadPay не примет заказ")
        if not email:
            raise RuntimeError("Для оплаты через LeadPay нужен email клиента")
        try:
            price_str = f"{int(round(float(price)))}"
        except (TypeError, ValueError):
            raise RuntimeError("Нечитаемая цена заказа")
        params: dict = {
            "login": LEADPAY_LOGIN,
            "id": f"{order_id_prefix}{order_id}",
            "product_name": (title or "Оплата ПЛЮСОН")[:255],
            "product_price": price_str,
            "count": str(count),
            "email": email,
            "notification_url": notification_url,
        }
    else:
        # Параметры, участвующие в хэше. Только непустые (None не попадают в hash).
        params = {
            "login": LEADPAY_LOGIN,
            "id": f"{order_id_prefix}{order_id}",
            "product_id": str(product_id),
            "count": str(count),
            "notification_url": notification_url,
        }
    if email and "email" not in params:
        params["email"] = email
    if phone:
        params["phone"] = phone
    if fio:
        params["fio"] = fio
    if redirect_url_ok:
        params["redirect_url_ok"] = redirect_url_ok
    if redirect_url_error:
        params["redirect_url_error"] = redirect_url_error

    params["hash"] = compute_hash(params)

    async with httpx.AsyncClient(timeout=20.0) as cli:
        resp = await cli.post(
            LEADPAY_GETLINK_V2_URL if use_v2 else LEADPAY_GETLINK_URL, data=params)

    try:
        body = resp.json()
    except Exception:
        logger.error("LeadPay getLink: не JSON-ответ (%s): %s", resp.status_code, resp.text[:500])
        raise RuntimeError(f"LeadPay вернул некорректный ответ (HTTP {resp.status_code})")

    if body.get("status") == "success" and body.get("url"):
        return body["url"]

    desc = body.get("description") or body.get("message") or "неизвестная ошибка"
    logger.error("LeadPay getLink error: %s (HTTP %s, order_id=%s)", desc, resp.status_code, order_id)
    raise RuntimeError(f"LeadPay: {desc}")
