"""
JWT-токен для связки контакта с его ПЛЮСОН-аккаунтом (команда /pluson_connect).

Флоу: человек в боте (TG/VK/MAX) пишет /pluson_connect → бот генерит этот токен
(в нём platform + user_id из АПДЕЙТА бота, где личность доказана платформой, +
client_id владельца бота) → отдаёт ссылку на форму pluson.ru/link-pluson?token=…
→ на форме человек вводит email/пароль ПЛЮСОНа (или регистрируется) → бэк по
токену находит его контакт и пишет contacts.linked_client_id → возврат в бот.

⚠️ Токен рождается ТОЛЬКО от факта, что человек сам написал команду в боте под
своим аккаунтом — подделать чужой user_id нельзя (id берётся из апдейта, не из
ввода). Это закрывает дыру «скинул чужую ссылку кабинета».

Живёт 1 час (одноразовость по времени — привязка это разовое действие).
"""
import time
from typing import Optional
from jose import jwt, JWTError
from app.config import settings


_ALGORITHM = "HS256"
_KIND = "pluson_connect"
_TTL_SECONDS = 3600  # 1 час


def make_pluson_connect_token(*, client_id: int, platform: str, user_id: str) -> str:
    payload = {
        "kind": _KIND,
        "cid": client_id,
        "pf": platform,          # 'telegram' | 'vk' | 'max'
        "uid": str(user_id),     # id человека на этой платформе (из апдейта бота)
        "iat": int(time.time()),
        "exp": int(time.time()) + _TTL_SECONDS,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM)


def parse_pluson_connect_token(token: str) -> Optional[dict]:
    """{client_id, platform, user_id} или None (невалидный/просроченный/не тот kind)."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except (JWTError, Exception):
        return None
    if payload.get("kind") != _KIND:
        return None
    try:
        return {
            "client_id": int(payload["cid"]),
            "platform": str(payload["pf"]),
            "user_id": str(payload["uid"]),
        }
    except (KeyError, TypeError, ValueError):
        return None
