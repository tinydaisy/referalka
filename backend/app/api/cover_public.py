"""Данные для страницы отрисовки обложки — по подписанному токену.

⚠️⚠️ ЗАЧЕМ ОТДЕЛЬНАЯ РУЧКА, А НЕ ОБЫЧНАЯ КЛИЕНТСКАЯ. Картинку снимает Chromium
на сервере: он открывает страницу как посторонний, без входа и без токена
кабинета в заголовке. Отдать ему `/api/v1/clients/me/...` нечем — он получит 401
и снимет пустой экран.

Поэтому тот же приём, что у предпросмотра лендинга: короткоживущий подписанный
токен В АДРЕСЕ (`?t=`). Живёт 2 часа, содержит только `client_id`, читается
общим `preview_token` — своей проверки подписи здесь нет.

⚠️ Отдаёт ТОЛЬКО то, что и так попадёт в картинку: шаблон, цвета, логотип,
название бренда. Никаких контактов и списков.
"""

from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.database import get_db
from app.services.preview_token import preview_client_id

router = APIRouter(prefix="/api/v1/public/cover", tags=["Отрисовка обложки"])


@router.get("/data", summary="Шаблон и тема для отрисовки обложки")
async def cover_data(
    kind: str = Query("material"),
    t: Optional[str] = Query(None, description="Подписанный токен предпросмотра"),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = preview_client_id(t)
    if not client_id:
        # Мусорный или просроченный токен — 404, а не 401: страницы с таким
        # адресом для постороннего просто не существует.
        raise HTTPException(404, "Страница не найдена")
    if kind not in ("material", "speaker"):
        raise HTTPException(404, "Страница не найдена")

    from app.api.cover_templates import _row

    tpl = await _row(db, client_id, kind)
    c = await db.fetchrow(
        """SELECT lp_bg_color, lp_bg_color_2, lp_bg_angle, lp_bg_gradient,
                  lp_font_heading, lp_font_body,
                  lp_color_heading, lp_color_body, lp_heading_metallic,
                  brand_logo_url, brand_logo_light_url,
                  brand_name, name, last_name
             FROM clients WHERE id = $1""",
        client_id,
    )
    theme = dict(c) if c else {}

    # Справочник шрифтов: в теме лежит ключ (`BebasNeue`), а семейство в CSS
    # называется иначе — без него страница нарисуется запасным шрифтом.
    from app.services.landing_fonts import FONTS
    theme["fonts"] = [{"key": f["key"], "label": f["label"]} for f in FONTS]

    return {"template": tpl, "theme": theme}
