"""Сколько подписчиков в каналах основателя — цифры от самих площадок.

Зачем. Медийные активы человек заявляет руками и может завысить. А число
подписчиков канала отдаёт сама площадка — при условии, что бот клиента там
администратор. Для партнёра в каталоге это подтверждённая цифра, а не обещание.

⚠️ Не путать с БАЗОЙ в ПЛЮСОНе (`platform_users`): база — это люди, прошедшие
через боты и почту внутри системы, а здесь — подписчики публичных каналов.
Числа разные и складывать их в одно нельзя.

⚠️ Считается по ВСЕМ каналам площадки, а не по первому: у клиента их бывает
несколько (`social_links.telegram_channels` — массив).

Сбой площадки не должен ронять карточку, поэтому любая ошибка = 0 по этому
каналу: лучше показать меньше, чем не показать карточку вовсе.
"""
import asyncio
import json
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT = 8.0


def _channels(social: dict, key: str) -> list:
    """Список каналов площадки из social_links (JSONB бывает строкой)."""
    if isinstance(social, str):
        try:
            social = json.loads(social)
        except Exception:
            return []
    val = (social or {}).get(key)
    return val if isinstance(val, list) else []


async def _tg_count(token: str, chat_id: str) -> int:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(f"https://api.telegram.org/bot{token}/getChatMemberCount",
                            params={"chat_id": chat_id})
            data = r.json()
            return int(data.get("result") or 0) if data.get("ok") else 0
    except Exception:
        logger.debug("tg count failed for %s", chat_id, exc_info=True)
        return 0


async def _max_count(token: str, chat_id: str) -> int:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get(f"https://botapi.max.ru/chats/{chat_id}",
                            headers={"Authorization": token})
            return int(r.json().get("participants_count") or 0)
    except Exception:
        logger.debug("max count failed for %s", chat_id, exc_info=True)
        return 0


async def _vk_count(token: str, group_id: str) -> int:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.get("https://api.vk.com/method/groups.getById",
                            params={"group_id": group_id, "fields": "members_count",
                                    "access_token": token, "v": "5.199"})
            groups = (r.json().get("response") or {}).get("groups") or []
            return int(groups[0].get("members_count") or 0) if groups else 0
    except Exception:
        logger.debug("vk count failed for %s", group_id, exc_info=True)
        return 0


# ⚠️ Кеш на 10 минут. Подписчиков спрашиваем у САМИХ площадок по сети, а
# каталог рисует десятки карточек разом — без кеша это десятки внешних
# запросов на каждое открытие страницы: и медленно, и площадки начнут
# ограничивать. Подписчики за 10 минут заметно не меняются.
_CACHE: dict[int, tuple[float, dict]] = {}
_CACHE_TTL = 600.0


async def channel_audience(db, client_id: int, social: Optional[dict]) -> dict:
    """{'plusson_tg_ch': N, 'plusson_max_ch': N, 'plusson_vk_ch': N}.

    Пустой словарь значений (нули), если бот не подключён или не админ в канале —
    цифру мы в таком случае не знаем и выдумывать не станем.
    """
    import time
    hit = _CACHE.get(client_id)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1]

    from app.services.channels import (get_client_telegram_token,
                                       get_client_max_token,
                                       get_client_vk_token)

    social = social or {}
    tg_ids = [str(c.get("chat_id") or "") for c in _channels(social, "telegram_channels")]
    max_ids = [str(c.get("chat_id") or "") for c in _channels(social, "max_channels")]
    vk_group = str((social if isinstance(social, dict) else {}).get("vk_group_id") or "")

    # ⚠️ Токены берём ПОСЛЕДОВАТЕЛЬНО. Одно соединение asyncpg не выполняет
    # несколько запросов разом — параллельный gather роняет ручку с ошибкой
    # «another operation is in progress», и карточка не грузится вовсе.
    # Параллелить можно только сетевые вызовы к площадкам (ниже) — они к базе
    # не обращаются.
    tg_token = await get_client_telegram_token(client_id, db)
    max_token = await get_client_max_token(client_id, db)
    vk_token = await get_client_vk_token(client_id, db)

    tasks = []
    if tg_token:
        tasks += [_tg_count(tg_token, i) for i in tg_ids if i]
    tg_n = len([i for i in tg_ids if i]) if tg_token else 0

    if max_token:
        tasks += [_max_count(max_token, i) for i in max_ids if i]
    max_n = len([i for i in max_ids if i]) if max_token else 0

    if vk_token and vk_group:
        tasks.append(_vk_count(vk_token, vk_group))

    results = await asyncio.gather(*tasks, return_exceptions=True)
    nums = [r if isinstance(r, int) else 0 for r in results]

    out = {
        "plusson_tg_ch":  sum(nums[:tg_n]),
        "plusson_max_ch": sum(nums[tg_n:tg_n + max_n]),
        "plusson_vk_ch":  sum(nums[tg_n + max_n:]),
    }
    _CACHE[client_id] = (time.time(), out)
    return out
