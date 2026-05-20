"""
Валидация launch params от MAX Mini App SDK (MAX Bridge).

MAX SDK подключается как:
    <script src="https://st.max.ru/js/max-web-app.js"></script>
и кладёт глобальный объект `window.WebApp` с полями:
    - initDataUnsafe.user.{user_id, first_name, last_name, username}
    - initDataUnsafe.start_param  (строка из ?startapp=...)
    - initData  (raw query-string, может быть подписана ботом)

Публичной документации формата подписи MAX пока нет (на 2026-05). Делаем по аналогии
с Telegram WebApp (HMAC-SHA256 от sorted init_data со ключом, производным от bot_token).
Если подпись не валидируется — данные принимаются, но `signed=False` — фронт получает
welcome, но критичные операции (выдача лид-магнита, регистрация) лучше делать через
дополнительные проверки.

Это сознательный компромисс на MVP — без публичной доки SDK нет другого пути.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any
from urllib.parse import parse_qsl

logger = logging.getLogger(__name__)


def parse_launch_params(init_data: str) -> dict[str, str]:
    """Разобрать raw init_data строку в словарь. Сохраняет порядок не важен,
    но повторяющиеся ключи запрещены (стандарт URLSearchParams).
    """
    if not init_data:
        return {}
    return dict(parse_qsl(init_data, keep_blank_values=True))


def _telegram_style_check(init_data: str, bot_token: str) -> bool:
    """Попытка валидации по Telegram-схеме:

    1. Парсим init_data в k=v пары.
    2. Удаляем поле `hash`.
    3. Сортируем оставшиеся по ключу, склеиваем как k=v\\nk=v...
    4. secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
    5. hash_check = HMAC_SHA256(key=secret, msg=data_check_string)
    6. Сравниваем с переданным `hash`.
    """
    params = parse_launch_params(init_data)
    received_hash = params.pop("hash", None)
    if not received_hash:
        return False
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    expected = hmac.new(secret, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, received_hash)


def validate_max_launch_params(
    init_data: str | None,
    *,
    bot_token: str | None = None,
) -> dict[str, Any]:
    """Главная функция валидации.

    :return: словарь:
      {
        "signed": bool,        # удалось ли подтвердить подпись
        "params": dict,        # все распарсенные параметры
        "user_id": int | None, # извлечённый из user или auth_user поля
        "start_param": str,    # содержимое ?startapp=
      }
    """
    params = parse_launch_params(init_data or "")
    signed = False
    if init_data and bot_token:
        try:
            signed = _telegram_style_check(init_data, bot_token)
        except Exception as e:
            logger.warning(f"MAX signature check raised: {e}")
            signed = False

    user_id = None
    raw_user_id = params.get("user_id") or params.get("auth_user_id")
    if raw_user_id:
        try:
            user_id = int(raw_user_id)
        except ValueError:
            user_id = None

    start_param = params.get("start_param") or params.get("startapp") or ""

    return {
        "signed": signed,
        "params": params,
        "user_id": user_id,
        "start_param": start_param,
    }


def parse_startapp_ref_payload(start_param: str) -> dict[str, str]:
    """Разобрать payload из ?startapp=ref_pg{slug}[_pid{ref_code}][_src{utm}][_tab{tab}]_reg.

    Возвращает словарь с ключами: event_slug, partner_ref_code, utm_source, tab, reg_from_landing.

    Пример входа: "ref_pgivision-7_pidabc123_srcinsta_tabgame"
    """
    out = {
        "event_slug": "",
        "partner_ref_code": "",
        "utm_source": "",
        "tab": "",
        "reg_from_landing": False,
    }
    if not start_param or not start_param.startswith("ref"):
        return out
    rest = start_param[3:]  # снимаем префикс "ref"
    if rest.startswith("_"):
        rest = rest[1:]
    parts = rest.split("_") if rest else []
    for part in parts:
        if part.startswith("pg"):
            out["event_slug"] = part[2:]
        elif part.startswith("pid"):
            out["partner_ref_code"] = part[3:]
        elif part.startswith("src"):
            out["utm_source"] = part[3:]
        elif part.startswith("tab"):
            out["tab"] = part[3:]
        elif part == "reg":
            out["reg_from_landing"] = True
    return out
