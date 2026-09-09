"""Шаблоны обложек — настройка «как выглядит обложка по умолчанию» (миграция 387).

Два вида: `material` (обложка записи или материала) и `speaker` (обложка
человека). Оформление берётся из темы бренда, здесь настраивается только
раскладка — где фото, где текст, какой логотип.

⚠️ Тема НЕ копируется в шаблон, а подмешивается при отдаче: клиент меняет
фирменный цвет один раз в «Стилях бренда и лендинга», и обложки меняются вместе с
лендингами. Копия разошлась бы с темой в тот же день.
"""

from __future__ import annotations

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.assistant_access import assistant_is_restricted

router = APIRouter(prefix="/cover-templates", tags=["Шаблоны обложек"])

KINDS = ("material", "speaker")

# Поля, которые клиент вправе менять. ⚠️ Список ОДИН на чтение и запись: два
# разных перечня разъезжаются, и поле, добавленное в форму, молча не
# сохраняется (так уже было с кабинетом спикера).
_FIELDS = (
    "bg_url", "bg_dim", "logo_variant", "logo_size", "logo_x", "logo_y",
    "photo_side", "photo_scale", "photo_x", "photo_y",
    "text_x", "text_y", "text_w", "text_align", "title_size",
    "title_color", "text_color", "show_brand",
    "show_owner_name", "show_brand_name", "brand_position",
)

# Значения по умолчанию — те же, что в CHECK миграции. ⚠️ Держать одинаковыми:
# разойдутся — форма покажет одно, а несохранённый шаблон отрисуется другим.
_DEFAULTS = {
    "material": {
        "photo_side": "left", "text_x": 50, "text_y": 50, "text_w": 45,
        "text_align": "left", "title_size": 8, "logo_variant": "light",
        "logo_size": 7, "logo_x": 88, "logo_y": 6,
        "show_owner_name": False, "show_brand_name": True, "brand_position": "below",
    },
    # У спикера имя по центру-слева, фото справа, сверху партнёры — раскладка
    # другая по смыслу, а не по вкусу.
    "speaker": {
        "photo_side": "right", "text_x": 6, "text_y": 45, "text_w": 55,
        "text_align": "left", "title_size": 9, "logo_variant": "light",
        # У спикера сверху идут логотипы партнёров — свой логотип уводим ниже,
        # к левому краю, чтобы они не наезжали друг на друга.
        "logo_size": 6, "logo_x": 12, "logo_y": 14,
        # У спикера под именем идёт его роль, а бренд — над названием
        # конференции: снизу и так две строки, третья их перегружает.
        "show_owner_name": False, "show_brand_name": True, "brand_position": "above",
    },
}


class TemplateIn(BaseModel):
    bg_url: Optional[str] = None
    bg_dim: Optional[int] = None
    logo_variant: Optional[str] = None
    logo_size: Optional[int] = None
    logo_x: Optional[int] = None
    logo_y: Optional[int] = None
    photo_side: Optional[str] = None
    photo_scale: Optional[int] = None
    photo_x: Optional[int] = None
    photo_y: Optional[int] = None
    text_x: Optional[int] = None
    text_y: Optional[int] = None
    text_w: Optional[int] = None
    text_align: Optional[str] = None
    title_size: Optional[int] = None
    title_color: Optional[str] = None
    text_color: Optional[str] = None
    show_brand: Optional[bool] = None
    show_owner_name: Optional[bool] = None
    show_brand_name: Optional[bool] = None
    brand_position: Optional[str] = None


def _clamp(v, lo: int, hi: int, default: int) -> int:
    """Значение в допустимый диапазон. ⚠️ Мусор приводим к дефолту, а не роняем
    запрос: CHECK в базе всё равно не пропустит, но человек получил бы 500
    вместо работающей формы."""
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _norm(data: dict, kind: str) -> dict:
    """Приводит присланное к допустимым значениям."""
    d = dict(data)
    if "bg_dim" in d:
        d["bg_dim"] = _clamp(d["bg_dim"], 0, 90, 0)
    if "logo_size" in d:
        d["logo_size"] = _clamp(d["logo_size"], 2, 30, 7)
    for f, dflt in (("logo_x", 88), ("logo_y", 6)):
        if f in d:
            d[f] = _clamp(d[f], 0, 100, dflt)
    if "photo_scale" in d:
        d["photo_scale"] = _clamp(d["photo_scale"], 30, 200, 100)
    for f in ("photo_x", "photo_y"):
        if f in d:
            d[f] = _clamp(d[f], -100, 100, 0)
    for f, lo, hi, dflt in (("text_x", 0, 100, 50), ("text_y", 0, 100, 50),
                            ("text_w", 10, 100, 45), ("title_size", 3, 20, 8)):
        if f in d:
            d[f] = _clamp(d[f], lo, hi, dflt)
    if "logo_variant" in d and d["logo_variant"] not in ("light", "dark", "none"):
        d["logo_variant"] = "light"
    if "photo_side" in d and d["photo_side"] not in ("left", "right", "none"):
        d["photo_side"] = _DEFAULTS[kind]["photo_side"]
    if "text_align" in d and d["text_align"] not in ("left", "center", "right"):
        d["text_align"] = "left"
    if "brand_position" in d and d["brand_position"] not in ("above", "below", "none"):
        d["brand_position"] = "below"
    return d


async def _row(db, client_id: int, kind: str) -> dict:
    """Шаблон клиента. Нет строки → отдаём умолчания, а не пустоту.

    ⚠️ Строку заранее не создаём: пустой шаблон в базе у каждого клиента —
    это записи, которыми никто не пользовался. Она появляется при первом
    сохранении.
    """
    row = await db.fetchrow(
        "SELECT * FROM cover_templates WHERE client_id = $1 AND kind = $2",
        client_id, kind,
    )
    if row:
        return dict(row)
    return {"client_id": client_id, "kind": kind, "bg_dim": 0,
            "photo_scale": 100, "photo_x": 0, "photo_y": 0,
            "show_brand": True, **_DEFAULTS[kind]}


@router.get("/{kind}", summary="Шаблон обложки + тема бренда")
async def get_template(
    kind: str,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Шаблон и всё, что нужно предпросмотру: цвета, шрифты, логотипы, бренд."""
    if kind not in KINDS:
        raise HTTPException(404, "Такого шаблона нет")
    client_id = int(user["sub"])

    tpl = await _row(db, client_id, kind)

    # ⚠️ Тема отдаётся ВМЕСТЕ с шаблоном, одним запросом: предпросмотр без неё
    # нарисовал бы обложку не в фирменных цветах, и клиент решил бы, что
    # настройка не применилась.
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

    # Фото для предпросмотра — СВОЯ карточка клиента (`self_collaborator_id`),
    # а не первый попавшийся человек из базы. Клиент смотрит на образец своей
    # обложки: чужое лицо в нём выглядит ошибкой, а не примером.
    # ⚠️ Ищет БЭКЕНД: во фронте пришлось бы тянуть весь список коллабораторов
    # и выбирать из него — лишний запрос ради одного адреса.
    theme["sample_photo_url"] = await db.fetchval(
        """SELECT co.cutout_photo_url
             FROM clients cl JOIN collaborators co ON co.id = cl.self_collaborator_id
            WHERE cl.id = $1""",
        client_id,
    )
    return {"template": tpl, "theme": theme}


@router.put("/{kind}", summary="Сохранить шаблон обложки")
async def save_template(
    kind: str,
    data: TemplateIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    if kind not in KINDS:
        raise HTTPException(404, "Такого шаблона нет")
    if await assistant_is_restricted(user):
        raise HTTPException(403, "Настройки доступны только владельцу кабинета")
    client_id = int(user["sub"])

    # ⚠️ Пишем только присланные поля (`exclude_unset`): форма может слать
    # часть, и не присланное должно остаться прежним, а не обнулиться.
    payload = _norm(data.model_dump(exclude_unset=True), kind)
    if not payload:
        return await _row(db, client_id, kind)

    cur = await _row(db, client_id, kind)
    merged = {f: payload.get(f, cur.get(f)) for f in _FIELDS}

    cols = ", ".join(_FIELDS)
    ph = ", ".join(f"${i + 3}" for i in range(len(_FIELDS)))
    upd = ", ".join(f"{f} = EXCLUDED.{f}" for f in _FIELDS)
    row = await db.fetchrow(
        f"""INSERT INTO cover_templates (client_id, kind, {cols})
            VALUES ($1, $2, {ph})
            ON CONFLICT (client_id, kind) DO UPDATE
              SET {upd}, updated_at = NOW()
            RETURNING *""",
        client_id, kind, *[merged[f] for f in _FIELDS],
    )
    return dict(row)
