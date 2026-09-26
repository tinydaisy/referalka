"""Аккаунты внедренцев в Авторассыльщике (mailer.pluson.ru) — миграция 517.

⚠️⚠️ ВЫДАЁТ И БЛОКИРУЕТ ВЛАДЕЛЕЦ КНОПКОЙ В АДМИНКЕ, а не автомат при
назначении/увольнении (решение 26.09.2026).

⚠️ Токен — из окружения `MAILER_API_TOKEN` (backend/.env на сервере), в git
его нет: с ним кто угодно заводил бы кабинеты в мейлере.

⚠️ Повторная регистрация той же почты мейлер отдаёт 409 `email_taken`, а НЕ
новый пароль — намеренно, иначе ручка была бы сбросом пароля любому. Такой
случай запоминаем как «аккаунт уже был» (почта есть, пароля нет).
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

MAILER_BASE_URL = (os.getenv("MAILER_BASE_URL") or "https://mailer.pluson.ru").rstrip("/")
MAILER_LOGIN_URL = f"{MAILER_BASE_URL}/login"


class MailerError(Exception):
    """Понятный человеку текст ошибки — показывается в админке как есть."""


def _token() -> str:
    tok = (os.getenv("MAILER_API_TOKEN") or "").strip()
    if not tok:
        raise MailerError("На сервере не задан MAILER_API_TOKEN — мейлер недоступен")
    return tok


async def register(email: str, name: Optional[str], full_name: Optional[str]) -> dict:
    """Заводит кабинет в мейлере.

    Возвращает {email, password|None, login_url, existed: bool}.
    `existed=True` — почта там уже была, пароль нам не известен.
    """
    body = {"email": email}
    if name:
        body["name"] = name
    if full_name:
        body["full_name"] = full_name
    try:
        async with httpx.AsyncClient(timeout=20) as cli:
            r = await cli.post(f"{MAILER_BASE_URL}/api/v1/register", json=body,
                               headers={"X-Api-Token": _token()})
    except httpx.HTTPError as e:
        logger.warning("mailer register %s: %s", email, e)
        raise MailerError("Мейлер не отвечает — попробуйте позже")

    data = {}
    try:
        data = r.json()
    except Exception:
        pass
    err = data.get("error") if isinstance(data, dict) else None

    if r.status_code == 201 and data.get("ok"):
        return {"email": data.get("email") or email,
                "password": data.get("password"),
                "login_url": data.get("login_url") or MAILER_LOGIN_URL,
                "existed": False}
    if r.status_code == 409 and err == "email_taken":
        return {"email": email, "password": None,
                "login_url": MAILER_LOGIN_URL, "existed": True}
    if r.status_code == 409 and err == "code_taken":
        raise MailerError("Код кабинета в мейлере занят — нужна регистрация вручную")
    if r.status_code == 401:
        raise MailerError("Мейлер не принял токен (MAILER_API_TOKEN неверный)")
    if r.status_code == 400:
        raise MailerError(f"Мейлер не принял почту {email} ({err or 'bad_request'})")
    logger.warning("mailer register %s: HTTP %s %s", email, r.status_code, r.text[:300])
    raise MailerError(f"Мейлер ответил ошибкой {r.status_code}")


async def block(email: str) -> None:
    """Закрывает доступ к аккаунту в мейлере.

    ⚠️ Ручки блокировки в мейлере пока НЕТ (26.09.2026) — владелец попросил её
    у мейлера и пришлёт описание. До тех пор честно отвечаем, что не умеем,
    а не делаем вид, что закрыли: иначе уволенный продолжал бы рассылать.
    """
    raise MailerError("Мейлер пока не умеет блокировать аккаунты — ждём от него "
                      "эндпойнт. Доступ НЕ закрыт.")
