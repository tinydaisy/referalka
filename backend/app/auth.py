from datetime import datetime, timedelta
from typing import Optional
import bcrypt
from jose import JWTError, jwt
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.config import settings

security = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: Optional[str]) -> bool:
    # Аккаунт без пароля (password_hash = NULL) → просто «неверный пароль»,
    # а не 500. Раньше hashed=None ронял login с AttributeError.
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except (ValueError, TypeError):
        return False


def create_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=settings.jwt_expire_minutes))
    to_encode["exp"] = expire
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        raise HTTPException(status_code=401, detail="Неверный или просроченный токен")


async def get_current_client(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    return decode_token(credentials.credentials)


async def get_current_tech(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    """Тех-специалист (внедренец) — третий тип входа (миграция 391).

    ⚠️ В `sub` лежит id САМОГО специалиста, а не клиента: он видит срез данных
    платформы по закреплённым за ним клиентам, а не работает внутри кабинета.
    Этим он отличается от помощника, у которого в `sub` — id кабинета.
    """
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    if payload.get("role") != "tech":
        raise HTTPException(status_code=403, detail="Доступ только для тех-специалистов")
    return payload


async def get_current_admin(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    if payload.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Доступ запрещён — только для администраторов")
    return payload
