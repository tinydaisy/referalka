"""Данные для страницы отрисовки афиши.

⚠️ ЗАЧЕМ ОТДЕЛЬНАЯ РУЧКА. Картинку снимает headless-браузер, и страницу он
открывает КАК ПОСТОРОННИЙ — токена кабинета у него нет. На обычный
`/api/v1/events/...` он получил бы 401 и снял пустой экран. Поэтому доступ — по
подписанному токену предпросмотра в адресе.

⚠️⚠️ ТОКЕН ЗНАЕТ ТОЛЬКО КЛИЕНТА, НО НЕ СОБЫТИЕ. `preview_client_id` возвращает
id кабинета — и всё. Владение событием обязано проверяться ЗДЕСЬ отдельно, иначе
клиент по своему законному токену вытащил бы состав и фото чужого события,
подставив чужой `event`.

⚠️ Отдаём ровно то, что попадёт в картинку: макет, фирменный стиль и людей с
фотографиями. Ни контактов, ни ссылок, ни подарков — они на афише не нужны, а
ручка публичная.
"""

from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.event_posters_gen import (
    FEATURE, KINDS, ORIENTATIONS, _days, _people, _row, _sessions,
    _suggested, _theme,
)
from app.database import get_db
from app.services.event_access import is_event_owner
from app.services.features import client_has_feature
from app.services.preview_token import preview_client_id

router = APIRouter(prefix="/api/v1/public/poster", tags=["Отрисовка афиши"])


@router.get("/data", summary="Макет, тема и состав для отрисовки афиши")
async def poster_data(
    event: int = Query(..., description="Событие"),
    o: str = Query("vertical", description="Вид афиши"),
    # Вид макета и, при необходимости, конкретный день или спикер.
    kind: str = Query("common"),
    day: Optional[int] = Query(None),
    speaker: Optional[int] = Query(None),
    t: Optional[str] = Query(None, description="Подписанный токен предпросмотра"),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = preview_client_id(t)
    # ⚠️ Мусорный, просроченный или чужой токен — 404, а не 401: ручка публичная,
    # и по коду ответа не должно быть видно, существует событие или нет.
    if not client_id or o not in ORIENTATIONS or kind not in KINDS:
        raise HTTPException(404, detail="Страница не найдена")
    if not await is_event_owner(db, event, client_id):
        raise HTTPException(404, detail="Страница не найдена")
    # ⚠️ Фича проверяется и ЗДЕСЬ (миграция 436). Ручка публичная: без проверки
    # состав события вытаскивался бы по токену предпросмотра даже у кабинета,
    # которому генератор не открывали.
    if not await client_has_feature(db, client_id, FEATURE):
        raise HTTPException(404, detail="Страница не найдена")

    return {
        "layout": await _row(db, event, o, kind),
        "theme": await _theme(db, client_id),
        "people": await _people(db, event),
        "days": await _days(db, event),
        "sessions": await _sessions(db, event),
        # Что именно рисуем: конкретный день или конкретного спикера.
        "day": day,
        "speaker": speaker,
        # Те же подсказки, что в кабинете: иначе снимок вышел бы с пустым
        # заголовком там, где в предпросмотре стояло название события.
        "suggested": await _suggested(db, event),
    }
