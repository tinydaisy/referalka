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
    "bg_mode": "lp_bg_mode",
    "font_heading": "lp_font_heading",
    "color_heading": "lp_color_heading",
    "heading_metallic": "lp_heading_metallic",
    "font_body": "lp_font_body",
    "color_body": "lp_color_body",
    "color_link": "lp_color_link",
    "price_color": "lp_price_color",
    "btn_color": "lp_btn_color",
    "btn_text_color": "lp_btn_text_color",
    "btn_metallic": "lp_btn_metallic",
    "btn_color_2": "lp_btn_color_2",
    "btn_angle": "lp_btn_angle",
    "btn_border_color": "lp_btn_border_color",
    "btn_border_width": "lp_btn_border_width",
    "btn_border_metallic": "lp_btn_border_metallic",
    "btn_radius": "lp_btn_radius",
    "border_color": "lp_border_color",
    "border_metallic": "lp_border_metallic",
    "border_style": "lp_border_style",
    "card_bg": "lp_card_bg",
    "card_bg_opacity": "lp_card_bg_opacity",
    "icon_color": "lp_icon_color",
    "icon_metallic": "lp_icon_metallic",
    "radius": "lp_radius",
    "body_size": "lp_body_size",
    "content_width": "lp_content_width",
    "pad_x": "lp_pad_x",
    "section_gap": "lp_section_gap",
}


class ThemeUpdate(BaseModel):
    bg_color: Optional[str] = None
    bg_color_2: Optional[str] = None
    bg_angle: Optional[int] = None
    bg_gradient: Optional[bool] = None
    bg_mode: Optional[str] = None
    font_heading: Optional[str] = None
    color_heading: Optional[str] = None
    heading_metallic: Optional[bool] = None
    font_body: Optional[str] = None
    color_body: Optional[str] = None
    color_link: Optional[str] = None
    price_color: Optional[str] = None
    btn_color: Optional[str] = None
    btn_text_color: Optional[str] = None
    btn_metallic: Optional[bool] = None
    btn_color_2: Optional[str] = None
    btn_angle: Optional[int] = None
    btn_border_color: Optional[str] = None
    btn_border_width: Optional[int] = None
    btn_border_metallic: Optional[bool] = None
    btn_radius: Optional[int] = None
    border_color: Optional[str] = None
    border_metallic: Optional[bool] = None
    border_style: Optional[str] = None
    card_bg: Optional[str] = None
    card_bg_opacity: Optional[int] = None
    icon_color: Optional[str] = None
    icon_metallic: Optional[bool] = None
    radius: Optional[int] = None
    body_size: Optional[int] = None
    content_width: Optional[int] = None
    pad_x: Optional[int] = None
    section_gap: Optional[int] = None


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
        if api_field == "bg_mode" and val not in ("page", "screen", "block"):
            val = "screen"
        if api_field == "btn_angle" and val is not None:
            val = max(0, min(360, int(val)))
        if api_field == "btn_border_width" and val is not None:
            val = max(0, min(12, int(val)))
        if api_field == "bg_angle" and val is not None:
            val = max(0, min(360, int(val)))
        if api_field == "radius" and val is not None:
            val = max(0, min(64, int(val)))
        if api_field == "body_size" and val is not None:
            val = max(12, min(28, int(val)))
        if api_field == "content_width" and val is not None:
            val = 0 if int(val) == 0 else max(480, min(2000, int(val)))
        if api_field == "pad_x" and val is not None:
            val = max(0, min(160, int(val)))
        if api_field == "section_gap" and val is not None:
            val = max(0, min(200, int(val)))
        vals.append(val)
        sets.append(f"{col} = ${len(vals)}")

    if not sets:
        return await get_theme(client=client, db=db)

    client_id = int(client["sub"])
    vals.append(client_id)
    await db.execute(
        f"UPDATE clients SET {', '.join(sets)} WHERE id = ${len(vals)}", *vals
    )

    # ⚠️ Тема применяется к лендингам СРАЗУ при сохранении.
    # Раньше значения только копировались в момент создания страницы, и клиент
    # правил стиль в Настройках, а на своём лендинге ничего не видел. Ручную
    # правку стиля в самом событии не затираем — такие страницы помечены
    # `style_customized` и живут своей жизнью.
    await db.execute(
        """UPDATE event_landing_pages p SET
             bg_color = c.lp_bg_color, bg_color_2 = c.lp_bg_color_2,
             bg_angle = c.lp_bg_angle, bg_gradient = c.lp_bg_gradient,
             bg_mode = COALESCE(c.lp_bg_mode, 'screen'),
             font_heading = c.lp_font_heading, color_heading = c.lp_color_heading,
             heading_metallic = c.lp_heading_metallic,
             font_body = c.lp_font_body, color_body = c.lp_color_body,
             color_link = c.lp_color_link,
             btn_color = c.lp_btn_color, btn_text_color = c.lp_btn_text_color,
             btn_metallic = c.lp_btn_metallic, btn_color_2 = c.lp_btn_color_2,
             btn_angle = COALESCE(c.lp_btn_angle, 180),
             btn_border_color = c.lp_btn_border_color,
             btn_border_width = COALESCE(c.lp_btn_border_width, 0),
             btn_border_metallic = COALESCE(c.lp_btn_border_metallic, FALSE),
             btn_radius = c.lp_btn_radius,
             border_color = c.lp_border_color, border_metallic = c.lp_border_metallic,
             icon_color = c.lp_icon_color, icon_metallic = c.lp_icon_metallic,
             radius = COALESCE(c.lp_radius, 5),
             body_size = COALESCE(c.lp_body_size, 16),
             content_width = COALESCE(c.lp_content_width, 1120),
             pad_x = COALESCE(c.lp_pad_x, 24),
             section_gap = COALESCE(c.lp_section_gap, 64),
             updated_at = NOW()
           FROM clients c, event_owners eo
          WHERE c.id = $1
            AND eo.client_id = c.id AND eo.status = 'accepted'
            AND p.event_id = eo.event_id
            AND NOT p.style_customized""",
        client_id,
    )
    return await get_theme(client=client, db=db)
