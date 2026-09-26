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
from fastapi import APIRouter, Depends, HTTPException, Query, Response
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
    # Форма кадра фото (миграция 515): половина спикеров без вырезки, и
    # прямоугольный снимок закрывал половину полотна, куда ложится текст.
    "photo_shape", "photo_w", "photo_radius", "photo_fade",
    "text_x", "text_y", "text_w", "text_align", "title_size",
    # Тема выступления и высота области (миграция 515): раньше кегль темы
    # стоял числом в коде, и длинная тема вылезала за область и на фото.
    "subtitle_size", "subtitle_lines", "text_h", "text_fit",
    # Надписи (миграция 522): раньше настраивался только размер заголовка —
    # цвет имени тянулся из темы, шрифта не было, а у названия конференции
    # кегль и интервал стояли числами в коде.
    "title_font", "title_align", "title_upper",
    "overline_size", "overline_color", "overline_font", "overline_upper",
    "subtitle_color", "subtitle_font",
    # Оформление области текста (миграция 395): подложка и рамка.
    "text_bg_color", "text_bg_color_2", "text_bg_angle", "text_bg_opacity",
    "text_bg_radius", "text_bg_pad", "text_border_color", "text_border_width",
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
    photo_shape: Optional[str] = None
    photo_w: Optional[int] = None
    photo_radius: Optional[int] = None
    photo_fade: Optional[int] = None
    text_x: Optional[int] = None
    text_y: Optional[int] = None
    text_w: Optional[int] = None
    text_align: Optional[str] = None
    # Оформление области текста. Пусто → подложки/рамки нет.
    text_bg_color: Optional[str] = None
    text_bg_color_2: Optional[str] = None
    text_bg_angle: Optional[int] = None
    text_bg_opacity: Optional[int] = None
    text_bg_radius: Optional[int] = None
    text_bg_pad: Optional[int] = None
    text_border_color: Optional[str] = None
    text_border_width: Optional[int] = None
    title_size: Optional[int] = None
    # Тема выступления: свой кегль и предел по строкам (миграция 515).
    # ⚠️ `float`, а не `int`: на полотне 720 px шаг в целый процент — это сразу
    # 7 px кегля, слишком грубо, чтобы подогнать длинную тему под область.
    subtitle_size: Optional[float] = None
    subtitle_lines: Optional[int] = None
    title_font: Optional[str] = None
    title_align: Optional[str] = None
    title_upper: Optional[bool] = None
    overline_size: Optional[float] = None
    overline_color: Optional[str] = None
    overline_font: Optional[str] = None
    overline_upper: Optional[bool] = None
    subtitle_color: Optional[str] = None
    subtitle_font: Optional[str] = None
    text_h: Optional[int] = None
    text_fit: Optional[bool] = None
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
    for f, lo, hi, dflt in (("photo_w", 10, 90, 38), ("photo_radius", 0, 50, 0),
                            ("photo_fade", 0, 60, 0)):
        if f in d and d[f] is not None:
            d[f] = _clamp(d[f], lo, hi, dflt)
    # ⚠️ Список форм тот же, что в CHECK миграции 515: разойдутся — сохранение
    # упадёт на ограничении БД уже после того, как клиент нажал «Сохранить».
    if "photo_shape" in d and d["photo_shape"] not in (
            "cutout", "portrait", "square", "circle", "oval"):
        d["photo_shape"] = "cutout"
    # ⚠️ Границы те же, что в CHECK миграции 395: значение из браузера может
    # прийти любым, а падать на ограничении БД посреди сохранения нельзя.
    for key, lo, hi, default in (
        ("text_bg_angle", 0, 360, 135),
        ("text_bg_opacity", 0, 100, 100),
        ("text_bg_radius", 0, 50, 0),
        ("text_bg_pad", 0, 20, 0),
        ("text_border_width", 0, 20, 0),
    ):
        if key in d and d[key] is not None:
            d[key] = _clamp(d[key], lo, hi, default)
    for f in ("photo_x", "photo_y"):
        if f in d:
            d[f] = _clamp(d[f], -100, 100, 0)
    for f, lo, hi, dflt in (("text_x", 0, 100, 50), ("text_y", 0, 100, 50),
                            ("text_w", 10, 100, 45), ("title_size", 3, 20, 8),
                            # 0 = без ограничения по строкам / по высоте.
                            ("subtitle_lines", 0, 10, 0), ("text_h", 0, 100, 0)):
        if f in d:
            d[f] = _clamp(d[f], lo, hi, dflt)
    # ⚠️ Кегль темы — дробный, поэтому своим проходом, а не общим `_clamp`:
    # тот приводит к `int` и 4.2 % превратились бы в 4 %.
    for f, lo, hi, dflt in (("subtitle_size", 1.0, 12.0, 4.2),
                            ("overline_size", 1.0, 10.0, 3.1)):
        if f in d and d[f] is not None:
            try:
                d[f] = round(max(lo, min(hi, float(d[f]))), 1)
            except (TypeError, ValueError):
                d[f] = dflt
    # ⚠️ Список тот же, что в CHECK миграции 522: разойдутся — сохранение
    # упадёт на ограничении БД уже после нажатия «Сохранить».
    if d.get("title_align") not in (None, "left", "center", "right"):
        d["title_align"] = None
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
        d = dict(row)
        # ⚠️ `numeric` приезжает из asyncpg как `Decimal`, а JSON отдаёт его
        # СТРОКОЙ ("4.2"). На фронте это молча ломает арифметику ползунка:
        # `"4.2" * 720 / 100` даёт NaN, и кегль темы схлопывается в ноль.
        # ⚠️ `numeric` приезжает Decimal, а JSON отдаёт его СТРОКОЙ — на фронте
        # это молча ломает арифметику ползунка.
        for f in ("subtitle_size", "overline_size"):
            if d.get(f) is not None:
                d[f] = float(d[f])
        return d
    return {"client_id": client_id, "kind": kind, "bg_dim": 0,
            "photo_scale": 100, "photo_x": 0, "photo_y": 0,
            "show_brand": True, "subtitle_size": 4.2, "subtitle_lines": 0,
            "text_h": 0, "text_fit": False, "photo_shape": "cutout",
            "overline_size": 3.1, "overline_upper": True, "title_upper": False,
            "photo_w": 38, "photo_radius": 0, "photo_fade": 0,
            **_DEFAULTS[kind]}


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


@router.get("/{kind}/png", summary="Скачать обложку картинкой")
async def download_cover(
    kind: str,
    title: str = Query("", description="Название на обложке"),
    subtitle: str = Query(""),
    overline: str = Query(""),
    photo: str = Query("", description="Фото на прозрачном фоне"),
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """PNG 1280×720 — под обложку видео в VK и на YouTube.

    ⚠️ Картинку снимает браузер с той же страницы, что показывает предпросмотр.
    Отдельного рисовальщика нет: он разошёлся бы с тем, что клиент видит.
    """
    if kind not in KINDS:
        raise HTTPException(404, "Такого шаблона нет")
    client_id = int(user["sub"])

    from urllib.parse import quote, urlencode

    from app.services.client_domains import platform_base_url
    from app.services.cover_render import CoverRenderError, render_cover_png
    from app.services.preview_token import make_preview_token

    # ⚠️ Адрес ПЛАТФОРМЫ, а не домен клиента: страница отрисовки живёт в
    # кабинете и на свой домен не переезжает.
    qs = urlencode({
        "kind": kind, "t": make_preview_token(client_id),
        "title": title, "subtitle": subtitle,
        "overline": overline, "photo": photo,
    })
    url = f"{platform_base_url().rstrip('/')}/cover?{qs}"

    try:
        png = await render_cover_png(url)
    except CoverRenderError as e:
        raise HTTPException(503, str(e))

    # Имя файла — по названию: человек ищет обложку глазами среди скачанных.
    # ⚠️ Кириллица уходит заголовком по RFC 5987, иначе браузер её испортит.
    base = (title or "обложка").strip()[:60] or "обложка"
    safe = base.replace('"', "").replace("\\", "")
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "Content-Disposition":
                f"attachment; filename=\"cover.png\"; filename*=UTF-8\'\'{quote(safe)}.png",
        },
    )

@router.post("/{kind}/render", summary="Собрать обложку и сохранить в хранилище")
async def render_cover_to_storage(
    kind: str,
    title: str = Query("", description="Название на обложке"),
    subtitle: str = Query(""),
    overline: str = Query(""),
    photo: str = Query("", description="Фото на прозрачном фоне"),
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """То же, что `/png`, но картинка сразу ложится в хранилище и отдаётся ссылкой.

    ⚠️ Зачем отдельно от `/png`: скачать файл и тут же загрузить его обратно —
    ровно та ручная работа, ради которой конструктор и делали. У курса из
    двадцати уроков это сорок действий мышью на каждую смену оформления.

    ⚠️ Рисуется ТЕМ ЖЕ `render_cover_png`, что и скачивание, — второй
    рисовальщик разошёлся бы с предпросмотром.
    """
    if kind not in KINDS:
        raise HTTPException(404, "Такого шаблона нет")
    client_id = int(user["sub"])

    from urllib.parse import urlencode

    from app.services.client_domains import platform_base_url
    from app.services.cover_render import CoverRenderError, render_cover_png
    from app.services.preview_token import make_preview_token
    from app.services.store_file import store_bytes

    qs = urlencode({
        "kind": kind, "t": make_preview_token(client_id),
        "title": title, "subtitle": subtitle,
        "overline": overline, "photo": photo,
    })
    url = f"{platform_base_url().rstrip('/')}/cover?{qs}"

    try:
        png = await render_cover_png(url)
    except CoverRenderError as e:
        raise HTTPException(503, str(e))

    # ⚠️ kind='material_media' — обложка живёт рядом с материалами и попадает
    # в тот же раздел хранилища, где человек её потом ищет.
    saved = await store_bytes(
        db, client_id=client_id, data=png,
        kind="material_media", ext="png", content_type="image/png",
    )
    return saved
