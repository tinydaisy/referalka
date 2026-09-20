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
from app.services.event_photo import apply_event_photo
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
    # Раскладка в колонки (миграция 454).
    "layout_mode", "speakers_width", "text_align",
    # Свободное размещение блоков (миграция 455).
    "logos_x", "logos_w", "logos_dir", "text_x", "text_w", "speakers_x",
    "mask_shape", "mask_radius", "per_row", "gap", "gap_y", "row_overlap",
    "show_names", "name_order", "name_lines", "name_font", "name_size",
    "name_color", "name_shadow", "name_place",
    "hl_style", "hl_color", "hl_border_w", "hl_glow",
    "role_badge", "role_badge_color", "role_badge_text_color",
    "title", "title_2", "title_2_color", "title_2_newline",
    "subtitle", "subtitle_2", "subtitle_2_color", "subtitle_2_newline",
    "show_title", "show_subtitle",
    "title_font", "title_size", "title_color", "title_metallic",
    "title_underline", "title_align",
    "subtitle_font", "subtitle_size", "subtitle_color", "subtitle_metallic",
    "subtitle_underline", "subtitle_align",
    "text_top", "gap_pill_title", "gap_title_subtitle",
    "show_pill", "pill_text", "pill_text_2", "pill_style", "pill_radius",
    "pill_border_color", "pill_border_color_2", "pill_border_w",
    "pill_bg_color", "pill_text_color", "pill_font", "pill_size",
    "show_brand_logo", "brand_logo_variant", "brand_logo_x", "brand_logo_y",
    "brand_logo_size",
    "show_partners", "partners_y", "partners_size",
    "speaker_order",
    # Индивидуальная афиша (миграция 459).
    "ind_show_role", "ind_show_topic", "ind_show_time", "ind_show_event_title",
    "ind_photo_size", "ind_photo_x", "ind_photo_y",
    "ind_name_size", "ind_role_size", "ind_topic_size",
    "ind_role_color", "ind_topic_color",
    # Ряды спикеров (миграция 445): [[id,id],[id,id,id]].
    "speaker_rows",
    # Ряды ОТДЕЛЬНО по дням (миграция 466): {"1": [[id,id]], "2": [...]}.
    "day_speaker_rows",
    # Положение КАЖДОГО блока в пикселях рабочей области (миграция 468).
    # NULL = «как раньше», по старым настройкам блока.
    "pos_logos_x", "pos_logos_y", "pos_text_x", "pos_text_y",
    "pos_pill1_x", "pos_pill1_y", "pos_pill2_x", "pos_pill2_y",
    "pos_speakers_x", "pos_speakers_y", "pos_photo_x", "pos_photo_y",
    "pos_topic_x", "pos_topic_y", "pos_time_x", "pos_time_y",
    # Выключка текстовых блоков и порядок фото/текста.
    "pill1_align", "pill2_align", "topic_align", "time_align", "name_align",
    "card_max_w",
    # Добавленные клиентом пилюли (миграция 471).
    "extra_pills",
    # Свои шрифты/размер/цвет темы, времени, имени и роли (миграция 473).
    "ind_topic_font", "ind_time_font", "ind_time_size", "ind_time_color",
    "ind_name_font", "ind_role_font",
    "ind_title_size", "ind_title_color", "ind_title_font", "ind_title_align", "ind_role_align",
    "ind_title_text", "ind_title_metallic", "ind_time_with_date",
    # Своя точка каждого элемента афиши спикера (миграция 470).
    "ind_title_x", "ind_title_y", "ind_role_x", "ind_role_y",
    "ind_name_x", "ind_name_y", "ind_topic_x", "ind_topic_y",
    "ind_time_x", "ind_time_y", "ind_topic_w", "ind_name_w",
    "ind_photo_first",
    # Публикация в кабинет спикера (миграция 469).
    "published_to_cabinet",
    # Где стоит пилюля дня (миграция 467): with_pills / under_title / free.
    # Порядок логотипов партнёров (миграция 445).
    "partner_order",
    # Общая строка логотипов (миграция 446): бренд и партнёры вместе.
    "logos_align", "logos_gap", "logos_variant", "logos_hidden", "logos_order",
)

# ⚠️ Должны совпадать с DEFAULT и CHECK в миграции 435: разойдутся — клиент
# увидит в форме одно, а база запишет другое (или отвергнет запись).
_DEFAULTS = {
    "bg_url": None, "bg_dim": 0,
    "margin_top": 10, "margin_bottom": 10, "margin_left": 10, "margin_right": 10,
    "speakers_top": 46, "speakers_bottom": 97, "speakers_side": 5,
    "layout_mode": "full", "speakers_width": 55, "text_align": "center",
    "logos_x": 0, "logos_w": 100, "logos_dir": "row",
    "text_x": 0, "text_w": 100, "speakers_x": 0,
    "mask_shape": "portrait", "mask_radius": 0, "per_row": None,
    "gap": 2, "gap_y": None, "row_overlap": 0,
    "show_names": True, "name_order": "first_last", "name_lines": 2,
    "name_font": None, "name_size": 15, "name_color": None,
    "name_shadow": False, "name_place": "below",
    "hl_style": "border", "hl_color": None, "hl_border_w": 0.3, "hl_glow": 1.5,
    "role_badge": "pill", "role_badge_color": None, "role_badge_text_color": None,
    "title": None, "title_2": None, "title_2_color": None, "title_2_newline": True,
    "subtitle": None, "subtitle_2": None, "subtitle_2_color": None,
    "subtitle_2_newline": False,
    "show_title": True, "show_subtitle": True,
    "title_font": None, "title_size": 76, "title_color": None,
    "title_metallic": True, "title_underline": "none", "title_align": "center",
    "subtitle_font": None, "subtitle_size": 28, "subtitle_color": None,
    "subtitle_metallic": False, "subtitle_underline": "none", "subtitle_align": "center",
    "text_top": 18, "gap_pill_title": 18, "gap_title_subtitle": 14,
    "show_pill": True, "pill_text": None, "pill_text_2": None,
    "pill_style": "border", "pill_radius": 50,
    "pill_border_color": None, "pill_border_color_2": None, "pill_border_w": 0.15,
    "pill_bg_color": None, "pill_text_color": None, "pill_font": None, "pill_size": 22,
    "show_brand_logo": True, "brand_logo_variant": "light",
    "brand_logo_x": 50, "brand_logo_y": 5, "brand_logo_size": 6,
    "show_partners": True, "partners_y": 5, "partners_size": 5,
    "speaker_order": [], "speaker_rows": [], "day_speaker_rows": {}, "partner_order": [],
    "pos_logos_x": None, "pos_logos_y": None, "pos_text_x": None, "pos_text_y": None,
    "pos_pill1_x": None, "pos_pill1_y": None, "pos_pill2_x": None, "pos_pill2_y": None,
    "pos_speakers_x": None, "pos_speakers_y": None,
    "pos_photo_x": None, "pos_photo_y": None,
    "pos_topic_x": None, "pos_topic_y": None, "pos_time_x": None, "pos_time_y": None,
    "pill1_align": "center", "pill2_align": "center", "topic_align": "center",
    "time_align": "center", "name_align": "center", "ind_photo_first": False,
    "card_max_w": 30, "extra_pills": [],
    "ind_topic_font": None, "ind_time_font": None, "ind_time_size": 24,
    "ind_time_color": None, "ind_name_font": None, "ind_role_font": None,
    "ind_title_size": 22, "ind_title_color": None, "ind_title_font": None,
    "ind_title_align": "center", "ind_role_align": "center",
    "ind_title_text": None, "ind_title_metallic": False, "ind_time_with_date": True,
    "ind_title_x": None, "ind_title_y": None, "ind_role_x": None, "ind_role_y": None,
    "ind_name_x": None, "ind_name_y": None, "ind_topic_x": None, "ind_topic_y": None,
    "ind_time_x": None, "ind_time_y": None, "ind_topic_w": None, "ind_name_w": None,
    "published_to_cabinet": False,

    "ind_show_role": True, "ind_show_topic": True, "ind_show_time": True,
    "ind_show_event_title": True,
    "ind_photo_size": 45, "ind_photo_x": 50, "ind_photo_y": 55,
    "ind_name_size": 54, "ind_role_size": 24, "ind_topic_size": 30,
    "ind_role_color": None, "ind_topic_color": None,
    "logos_align": "center", "logos_gap": 2.5, "logos_variant": "light",
    "logos_hidden": [], "logos_order": [],
}

# Границы числовых полей — те же, что в CHECK миграции.
_RANGES = {
    "bg_dim": (0, 90),
    "margin_top": (0, 60), "margin_bottom": (0, 60),
    "margin_left": (0, 60), "margin_right": (0, 60),
    "speakers_top": (0, 95), "speakers_bottom": (5, 100),
    "speakers_side": (0, 40), "speakers_width": (25, 80),
    "ind_photo_size": (10, 100), "ind_photo_x": (0, 100), "ind_photo_y": (0, 100),
    "ind_name_size": (10, 200), "ind_role_size": (8, 100), "ind_topic_size": (8, 120),
    "logos_x": (0, 100), "logos_w": (10, 100),
    "text_x": (0, 100), "text_w": (10, 100), "speakers_x": (0, 100),
    "mask_radius": (0, 50), "per_row": (1, 12),
    "gap": (0, 20), "gap_y": (0, 20), "row_overlap": (0, 60),
    # Размер имени — % ШИРИНЫ КАРТОЧКИ (мигр. 435 хранила % афиши; см. код).
    "name_size": (5, 40),
    "hl_border_w": (0, 3), "hl_glow": (0, 10),
    # Кегли — в ПИКСЕЛЯХ полотна (миграция 457).
    "title_size": (20, 200), "subtitle_size": (10, 90), "text_top": (0, 100),
    "gap_pill_title": (0, 200), "gap_title_subtitle": (0, 200),
    "pill_radius": (0, 50), "pill_border_w": (0, 2), "pill_size": (8, 70),
    "brand_logo_x": (0, 100), "brand_logo_y": (0, 100), "brand_logo_size": (1, 30),
    "partners_y": (0, 100), "partners_size": (1, 20),
    "logos_gap": (0, 20),
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
    "layout_mode": ("full", "left", "right"),
    "text_align": ("left", "center", "right"),
    "logos_dir": ("row", "column", "grid"),
    "logos_align": ("left", "center", "right"),
    "logos_variant": ("light", "dark"),
}

# Целые поля — их база не примет дробью.
_INT_FIELDS = {
    "bg_dim", "speakers_top", "speakers_bottom", "speakers_side", "mask_radius",
    "per_row", "row_overlap", "text_top", "pill_radius",
    "brand_logo_x", "brand_logo_y", "name_lines", "speakers_width",
    "ind_photo_size", "ind_photo_x", "ind_photo_y",
    "logos_x", "logos_w", "text_x", "text_w", "speakers_x",
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
    # Раскладка в колонки (миграция 454).
    layout_mode: Optional[str] = None
    speakers_width: Optional[int] = None
    text_align: Optional[str] = None
    # Свободное размещение блоков (миграция 455).
    logos_x: Optional[int] = None
    logos_w: Optional[int] = None
    logos_dir: Optional[str] = None
    text_x: Optional[int] = None
    text_w: Optional[int] = None
    speakers_x: Optional[int] = None
    mask_shape: Optional[str] = None
    mask_radius: Optional[int] = None
    per_row: Optional[int] = None
    gap: Optional[float] = None
    # Промежуток между РЯДАМИ (миграция 453). Пусто — как по горизонтали.
    gap_y: Optional[float] = None
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
    # Вторая часть заголовка своим цветом (миграция 447).
    title_2: Optional[str] = None
    title_2_color: Optional[str] = None
    title_2_newline: Optional[bool] = None
    subtitle: Optional[str] = None
    # Вторая часть подзаголовка своим цветом (миграция 458).
    subtitle_2: Optional[str] = None
    subtitle_2_color: Optional[str] = None
    subtitle_2_newline: Optional[bool] = None
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
    # Отступы между текстовыми блоками, px (миграция 458).
    gap_pill_title: Optional[float] = None
    gap_title_subtitle: Optional[float] = None
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
    # Ряды спикеров (миграция 445). Ряды разной длины — это норма.
    speaker_rows: Optional[list[list[int]]] = None
    # Ключ — номер дня строкой: JSON не умеет числовые ключи.
    day_speaker_rows: Optional[dict[str, list[list[int]]]] = None
    pos_logos_x: Optional[int] = None
    pos_logos_y: Optional[int] = None
    pos_text_x: Optional[int] = None
    pos_text_y: Optional[int] = None
    pos_pill1_x: Optional[int] = None
    pos_pill1_y: Optional[int] = None
    pos_pill2_x: Optional[int] = None
    pos_pill2_y: Optional[int] = None
    pos_speakers_x: Optional[int] = None
    pos_speakers_y: Optional[int] = None
    pos_photo_x: Optional[int] = None
    pos_photo_y: Optional[int] = None
    pos_topic_x: Optional[int] = None
    pos_topic_y: Optional[int] = None
    pos_time_x: Optional[int] = None
    pos_time_y: Optional[int] = None
    pill1_align: Optional[str] = None
    pill2_align: Optional[str] = None
    topic_align: Optional[str] = None
    time_align: Optional[str] = None
    name_align: Optional[str] = None
    ind_photo_first: Optional[bool] = None
    card_max_w: Optional[float] = None
    extra_pills: Optional[list[dict]] = None
    ind_topic_font: Optional[str] = None
    ind_time_font: Optional[str] = None
    ind_time_size: Optional[float] = None
    ind_time_color: Optional[str] = None
    ind_name_font: Optional[str] = None
    ind_role_font: Optional[str] = None
    ind_title_size: Optional[float] = None
    ind_title_color: Optional[str] = None
    ind_title_font: Optional[str] = None
    ind_title_align: Optional[str] = None
    ind_role_align: Optional[str] = None
    ind_title_text: Optional[str] = None
    ind_title_metallic: Optional[bool] = None
    ind_time_with_date: Optional[bool] = None
    ind_title_x: Optional[float] = None
    ind_title_y: Optional[float] = None
    ind_role_x: Optional[float] = None
    ind_role_y: Optional[float] = None
    ind_name_x: Optional[float] = None
    ind_name_y: Optional[float] = None
    ind_topic_x: Optional[float] = None
    ind_topic_y: Optional[float] = None
    ind_time_x: Optional[float] = None
    ind_time_y: Optional[float] = None
    ind_topic_w: Optional[float] = None
    ind_name_w: Optional[float] = None
    published_to_cabinet: Optional[bool] = None
    # Индивидуальная афиша (миграция 459).
    ind_show_role: Optional[bool] = None
    ind_show_topic: Optional[bool] = None
    ind_show_time: Optional[bool] = None
    ind_show_event_title: Optional[bool] = None
    ind_photo_size: Optional[int] = None
    ind_photo_x: Optional[int] = None
    ind_photo_y: Optional[int] = None
    ind_name_size: Optional[float] = None
    ind_role_size: Optional[float] = None
    ind_topic_size: Optional[float] = None
    ind_role_color: Optional[str] = None
    ind_topic_color: Optional[str] = None
    partner_order: Optional[list[int]] = None
    # Общая строка логотипов (миграция 446).
    logos_align: Optional[str] = None
    logos_gap: Optional[float] = None
    logos_variant: Optional[str] = None
    # ⚠️ Скрытые — смешанный список: id партнёров и строка 'brand'.
    logos_hidden: Optional[list] = None
    logos_order: Optional[list] = None


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
    # ⚠️ Оба списка — массивы целых id. Строки и мусор отсеиваем здесь: иначе
    # они доедут до вёрстки и не совпадут ни с одним человеком, а клиент решит,
    # что перетаскивание «не работает».
    for _key in ("speaker_order", "partner_order"):
        if _key not in out:
            continue
        raw = out[_key] or []
        clean: list[int] = []
        for x in raw if isinstance(raw, list) else []:
            try:
                n = int(x)
            except (TypeError, ValueError):
                continue
            if n not in clean:
                clean.append(n)
        out[_key] = clean
    # ⚠️ Ряды (миграция 445): массив массивов id. Чистим так же — мусор до
    # вёрстки доехать не должен. ПУСТЫЕ РЯДЫ ВЫБРАСЫВАЕМ: ряд, из которого
    # утащили последнего человека, иначе остался бы дырой в сетке.
    if "speaker_rows" in out:
        raw = out["speaker_rows"] or []
        seen: set[int] = set()
        rows: list[list[int]] = []
        for row in raw if isinstance(raw, list) else []:
            if not isinstance(row, list):
                continue
            clean_row: list[int] = []
            for x in row:
                try:
                    n = int(x)
                except (TypeError, ValueError):
                    continue
                # ⚠️ Один человек не может стоять в двух рядах сразу.
                if n in seen:
                    continue
                seen.add(n)
                clean_row.append(n)
            if clean_row:
                rows.append(clean_row)
        out["speaker_rows"] = rows
    # ⚠️ Добавленные пилюли (миграция 471). Чистим так же, как ряды: приходят
    # они с фронта, и класть их в базу как есть нельзя. Пустой текст выбрасываем
    # целиком — пустая пилюля это просто рамка ни вокруг чего.
    if "extra_pills" in out:
        raw = out["extra_pills"] or []
        pills = []
        for it in raw if isinstance(raw, list) else []:
            if not isinstance(it, dict):
                continue
            text = str(it.get("text") or "").strip()
            if not text:
                continue

            def _coord(v):
                # ⚠️ None — законное значение: «пилюля стоит в общем ряду».
                # Отличать его от кривого числа обязательно, иначе пилюля
                # молча уедет в угол листа.
                if v is None:
                    return None
                try:
                    n = float(v)
                except (TypeError, ValueError):
                    return None
                return max(0.0, min(100.0, n))

            align = it.get("align")
            pills.append({
                "text": text[:200],
                "x": _coord(it.get("x")),
                "y": _coord(it.get("y")),
                "align": align if align in ("left", "center", "right") else "center",
            })
        # Потолок на число: полсотни пилюль — это не макет, а сломанный фронт.
        out["extra_pills"] = pills[:20]

    # ⚠️ Ряды по дням (миграция 466). Чистим КАЖДЫЙ ДЕНЬ отдельно: человек не
    # может стоять дважды в одном дне, но в разные дни попадает законно —
    # общий `seen` на весь словарь выбросил бы его со второго дня.
    if "day_speaker_rows" in out:
        raw_map = out["day_speaker_rows"] or {}
        clean_map: dict[str, list[list[int]]] = {}
        for day_key, raw in (raw_map.items() if isinstance(raw_map, dict) else []):
            try:
                day_no = int(day_key)
            except (TypeError, ValueError):
                continue
            seen_d: set[int] = set()
            rows_d: list[list[int]] = []
            for row in raw if isinstance(raw, list) else []:
                if not isinstance(row, list):
                    continue
                clean_row = []
                for x in row:
                    try:
                        n = int(x)
                    except (TypeError, ValueError):
                        continue
                    if n in seen_d:
                        continue
                    seen_d.add(n)
                    clean_row.append(n)
                if clean_row:
                    rows_d.append(clean_row)
            if rows_d:
                clean_map[str(day_no)] = rows_d
        out["day_speaker_rows"] = clean_map
    return out


# ⚠️ Высота, с которой начинаются люди, У КАЖДОГО ФОРМАТА СВОЯ. Одно общее
# число (45 %) хорошо ложилось на вертикальную афишу, а на горизонтальной
# оставляло людям треть высоты: карточки ужимались втрое против примеров
# заказчика. Сверху всегда идут логотипы и заголовок, но на широком полотне
# они занимают меньшую долю высоты — значит и линия должна быть выше.
_TOP_BY_ORIENTATION = {"horizontal": 40, "vertical": 46, "square": 42}


# Поля, которые лежат в базе как jsonb.
# ⚠️ Из них СЛОВАРИ (а не списки) — пустышка у них своя.
_JSON_OBJECT_FIELDS = ("day_speaker_rows",)
_JSON_FIELDS = ("speaker_order", "speaker_rows", "day_speaker_rows", "partner_order",
                "extra_pills",
                "logos_hidden", "logos_order")


def _num(row) -> dict:
    """Record → dict с нормальными типами для фронта.

    ⚠️⚠️ ДВЕ ЛОВУШКИ asyncpg, обе тихие.

    1. NUMERIC приходит как `Decimal`, а тот уезжает в JSON СТРОКОЙ («10.0»).
       Фронт умножает поля и кегли на коэффициенты — на строке это даёт NaN, и
       афиша рисуется пустой. Полей NUMERIC много: поля от края, `gap`,
       `name_size`, `hl_border_w`, `hl_glow`, размеры заголовка и пилюли.

    2. JSONB приходит СТРОКОЙ («[]»), а не списком. Фронт зовёт `.map()` и
       `.length` — на строке `.length` даёт 2 (длину текста «[]»), раскладка
       считает, что ряды заданы, и падает на `.map()` элементов-символов.
       Ровно так и ловилась «application error» после сохранения макета.
    """
    from decimal import Decimal
    import json as _json
    out = dict(row)
    for k, v in out.items():
        if isinstance(v, Decimal):
            out[k] = float(v)
        elif k in _JSON_FIELDS and isinstance(v, str):
            try:
                out[k] = _json.loads(v)
            except ValueError:
                # ⚠️ Пустышка по ТИПУ поля: `day_speaker_rows` — словарь по
                # дням, и подставленный сюда список сломал бы чтение по ключу
                # (`rows[day]` на списке — ошибка, а не «пусто»).
                out[k] = {} if k in _JSON_OBJECT_FIELDS else []
        elif k in _JSON_FIELDS and v is None:
            out[k] = {} if k in _JSON_OBJECT_FIELDS else []
    return out


KINDS = ("common", "day", "individual")


async def _row(db: asyncpg.Connection, event_id: int, orientation: str,
               kind: str = "common") -> dict:
    """Макет из базы либо умолчания.

    ⚠️ Строку заранее НЕ создаём: она появляется при первом сохранении. Иначе
    у каждого события заводилось бы по три строки настроек, которых никто не
    открывал.
    """
    row = await db.fetchrow(
        "SELECT * FROM event_poster_layouts "
        " WHERE event_id = $1 AND orientation = $2 AND kind = $3",
        event_id, orientation, kind,
    )
    if row:
        # ⚠️ Через _num: NUMERIC иначе уедет строкой и сломает расчёты на фронте.
        return _num(row)
    base = {
        "event_id": event_id, "orientation": orientation, "kind": kind,
        **_DEFAULTS,
        "speakers_top": _TOP_BY_ORIENTATION.get(orientation, _DEFAULTS["speakers_top"]),
    }
    # ⚠️ У афиши ДНЯ подзаголовка нет: под названием идёт дата и время дня
    # (решение владельца). У индивидуальной он тоже не нужен — там тема.
    if kind in ("day", "individual"):
        base["show_subtitle"] = False
    return base


# Месяцы для «23–24 апреля».
_RU_MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
              "июля", "августа", "сентября", "октября", "ноября", "декабря"]


async def _suggested(db: asyncpg.Connection, event_id: int) -> dict:
    """Что подставить в пустые поля макета: название, подзаголовок, дата.

    ⚠️ ПОДСТАВЛЯЕМ ПРИ ОТДАЧЕ, А НЕ ПИШЕМ В БАЗУ. Запиши мы это один раз при
    создании макета — правка названия события или дат перестала бы доезжать до
    афиши, и клиент правил бы их дважды. Пустое поле означает «бери из события»,
    а как только клиент впишет своё — оно и останется.
    """
    ev = await db.fetchrow(
        "SELECT title, start_at, end_at, module_slug FROM events WHERE id = $1", event_id)
    if not ev:
        return {}

    # Подзаголовок — из блока «герой» лендинга события (то, что клиент уже
    # написал там, а не второй раз здесь).
    sub = await db.fetchval(
        """SELECT NULLIF(btrim(b.subtitle), '')
             FROM event_landing_blocks b
             JOIN event_landing_pages p ON p.id = b.page_id
            WHERE p.event_id = $1 AND p.kind = 'main' AND b.kind = 'hero'
              AND NULLIF(btrim(b.subtitle), '') IS NOT NULL
            ORDER BY b.sort_order LIMIT 1""",
        event_id,
    )

    # ⚠️ Даты у конференции и турнира живут в conf_days / conf_stages, а не в
    # events.start_at — там они часто пустые. Берём крайние дни программы.
    d1 = d2 = None
    if ev["module_slug"] in ("conference", "turnir"):
        row = await db.fetchrow(
            "SELECT MIN(day_date) AS a, MAX(day_date) AS b FROM conf_days WHERE event_id = $1",
            event_id,
        )
        if row:
            d1, d2 = row["a"], row["b"]
    if not d1 and ev["start_at"]:
        d1 = ev["start_at"].date()
        d2 = ev["end_at"].date() if ev["end_at"] else d1

    date_text = ""
    if d1:
        if d2 and d2 != d1:
            date_text = (f"{d1.day}–{d2.day} {_RU_MONTHS[d2.month]}"
                         if d1.month == d2.month
                         else f"{d1.day} {_RU_MONTHS[d1.month]} – {d2.day} {_RU_MONTHS[d2.month]}")
        else:
            date_text = f"{d1.day} {_RU_MONTHS[d1.month]}"

    # Формат события: «онлайн» есть в названии почти всегда, но полагаться на
    # это нельзя — для конференции подпись и так верна.
    fmt = "Онлайн-конференция" if ev["module_slug"] == "conference" else ""

    return {
        "title": ev["title"] or "",
        "subtitle": sub or "",
        "pill_text": date_text,
        "pill_text_2": fmt,
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
                  -- Логотип компании для светлого фона (миграция 450).
                  c.logo_on_light_url,
                  -- Приближение кадра по формам (миграция 451): афиша обязана
                  -- показать ровно то, что клиент настроил в карточке.
                  c.crop_zoom_circle, c.crop_zoom_square, c.crop_zoom_portrait,
                  c.crop_dx_circle, c.crop_dy_circle, c.crop_dx_square,
                  c.crop_dy_square, c.crop_dx_portrait, c.crop_dy_portrait,
                  ec.role, ec.is_commercial, ec.sort_order,
                  ephoto.url AS ep_url, ephoto.cutout_url AS ep_cutout_url,
                  ephoto.photo_focal AS ep_photo_focal,
                  ephoto.cutout_photo_focal AS ep_cutout_photo_focal,
                  ephoto.crop_zoom_circle AS ep_crop_zoom_circle,
                  ephoto.crop_zoom_square AS ep_crop_zoom_square,
                  ephoto.crop_zoom_portrait AS ep_crop_zoom_portrait,
                  ephoto.crop_dx_circle AS ep_crop_dx_circle,
                  ephoto.crop_dy_circle AS ep_crop_dy_circle,
                  ephoto.crop_dx_square AS ep_crop_dx_square,
                  ephoto.crop_dy_square AS ep_crop_dy_square,
                  ephoto.crop_dx_portrait AS ep_crop_dx_portrait,
                  ephoto.crop_dy_portrait AS ep_crop_dy_portrait
             FROM event_collaborators ec
             JOIN collaborators c ON c.id = ec.speaker_id
             -- ⚠️ Фото, выбранное ДЛЯ ЭТОГО события (миграция 472): клиент
             -- готовит под конференцию свои варианты — карикатуры, снимки с
             -- предметами. Не выбрано — остаётся профильное.
             LEFT JOIN collaborator_photos ephoto ON ephoto.id = ec.photo_id
            WHERE ec.event_id = $1
              AND COALESCE(ec.is_visible, TRUE)
              AND (c.photo_url IS NOT NULL OR c.cutout_photo_url IS NOT NULL
                   OR ephoto.url IS NOT NULL)
            ORDER BY COALESCE(ec.sort_order, 0), c.id""",
        event_id,
    )
    out = []
    for r in rows:
        # ⚠️ Фото события поверх профильного — ОДНА функция на весь проект:
        # кадр переезжает вместе с фото, иначе точка лица промахнётся.
        d = apply_event_photo(dict(r))
        # media_assets приходит из jsonb — asyncpg отдаёт строкой.
        # ⚠️ NUMERIC уезжает строкой, а фронт на него УМНОЖАЕТ размер фото.
        for _z in ("crop_zoom_circle", "crop_zoom_square", "crop_zoom_portrait",
                   "crop_dx_circle", "crop_dy_circle", "crop_dx_square",
                   "crop_dy_square", "crop_dx_portrait", "crop_dy_portrait"):
            if d.get(_z) is not None:
                d[_z] = float(d[_z])
        ma = d.get("media_assets")
        if isinstance(ma, str):
            import json
            try:
                d["media_assets"] = json.loads(ma)
            except ValueError:
                d["media_assets"] = []
        out.append(d)
    return out


async def _days(db: asyncpg.Connection, event_id: int) -> list[dict]:
    """Дни события со спикерами каждого дня — для афиш по дням.

    ⚠️ СПИКЕР В ДНЕ НЕ ДУБЛИРУЕТСЯ, даже если выступает дважды: на афише он
    один человек, а не два выступления (требование владельца).

    ⚠️ Время дня — ВРЕМЯ ПЕРВОГО ВЫСТУПЛЕНИЯ, а не поле `open_time`: оно часто
    пустое, и в пилюле оказывалось «День 1 — 24.09 в », с оборванным хвостом.
    """
    rows = await db.fetch(
        """SELECT d.day_number, d.day_date,
                  COALESCE(NULLIF(d.open_time, ''),
                           (SELECT MIN(NULLIF(s.start_time, ''))
                              FROM conf_sessions s
                             WHERE s.event_id = d.event_id AND s.day = d.day_number)
                  ) AS start_time,
                  ARRAY(
                    -- ⚠️⚠️ `conf_sessions.speaker_id` — это `event_collaborators.id`
                    -- (миграции 003/004 + переименование 075), а состав афиши
                    -- (`_people`) отдаёт `collaborators.id`. Без этого перехода
                    -- списки НИКОГДА не совпадут: на афише дня окажется пусто
                    -- или, того хуже, чужие люди с совпавшими номерами.
                    SELECT DISTINCT ec2.speaker_id
                      FROM conf_sessions s2
                      JOIN event_collaborators ec2 ON ec2.id = s2.speaker_id
                     WHERE s2.event_id = d.event_id AND s2.day = d.day_number
                       AND s2.speaker_id IS NOT NULL
                  ) AS speaker_ids
             FROM conf_days d
            WHERE d.event_id = $1
            ORDER BY d.day_date NULLS LAST, d.day_number""",
        event_id,
    )
    out = []
    # ⚠️⚠️ НОМЕР В ПОДПИСИ — ПОРЯДКОВЫЙ ПО ДАТЕ, а не сырой `day_number`.
    # В базе номер дня и его дата легко расходятся: клиент добавил день задним
    # числом, и у события 89 «19 сентября» записано как day_number = 4, а
    # 24 и 25 сентября — как дни 1 и 2. Список отсортирован по дате (это
    # верно), и на афишах выходило «День 4» у первого дня, «День 1» у
    # третьего — нумерация выглядела сломанной (жалоба владельца 20.09.2026).
    #
    # Человек считает дни по порядку их наступления, поэтому нумеруем так же.
    # ⚠️ Сам `day` в ответе остаётся НАСТОЯЩИМ (day_number): по нему ищутся
    # спикеры дня и раскладываются афиши в `event_posters.day`. Меняется
    # только то, что написано на картинке.
    for idx, r in enumerate(rows, start=1):
        d = r["day_date"]
        # «День 1 — 24.09 в 11:00». Год не пишем: афиша живёт недели, не годы.
        label = f"День {idx}"
        if d:
            label += f" — {d.day:02d}.{d.month:02d}"
        if r["start_time"]:
            label += f" в {r['start_time']}"
        out.append({
            "day": r["day_number"],
            "date": d.isoformat() if d else None,
            "start_time": r["start_time"],
            "label": label,
            "speaker_ids": list(r["speaker_ids"] or []),
        })
    return out


async def _sessions(db: asyncpg.Connection, event_id: int) -> dict:
    """Выступления каждого спикера: тема, дата и время — для афиш спикера.

    ⚠️⚠️ ВСЕ СЛОТЫ, А НЕ ПЕРВЫЙ. Раньше стоял `DISTINCT ON` и брался один: у
    того, кто выступает дважды (как Марго Форбс), вторая дата на афише просто
    пропадала. Клиент просил показывать все (20.09.2026).

    ⚠️ Ключ словаря — `collaborators.id`: полотно ищет по `p.id`. Поэтому
    переход через `event_collaborators`, а не `conf_sessions.speaker_id`
    напрямую (тот ссылается на связку человек+событие, миграции 003/004).
    """
    rows = await db.fetch(
        """SELECT ec.speaker_id, s.day, s.start_time, s.title, d.day_date
             FROM conf_sessions s
             JOIN event_collaborators ec ON ec.id = s.speaker_id
             LEFT JOIN conf_days d ON d.event_id = s.event_id AND d.day_number = s.day
            WHERE s.event_id = $1 AND s.speaker_id IS NOT NULL
            ORDER BY ec.speaker_id, d.day_date NULLS LAST, s.day, s.start_time""",
        event_id,
    )
    out: dict[str, dict] = {}
    for r in rows:
        key = str(r["speaker_id"])
        dt = r["day_date"]
        date_str = f"{dt.day:02d}.{dt.month:02d}" if dt else ""
        time_str = str(r["start_time"]) if r["start_time"] else ""
        # «24.09 в 11:00»; если чего-то нет — только то, что есть.
        when = " в ".join([x for x in (date_str, time_str) if x])

        cur = out.setdefault(key, {
            "topic": r["title"] or "",
            "when": when,
            "day": r["day"],
            # ⚠️ Все слоты списком: пилюля дат на афише собирается из них.
            "slots": [],
            # ⚠️ И ВСЕ ТЕМЫ: у каждого выступления она своя. Взяв только первую,
            # мы бы показали на афише одну тему, а человек выступает с двумя —
            # анонс получился бы неполным.
            "topics": [],
        })
        if when:
            cur["slots"].append(when)
        if r["title"] and r["title"] not in cur["topics"]:
            cur["topics"].append(r["title"])
        if not cur["topic"] and r["title"]:
            cur["topic"] = r["title"]
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


async def _existing_count(db: asyncpg.Connection, event_id: int,
                          orientation: str, kind: str) -> int:
    """Сколько афиш этого вида и ориентации уже собрано.

    ⚠️ Общие и дневные различаются по `day`: у общих он NULL. Индивидуальные
    лежат не здесь, а в библиотеках спикеров — их считаем по метке, которую
    ставит render-all.
    """
    if kind == "common":
        return await db.fetchval(
            "SELECT COUNT(*) FROM event_posters"
            " WHERE event_id = $1 AND orientation = $2 AND day IS NULL",
            event_id, orientation,
        ) or 0
    if kind == "day":
        return await db.fetchval(
            "SELECT COUNT(*) FROM event_posters"
            " WHERE event_id = $1 AND orientation = $2 AND day IS NOT NULL",
            event_id, orientation,
        ) or 0
    return await db.fetchval(
        "SELECT COUNT(*) FROM collaborator_posters cp"
        "  JOIN event_collaborators ec ON ec.speaker_id = cp.collaborator_id"
        " WHERE ec.event_id = $1 AND cp.label LIKE $2",
        event_id, f"%({orientation})",
    ) or 0


@router.get("/events/{event_id}/poster-layout/{orientation}",
            summary="Макет афиши, тема бренда и состав")
async def get_layout(
    event_id: int,
    orientation: str,
    # Вид макета: общая афиша, афиша дня или индивидуальная (миграция 459).
    kind: str = "common",
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    _check_orientation(orientation)
    if kind not in KINDS:
        raise HTTPException(404, detail="Неизвестный вид афиши")
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)
    return {
        "layout": await _row(db, event_id, orientation, kind),
        # Дни со спикерами и выступления — для афиш по дням и индивидуальных.
        "days": await _days(db, event_id),
        "sessions": await _sessions(db, event_id),
        "theme": await _theme(db, client_id),
        "people": await _people(db, event_id),
        # ⚠️ Отдаём ОТДЕЛЬНО от макета, а не подмешиваем в него: иначе
        # сохранение записало бы подсказку как «выбор клиента», и правка
        # названия события перестала бы доезжать до афиши.
        "suggested": await _suggested(db, event_id),
        # ⚠️ Сколько афиш этого вида и ориентации уже лежит. Нужно фронту,
        # чтобы спросить «заменить или добавить» — и НЕ спрашивать, когда
        # заменять нечего (первая сборка).
        "existing": await _existing_count(db, event_id, orientation, kind),
    }


@router.put("/events/{event_id}/poster-layout/{orientation}",
            summary="Сохранить макет афиши")
async def save_layout(
    event_id: int,
    orientation: str,
    data: LayoutIn,
    kind: str = "common",
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    _check_orientation(orientation)
    if kind not in KINDS:
        raise HTTPException(404, detail="Неизвестный вид афиши")
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)
    if await assistant_is_restricted(user):
        raise HTTPException(403, detail="Настройки афиш доступны только владельцу кабинета")

    # ⚠️ `exclude_unset` — присланные поля отличаем от неприсланных: без него
    # каждое сохранение затирало бы всё остальное умолчаниями.
    payload = _norm(data.model_dump(exclude_unset=True))
    cur = await _row(db, event_id, orientation, kind)
    merged = {f: payload.get(f, cur.get(f, _DEFAULTS[f])) for f in _FIELDS}

    # speaker_order уходит в jsonb — asyncpg ждёт строку.
    import json
    merged["speaker_order"] = json.dumps(merged.get("speaker_order") or [])
    merged["speaker_rows"] = json.dumps(merged.get("speaker_rows") or [])
    # ⚠️ Словарь, а не список: в базе стоит проверка jsonb_typeof = object.
    merged["day_speaker_rows"] = json.dumps(merged.get("day_speaker_rows") or {})
    merged["partner_order"] = json.dumps(merged.get("partner_order") or [])
    merged["logos_hidden"] = json.dumps(merged.get("logos_hidden") or [])
    merged["logos_order"] = json.dumps(merged.get("logos_order") or [])
    merged["extra_pills"] = json.dumps(merged.get("extra_pills") or [])

    cols = ", ".join(_FIELDS)
    ph = ", ".join(f"${i + 4}" for i in range(len(_FIELDS)))
    upd = ", ".join(f"{f} = EXCLUDED.{f}" for f in _FIELDS)
    row = await db.fetchrow(
        f"""INSERT INTO event_poster_layouts (event_id, orientation, kind, {cols})
            VALUES ($1, $2, $3, {ph})
            ON CONFLICT (event_id, kind, orientation) DO UPDATE
              SET {upd}, updated_at = NOW()
            RETURNING *""",
        event_id, orientation, kind, *[merged[f] for f in _FIELDS],
    )
    return _num(row)


def _render_url(event_id: int, orientation: str, client_id: int,
                kind: str = "common", day: int | None = None,
                speaker_id: int | None = None) -> str:
    """Адрес страницы, которую откроет браузер для снимка.

    ⚠️ Адрес ПЛАТФОРМЫ, а не домен клиента: страница отрисовки живёт в кабинете
    и на свой домен не переезжает.
    """
    params = {
        "event": event_id,
        "o": orientation,
        "kind": kind,
        "t": make_preview_token(client_id),
    }
    # Афиша конкретного дня или конкретного спикера.
    if day is not None:
        params["day"] = day
    if speaker_id is not None:
        params["speaker"] = speaker_id
    qs = urlencode(params)
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


@router.post("/events/{event_id}/poster-layout/{orientation}/copy-bg",
             summary="Скопировать фон и оформление во все афиши этой ориентации")
async def poster_copy_bg(
    event_id: int,
    orientation: str,
    kind: str = "common",
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Копирует фон И ОФОРМЛЕНИЕ текущей афиши во ВСЕ виды этой ориентации.

    ⚠️ ТОЛЬКО В СВОЮ ОРИЕНТАЦИЮ: вертикальный фон на горизонтальной афише
    растянется или обрежется — это разные картинки, а не один файл в трёх
    размерах. Поэтому «скопировать из вертикальной» означает «во все
    вертикальные»: общую, дневную и индивидуальную (владелец, 19.09.2026).

    Копируем оформление целиком: фон, цвета, кегли, логотипы партнёров с их
    размерами и показанностью, оформление карточек спикеров. НЕ копируем
    состав и расстановку людей и тексты — они у каждого вида свои (подробности
    в списке _NOT_COPIED ниже).
    """
    _check_orientation(orientation)
    if kind not in KINDS:
        raise HTTPException(404, detail="Неизвестный вид афиши")
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)
    if await assistant_is_restricted(user):
        raise HTTPException(403, detail="Настройки афиш доступны только владельцу кабинета")

    src = await _row(db, event_id, orientation, kind)

    # ⚠️⚠️ КОПИРУЕМ ВСЁ ОФОРМЛЕНИЕ, а не только картинку фона: показанность и
    # размер логотипов партнёров, кегли заголовков, все цвета, оформление
    # карточек спикеров — клиент перечислил это прямо (19.09.2026).
    #
    # ⚠️ НЕ КОПИРУЕМ то, что у видов своё по смыслу:
    #   speaker_rows / day_speaker_rows / speaker_order / partner_order —
    #     состав и расстановка: в общей афише четырнадцать человек, в дневной
    #     четверо, в индивидуальной один. Перенос стёр бы расстановку;
    #   тексты заголовка, подзаголовка и пилюль — они про разное: у дня своя
    #     метка, у спикера своя тема;
    #   published_to_cabinet — публикация решается отдельно для каждого вида.
    _NOT_COPIED = {
        "speaker_rows", "day_speaker_rows", "speaker_order", "partner_order",
        "title", "title_2", "subtitle", "subtitle_2",
        "pill_text", "pill_text_2", "published_to_cabinet",
    }
    fields = [f for f in _FIELDS if f not in _NOT_COPIED]

    done = []
    for k in KINDS:
        if k == kind:
            continue
        # ⚠️⚠️ ИМЕННО UPSERT, а не UPDATE. `_row` строку НЕ создаёт — она
        # появляется только при первом сохранении макета. Вид, который клиент
        # ещё не открывал, простым UPDATE не получил бы ничего: команда
        # отработала бы «успешно», изменив ноль строк, а фон не появился.
        import json
        vals = []
        for f in fields:
            v = src.get(f, _DEFAULTS[f])
            # ⚠️ jsonb-поля уходят строкой: asyncpg не умеет списки и словари.
            if f in _JSON_FIELDS:
                v = json.dumps(v if v is not None else ([] if f not in _JSON_OBJECT_FIELDS else {}))
            vals.append(v)
        cols = ", ".join(fields)
        ph = ", ".join(f"${i + 4}" for i in range(len(fields)))
        upd = ", ".join(f"{f} = EXCLUDED.{f}" for f in fields)
        await db.execute(
            f"INSERT INTO event_poster_layouts (event_id, kind, orientation, {cols})"
            f" VALUES ($1, $2, $3, {ph})"
            f" ON CONFLICT (event_id, kind, orientation) DO UPDATE SET {upd}",
            event_id, k, orientation, *vals,
        )
        done.append(k)

    return {"copied_to": done, "orientation": orientation}


@router.post("/events/{event_id}/poster-layout/{orientation}/render-all",
             summary="Собрать все афиши вида и разложить по местам")
async def poster_render_all(
    event_id: int,
    orientation: str,
    kind: str = "common",
    # ⚠️⚠️ ЗАМЕНИТЬ ИЛИ ДОБАВИТЬ. Раньше афиши всегда ложились рядом, и после
    # трёх пересборок у события копилась куча одинаковых картинок. Рассылка
    # берёт ПЕРВУЮ по (sort, id) — то есть какая из них уйдёт людям, решал
    # случай: все вставлялись с sort = 0. Клиент прямо сказал, что не понимает,
    # какая пойдёт в рассылку, — и был прав, это нигде не определено.
    #
    # Несколько афиш оставить можно (раньше так делали под разных спикеров),
    # поэтому выбор, а не жёсткая замена. Спрашивает фронт, сюда приходит ответ.
    #
    # ⚠️ Замена трогает ТОЛЬКО ЭТУ ОРИЕНТАЦИЮ (решение владельца): опубликовал
    # вертикальную — заменилась вертикальная, горизонтальная осталась на месте.
    replace: bool = False,
    # Показывать ли афиши этого вида в кабинете спикера (миграция 469).
    publish: bool = False,
    user: dict = Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Собирает СРАЗУ ВСЕ афиши выбранного вида и кладёт каждую куда следует.

    ⚠️ ОДНА КНОПКА НА ВСЁ (требование владельца): у события бывает четыре дня и
    полтора десятка спикеров — нажимать «собрать» на каждой афише отдельно это
    двадцать нажатий и двадцать ожиданий.

    Куда попадает результат:
      common     — в общие афиши события (`event_posters`, day IS NULL);
      day        — в афиши СВОЕГО дня (`event_posters.day = N`);
      individual — в библиотеку афиш спикера (`collaborator_posters`) и
                   отмечается как афиша этого события.
    """
    _check_orientation(orientation)
    if kind not in KINDS:
        raise HTTPException(404, detail="Неизвестный вид афиши")
    client_id = int(user["sub"])
    await _guard(db, event_id, client_id)
    if await assistant_is_restricted(user):
        raise HTTPException(403, detail="Сборка афиш доступна только владельцу кабинета")

    made: list[dict] = []

    if replace:
        # ⚠️ Только своя ориентация и только свой вид: общие афиши живут с
        # day IS NULL, дневные — с проставленным day. Снести всё разом значило
        # бы выбросить и то, чего клиент не пересобирал.
        if kind == "common":
            await db.execute(
                "DELETE FROM event_posters"
                " WHERE event_id = $1 AND orientation = $2 AND day IS NULL",
                event_id, orientation,
            )
        elif kind == "day":
            await db.execute(
                "DELETE FROM event_posters"
                " WHERE event_id = $1 AND orientation = $2 AND day IS NOT NULL",
                event_id, orientation,
            )

    async def _shot(day: int | None = None, speaker_id: int | None = None) -> bytes:
        url = _render_url(event_id, orientation, client_id, kind, day, speaker_id)
        try:
            return await render_poster_png(url, orientation)
        except PosterRenderError as e:
            raise HTTPException(503, detail=str(e))

    if kind == "common":
        png = await _shot()
        saved = await store_bytes(
            db, client_id=client_id, data=png, kind="event_poster",
            ext="png", content_type="image/png",
            event_id=event_id, poster_type=orientation,
        )
        await db.execute(
            "INSERT INTO event_posters (event_id, url, orientation, sort) VALUES ($1,$2,$3,0)",
            event_id, saved["url"], orientation,
        )
        made.append({"what": "common", "url": saved["url"]})

    elif kind == "day":
        for d in await _days(db, event_id):
            png = await _shot(day=d["day"])
            saved = await store_bytes(
                db, client_id=client_id, data=png, kind="event_poster",
                ext="png", content_type="image/png",
                event_id=event_id, poster_type=orientation,
            )
            # ⚠️ В афиши СВОЕГО дня: у `event_posters` для этого есть `day`.
            await db.execute(
                "INSERT INTO event_posters (event_id, url, orientation, sort, day)"
                " VALUES ($1,$2,$3,0,$4)",
                event_id, saved["url"], orientation, d["day"],
            )
            made.append({"what": f"day{d['day']}", "url": saved["url"]})

    else:  # individual
        ev_title = await db.fetchval("SELECT title FROM events WHERE id = $1", event_id) or "Событие"
        people = [p for p in await _people(db, event_id) if not p.get("is_company")]
        for p in people:
            png = await _shot(speaker_id=p["id"])
            saved = await store_bytes(
                db, client_id=client_id, data=png, kind="speaker_poster",
                ext="png", content_type="image/png",
                collaborator_id=p["id"],
            )
            # В библиотеку афиш человека.
            # ⚠️ С подписью: в библиотеке спикера лежат и загруженные вручную
            # афиши, и по метке видно, какая пришла из генератора события.
            row = await db.fetchrow(
                "INSERT INTO collaborator_posters (collaborator_id, url, label, sort_order)"
                " VALUES ($1,$2,$3,0) RETURNING id",
                p["id"], saved["url"], f"{ev_title} ({orientation})",
            )
            # ⚠️ И сразу отмечаем её афишей ЭТОГО события: иначе клиенту
            # пришлось бы руками проходить по всем карточкам и ставить галочку.
            #
            # ⚠️⚠️ ДВА РАЗНЫХ ПОЛЯ, и нужны ОБА:
            #   poster_id               — главная афиша спикера (миграция 121);
            #   announcement_poster_ids — галочка «для анонсов» (миграция 122),
            #     и ИМЕННО по ней выгрузка материалов собирает папку
            #     «Афиши/Индивидуальные афиши». Проставишь только poster_id —
            #     афиша есть в карточке, но в архив не попадает, и владелец
            #     получает пустую папку, не понимая почему.
            await db.execute(
                "UPDATE event_collaborators"
                "   SET poster_id = $1,"
                # Добавляем к отмеченным, а не затираем: клиент мог отметить
                # ещё и свои загруженные афиши.
                "       announcement_poster_ids ="
                "         CASE WHEN $1 = ANY(announcement_poster_ids)"
                "              THEN announcement_poster_ids"
                "              ELSE announcement_poster_ids || $1 END"
                " WHERE event_id = $2 AND speaker_id = $3",
                row["id"], event_id, p["id"],
            )
            made.append({"what": f"speaker{p['id']}", "url": saved["url"]})

    # ⚠️ Публикация — отдельное осознанное действие (миграция 469). Без неё
    # афиши собраны, но в кабинете спикера не показываются: клиент подбирает
    # раскладку в несколько заходов, и каждая проба не должна уезжать людям.
    if publish:
        await db.execute(
            "INSERT INTO event_poster_layouts (event_id, kind, orientation, published_to_cabinet)"
            " VALUES ($1, $2, $3, TRUE)"
            " ON CONFLICT (event_id, kind, orientation)"
            " DO UPDATE SET published_to_cabinet = TRUE",
            event_id, kind, orientation,
        )

    return {"made": made, "count": len(made), "replaced": replace, "published": publish}
