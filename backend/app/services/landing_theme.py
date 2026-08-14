"""Оформление собранной страницы — вычисляемые поля темы.

Конструктор блоков общий для события и продукта (миграция 293), а вот
подготовка темы к отдаче жила ТОЛЬКО в лендинге события. У продукта её
просто забыли: цвета в базе лежали правильные, но `bg_css` и `font_*_css`
не считались, фронт получал `null` — и страница выходила белой, будто тема
не сохранилась. Отсюда единая функция: добавится третий владелец страницы —
он получит оформление сам.

Считаем на бэкенде, чтобы страница не собирала один и тот же CSS в нескольких
местах и не разъезжалась между ними.
"""
from typing import Any

from app.services.landing_fonts import font_family_css, normalize_font


def apply_theme_fields(page_d: dict[str, Any]) -> dict[str, Any]:
    """Дописывает в словарь страницы готовые CSS-значения. Меняет и возвращает."""
    page_d["font_heading_css"] = font_family_css(page_d.get("font_heading"))
    page_d["font_body_css"] = font_family_css(page_d.get("font_body"))
    page_d["font_heading"] = normalize_font(page_d.get("font_heading"))
    page_d["font_body"] = normalize_font(page_d.get("font_body"))

    # Готовая заливка фона: градиент под заданным углом либо сплошной цвет.
    if page_d.get("bg_gradient") and page_d.get("bg_color_2"):
        c1 = page_d.get("bg_color") or "#25455D"
        c2 = page_d["bg_color_2"]
        angle = page_d.get("bg_angle", 45)
        page_d["bg_css"] = f"linear-gradient({angle}deg, {c1}, {c2})"
        # ⚠️ Для режима «повторять на каждом экране» — ЗЕРКАЛЬНЫЙ градиент
        # (цвет1 → цвет2 → цвет1). Обычный при повторении даёт резкую полосу
        # на стыке: тёмный конец упирается в светлое начало следующего.
        page_d["bg_css_screen"] = (
            f"linear-gradient({angle}deg, {c1} 0%, {c2} 50%, {c1} 100%)"
        )
    else:
        page_d["bg_css"] = page_d.get("bg_color") or "#25455D"
        page_d["bg_css_screen"] = page_d["bg_css"]

    return page_d
