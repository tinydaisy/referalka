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
  • Т-Банк (миграция 277) — ссылку выдаёт по сети (метод Init), но кода товара
    не требует: название и цена уходят в запросе. Сумма — В КОПЕЙКАХ.
Наружу все три ведут себя одинаково: `create_payment_link` возвращает адрес
оплаты, вебхук приходит с номером нашего заказа.

⚠️ Про «Т-Чеки». Это НЕ отдельная система, а сервис фискализации поверх
эквайринга Т-Банка: клиент включает его у себя в кабинете, и банк сам выдаёт
покупателям чеки. От нас нужно лишь передать состав заказа (объект `Receipt`)
в том же запросе `Init`. Поэтому мы передаём его ВСЕГДА: у кого сервис
включён — чек уйдёт, у кого нет — банк поле проигнорирует. Отдельной
настройки «включить Т-Чеки» у нас нет и не нужно.
"""
import hmac
import hashlib
import logging
from typing import Optional
from urllib.parse import urlencode

import httpx

logger = logging.getLogger(__name__)

LEADPAY_GETLINK_URL = "https://app.leadpay.ru/api/v1/getLink/"
TBANK_INIT_URL = "https://securepay.tinkoff.ru/v2/Init"

# Названия платёжных систем для интерфейса.
PROVIDERS = {
    "leadpay": "LeadPay",
    "prodamus": "Продамус",
    "tbank": "Эквайринг Т-Банка",
}

# У какой системы в тарифе нужен код товара. У Продамуса и Т-Банка название и
# цена уходят прямо в запросе — заводить товар заранее не нужно.
NEEDS_PRODUCT_ID = {"leadpay"}

# Системы налогообложения и ставки НДС для чека Т-Банка — значения из его
# документации. Нужны, только если у клиента включён сервис «Чеки».
TBANK_TAXATIONS = {
    "usn_income": "УСН «Доходы»",
    "usn_income_outcome": "УСН «Доходы минус расходы»",
    "osn": "Общая (ОСН)",
    "patent": "Патент",
    "esn": "ЕСХН",
}
TBANK_VATS = {
    "none": "Без НДС",
    "vat0": "НДС 0%",
    "vat5": "НДС 5%",
    "vat7": "НДС 7%",
    "vat10": "НДС 10%",
    "vat20": "НДС 20%",
}
# ⚠️ Пустые поля не должны срывать оплату — берём самый частый у наших
# клиентов случай.
TBANK_DEFAULT_TAXATION = "usn_income"
TBANK_DEFAULT_VAT = "none"


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
    if provider == "tbank":
        # ⚠️ Проверяем ту пару, которой реально будем платить: с включённой
        # галочкой теста боевые ключи не спасут — запрос уйдёт с тестовыми.
        terminal, password = tbank_keys(client)
        return bool(terminal and password)
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


# ─────────────────────────────────────────────────────────────────────────────
# Эквайринг Т-Банка (миграция 277)
# ─────────────────────────────────────────────────────────────────────────────
def tbank_keys(client: dict) -> tuple[str, str]:
    """Какой парой ключей работаем: тестовой или боевой.

    ⚠️ Тестовый терминал у Т-Банка — ОТДЕЛЬНАЯ пара ключей, а не флаг в
    запросе; адрес API один и тот же. Обе пары лежат рядом, выбор — галочкой.

    ⚠️ Единственная точка выбора. Если брать ключи напрямую из полей в разных
    местах, где-нибудь останется боевая пара при включённом тесте — и клиент
    проведёт настоящую оплату, думая, что проверяет.
    """
    if client.get("pay_tbank_test_mode"):
        return ((client.get("pay_tbank_test_terminal_key") or "").strip(),
                (client.get("pay_tbank_test_password") or "").strip())
    return ((client.get("pay_tbank_terminal_key") or "").strip(),
            (client.get("pay_tbank_password") or "").strip())


def _tbank_token(params: dict, password: str) -> str:
    """Подпись запроса по правилам Т-Банка.

    Алгоритм из документации: берём пары ключ-значение, добавляем `Password`,
    сортируем по КЛЮЧУ, склеиваем только ЗНАЧЕНИЯ без разделителей и берём
    SHA-256.

    ⚠️ Вложенные объекты (`Receipt`, `DATA`) в подписи НЕ участвуют — только
    поля верхнего уровня. Если их не исключить, подпись не сойдётся и банк
    ответит отказом.
    """
    flat = {
        k: v for k, v in params.items()
        if k != "Token" and not isinstance(v, (dict, list, tuple)) and v is not None
    }
    flat["Password"] = password
    raw = "".join(_tbank_str(flat[k]) for k in sorted(flat.keys()))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _tbank_str(value) -> str:
    """Значение в том виде, в каком оно уходит в запросе.

    ⚠️ Булево у Т-Банка — «true»/«false» строчными, а не питоновские
    «True»/«False»: иначе подпись разойдётся с тем, что посчитает банк.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def verify_tbank_webhook(payload: dict, *passwords: Optional[str]) -> bool:
    """Проверяет подпись нотификации Т-Банка (поле `Token` в теле).

    Считается так же, как подпись запроса: вложенные объекты не участвуют.

    ⚠️ Паролей может быть два — боевой и тестовый. Подходит любой: нотификация
    приходит с того терминала, на котором прошла оплата, а клиент мог
    переключить галочку уже после того, как заказ ушёл в оплату. Сверять
    только с текущим режимом значило бы терять такие оплаты.

    Ни одного пароля → False: приём оплаты не настроен, доверять нельзя.
    """
    received = str(payload.get("Token") or "").strip()
    if not received:
        return False
    for password in passwords:
        password = (password or "").strip()
        if not password:
            continue
        if hmac.compare_digest(
                _tbank_token(payload, password).lower(), received.lower()):
            return True
    return False


def _tbank_receipt(
    *,
    client: dict,
    title: str,
    amount_kop: int,
    email: Optional[str],
    phone: Optional[str],
) -> Optional[dict]:
    """Состав заказа для чека.

    ⚠️ Чеки выдаёт САМ банк (сервис «Чеки от Т-Бизнеса»), от нас нужны только
    данные. Передаём всегда: у кого сервис включён — чек уйдёт, у кого нет —
    банк поле проигнорирует.

    Нужен хотя бы один контакт покупателя (email или телефон) — без него банк
    чек не примет. Нет ни одного → чек не передаём вовсе, оплата пройдёт без
    фискализации (лучше принять деньги, чем сорвать оплату).
    """
    email = (email or "").strip()
    phone = (phone or "").strip()
    if not email and not phone:
        return None

    taxation = (client.get("pay_tbank_taxation") or "").strip() or TBANK_DEFAULT_TAXATION
    vat = (client.get("pay_tbank_vat") or "").strip() or TBANK_DEFAULT_VAT
    if taxation not in TBANK_TAXATIONS:
        taxation = TBANK_DEFAULT_TAXATION
    if vat not in TBANK_VATS:
        vat = TBANK_DEFAULT_VAT

    receipt: dict = {
        "Taxation": taxation,
        "Items": [{
            # Ограничение банка — 128 символов на название.
            "Name": (title or "Участие в событии")[:128],
            "Price": amount_kop,
            "Quantity": 1,
            "Amount": amount_kop,
            "Tax": vat,
            # Участие в событии — услуга, а не товар.
            "PaymentMethod": "full_payment",
            "PaymentObject": "service",
        }],
    }
    if email:
        receipt["Email"] = email
    if phone:
        receipt["Phone"] = phone
    return receipt


async def _tbank_link(
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
) -> str:
    """Просит у Т-Банка ссылку на оплату (метод Init)."""
    terminal, password = tbank_keys(client)

    # ⚠️ Сумма у Т-Банка В КОПЕЙКАХ. Округляем через Decimal: float дал бы
    # 1990.0 * 100 = 198999.99… и заказ ушёл бы на копейку дешевле.
    from decimal import Decimal, ROUND_HALF_UP
    try:
        amount_kop = int(
            (Decimal(str(price)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
        )
    except Exception:
        raise RuntimeError("У тарифа не указана цена")
    if amount_kop <= 0:
        raise RuntimeError("У тарифа не указана цена")

    params: dict = {
        "TerminalKey": terminal,
        "Amount": amount_kop,
        # Тот же префикс, что у остальных систем: по нему вебхук отличает
        # оплату тарифа события от оплаты подписки на платформу.
        "OrderId": f"evt-{order_id}",
        # Ограничение банка — 140 символов.
        "Description": (title or "Участие в событии")[:140],
        "NotificationURL": notification_url,
        "SuccessURL": redirect_url_ok,
        "FailURL": redirect_url_error,
    }
    params["Token"] = _tbank_token(params, password)

    # ⚠️ Receipt добавляется ПОСЛЕ подписи — вложенные объекты в неё не входят.
    receipt = _tbank_receipt(client=client, title=title, amount_kop=amount_kop,
                             email=email, phone=phone)
    if receipt:
        params["Receipt"] = receipt

    async with httpx.AsyncClient(timeout=20.0) as cli:
        resp = await cli.post(TBANK_INIT_URL, json=params)

    try:
        body = resp.json()
    except Exception:
        logger.error("Т-Банк (клиент %s): не JSON (%s): %s",
                     client.get("id"), resp.status_code, resp.text[:300])
        raise RuntimeError(f"Платёжная система вернула непонятный ответ (HTTP {resp.status_code})")

    if body.get("Success") and body.get("PaymentURL"):
        return body["PaymentURL"]

    desc = (body.get("Details") or body.get("Message")
            or body.get("ErrorCode") or "неизвестная ошибка")
    logger.error("Т-Банк (клиент %s) Init: %s", client.get("id"), desc)
    raise RuntimeError(f"Платёжная система: {desc}")


async def check_tbank_credentials(terminal_key: str, password: str) -> tuple[bool, str]:
    """Проверка ключей кнопкой «Проверить связь».

    Настоящую оплату не создаём — шлём заведомо негодную сумму (0). Если ключи
    верны, банк ответит про сумму; если неверны — про подпись или терминал.
    Ответ про сумму = ключи рабочие.
    """
    terminal_key = (terminal_key or "").strip()
    password = (password or "").strip()
    if not terminal_key or not password:
        return False, "Заполните Terminal Key и пароль терминала"

    params = {"TerminalKey": terminal_key, "Amount": 0, "OrderId": "check-0"}
    params["Token"] = _tbank_token(params, password)

    try:
        async with httpx.AsyncClient(timeout=15.0) as cli:
            resp = await cli.post(TBANK_INIT_URL, json=params)
        body = resp.json()
    except Exception as e:
        return False, f"Не удалось связаться с платёжной системой: {e}"

    if body.get("Success"):
        return True, "Связь есть"

    code = str(body.get("ErrorCode") or "").strip()
    text = str(body.get("Details") or body.get("Message") or "").strip()
    # 9 — «неверный токен», 7 — терминал не найден/заблокирован.
    if code in ("9", "7") or "токен" in text.lower() or "termina" in text.lower():
        return False, f"Ключи не подошли: {text or f'код {code}'}"
    # Всё остальное (жалоба на сумму) значит, что подпись принята.
    return True, "Связь есть, ключи приняты"


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

    if provider == "tbank":
        return await _tbank_link(
            client=client,
            order_id=order_id,
            title=title or "",
            price=price,
            notification_url=notification_url,
            redirect_url_ok=redirect_url_ok,
            redirect_url_error=redirect_url_error,
            email=email, phone=phone,
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
    if provider == "tbank":
        # Проверяем ту пару ключей, которой будем платить.
        terminal, password = tbank_keys(creds)
        return await check_tbank_credentials(terminal, password)
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
