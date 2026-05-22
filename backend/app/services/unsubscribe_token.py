"""
JWT-токены для ссылок отписки от email-рассылок.

Каждая ссылка в подвале письма содержит токен, который однозначно
идентифицирует (получатель × канал) и не раскрывает email/contact_id
напрямую в URL.

Не имеет срока жизни — ссылки в письмах должны работать долго,
даже через год после отправки.

Использует общий settings.jwt_secret + специальный kind='unsub_email',
чтобы исключить случайное использование auth-токена как unsubscribe-токена.
"""
import time
from typing import Optional
from jose import jwt, JWTError
from app.config import settings


_ALGORITHM = "HS256"
_KIND = "unsub_email"


def make_email_unsubscribe_token(
    *,
    client_id: int,
    contact_id: int,
    client_channel_id: int,
) -> str:
    """
    Создаёт токен для отписки от конкретной пары (получатель × email-канал клиента).

    client_channel_id — это id записи в client_channels (НЕ channels), потому что
    подписка в platform_user_channels привязана именно к client_channel_id.
    """
    payload = {
        "kind": _KIND,
        "cid": client_id,
        "co": contact_id,
        "cch": client_channel_id,
        "iat": int(time.time()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM)


def parse_email_unsubscribe_token(token: str) -> Optional[dict]:
    """
    Возвращает {client_id, contact_id, client_channel_id} или None если токен
    невалидный / не того kind.

    Не бросает исключения — возврат None любым каналом ошибки.
    """
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except (JWTError, Exception):
        return None
    if payload.get("kind") != _KIND:
        return None
    try:
        return {
            "client_id": int(payload["cid"]),
            "contact_id": int(payload["co"]),
            "client_channel_id": int(payload["cch"]),
        }
    except (KeyError, TypeError, ValueError):
        return None
