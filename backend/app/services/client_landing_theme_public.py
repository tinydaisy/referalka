"""
Тема оформления клиента для ПУБЛИЧНЫХ страниц — одна точка.

Анкета (`/f/{slug}`), оферта (`/o/{slug}`) и прочие служебные страницы должны
выглядеть как лендинги клиента, а не как чужая белая простыня: человек попадает
на них из воронки клиента и не должен чувствовать, что его увели на сторонний
сервис (решение владельца 2026-08-12).

Настройки задаются один раз в «Настройки → Стили лендингов» (`clients.lp_*`) и
отдаются страницам как есть — фронт сам решает, что применить.

⚠️ Своего SELECT по `lp_*` в модулях быть не должно: набор колонок вырастет, и
страницы разъедутся между собой. Нужна новая колонка — дописывать сюда.
"""
from __future__ import annotations

import logging

from app.services.person_name import display_name

logger = logging.getLogger(__name__)

# Колонки темы. Порядок неважен, важно, чтобы список был ОДИН на все страницы.
_THEME_COLUMNS = (
    "lp_bg_color", "lp_bg_color_2", "lp_bg_angle", "lp_bg_gradient",
    "lp_color_heading", "lp_color_body", "lp_color_link",
    "lp_card_bg", "lp_card_text_color",
    "lp_btn_color", "lp_btn_text_color", "lp_btn_radius",
    "lp_font_heading", "lp_font_body", "lp_content_width",
)


async def client_landing_theme(db, client_id: int) -> dict:
    """Тема клиента для публичной страницы. Пустой словарь = оформления нет.

    ⚠️ Ошибку глушим намеренно: тема — оформление, а не содержимое. Сбой
    запроса не должен ронять страницу с текстом оферты или анкетой — человек
    увидит её в стандартном виде, но увидит.
    """
    if not client_id:
        return {}
    try:
        row = await db.fetchrow(
            f"SELECT {', '.join(_THEME_COLUMNS)} FROM clients WHERE id = $1",
            client_id,
        )
    except Exception:
        logger.exception("не удалось получить тему клиента %s", client_id)
        return {}
    if not row:
        return {}
    theme = {k: v for k, v in dict(row).items() if v is not None}

    # Готовая заливка фона — считаем ЗДЕСЬ, тем же правилом, что у лендинга
    # (`bg_css` в event_landing_public). Иначе каждая страница собирает CSS
    # по-своему и они расходятся: у оферты фон уже выглядел иначе, чем у
    # лендинга того же клиента.
    c1 = theme.get("lp_bg_color") or "#25455D"
    c2 = theme.get("lp_bg_color_2")
    angle = theme.get("lp_bg_angle", 45)
    if theme.get("lp_bg_gradient") and c2:
        theme["bg_css"] = f"linear-gradient({angle}deg, {c1}, {c2})"
        # ⚠️ Для ДЛИННОЙ страницы (оферта — сплошной текст на много экранов)
        # обычный градиент растягивается, и низ уходит в тёмный конец: у
        # клиента с настройкой «бирюза → почти чёрный» документ дочитывался
        # уже по чёрному. Зеркальный (цвет1 → цвет2 → цвет1) держит оба края
        # в исходном цвете — то же решение, что у режима «на каждом экране».
        theme["bg_css_long"] = (
            f"linear-gradient({angle}deg, {c1} 0%, {c2} 50%, {c1} 100%)"
        )
    else:
        theme["bg_css"] = c1
        theme["bg_css_long"] = c1
    return theme


async def client_brand_header(db, client_id: int) -> dict:
    """Шапка публичной страницы: логотип, бренд, имя основателя. Одна точка.

    ⚠️ Логотипов ДВА: основной (`brand_logo_url`) обычно белый и виден на
    тёмном фоне, светлый (`brand_logo_light_url`) — тёмная версия знака для
    светлой карточки. Раньше был один, и на белом фоне анкеты он сливался с
    подложкой, выглядя как пустое место (жалоба владельца 2026-08-12).
    Какой показать — решает страница по светлоте своей карточки.
    """
    if not client_id:
        return {}
    try:
        b = await db.fetchrow(
            # ⚠️ Имя основателя — с фамилией (миграция 381): шапка видна
            # посетителю на оферте и в анкете, где он оставляет свои данные.
            "SELECT name, last_name, brand_name, brand_logo_url, brand_logo_light_url, "
            "       profile_photo_url "
            "FROM clients WHERE id = $1",
            client_id,
        )
    except Exception:
        logger.exception("не удалось получить бренд клиента %s", client_id)
        return {}
    if not b:
        return {}
    return {
        "owner_name": display_name(b["name"], b["last_name"]),
        "brand_name": b["brand_name"],
        # Пусто → берём основной: у большинства клиентов второго файла нет,
        # и поведение остаётся прежним.
        "logo_url": b["brand_logo_url"] or b["profile_photo_url"],
        "logo_light_url": b["brand_logo_light_url"] or b["brand_logo_url"]
                          or b["profile_photo_url"],
    }
