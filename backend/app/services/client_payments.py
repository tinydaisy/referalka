"""
Платёжная система КЛИЕНТА — приём оплаты за тарифы его событий (миграция 257).

⚠️ Не путать с платежами самого ПЛЮСОНа. `app/services/leadpay.py` работает на
НАШИХ ключах из переменных окружения — им клиенты оплачивают подписку на
платформу. Здесь ключи КАЖДОГО клиента из таблицы `clients`: ими покупатели
оплачивают тарифы его событий, и деньги идут ему.

Как это связывается (важно для понимания всей схемы):
  1. Человек на лендинге жмёт «Купить» → форма заказа → мы заводим/находим
     контакт и создаём заказ в `event_participant_tariffs` (status='unpaid').
  2. Просим у платёжной системы ссылку, передавая ТОЛЬКО номер нашего заказа.
     Ни контакт, ни событие наружу не уходят — всё лежит у нас в базе.
  3. После оплаты система дёргает наш вебхук с этим же номером → находим
     заказ, ставим 'paid', регистрируем участника.

Поэтому скрытые поля и GET-параметры (как было с GetCourse) больше не нужны:
опознаёт человека сама форма заказа.
"""
import hmac
import hashlib
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

LEADPAY_GETLINK_URL = "https://app.leadpay.ru/api/v1/getLink/"

# Названия платёжных систем для интерфейса.
PROVIDERS = {"leadpay": "LeadPay"}


def is_configured(client: dict) -> bool:
    """У клиента настроен приём оплаты."""
    if (client.get("pay_provider") or "") != "leadpay":
        return False
    return bool((client.get("pay_leadpay_login") or "").strip()
                and (client.get("pay_leadpay_token") or "").strip())


def _leadpay_hash(params: dict, token: str) -> str:
    """HMAC-SHA256 по алгоритму LeadPay: ключи по алфавиту, значения склеены
    без разделителей, без поля `hash`."""
    data = {k: v for k, v in params.items() if k != "hash" and v is not None}
    raw = "".join(str(data[k]) for k in sorted(data.keys()))
    return hmac.new(token.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_leadpay_webhook(payload: dict, token: str) -> bool:
    """Проверяет подпись вебхука. Пустой токен → не проверяем (не настроено)."""
    if not token:
        return False
    received = (payload.get("hash") or "").strip()
    if not received:
        return False
    return hmac.compare_digest(_leadpay_hash(payload, token).lower(), received.lower())


async def create_payment_link(
    *,
    client: dict,
    order_id: int,
    product_id: str,
    notification_url: str,
    redirect_url_ok: str,
    redirect_url_error: str,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    fio: Optional[str] = None,
) -> str:
    """Просит у платёжной системы клиента ссылку на оплату.

    В систему уходит только номер заказа с префиксом `evt-` — по нему вебхук
    отличит оплату тарифа события от оплаты подписки на платформу.

    Бросает RuntimeError с понятным текстом — вызывающий показывает его клиенту.
    """
    if not is_configured(client):
        raise RuntimeError("Платёжная система не подключена в настройках")
    if not product_id:
        raise RuntimeError("У тарифа не указан код товара в платёжной системе")

    login = (client["pay_leadpay_login"] or "").strip()
    token = (client["pay_leadpay_token"] or "").strip()

    params: dict = {
        "login": login,
        "id": f"evt-{order_id}",
        "product_id": str(product_id),
        "count": "1",
        "notification_url": notification_url,
        "redirect_url_ok": redirect_url_ok,
        "redirect_url_error": redirect_url_error,
    }
    if email:
        params["email"] = email
    if phone:
        params["phone"] = phone
    if fio:
        params["fio"] = fio

    params["hash"] = _leadpay_hash(params, token)

    async with httpx.AsyncClient(timeout=20.0) as cli:
        resp = await cli.post(LEADPAY_GETLINK_URL, data=params)

    try:
        body = resp.json()
    except Exception:
        logger.error("LeadPay (клиент %s): не JSON (%s): %s",
                     client.get("id"), resp.status_code, resp.text[:300])
        raise RuntimeError(f"Платёжная система вернула непонятный ответ (HTTP {resp.status_code})")

    if body.get("status") == "success" and body.get("url"):
        return body["url"]

    desc = body.get("description") or body.get("message") or "неизвестная ошибка"
    logger.error("LeadPay (клиент %s) getLink: %s", client.get("id"), desc)
    raise RuntimeError(f"Платёжная система: {desc}")


async def check_credentials(login: str, token: str) -> tuple[bool, str]:
    """Проверка ключей кнопкой «Проверить» в настройках.

    Настоящую ссылку не создаём — шлём заведомо несуществующий товар. Если
    ключи верны, LeadPay ответит про товар; если ключи неверны — про подпись
    или доступ. Ответ «не найден товар» = ключи рабочие.
    """
    login = (login or "").strip()
    token = (token or "").strip()
    if not login or not token:
        return False, "Заполните адрес лендинга и секретный ключ"

    params = {
        "login": login,
        "id": "check-0",
        "product_id": "0",
        "count": "1",
        "notification_url": "https://pluson.ru/api/v1/integrations/client-pay/leadpay",
    }
    params["hash"] = _leadpay_hash(params, token)

    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.post(LEADPAY_GETLINK_URL, data=params)
        body = resp.json()
    except Exception as e:
        return False, f"Не удалось связаться с платёжной системой: {e}"

    text = str(body.get("description") or body.get("message") or "").lower()
    # Ключи верны, если система дошла до проверки товара, а не отвергла подпись.
    if body.get("status") == "success":
        return True, "Связь есть"
    if "hash" in text or "подпис" in text or "login" in text or "досту" in text:
        return False, f"Ключи не подошли: {body.get('description') or text}"
    # «Товар не найден» и подобное — значит, ключи приняты.
    return True, "Связь есть, ключи приняты"
