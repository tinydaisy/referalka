"""Клиент Zoom API — конференция под эфир вебинарной комнаты.

Зачем нужен. Связка «зум → наша комната» собирается руками и каждый раз
одинаково: завести конференцию, включить ей Custom Live Streaming, перенести
туда RTMP-адрес и ключ потока из кабинета, вернуть ссылку входа обратно в поле
`webinar_rooms.speaker_join_url`. Здесь это делается за один вызов.

⚠️⚠️ ЗУМ У КАЖДОГО КЛИЕНТА СВОЙ. Все функции принимают `client_id` и работают
токеном ИМЕННО ЭТОГО клиента (таблица `client_zoom_accounts`, миграция 444).
Конференции создаются в его аккаунте: у Zoom лимит одновременных конференций на
лицензию, и эфиры разных клиентов в одном аккаунте мешали бы друг другу.

В окружении сервера лежат только ключи ПРИЛОЖЕНИЯ ПЛЮСОНа в Zoom Marketplace
(`ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET`) — одно приложение на всех клиентов,
ровно как у VK и Instagram. Тип приложения — **General App** (OAuth), не
Server-to-Server.

⚠️ Токен доступа живёт 1 час, refresh — долго, НО Zoom выдаёт НОВЫЙ refresh при
каждом обмене и гасит прежний. Поэтому `_fresh_token` записывает оба и делает
это до того, как старый истёк, а не по факту ошибки 401.

Документация:
- согласие         GET   https://zoom.us/oauth/authorize
- обмен кода       POST  https://zoom.us/oauth/token?grant_type=authorization_code
- обновление       POST  https://zoom.us/oauth/token?grant_type=refresh_token
- создать встречу  POST  /users/me/meetings
- вещание          PATCH /meetings/{meetingId}/livestream
"""
from __future__ import annotations

import base64
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

ZOOM_API_BASE = "https://api.zoom.us/v2"
ZOOM_TOKEN_URL = "https://zoom.us/oauth/token"
ZOOM_AUTHORIZE_URL = "https://zoom.us/oauth/authorize"

# Права, которые запрашиваем у клиента.
#
# ⚠️ Список намеренно КОРОТКИЙ: каждое лишнее право придётся объяснять при
# проверке приложения в Zoom Marketplace, а неиспользуемые выглядят подозрительно.
#
# meeting:write   — создать конференцию и настроить ей вещание
# meeting:read    — прочитать её потом (проверка, что она ещё жива)
# user:read       — чей это аккаунт и какой тариф (ниже Pro вещания нет)
ZOOM_SCOPES = ["meeting:write", "meeting:read", "user:read"]


class ZoomError(Exception):
    """Ошибка со стороны Zoom, пригодная для показа человеку.

    ⚠️ Текст идёт прямо в кабинет, поэтому он на русском и без кодов: клиент,
    нажавший кнопку, должен понять, что делать дальше, а не искать в поиске
    «zoom error 3001».
    """


class ZoomNotConnected(ZoomError):
    """У клиента не подключён зум (или доступ отозван) — нужно пройти OAuth."""


def is_configured() -> bool:
    """Заданы ли ключи приложения ПЛЮСОНа в окружении.

    ⚠️ Пусто → кнопка «Подключить Zoom» не показывается вовсе. Показать её и
    уронить запрос в момент нажатия хуже: человек решит, что сломалась
    интеграция, а не что её не настраивали на сервере.
    """
    return bool(settings.zoom_client_id and settings.zoom_client_secret)


def _basic_auth() -> str:
    raw = f"{settings.zoom_client_id}:{settings.zoom_client_secret}".encode()
    return base64.b64encode(raw).decode()


# ─────────────────────────── OAuth ───────────────────────────
def oauth_url(state: str) -> str:
    """Ссылка на окно согласия Zoom.

    ⚠️ `redirect_uri` обязан совпадать с тем, что вписан в приложении Zoom,
    буква в букву — Zoom сверяет строку целиком, включая слэш на конце.
    """
    return f"{ZOOM_AUTHORIZE_URL}?" + urlencode({
        "response_type": "code",
        "client_id": settings.zoom_client_id,
        "redirect_uri": settings.zoom_oauth_redirect_uri,
        "state": state,
    })


async def exchange_code(code: str) -> dict:
    """Код из callback → токены доступа клиента."""
    return await _token_request({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.zoom_oauth_redirect_uri,
    })


async def _token_request(params: dict) -> dict:
    if not is_configured():
        raise ZoomError(
            "Zoom не настроен на сервере: нет ключей приложения "
            "ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET."
        )
    try:
        async with httpx.AsyncClient(timeout=30) as cli:
            r = await cli.post(
                ZOOM_TOKEN_URL,
                params=params,
                headers={"Authorization": f"Basic {_basic_auth()}"},
            )
    except Exception as e:
        raise ZoomError(f"Zoom не отвечает: {e}") from e

    data = _json_or_error(r)
    if r.status_code >= 400 or not data.get("access_token"):
        raise ZoomError(_human_error(data, "Zoom не выдал токен доступа"))
    return data


async def _save_tokens(db, client_id: int, data: dict) -> str:
    """Кладёт выданные токены клиенту и возвращает access_token.

    ⚠️ Пишем И access, И refresh: Zoom гасит прежний refresh при каждом обмене.
    Сохранить только access значит потерять возможность обновиться — и через
    час клиент «отвалится» без всякой причины.
    """
    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=int(data.get("expires_in") or 3600))
    await db.execute(
        "UPDATE client_zoom_accounts SET access_token=$1, refresh_token=$2, "
        " token_expires_at=$3, refresh_failed_at=NULL, refresh_error=NULL, updated_at=NOW() "
        "WHERE client_id=$4",
        data["access_token"], data.get("refresh_token") or "", expires_at, client_id,
    )
    return data["access_token"]


async def _fresh_token(db, client_id: int) -> str:
    """Живой access-token клиента: из базы, с обновлением по refresh при нужде.

    ⚠️ Обновляем ЗАРАНЕЕ (за 5 минут до истечения), а не по ошибке 401: запрос,
    начатый с токеном, истекающим через секунду, успеет протухнуть на полпути.
    """
    row = await db.fetchrow(
        "SELECT access_token, refresh_token, token_expires_at "
        "FROM client_zoom_accounts WHERE client_id=$1", client_id)
    if not row or not row["access_token"]:
        raise ZoomNotConnected("Zoom не подключён. Подключите его в «Настройки → Интеграция».")

    exp = row["token_expires_at"]
    if exp and exp > datetime.now(timezone.utc) + timedelta(minutes=5):
        return row["access_token"]

    if not row["refresh_token"]:
        raise ZoomNotConnected(
            "Доступ к Zoom истёк. Подключите Zoom заново в «Настройки → Интеграция».")

    try:
        data = await _token_request({
            "grant_type": "refresh_token",
            "refresh_token": row["refresh_token"],
        })
    except ZoomError as e:
        # Клиент отозвал доступ или удалил приложение — помечаем, чтобы кабинет
        # сказал «подключите заново», а не молчал до первого эфира.
        await db.execute(
            "UPDATE client_zoom_accounts SET refresh_failed_at=NOW(), refresh_error=$1, "
            " updated_at=NOW() WHERE client_id=$2", str(e)[:500], client_id)
        raise ZoomNotConnected(
            "Доступ к Zoom больше не действует. Подключите Zoom заново "
            "в «Настройки → Интеграция».") from e

    return await _save_tokens(db, client_id, data)


# ─────────────────────────── разбор ответов ───────────────────────────
def _json_or_error(r: httpx.Response) -> dict:
    try:
        return r.json() if r.content else {}
    except Exception:
        raise ZoomError(f"Zoom ответил не-JSON (код {r.status_code}): {r.text[:200]}")


def _human_error(data: dict, fallback: str) -> str:
    """Понятный текст ошибки Zoom для кабинета.

    Zoom кладёт причину то в `message`, то в `reason`, то в `errors[].message` —
    берём первое непустое. Код дописываем в скобках: по нему ищется
    документация, если объяснения не хватило.
    """
    msg = (data.get("message") or data.get("reason") or "").strip()
    if not msg:
        errs = data.get("errors")
        if isinstance(errs, list) and errs:
            first = errs[0]
            if isinstance(first, dict):
                msg = (first.get("message") or "").strip()
    if not msg:
        return fallback
    code = data.get("code")
    return f"{msg}" + (f" (код {code})" if code else "")


async def _request(db, client_id: int, method: str, path: str, **kw) -> dict:
    """Запрос к Zoom API от имени клиента."""
    token = await _fresh_token(db, client_id)
    try:
        async with httpx.AsyncClient(timeout=30) as cli:
            r = await cli.request(
                method, f"{ZOOM_API_BASE}{path}",
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json"},
                **kw,
            )
    except Exception as e:
        raise ZoomError(f"Zoom не отвечает: {e}") from e

    # 204 No Content — штатный ответ PATCH-ов Zoom, тела нет.
    if r.status_code == 204:
        return {}

    data = _json_or_error(r)
    if r.status_code == 401:
        raise ZoomNotConnected(
            "Zoom отклонил доступ. Подключите Zoom заново в «Настройки → Интеграция».")
    if r.status_code >= 400:
        raise ZoomError(_human_error(data, f"Zoom вернул ошибку {r.status_code}"))
    return data


# ─────────────────────────── операции ───────────────────────────
async def get_me(db, client_id: int) -> dict:
    """Владелец подключённого аккаунта — чей зум привязан и какой у него тариф."""
    return await _request(db, client_id, "GET", "/users/me")


async def get_me_with_token(access_token: str) -> dict:
    """То же, но токеном «на руках» — нужно в момент подключения.

    ⚠️ Отдельная функция: при первом обмене кода записи в базе ещё нет, а
    `_request` читает токен именно из неё. Так мы узнаём email и тариф ДО того,
    как создать строку — и сохраняем всё разом.
    """
    try:
        async with httpx.AsyncClient(timeout=30) as cli:
            r = await cli.get(
                f"{ZOOM_API_BASE}/users/me",
                headers={"Authorization": f"Bearer {access_token}"},
            )
    except Exception as e:
        raise ZoomError(f"Zoom не отвечает: {e}") from e
    data = _json_or_error(r)
    if r.status_code >= 400:
        raise ZoomError(_human_error(data, f"Zoom вернул ошибку {r.status_code}"))
    return data


async def create_meeting(
    db, client_id: int, *,
    topic: str,
    start_time_utc: Optional[str],
    duration_min: int,
    agenda: str = "",
) -> dict:
    """Создаёт конференцию в аккаунте клиента. Возвращает ответ Zoom как есть.

    ⚠️ `start_time` передаётся в UTC со суффиксом `Z` — тогда часовой пояс
    аккаунта Zoom на результат не влияет. Программа проекта живёт в МСК, перевод
    делает вызывающая сторона (единственное место, где вообще есть МСК).

    Настройки конференции выставляются СРАЗУ и осознанно:
    - `join_before_host` + `waiting_room=False` — спикер заходит и проверяет
      звук до ведущего. Зал ожидания тут только мешает: зрители в конференцию
      не ходят вовсе, они смотрят нашу комнату;
    - `mute_upon_entry` — вошедший не влетает в эфир своим фоном;
    - `auto_recording='none'` — запись ведёт НАШ MediaMTX. Вторая копия в
      облаке Zoom забивает его квоту и ничего не добавляет: нарезка по спикерам
      работает с нашим файлом.
    """
    body: dict[str, Any] = {
        "topic": topic[:200],                     # Zoom режет тему на 200 символах
        "type": 2 if start_time_utc else 3,        # 2 — на дату/время, 3 — бессрочная
        "duration": max(15, min(int(duration_min or 60), 1440)),
        "agenda": agenda[:2000],
        "settings": {
            "host_video": True,
            "participant_video": True,
            "join_before_host": True,
            "waiting_room": False,
            "mute_upon_entry": True,
            "auto_recording": "none",
        },
    }
    if start_time_utc:
        body["start_time"] = start_time_utc
        body["timezone"] = "UTC"

    return await _request(db, client_id, "POST", "/users/me/meetings", json=body)


async def set_livestream(db, client_id: int, meeting_id: str, *,
                         stream_url: str, stream_key: str) -> None:
    """Включает конференции вещание на наш RTMP (Custom Live Streaming).

    ⚠️ Zoom хранит адрес и ключ РАЗДЕЛЬНО и склеивает сам — ровно как в
    `webinar_service.rtmp_url()`, который отдаёт базу без ключа. Передать сюда
    адрес с ключом внутри значит получить путь `live/{key}/{key}`, которого
    плеер не найдёт: HLS ждёт `live/{key}`.

    ⚠️ Это НЕ запускает трансляцию — только настраивает. Кнопку «В эфир →
    Custom Live Streaming» ведущий всё равно жмёт в самом зуме; наш MediaMTX
    поймает поток и `runOnPublish` переведёт комнату в `live`.

    ⚠️ Требует у аккаунта Zoom тариф Pro и выше. На базовом Zoom отвечает
    ошибкой — её показываем как есть, она объясняет причину лучше нас.
    """
    await _request(
        db, client_id, "PATCH", f"/meetings/{meeting_id}/livestream",
        json={"stream_url": stream_url, "stream_key": stream_key, "page_url": ""},
    )


async def delete_meeting(db, client_id: int, meeting_id: str) -> None:
    """Удаляет конференцию. 404 считаем успехом — её уже нет, цель достигнута."""
    try:
        await _request(db, client_id, "DELETE", f"/meetings/{meeting_id}")
    except ZoomNotConnected:
        raise
    except ZoomError as e:
        txt = str(e).lower()
        if "3001" in txt or "not found" in txt or "does not exist" in txt:
            logger.info("Zoom: конференция %s уже удалена", meeting_id)
            return
        raise
