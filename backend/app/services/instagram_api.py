"""
Клиент Meta Graph API для Instagram.

Первый этап фичи: только ПОДКЛЮЧЕНИЕ аккаунта (OAuth + резолв Instagram-аккаунта
по странице Facebook). Работа с комментариями и директом — следующим этапом,
план в documentation/INSTAGRAM-FUNNEL-PLAN.md

⚠️⚠️ ТОЛЬКО домен graph.facebook.com — «Instagram API with Facebook Login».
Проверено на прод-сервере 2026-09-03: graph.instagram.com и api.instagram.com
оттуда не отвечают вовсе (таймаут, заблокированы). Новый способ Meta
«Instagram API with Instagram Login» живёт на этих доменах, поэтому у нас он
работать НЕ БУДЕТ без зарубежного прокси. Не переписывать на них «как в новой
документации» — сломается молча, на живых клиентах.

⚠️ Аккаунт клиента обязан быть профессиональным (Бизнес/Автор) и связан со
страницей Facebook: доступ выдаётся через страницу, а не через сам Instagram.

Документация: https://developers.facebook.com/docs/instagram-platform
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

# Разрешения, которые нужны фиче.
#
# ⚠️⚠️ В ЗАПРОС НЕ ПЕРЕДАЮТСЯ. В Business Login разрешения выбираются руками
# в кабинете Meta при создании конфигурации, а ссылка на вход несёт только её
# `config_id` (см. `oauth_url`). Список ниже — справочный: он говорит, что
# должно быть отмечено в конфигурации, и служит ответом на вопрос клиента
# «что именно вы получаете о моём аккаунте».
#
# ⚠️ Список намеренно КОРОТКИЙ. Каждое лишнее разрешение придётся объяснять при
# проверке Meta (App Review), а неиспользуемые выглядят подозрительно и
# затягивают одобрение.
#
# instagram_basic              — узнать сам аккаунт: id, ник, число подписчиков
# instagram_manage_comments    — читать комментарии и отвечать на них
# instagram_manage_messages    — писать в директ (в пределах 24-часового окна)
# pages_show_list              — список страниц Facebook (без него не найти,
#                                с какой страницей связан Instagram)
# pages_read_engagement        — читать данные страницы
# pages_manage_metadata        — подписать страницу на вебхуки
IG_SCOPES = [
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_manage_messages",
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_metadata",
]


class InstagramApiError(RuntimeError):
    """Meta вернула ошибку. `user_message` — текст, пригодный для показа клиенту."""

    def __init__(self, message: str, *, user_message: str | None = None,
                 code: int | None = None, subcode: int | None = None):
        super().__init__(message)
        self.user_message = user_message or message
        self.code = code
        self.subcode = subcode


def is_configured() -> bool:
    """Заведены ли ключи приложения Meta в окружении.

    ⚠️ `config_id` в проверке обязателен наравне с ключами: без него окно
    Facebook откроется, но БЕЗ единого разрешения — человек пройдёт вход
    и упрётся в «нет доступа» уже после, когда причину не видно.
    """
    return bool(settings.ig_app_id and settings.ig_app_secret and settings.ig_config_id)


def _base() -> str:
    ver = settings.ig_graph_version or "v21.0"
    return f"https://graph.facebook.com/{ver}"


async def graph_get(
    path: str,
    *,
    token: str,
    params: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """GET к Graph API.

    :raises InstagramApiError: если Meta вернула поле `error`.
    """
    url = f"{_base()}/{path.lstrip('/')}"
    query = dict(params or {})
    query["access_token"] = token
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.get(url, params=query)
    return _unwrap(resp, path)


async def graph_post(
    path: str,
    *,
    token: str,
    data: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """POST к Graph API."""
    url = f"{_base()}/{path.lstrip('/')}"
    body = dict(data or {})
    body["access_token"] = token
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.post(url, data=body)
    return _unwrap(resp, path)


def _unwrap(resp: httpx.Response, path: str) -> dict[str, Any]:
    """Разобрать ответ Meta и превратить ошибку в понятную человеку.

    ⚠️ Meta отдаёт ошибки С КОДОМ 200 в теле — проверять только по статусу
    нельзя, придётся читать поле `error` всегда.
    """
    try:
        payload = resp.json()
    except Exception:
        raise InstagramApiError(
            f"Graph API {path}: неразборчивый ответ ({resp.status_code})",
            user_message="Instagram ответил непонятно. Попробуйте ещё раз.",
        )

    if isinstance(payload, dict) and payload.get("error"):
        err = payload["error"]
        code = err.get("code")
        subcode = err.get("error_subcode")
        raw = err.get("message") or "неизвестная ошибка"
        logger.warning("Graph API %s → error %s/%s: %s", path, code, subcode, raw)
        raise InstagramApiError(
            f"Graph API {path}: {raw}",
            user_message=_human_error(code, subcode, raw),
            code=code,
            subcode=subcode,
        )

    if resp.status_code >= 400:
        raise InstagramApiError(
            f"Graph API {path}: HTTP {resp.status_code}",
            user_message="Instagram временно недоступен. Попробуйте позже.",
        )

    return payload if isinstance(payload, dict) else {"data": payload}


def _human_error(code: int | None, subcode: int | None, raw: str) -> str:
    """Перевести ошибку Meta на человеческий язык.

    ⚠️ Тексты Meta приходят по-английски и написаны для разработчика
    («Error validating access token»). Клиенту такое показывать нельзя — он
    решит, что сломалась платформа, и напишет в поддержку.
    """
    if code == 190:
        return ("Доступ к Instagram больше не действует — подключите аккаунт заново. "
                "Так бывает, если сменился пароль Facebook или доступ отозвали в настройках.")
    if code in (4, 17, 32, 613):
        return "Instagram временно ограничил запросы. Подождите несколько минут и попробуйте снова."
    if code == 10 or code == 200:
        return ("Не хватает разрешений. При подключении нужно оставить все галочки "
                "и выбрать страницу Facebook, связанную с вашим Instagram.")
    if code == 100:
        return ("Instagram не принял запрос. Проверьте, что аккаунт профессиональный "
                "(Бизнес или Автор) и связан со страницей Facebook.")
    return "Instagram вернул ошибку. Если повторяется — напишите нам, мы разберёмся."


# ─────────────────────────────────────────────────────────────────────────────
# OAuth: вход через Facebook
# ─────────────────────────────────────────────────────────────────────────────

def oauth_url(state: str) -> str:
    """Ссылка, на которую отправляем клиента для входа через Facebook.

    `state` защищает от подделки запроса: возвращается Meta как есть, и мы
    сверяем его в callback — иначе постороннюю страницу можно было бы
    подключить в чужой кабинет.

    ⚠️⚠️ В «Входе через Facebook для компаний» (Business Login) разрешения
    передаются НЕ параметром `scope`, а идентификатором заранее собранной
    конфигурации — `config_id`. Список разрешений выбирается один раз в
    кабинете Meta (Вход через Facebook → Конфигурации), и приложение на него
    только ссылается.

    Передать `scope` в этом режиме нельзя: Meta отвечает «Invalid Scopes» и
    перечисляет ВСЕ переданные разрешения как недействительные — выглядит так,
    будто имена устарели, хотя дело в самом способе передачи. На это уже
    потрачено время 2026-09-07, не возвращать `scope` обратно.

    ⚠️ Имена вида `instagram_business_*` — из ДРУГОГО способа входа
    («Instagram API with Instagram Login», домен graph.instagram.com). С нашего
    сервера этот домен не отвечает вовсе, поэтому такие имена нам не подходят,
    сколько бы их ни советовали статьи в интернете.
    """
    params = {
        "client_id": settings.ig_app_id,
        "config_id": settings.ig_config_id,
        "redirect_uri": settings.ig_oauth_redirect_uri,
        "state": state,
        "response_type": "code",
    }
    ver = settings.ig_graph_version or "v21.0"
    return f"https://www.facebook.com/{ver}/dialog/oauth?{urlencode(params)}"


async def exchange_code(code: str) -> str:
    """Код из callback → короткоживущий токен пользователя."""
    data = await graph_get(
        "oauth/access_token",
        token="",  # здесь токена ещё нет, он не нужен
        params={
            "client_id": settings.ig_app_id,
            "client_secret": settings.ig_app_secret,
            "redirect_uri": settings.ig_oauth_redirect_uri,
            "code": code,
        },
    )
    tok = data.get("access_token")
    if not tok:
        raise InstagramApiError(
            "exchange_code: в ответе нет access_token",
            user_message="Не удалось завершить подключение. Попробуйте ещё раз.",
        )
    return tok


async def exchange_long_lived(short_token: str) -> tuple[str, int]:
    """Короткий токен → длинный (60 дней). Возвращает (токен, срок в секундах).

    ⚠️⚠️ Обязательный шаг. Короткий токен живёт ЧАСЫ — если сохранить его,
    подключение отвалится к вечеру того же дня, и выглядеть это будет как
    «всё сломалось само».
    """
    data = await graph_get(
        "oauth/access_token",
        token="",
        params={
            "grant_type": "fb_exchange_token",
            "client_id": settings.ig_app_id,
            "client_secret": settings.ig_app_secret,
            "fb_exchange_token": short_token,
        },
    )
    tok = data.get("access_token")
    if not tok:
        raise InstagramApiError(
            "exchange_long_lived: в ответе нет access_token",
            user_message="Не удалось завершить подключение. Попробуйте ещё раз.",
        )
    # expires_in Meta отдаёт не всегда; 60 дней — заявленный срок long-lived.
    return tok, int(data.get("expires_in") or 60 * 24 * 3600)


# ─────────────────────────────────────────────────────────────────────────────
# Страницы и Instagram-аккаунт
# ─────────────────────────────────────────────────────────────────────────────

async def list_pages(user_token: str) -> list[dict[str, Any]]:
    """Страницы Facebook, доступные человеку.

    У каждой — СВОЙ `access_token` страницы: именно им дальше работаем с
    Instagram, а не токеном пользователя.

    ⚠️⚠️ Ищем в ДВУХ местах, и второе обязательно. `me/accounts` отдаёт только
    страницы, которыми человек владеет ЛИЧНО. Страницы, принадлежащие
    бизнес-портфолио, туда не попадают — приходит пустой список при полностью
    выданных правах, и со стороны это неотличимо от «страниц нет вовсе».
    На это уже потрачено время 2026-09-07: у владельца страницы лежали именно
    в портфолио, и подключение обрывалось без внятной причины.

    Поэтому при пустом ответе идём через `me/businesses` → страницы каждого
    портфолио. Порядок именно такой: личные страницы дешевле одним запросом,
    портфолио требует обхода.
    """
    data = await graph_get(
        "me/accounts",
        token=user_token,
        params={"fields": "id,name,access_token", "limit": 100},
    )
    pages = list(data.get("data") or [])
    if pages:
        return pages

    # Личных страниц нет — пробуем бизнес-портфолио.
    try:
        biz = await graph_get(
            "me/businesses", token=user_token, params={"fields": "id,name", "limit": 50}
        )
    except InstagramApiError as e:
        logger.warning("list_pages: портфолио спросить не удалось — %s", e)
        return []

    seen: set[str] = set()
    for b in (biz.get("data") or []):
        bid = str(b.get("id") or "")
        if not bid:
            continue
        # ⚠️ Два разных списка: owned_pages — страницы самого портфолио,
        # client_pages — чужие страницы, переданные ему в управление
        # (агентствами так и работают). Нужны оба, иначе часть клиентов
        # упрётся в ту же пустоту.
        for edge in ("owned_pages", "client_pages"):
            try:
                res = await graph_get(
                    f"{bid}/{edge}",
                    token=user_token,
                    params={"fields": "id,name,access_token", "limit": 100},
                )
            except InstagramApiError as e:
                logger.warning("list_pages: %s/%s — %s", bid, edge, e)
                continue
            for pg in (res.get("data") or []):
                pid = str(pg.get("id") or "")
                if pid and pid not in seen:
                    seen.add(pid)
                    pages.append(pg)

    logger.info("list_pages: через портфолио найдено страниц: %s", len(pages))
    return pages


async def instagram_account_of_page(page_id: str, page_token: str) -> dict[str, Any] | None:
    """Instagram-аккаунт, связанный со страницей. None — если связи нет.

    ⚠️ Это самое частое место, где у клиента «ничего не находится»: страница
    есть, а Instagram к ней не привязан. Возвращаем None, а не ошибку —
    вызывающий покажет человеку, что именно надо сделать в Instagram.
    """
    data = await graph_get(
        page_id,
        token=page_token,
        params={"fields": "instagram_business_account{id,username,name,followers_count,profile_picture_url}"},
    )
    acc = data.get("instagram_business_account")
    return acc if isinstance(acc, dict) and acc.get("id") else None


async def account_info(ig_user_id: str, page_token: str) -> dict[str, Any]:
    """Свежие данные подключённого аккаунта — для карточки в кабинете."""
    return await graph_get(
        ig_user_id,
        token=page_token,
        params={"fields": "id,username,name,followers_count,media_count,profile_picture_url"},
    )


async def check_token(page_token: str) -> dict[str, Any]:
    """Жив ли токен. Используется кнопкой «Проверить связь» в кабинете.

    ⚠️ Проверяем ПО СЕТИ, а не по сроку в базе: токен могли отозвать в
    настройках Facebook, и запись у нас осталась бы свежей, пока человек
    не столкнулся бы с молчащей воронкой.
    """
    return await graph_get("me", token=page_token, params={"fields": "id,name"})
