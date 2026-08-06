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

⚠️ Системы устроены по-разному, и это единственное место, где разница видна:
  • LeadPay — есть метод getLink: спрашиваем ссылку по сети, в тарифе нужен
    код товара.
  • Продамус (миграция 269) — метода «дай ссылку» НЕТ. Ссылку собираем сами
    из адреса формы, параметров заказа и подписи; кода товара не нужно —
    название и цену передаём в самой ссылке.
Наружу оба ведут себя одинаково: `create_payment_link` возвращает адрес
оплаты, вебхук приходит с номером нашего заказа.
"""
import hmac
import hashlib
import logging
from typing import Optional
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

LEADPAY_GETLINK_URL = "https://app.leadpay.ru/api/v1/getLink/"

# Названия платёжных систем для интерфейса.
PROVIDERS = {"leadpay": "LeadPay", "prodamus": "Продамус"}

# У какой системы в тарифе нужен код товара. У Продамуса название и цена
# уходят прямо в ссылке — заводить товар заранее не нужно.
NEEDS_PRODUCT_ID = {"leadpay"}


def provider_of(client: dict) -> Optional[str]:
    """Какая платёжная система выбрана. Неизвестная — как не выбранная."""
    p = (client.get("pay_provider") or "").strip().lower()
    return p if p in PROVIDERS else None


def is_configured(client: dict) -> bool:
    """У клиента настроен приём оплаты."""
    provider = provider_of(client)
    if provider == "leadpay":
        return bool((client.get("pay_leadpay_login") or "").strip()
                    and (client.get("pay_leadpay_token") or "").strip())
    if provider == "prodamus":
        return bool((client.get("pay_prodamus_url") or "").strip()
                    and (client.get("pay_prodamus_secret") or "").strip())
    return False


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


# ─────────────────────────────────────────────────────────────────────────────
# Продамус
# ─────────────────────────────────────────────────────────────────────────────
def _prodamus_normalize(value):
    """Приводит данные к виду, в котором Продамус считает подпись.

    ⚠️ Порядок действий важен: булево становится «1»/«0», числа — строкой,
    None — пустой строкой, ключи словарей сортируются на КАЖДОМ уровне
    вложенности (в товарах вложенность есть). Иначе подпись не сойдётся,
    а Продамус в ответ просто откажет в оплате без объяснения.
    """
    if isinstance(value, bool):
        return "1" if value else "0"
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        return {k: _prodamus_normalize(value[k]) for k in sorted(value.keys(), key=str)}
    if isinstance(value, (list, tuple)):
        # Список у Продамуса — это словарь с числовыми ключами.
        return {str(i): _prodamus_normalize(v) for i, v in enumerate(value)}
    return str(value)


def _prodamus_sign(data: dict, secret: str) -> str:
    """HMAC-SHA256 от JSON нормализованных данных (без поля `signature`)."""
    import json

    payload = _prodamus_normalize(
        {k: v for k, v in data.items() if k not in ("signature", "sign")}
    )
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"),
                     sort_keys=True).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()


def verify_prodamus_webhook(payload: dict, signature: Optional[str], secret: str) -> bool:
    """Проверяет подпись вебхука Продамуса (заголовок `Sign`).

    Пустой ключ → False: у клиента приём оплаты не настроен, доверять
    такому вебхуку нельзя.
    """
    if not secret or not signature:
        return False
    expected = _prodamus_sign(payload, secret)
    return hmac.compare_digest(expected.lower(), signature.strip().lower())


def _prodamus_link(
    *,
    client: dict,
    order_id: int,
    title: str,
    price,
    notification_url: str,
    redirect_url_ok: str,
    redirect_url_error: str,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    fio: Optional[str] = None,
) -> str:
    """Собирает ссылку на оплату Продамуса.

    ⚠️ Метода «дай ссылку» у Продамуса нет — адрес формируем сами и
    подписываем. Товар в кабинете заводить не нужно: название и цена уходят
    прямо в ссылке.
    """
    base = (client.get("pay_prodamus_url") or "").strip().rstrip("/")
    secret = (client.get("pay_prodamus_secret") or "").strip()
    if not base:
        raise RuntimeError("Не указан адрес формы оплаты Продамуса")
    if not base.startswith("http"):
        base = f"https://{base}"

    try:
        amount = f"{float(price):.2f}"
    except (TypeError, ValueError):
        raise RuntimeError("У тарифа не указана цена")

    params: dict = {
        # Номер заказа с тем же префиксом, что у LeadPay: по нему вебхук
        # отличает оплату тарифа события от оплаты подписки на платформу.
        "order_id": f"evt-{order_id}",
        "products[0][name]": title or "Участие в событии",
        "products[0][price]": amount,
        "products[0][quantity]": "1",
        "urlReturn": redirect_url_error,
        "urlSuccess": redirect_url_ok,
        "urlNotification": notification_url,
        # Ссылка ведёт сразу на оплату, а не на JSON с её описанием.
        "do": "pay",
        "sys": "pluson",
    }
    if email:
        params["customer_email"] = email
    if phone:
        params["customer_phone"] = phone
    if fio:
        params["customer_extra"] = fio

    if secret:
        params["signature"] = _prodamus_sign(params, secret)

    return f"{base}/?{urlencode(params)}"


async def check_prodamus_credentials(url: str, secret: str) -> tuple[bool, str]:
    """Проверка настроек Продамуса.

    ⚠️ Проверить ключ по сети нельзя — у Продамуса нет метода, который бы
    сказал «ключ верный». Поэтому проверяем то, что реально можно: адрес
    формы отвечает и похож на платёжную форму. Про ключ честно предупреждаем,
    что он сойдётся только на первой настоящей оплате.
    """
    url = (url or "").strip()
    secret = (secret or "").strip()
    if not url or not secret:
        return False, "Заполните адрес формы оплаты и секретный ключ"
    if not url.startswith("http"):
        url = f"https://{url}"

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as cli:
            resp = await cli.get(url)
    except Exception as e:
        return False, f"Адрес формы не отвечает: {e}"

    if resp.status_code >= 400:
        return False, f"Адрес формы вернул ошибку {resp.status_code} — проверьте адрес"

    return True, ("Форма оплаты доступна. Ключ проверится на первой оплате — "
                  "если он неверный, оплата не подтвердится.")


def webhook_path(provider: str) -> str:
    """Адрес нашего вебхука для этой системы. У каждой свой — форматы
    оповещения и проверка подписи разные."""
    return f"/api/v1/integrations/client-pay/{provider}"


async def create_payment_link(
    *,
    client: dict,
    order_id: int,
    product_id: Optional[str],
    base_url: str,
    redirect_url_ok: str,
    redirect_url_error: str,
    title: Optional[str] = None,
    price=None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    fio: Optional[str] = None,
) -> tuple[str, str]:
    """Даёт ссылку на оплату у платёжной системы клиента.

    Возвращает пару `(ссылка, название системы)` — название пишем в заказ,
    чтобы потом было видно, чем платили.

    В систему уходит только номер заказа с префиксом `evt-` — по нему вебхук
    отличит оплату тарифа события от оплаты подписки на платформу.

    Бросает RuntimeError с понятным текстом — вызывающий показывает его клиенту.
    """
    provider = provider_of(client)
    if not is_configured(client):
        raise RuntimeError("Платёжная система не подключена в настройках")

    notification_url = base_url.rstrip("/") + webhook_path(provider)

    if provider == "prodamus":
        return _prodamus_link(
            client=client,
            order_id=order_id,
            title=title or "",
            price=price,
            notification_url=notification_url,
            redirect_url_ok=redirect_url_ok,
            redirect_url_error=redirect_url_error,
            email=email, phone=phone, fio=fio,
        ), provider

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
        return body["url"], provider

    desc = body.get("description") or body.get("message") or "неизвестная ошибка"
    logger.error("LeadPay (клиент %s) getLink: %s", client.get("id"), desc)
    raise RuntimeError(f"Платёжная система: {desc}")


async def check_credentials(provider: Optional[str], creds: dict) -> tuple[bool, str]:
    """Кнопка «Проверить связь» в настройках — общий вход для всех систем."""
    provider = (provider or "").strip().lower()
    if provider == "prodamus":
        return await check_prodamus_credentials(
            creds.get("pay_prodamus_url") or "", creds.get("pay_prodamus_secret") or "")
    if provider == "leadpay":
        return await check_leadpay_credentials(
            creds.get("pay_leadpay_login") or "", creds.get("pay_leadpay_token") or "")
    return False, "Сначала выберите платёжную систему"


async def check_leadpay_credentials(login: str, token: str) -> tuple[bool, str]:
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
