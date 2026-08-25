"""Фирменные цвета клиента для Mini App и веб-витрины события.

Зачем. Клиент настраивает оформление в «Стилях лендингов» (`clients.lp_*`), и
до миграции 331 оно применялось ТОЛЬКО к лендингу. Mini App и веб-витрина
рисовались зашитыми цветами платформы — человек собирал фирменную тему и не
видел её ровно там, куда приводит свою аудиторию.

⚠️ ОДНА ТОЧКА СБОРКИ. Тема нужна трём эндпоинтам сразу (витрина события,
визитка клиента, экран разрешений VK). Собранный на месте набор цветов
неминуемо разъехался бы между ними: где-то забыли градиент, где-то взяли
другое поле под тот же элемент. Новая точка отдачи темы — зовёт `theme_dict`,
а не пишет свой SELECT.

⚠️ ГАЛОЧКА ВЫКЛЮЧЕНА — ОТДАЁМ None. Тема есть у каждого клиента (колонки
`lp_*` заполнены значениями по умолчанию с миграции 241), поэтому «отдадим
всегда, фронт разберётся» перекрасило бы Mini App у всех, кто цвета не выбирал.
Отсутствие темы во фронте означает «рисуй как раньше».
"""
from typing import Any, Optional

# Колонки clients, которые должен выбрать вызывающий SELECT, чтобы `theme_dict`
# собрал тему. Перечислены здесь справочно — в самих запросах пишутся явно,
# иначе длинный SQL пришлось бы склеивать конкатенацией и он стал бы нечитаем.
THEME_COLUMNS = (
    "miniapp_use_brand_theme",
    "lp_bg_color", "lp_bg_color_2", "lp_bg_angle", "lp_bg_gradient",
    "lp_btn_color", "lp_btn_color_2", "lp_btn_angle", "lp_btn_text_color",
    "lp_btn_border_color", "lp_btn_border_width",
    "lp_icon_color",
    "lp_card_bg", "lp_card_bg_opacity", "lp_card_text_color",
    "lp_color_heading", "lp_color_body",
    "lp_day_tab_color", "lp_day_tab_text_color",
)


def _gradient(c1: Optional[str], c2: Optional[str], angle: Any, enabled: Any) -> Optional[str]:
    """Заливка: градиент при двух цветах и включённом флаге, иначе сплошной цвет."""
    if not c1:
        return None
    if enabled and c2:
        try:
            deg = int(angle if angle is not None else 45)
        except (TypeError, ValueError):
            deg = 45
        return f"linear-gradient({deg}deg, {c1}, {c2})"
    return c1


def theme_dict(row: Any) -> Optional[dict[str, Any]]:
    """Собирает тему из строки clients. None = клиент не включил фирменные цвета.

    Возвращает ровно те роли, которые Mini App умеет красить, — не сырые
    колонки. Так фронт не знает про имена полей базы, и переименование колонки
    не разносится по всем экранам.
    """
    if row is None:
        return None
    d = dict(row) if not isinstance(row, dict) else row
    if not d.get("miniapp_use_brand_theme"):
        return None
    # ⚠️ Фича «Фирменный стиль Mini App» (мигр. 332) — платная, Экстра и выше.
    # Проверяем ЗДЕСЬ, а не только при сохранении галочки: клиент мог включить
    # её на Экстра и позже перейти на Профи — тогда галочка в базе осталась, а
    # права на неё уже нет. Поле приходит из SELECT вызывающего запроса; если
    # его не передали (старый вызов) — считаем, что фича есть, иначе тема
    # молча пропала бы у тех, у кого всё оплачено.
    if d.get("has_theme_feature") is False:
        return None

    bg = _gradient(d.get("lp_bg_color"), d.get("lp_bg_color_2"),
                   d.get("lp_bg_angle"), d.get("lp_bg_gradient"))
    # У кнопок призыва к действию свой градиент и свой угол — это отдельная
    # настройка, а не фон. Второй цвет у кнопки включает градиент сам по себе:
    # отдельного флага «градиент кнопки» в теме нет.
    btn = _gradient(d.get("lp_btn_color"), d.get("lp_btn_color_2"),
                    d.get("lp_btn_angle"), bool(d.get("lp_btn_color_2")))

    theme = {
        # Фон: тёмные шапки, плашки, подложка страницы.
        "bg": bg,
        "bg_color": d.get("lp_bg_color"),
        "bg_color_2": d.get("lp_bg_color_2"),
        # Иконки меню, стрелки, кружки — то, что сейчас персиковое.
        "icon": d.get("lp_icon_color"),
        # Главная кнопка действия (сейчас красная «ПОЛУЧИТЬ ЗАПИСИ»):
        # заливка, цвет надписи и рамка — всё из настроек кнопок.
        "btn": btn,
        "btn_text": d.get("lp_btn_text_color"),
        "btn_border": d.get("lp_btn_border_color"),
        # ⚠️ Скругление кнопки (`lp_btn_radius`) НЕ берём: на лендинге у
        # клиента 1 стоит 34 px — почти «таблетка». В Mini App кнопки узкие и
        # стоят вплотную к карточкам, такое скругление ломает ритм экрана.
        # Радиус остаётся платформенный.
        # ⚠️ Карточки спикеров и «Об основателе» красятся от ЦВЕТА ИКОНОК, а не
        # от `lp_card_bg`. У лендинга карточки лежат на тёмном фоне и сами
        # тёмные (у клиента 1 `lp_card_bg = #0F1E2E`); в Mini App те же
        # карточки светлые, на белой подложке — подстановка тёмного цвета
        # сделала бы их почти чёрными. Светлый оттенок получается разбавлением
        # акцентного цвета: он всегда светлее фона и всегда фирменный.
        "card_bg": d.get("lp_icon_color"),
        "card_text": d.get("lp_card_text_color") or None,
        # Вкладка выбранного дня программы.
        "day_tab": d.get("lp_day_tab_color"),
        "day_tab_text": d.get("lp_day_tab_text_color"),
        # Заголовки и основной текст.
        "heading": d.get("lp_color_heading"),
        "body": d.get("lp_color_body"),
    }
    # ⚠️ В базе прозрачность лежит В ПРОЦЕНТАХ (у клиента 1 — 55), а CSS ждёт
    # долю. Без деления `opacity: 55` означало бы «непрозрачно», и вся
    # полупрозрачность молча пропала бы.
    try:
        theme["card_bg_opacity"] = max(0.0, min(1.0, float(d.get("lp_card_bg_opacity")) / 100))
    except (TypeError, ValueError):
        theme["card_bg_opacity"] = 1.0

    # ⚠️ Толщину рамки ограничиваем 3 px. На лендинге кнопка широкая, и 6 px
    # там смотрятся рамкой-акцентом; в Mini App кнопка узкая — такая рамка
    # съедает её саму, надпись оказывается в коробке.
    try:
        theme["btn_border_width"] = max(0, min(3, int(d.get("lp_btn_border_width") or 0)))
    except (TypeError, ValueError):
        theme["btn_border_width"] = 0
    return theme
