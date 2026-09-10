"""
Подсказки адреса при вводе (DaData) — прокси к их API.

⚠️⚠️ ХОДИМ ЧЕРЕЗ СВОЙ СЕРВЕР, А НЕ ИЗ БРАУЗЕРА. У DaData подсказки штатно
дёргают прямо со страницы, но тогда ключ виден любому, кто откроет кабинет, и
единственная защита — «ограничение по домену» в ИХ личном кабинете, то есть в
месте, о котором через полгода никто не вспомнит. Ключ остаётся на сервере.

⚠️ Ключ ОДИН НА ПЛАТФОРМУ, не у каждого клиента: бесплатный тариф даёт 10 000
подсказок в сутки, а адрес вписывают один раз при создании события. Заставлять
клиента заводить свой ключ ради этого — лишний шаг на ровном месте.

⚠️ Отвечаем ПУСТЫМ СПИСКОМ, а не ошибкой, если ключа нет или DaData молчит.
Подсказки — удобство поверх обычного текстового поля: человек всё равно
допишет адрес руками, и красная ошибка над рабочим полем только пугает.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.config import settings
from app.api.auth import get_current_user

router = APIRouter(prefix="/address", tags=["address"])
logger = logging.getLogger(__name__)

_DADATA_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address"


class SuggestRequest(BaseModel):
    query: str
    count: int = 7


class Suggestion(BaseModel):
    """Одна подсказка.

    `value` — то, что подставляем в поле; `lat`/`lon` — координаты дома, если
    DaData их знает: по ним карта ставит метку точно, без повторного поиска по
    тексту.
    """
    value: str
    lat: float | None = None
    lon: float | None = None


@router.post("/suggest")
async def suggest_address(
    data: SuggestRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    """Подсказки по началу адреса. Возвращает `{"items": [...]}`.

    ⚠️ Только для вошедших в кабинет (`get_current_user`) — иначе наш ключ
    становится бесплатным геосервисом для кого угодно, и суточный лимит
    выберет посторонний, а не наши клиенты.
    """
    q = (data.query or "").strip()
    key = (settings.dadata_api_key or "").strip()
    # ⚠️ Меньше трёх символов не спрашиваем: на «Уф» приходит список городов и
    # улиц всей страны — он бесполезен и тратит суточный лимит.
    if not key or len(q) < 3:
        return {"items": []}

    count = max(1, min(int(data.count or 7), 10))
    try:
        async with httpx.AsyncClient(timeout=5) as cl:
            resp = await cl.post(
                _DADATA_URL,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": f"Token {key}",
                },
                json={"query": q, "count": count},
            )
        if resp.status_code != 200:
            logger.warning("DaData ответила %s: %s", resp.status_code, resp.text[:200])
            return {"items": []}
        raw = resp.json().get("suggestions") or []
    except Exception as e:
        # Сеть/таймаут — подсказок просто не будет, поле остаётся рабочим.
        logger.warning("DaData suggest failed: %s", e)
        return {"items": []}

    items: list[dict] = []
    for s in raw:
        value = (s.get("value") or "").strip()
        if not value:
            continue
        d = s.get("data") or {}
        lat, lon = d.get("geo_lat"), d.get("geo_lon")
        try:
            lat = float(lat) if lat is not None else None
            lon = float(lon) if lon is not None else None
        except (TypeError, ValueError):
            lat = lon = None
        items.append({"value": value, "lat": lat, "lon": lon})
    return {"items": items}
