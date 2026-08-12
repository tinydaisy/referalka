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

logger = logging.getLogger(__name__)

# Колонки темы. Порядок неважен, важно, чтобы список был ОДИН на все страницы.
_THEME_COLUMNS = (
    "lp_bg_color", "lp_bg_color_2", "lp_bg_angle",
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
    return {k: v for k, v in dict(row).items() if v is not None}
