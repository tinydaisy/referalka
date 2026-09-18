"""Генератор афиш события (миграция 435).

Афишу на два десятка спикеров собирали руками в фотошопе: расставить фото по
сетке, подписать, выделить организатора, добавить логотипы партнёров — и всё
заново, как только состав поменялся. Здесь фон и оформление задаются один раз,
а состав подставляется сам из карточек события.

⚠️ СОСТАВ В МАКЕТ НЕ КОПИРУЕТСЯ. Спикеры, их фото и роли читаются при каждой
отрисовке из `event_collaborators` + `collaborators`. Копия разошлась бы с
составом в тот день, когда добавили спикера: в списке события он есть, на афише
его нет, и никто не понимает почему.

⚠️ КАРТИНКУ РИСУЕТ БРАУЗЕР той же вёрсткой, что показывает предпросмотр
(`poster_render.py`), а не Pillow и не canvas. Причина — в шапке `poster_render`.
"""

from __future__ import annotations

from typing import Optional
from urllib.parse import quote, urlencode

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.assistant_access import assistant_is_restricted
from app.services.client_domains import platform_base_url
from app.services.event_access import assert_event_owner
from app.services.features import client_has_feature
from app.services.poster_render import PosterRenderError, render_poster_png
from app.services.preview_token import make_preview_token
from app.services.store_file import store_bytes

router = APIRouter(tags=["Генератор афиш"])

ORIENTATIONS = ("horizontal", "vertical", "square")

# ⚠️ ОДИН перечень полей на чтение и на запись. Два разных списка неизбежно
# разъезжаются, и новое поле формы молча перестаёт сохраняться — ровно этим
# предупреждением открывается тот же кортеж в шаблонах обложек.
_FIELDS = (
    "bg_url", "bg_dim",
    # Поля от края в мм (миграция 440) — задают рабочую область афиши.
    "margin_top", "margin_bottom", "margin_left", "margin_right",
    "speakers_top", "speakers_bottom", "speakers_side",
    "mask_shape", "mask_radius", "per_row", "gap", "row_overlap",
    "show_names", "name_order", "name_lines", "name_font", "name_size",
    "name_color", "name_shadow", "name_place",
    "hl_style", "hl_color", "hl_border_w", "hl_glow",
    "role_badge", "role_badge_color", "role_badge_text_color",
    "title", "subtitle", "show_title", "show_subtitle",
    "title_font", "title_size", "title_color", "title_metallic",
    "title_underline", "title_align",
    "subtitle_font", "subtitle_size", "subtitle_color", "subtitle_metallic",
    "subtitle_underline", "subtitle_align",
    "text_top",
    "show_pill", "pill_text", "pill_text_2", "pill_style", "pill_radius",
    "pill_border_color", "pill_border_color_2", "pill_border_w",
    "pill_bg_color", "pill_text_color", "pill_font", "pill_size",
    "show_brand_logo", "brand_logo_variant", "brand_logo_x", "brand_logo_y",
    "brand_logo_size",
    "show_partners", "partners_y", "partners_size",
    "speaker_order",
)

# ⚠️ Должны совпадать с DEFAULT и CHECK в миграции 435: разойдутся — клиент
# увидит в форме одно, а база запишет другое (или отвергнет запись).
_DEFAULTS = {
    "bg_url": None, "bg_dim": 0,
    "margin_top": 10, "margin_bottom": 10, "margin_left": 10, "margin_right": 10,
    "speakers_top": 45, "speakers_bottom": 97, "speakers_side": 5,
    "mask_shape": "portrait", "mask_radius": 0, "per_row": None,
    "gap": 2, "row_overlap": 0,
    "show_names": True, "name_order": "first_last", "name_lines": 2,
    "name_font": None, "name_size": 1.6, "name_color": None,
    "name_shadow": False, "name_place": "below",
    "hl_style": "border", "hl_color": None, "hl_border_w": 0.3, "hl_glow": 1.5,
    "role_badge": "pill", "role_badge_color": None, "role_badge_text_color": None,
    "title": None, "subtitle": None, "show_title": True, "show_subtitle": True,
    "title_font": None, "title_size": 6, "title_color": None,
    "title_metallic": True, "title_underline": "none", "title_align": "center",
    "subtitle_font": None, "subtitle_size": 2.4, "subtitle_color": None,
    "subtitle_metallic": False, "subtitle_underline": "none", "subtitle_align": "center",
    "text_top": 18,
    "show_pill": True, "pill_text": None, "pill_text_2": None,
    "pill_style": "border", "pill_radius": 50,
    "pill_border_color": None, "pill_border_color_2": None, "pill_border_w": 0.15,
    "pill_bg_color": None, "pill_text_color": None, "pill_font": None, "pill_size": 1.8,
    "show_brand_logo": True, "brand_logo_variant": "light",
    "brand_logo_x": 50, "brand_logo_y": 5, "brand_logo_size": 6,
    "show_partners": True, "partners_y": 5, "partners_size": 5,
    "speaker_order": [],
}

# Границы числовых полей — те же, что в CHECK миграции.
_RANGES = {
    "bg_dim": (0, 90),
    "margin_top": (0, 60), "margin_bottom": (0, 60),
    "margin_left": (0, 60), "margin_right": (0, 60),
    "speakers_top": (0, 95), "speakers_bottom": (5, 100),
    "speakers_side": (0, 40), "mask_radius": (0, 50), "per_row": (1, 12),
    "gap": (0, 20), "row_overlap": (0, 60), "name_size": (0.3, 8),
    "hl_border_w": (0, 3), "hl_glow": (0, 10),
    "title_size": (1, 20), "subtitle_size": (0.5, 12), "text_top": (0, 100),
    "pill_radius": (0, 50), "pill_border_w": (0, 2), "pill_size": (0.3, 8),
    "brand_logo_x": (0, 100), "brand_logo_y": (0, 100), "brand_logo_size": (1, 30),
    "partners_y": (0, 100), "partners_size": (1, 20),
}

_CHOICES = {
    "mask_shape": ("portrait", "square", "circle", "oval", "egg", "cutout"),
    "name_order": ("first_last", "last_first"),
    "name_place": ("below", "over"),
    "hl_style": ("none", "border", "glow", "both"),
    "role_badge": ("none", "pill", "ribbon", "suffix"),
    "title_underline": ("none", "line", "gradient"),
    "subtitle_underline": ("none", "line", "gradient"),
    "title_align": ("left", "center", "right"),
    "subtitle_align": ("left", "center", "right"),
    "pill_style": ("border", "filled", "underline", "plain"),
    "brand_logo_variant": ("light", "dark"),
}

# Целые поля — их база не примет дробью.
_INT_FIELDS = {
    "bg_dim", "speakers_top", "speakers_bottom", "speakers_side", "mask_radius",
    "per_row", "row_overlap", "text_top", "pill_radius",
    "brand_logo_x", "brand_logo_y", "name_lines",
}


class LayoutIn(BaseModel):
    """Тело сохранения макета. Все поля необязательные — шлём только изменённое."""
    bg_url: Optional[str] = None
    bg_dim: Optional[int] = None
    # Поля от края в мм (миграция 440). Дробные допустимы: 2.5 мм — законное поле.
    margin_top: Optional[float] = None
    margin_bottom: Optional[float] = None
    margin_left: Optional[float] = None
    margin_right: Optional[float] = None
    speakers_top: Optional[int] = None
    speakers_bottom: Optional[int] = None
    speakers_side: Optional[int] = None
    mask_shape: Optional[str] = None
    mask_radius: Optional[int] = None
    per_row: Optional[int] = None
    gap: Optional[float] = None
    row_overlap: Optional[int] = None
    show_names: Optional[bool] = None
    name_order: Optional[str] = None
    name_lines: Optional[int] = None
    name_font: Optional[str] = None
    name_size: Optional[float] = None
    name_color: Optional[str] = None
    name_shadow: Optional[bool] = None
    name_place: Optional[str] = None
    hl_style: Optional[str] = None
    hl_color: Optional[str] = None
    hl_border_w: Optional[float] = None
    hl_glow: Optional[float] = None
    role_badge: Optional[str] = None
    role_badge_color: Optional[str] = None
    role_badge_text_color: Optional[str] = None
    title: Optional[str] = None
    subtitle: Optional[str] = None
    show_title: Optional[bool] = None
    show_subtitle: Optional[bool] = None
    title_font: Optional[str] = None
    title_size: Optional[float] = None
    title_color: Optional[str] = None
    title_metallic: Optional[bool] = None
    title_underline: Optional[str] = None
    title_align: Optional[str] = None
    subtitle_font: Optional[str] = None
    subtitle_size: Optional[float] = None
    subtitle_color: Optional[str] = None
    subtitle_metallic: Optional[bool] = None
    subtitle_underline: Optional[str] = None
    subtitle_align: Optional[str] = None
    text_top: Optional[int] = None
    show_pill: Optional[bool] = None
    pill_text: Optional[str] = None
    pill_text_2: Optional[str] = None
    pill_style: Optional[str] = None
    pill_radius: Optional[int] = None
    pill_border_color: Optional[str] = None
    pill_border_color_2: Optional[str] = None
    pill_border_w: Optional[float] = None
    pill_bg_color: Optional[str] = None
    pill_text_color: Optional[str] = None
    pill_font: Optional[str] = None
    pill_size: Optional[float] = None
    show_brand_logo: Optional[bool] = None
    brand_logo_variant: Optional[str] = None
    brand_logo_x: Optional[int] = None
    brand_logo_y: Optional[int] = None
    brand_logo_size: Optional[float] = None
    show_partners: Optional[bool] = None
    partners_y: Optional[int] = None
    partners_size: Optional[float] = None
    speaker_order: Optional[list[int]] = None


def _clamp(v, lo, hi, default, as_int=False):
    """Мусор приводим к умолчанию, а не роняем запрос.

    ⚠️ Иначе клиент, у которого в поле каким-то образом оказалась пустая строка,
    получит 500 вместо формы и не поймёт, что делать.
    """
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    n = max(lo, min(hi, n))
    return int(round(n)) if as_int else n


def _norm(data: dict) -> dict:
    out = dict(data)
    for f, (lo, hi) in _RANGES.items():
        if f in out and out[f] is not None:
            out[f] = _clamp(out[f], lo, hi, _DEFAULTS[f], as_int=f in _INT_FIELDS)
    for f, allowed in _CHOICES.items():
        if f in out and out[f] not in allowed:
            out[f] = _DEFAULTS[f]
    if "name_lines" in out and out["name_lines"] not in (1, 2):
        out["name_lines"] = 2
    # ⚠️ Порядок спикеров — массив ЦЕЛЫХ id. Строки и мусор отсеиваем здесь:
    # иначе они доедут до вёрстки и просто не совпадут ни с одним спикером,
    # а человек будет видеть, что перетаскивание «не работает».
    if "speaker_order" in out:
        raw = out["speaker_order"] or []
        clean: list[int] = []
        for x in raw if isinstance(raw, list) else []:
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if n not in clean:
                clean.append(n)
        out["speaker_order"] = clean
    return out


# ⚠️ Высота, с которой начинаются люди, У КАЖДОГО ФОРМАТА СВОЯ. Одно общее
# число (45 %) хорошо ложилось на вертикальную афишу, а на горизонтальной
# оставляло людям треть высоты: карточки ужимались втрое против примеров
# заказчика. Сверху всегда идут логотипы и заголовок, но на широком полотне
# они занимают меньшую долю высоты — значит и линия должна быть выше.
_TOP_BY_ORIENTATION = {"horizontal": 26, "vertical": 32, "square": 30}


def _num(row) -> dict:
    """Record → dict, где NUMERIC превращён в обычное число.

    ⚠️⚠️ ОБЯЗАТЕЛЬНО. asyncpg отдаёт NUMERIC как `Decimal`, а тот уезжает в JSON
    СТРОКОЙ («10.0»). Фронт умножает поля и кегли на коэффициенты — на строке
    это даёт NaN, и афиша рисуется пустой или схлопнутой. Полей NUMERIC здесь
    много: поля от края, `gap`, `name_size`, `hl_border_w`, `hl_glow`, размеры
    заголовка и пилюли.
    """
    from decimal import Decimal
    out = dict(row)
    for k, v in out.items():
        if isinstance(v, Decimal):
            out[k] = float(v)
    return out


async def _row(db: asyncpg.Connection, event_id: int, orientation: str) -> dict:
    """Макет из базы либо умолчания.

    ⚠️ Строку заранее НЕ создаём: она появляется при первом сохранении. Иначе
    у каждого события заводилось бы по три строки настроек, которых никто не
    открывал.
    """
    row = await db.fetchrow(
        "SELECT * FROM event_poster_layouts WHERE event_id = $1 AND orientation = $2",
        event_id, orientation,
    )
    if row:
        # ⚠️ Через _num: NUMERIC иначе уедет строкой и сломает расчёты на фронте.
        return _num(row)
    return {
        "event_id": event_id, "orientation": orientation,
        **_DEFAULTS,
        "speakers_top": _TOP_BY_ORIENTATION.get(orientation, _DEFAULTS["speakers_top"]),
    }


async def _theme(db: asyncpg.Connection, client_id: int) -> dict:
    """Фирменный стиль кабинета. Тот же запрос, что у обложек.

    ⚠️ Цвета и шрифты НЕ копируются в макет: они живут в «Стилях лендингов».
    Копия разошлась бы с темой в день, когда клиент поменяет фирменный цвет.
    """
    row = await db.fetchrow(
        """SELECT lp_bg_color, lp_bg_color_2, lp_bg_angle, lp_bg_gradient,
                  lp_font_heading, lp_font_body, lp_color_heading, lp_color_body,
                  lp_heading_metallic, brand_logo_url, brand_logo_light_url,
                  brand_name
             FROM clients WHERE id = $1""",
        client_id,
    )
    theme = dict(row) if row else {}
    from app.services.landing_fonts import FONTS
    theme["fonts"] = [{"key": f["key"], "label": f["label"]} for f in FONTS]
    return theme


async def _people(db: asyncpg.Connection, event_id: int) -> list[dict]:
    """Состав события для афиши.

    ⚠️ Берём ТОЛЬКО видимых (`is_visible`) и только с фотографией: карточка без
    фото на афише — это пустой прямоугольник, который ломает ряд.

    ⚠️ `name`/`last_name` и фото — из `collaborators` (они не меняются от
    события к событию), а роль, коммерческий признак и порядок — из
    `event_collaborators` (они у каждого события свои).
    """
    rows = await db.fetch(
        """SELECT c.id, c.name, c.last_name,
                  c.photo_url, c.cutout_photo_url,
                  c.photo_focal, c.cutout_photo_focal,
                  c.is_company, c.media_assets,
                  ec.role, ec.is_commercial, ec.sort_order
             FROM event_collaborators ec
             JOIN collaborators c ON c.id = ec.speaker_id
            WHERE ec.event_id = $1
              AND COALESCE(ec.is_visible, TRUE)
              AND (c.photo_url IS NOT NULL OR c.cutout_photo_url IS NOT NULL)
            ORDER BY COALESCE(ec.sort_order, 0), c.id""",
        event_id,
    )
    out = []
    for r in rows:
        d = dict(r)
        # media_assets приходит из jsonb — asyncpg отдаёт строкой.
        ma = d.get("media_assets")
        if isinstance(ma, str):
            import json
            try:
                d["media_assets"] = json.loads(ma)
            except ValueError:
                d["media_assets"] = []
        out.append(d)
    return out


def _check_orientation(orientation: str) -> None:
    if orientation not in ORIENTATIONS:
        raise HTTPException(404, detail="Неизвестный вид афиши")


# Фича генератора афиш (миграция 436). Пока включена только в скрытом тарифе
# `admin` — возможность обкатывается, клиентам её не открывали.
FEATURE = "poster_generator"


async def _guard(db: asyncpg.Connection, event_id: int, client_id: int) -> None:
    """Владение событием + фича.

    ⚠️ Проверка стоит в КАЖДОЙ ручке, а не только на чтении: без неё настройки
    и сборку картинки можно было бы дёрнуть напрямую, минуя спрятанную вкладку.
    """
    await assert_event_owner(db, event_id, client_id)
    if not await client_has_feature(db, client_id, FEATURE):
        # 404, а не 403: возможности для этого кабинета попросту нет.
        raise HTTPException(404, detail="Генератор афиш недоступен")


@router.get("/events/{event_id}/poster-layout/{orientation}",
            summary="Макет афиши, тема бренда и состав")
async def get_layout(
    event_id: int,
    orientation: str,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    _check_orientation(orientation)
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)
    return {
        "layout": await _row(db, event_id, orientation),
        "theme": await _theme(db, client_id),
        "people": await _people(db, event_id),
    }


@router.put("/events/{event_id}/poster-layout/{orientation}",
            summary="Сохранить макет афиши")
async def save_layout(
    event_id: int,
    orientation: str,
    data: LayoutIn,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    _check_orientation(orientation)
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)
    if await assistant_is_restricted(user):
        raise HTTPException(403, detail="Настройки афиш доступны только владельцу кабинета")

    # ⚠️ `exclude_unset` — присланные поля отличаем от неприсланных: без него
    # каждое сохранение затирало бы всё остальное умолчаниями.
    payload = _norm(data.model_dump(exclude_unset=True))
    cur = await _row(db, event_id, orientation)
    merged = {f: payload.get(f, cur.get(f, _DEFAULTS[f])) for f in _FIELDS}

    # speaker_order уходит в jsonb — asyncpg ждёт строку.
    import json
    merged["speaker_order"] = json.dumps(merged.get("speaker_order") or [])

    cols = ", ".join(_FIELDS)
    ph = ", ".join(f"${i + 3}" for i in range(len(_FIELDS)))
    upd = ", ".join(f"{f} = EXCLUDED.{f}" for f in _FIELDS)
    row = await db.fetchrow(
        f"""INSERT INTO event_poster_layouts (event_id, orientation, {cols})
            VALUES ($1, $2, {ph})
            ON CONFLICT (event_id, orientation) DO UPDATE
              SET {upd}, updated_at = NOW()
            RETURNING *""",
        event_id, orientation, *[merged[f] for f in _FIELDS],
    )
    return _num(row)


def _render_url(event_id: int, orientation: str, client_id: int) -> str:
    """Адрес страницы, которую откроет браузер для снимка.

    ⚠️ Адрес ПЛАТФОРМЫ, а не домен клиента: страница отрисовки живёт в кабинете
    и на свой домен не переезжает.
    """
    qs = urlencode({
        "event": event_id,
        "o": orientation,
        "t": make_preview_token(client_id),
    })
    return f"{platform_base_url().rstrip('/')}/poster-render?{qs}"


@router.get("/events/{event_id}/poster-layout/{orientation}/png",
            summary="Скачать афишу картинкой")
async def poster_png(
    event_id: int,
    orientation: str,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    _check_orientation(orientation)
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)

    try:
        png = await render_poster_png(_render_url(event_id, orientation, client_id), orientation)
    except PosterRenderError as e:
        raise HTTPException(503, detail=str(e))

    # Кириллица в имени файла — по RFC 5987, иначе браузер её испортит.
    name = "афиша"
    return Response(content=png, media_type="image/png", headers={
        "Content-Disposition":
            f"attachment; filename=\"poster.png\"; filename*=UTF-8''{quote(name)}.png",
    })


@router.post("/events/{event_id}/poster-layout/{orientation}/render",
             summary="Собрать афишу и положить в афиши события")
async def poster_render(
    event_id: int,
    orientation: str,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Собирает афишу и сразу кладёт её в афиши события.

    ⚠️ Так клиенту не нужно скачивать картинку и загружать её обратно руками —
    собранная афиша тут же доступна лендингу, Mini App и материалам для шеринга.
    """
    _check_orientation(orientation)
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)
    if await assistant_is_restricted(user):
        raise HTTPException(403, detail="Сборка афиш доступна только владельцу кабинета")

    try:
        png = await render_poster_png(_render_url(event_id, orientation, client_id), orientation)
    except PosterRenderError as e:
        raise HTTPException(503, detail=str(e))

    saved = await store_bytes(
        db, client_id=client_id, data=png,
        kind="event_poster", ext="png", content_type="image/png",
        event_id=event_id, poster_type=orientation,
    )

    # Кладём в общие афиши события (day IS NULL) — туда же, куда клиент грузит
    # афиши руками. Порядок 0: свежесобранная показывается первой.
    await db.execute(
        """INSERT INTO event_posters (event_id, url, orientation, sort)
           VALUES ($1, $2, $3, 0)""",
        event_id, saved["url"], orientation,
    )
    return saved
