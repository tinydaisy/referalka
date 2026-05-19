"""
Валидация подписи launch params от VK Bridge.

VK Bridge при запуске Mini App передаёт во фрейме URL-параметры с префиксом `vk_`
(vk_user_id, vk_app_id, vk_is_app_user, vk_ts, vk_platform, ...). К ним прилагается
параметр `sign` — HMAC-SHA256(secure_key, query_string), base64url без `=`.

Документация VK: https://dev.vk.com/ru/mini-apps/development/launch-params

Используется и Mini App (передаёт первоначальные параметры на бэк), и эндпоинт `/api/v1/vk/event`,
который обязан проверить подпись прежде чем доверять `vk_user_id`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from urllib.parse import quote_plus
from typing import Mapping


def validate_vk_launch_params(params: Mapping[str, str], secure_key: str) -> bool:
    """
    Проверяет подпись launch params VK Bridge.

    :param params: словарь {ключ → значение}, обычно из query-string запуска Mini App.
        Должен содержать как минимум `sign` и хотя бы один `vk_*` параметр.
    :param secure_key: Защищённый ключ приложения (Secure Key из dev.vk.com).
    :return: True если подпись валидна. False иначе (включая отсутствие `sign` или ключа).
    """
    if not secure_key:
        return False
    sign = params.get("sign")
    if not sign:
        return False

    vk_params = sorted([(k, v) for k, v in params.items() if k.startswith("vk_")])
    if not vk_params:
        return False

    # VK строит query как k=urlencode(v) через amp, urlencode по правилам PHP urlencode (пробел = +)
    query = "&".join(f"{k}={quote_plus(str(v))}" for k, v in vk_params)
    expected = base64.urlsafe_b64encode(
        hmac.new(secure_key.encode("utf-8"), query.encode("utf-8"), hashlib.sha256).digest()
    ).decode("utf-8").rstrip("=")

    try:
        return hmac.compare_digest(expected, str(sign))
    except Exception:
        return False
