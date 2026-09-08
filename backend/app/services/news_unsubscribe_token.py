"""Токен отписки КЛИЕНТА платформы от писем с новостями ПЛЮСОНа.

⚠️ Отдельный вид токена, а не `unsubscribe_token.py`. Тот описывает пару
(контакт × email-канал клиента) — то есть отписку ЧЕЛОВЕКА ИЗ БАЗЫ клиента от
рассылок этого клиента. Здесь отписывается сам клиент платформы, у него нет ни
contact_id, ни client_channel_id в этом смысле. Подставить туда id клиента
значило бы отписать чужой контакт с тем же номером.

Срока жизни нет — ссылка в письме должна работать и через год.
"""
import time
from typing import Optional
from jose import jwt, JWTError
from app.config import settings

_ALGORITHM = "HS256"
_KIND = "unsub_news"


def make_news_unsubscribe_token(*, client_id: int) -> str:
    payload = {"kind": _KIND, "cid": client_id, "iat": int(time.time())}
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM)


def parse_news_unsubscribe_token(token: str) -> Optional[int]:
    """Возвращает client_id или None. Исключений не бросает."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except (JWTError, Exception):
        return None
    if payload.get("kind") != _KIND:
        return None
    try:
        return int(payload["cid"])
    except (KeyError, TypeError, ValueError):
        return None
