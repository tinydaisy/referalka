"""
Тема лендинга по умолчанию — фирменный стиль клиента (миграция 241).

Задаётся один раз в Настройках и подставляется при создании страницы лендинга
любого события (`_get_or_create_page` в event_landing.py). Это ДЕФОЛТ, а не
жёсткая привязка: значения копируются в момент создания, дальше страница живёт
своей жизнью — правка темы задним числом уже собранные лендинги не ломает.

Отдельный роутер (не поля в `ProfileUpdate`): тема — про оформление лендингов,
визитка — про содержимое Mini App. Смешивать их в одной форме неудобно.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.landing_fonts import FONTS, normalize_font

router = APIRouter(prefix="/clients/me/landing-theme", tags=["Тема лендинга"])

# Колонка в clients ← поле в API. Префикс lp_ = landing page.
_FIELDS = {
    "bg_color": "lp_bg_color",
    "bg_color_2": "lp_bg_color_2",
    "bg_angle": "lp_bg_angle",
    "bg_gradient": "lp_bg_gradient",
    "font_heading": "lp_font_heading",
    "color_heading": "lp_color_heading",
    "heading_metallic": "lp_heading_metallic",
    "font_body": "lp_font_body",
    "color_body": "lp_color_body",
    "color_link": "lp_color_link",
    "btn_color": "lp_btn_color",
    "btn_text_color": "lp_btn_text_color",
    "btn_metallic": "lp_btn_metallic",
    "border_color": "lp_border_color",
    "border_metallic": "lp_border_metallic",
    "icon_color": "lp_icon_color",
    "icon_metallic": "lp_icon_metallic",
    "radius": "lp_radius",
}


class ThemeUpdate(BaseModel):
    bg_color: Optional[str] = None
    bg_color_2: Optional[str] = None
    bg_angle: Optional[int] = None
    bg_gradient: Optional[bool] = None
    font_heading: Optional[str] = None
    color_heading: Optional[str] = None
    heading_metallic: Optional[bool] = None
    font_body: Optional[str] = None
    color_body: Optional[str] = None
    color_link: Optional[str] = None
    btn_color: Optional[str] = None
    btn_text_color: Optional[str] = None
    btn_metallic: Optional[bool] = None
    border_color: Optional[str] = None
    border_metallic: Optional[bool] = None
    icon_color: Optional[str] = None
    icon_metallic: Optional[bool] = None
    radius: Optional[int] = None


@router.get("", summary="Тема лендинга клиента")
async def get_theme(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    cols = ", ".join(f"{col} AS {api}" for api, col in _FIELDS.items())
    row = await db.fetchrow(f"SELECT {cols} FROM clients WHERE id = $1", int(client["sub"]))
    return {"theme": dict(row) if row else {}, "fonts": FONTS}


@router.patch("", summary="Сохранить тему лендинга")
async def patch_theme(
    data: ThemeUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    fs = data.model_fields_set
    sets, vals = [], []
    for api_field, col in _FIELDS.items():
        if api_field not in fs:
            continue
        val = getattr(data, api_field)
        if api_field in ("font_heading", "font_body"):
            val = normalize_font(val)
        if api_field == "bg_angle" and val is not None:
            val = max(0, min(360, int(val)))
        if api_field == "radius" and val is not None:
            val = max(0, min(64, int(val)))
        vals.append(val)
        sets.append(f"{col} = ${len(vals)}")

    if not sets:
        return await get_theme(client=client, db=db)

    vals.append(int(client["sub"]))
    await db.execute(
        f"UPDATE clients SET {', '.join(sets)} WHERE id = ${len(vals)}", *vals
    )
    return await get_theme(client=client, db=db)
