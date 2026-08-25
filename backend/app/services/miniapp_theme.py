"""Фирменные цвета Mini App и веб-витрины события (миграция 333).

⚠️⚠️ В MINI APP ВСЕГО ТРИ ЦВЕТА — решение владельца:
    1. СИНИЙ    — фон, шапка, тёмные плашки (два цвета + угол градиента);
    2. ПЕРСИКОВЫЙ — иконки, стрелки, акценты, заливка карточек;
    3. CTA      — кнопка призыва к действию (два цвета + угол + граница).
Всё остальное на экране — производные от них через ПРОЗРАЧНОСТЬ (20%).
Не заводить отдельных настроек «цвет заголовка», «цвет вкладки дня» и т.п.:
именно так и вышел разнобой из пяти несочетающихся оттенков, когда цвета
тянулись из лендинга.

⚠️ ЦВЕТА СВОИ, НЕ ИЗ ЛЕНДИНГА (`clients.ma_*`, а не `lp_*`). Оформление
продающей страницы и кабинета участника — разные задачи: на лендинге карточки
тёмные на тёмном фоне, в Mini App — светлые на белой подложке. Общая палитра
на оба места неизбежно ломает одно из них.

⚠️ ОДНА ТОЧКА СБОРКИ. Тема нужна трём эндпоинтам (витрина события, визитка
клиента, экран разрешений VK). Новая точка отдачи — зовёт `theme_dict`, а не
собирает цвета сама, иначе они разъедутся между экранами.

⚠️ ГАЛОЧКА ВЫКЛЮЧЕНА — ОТДАЁМ None. Колонки заполнены значениями по умолчанию
у всех, поэтому «отдадим всегда» перекрасило бы Mini App у тех, кто цвета не
выбирал. Отсутствие темы во фронте означает «рисуй как раньше».
"""
from typing import Any, Optional

# Колонки clients, которые должен выбрать вызывающий SELECT, чтобы `theme_dict`
# собрал тему. Перечислены справочно — в запросах пишутся явно, иначе длинный
# SQL пришлось бы склеивать конкатенацией и он стал бы нечитаем.
THEME_COLUMNS = (
    "miniapp_use_brand_theme",
    "ma_bg_color", "ma_bg_color_2", "ma_bg_angle",
    "ma_accent_color",
    "ma_cta_color", "ma_cta_color_2", "ma_cta_angle", "ma_cta_border",
    "ma_radius",
)

# ⚠️ Насколько разбавляется цвет в полупрозрачных подложках — карточки
# спикеров, зебра строк, плашки. 0.20 по требованию владельца: при 55% (как на
# лендинге) заливка выходит в полный тон и «слишком ярко» — карточки кричат
# громче содержимого, а текст поверх перестаёт читаться.
TINT_OPACITY = 0.20


def _rgb(hex_color: Optional[str]) -> Optional[tuple[int, int, int]]:
    """`#25455D` → (37, 69, 93). Понимает и короткую запись `#abc`."""
    if not hex_color:
        return None
    h = str(hex_color).strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return None
    try:
        n = int(h, 16)
    except ValueError:
        return None
    return ((n >> 16) & 255, (n >> 8) & 255, n & 255)


def _luminance(hex_color: Optional[str]) -> Optional[float]:
    """Воспринимаемая яркость 0..255. Больше — светлее."""
    rgb = _rgb(hex_color)
    if not rgb:
        return None
    r, g, b = rgb
    return 0.299 * r + 0.587 * g + 0.114 * b


def _readable_on(bg_color: Optional[str], wanted: Optional[str] = None,
                 *, min_gap: float = 60.0) -> str:
    """Читаемый цвет поверх фона `bg_color`.

    ⚠️ Зачем. Клиент задаёт три цвета, а «какой текст поверх плашки» — нет,
    такой настройки нет и быть не должно. При тёмном фоне тёмный текст исчезает
    полностью. Поэтому: желаемый цвет берём, если он достаточно отличается от
    фона по яркости; иначе подставляем контрастный. Лучше не тот оттенок, чем
    невидимая надпись.
    """
    lum_bg = _luminance(bg_color)
    if lum_bg is None:
        return wanted or "#1a2a3a"
    lum_fg = _luminance(wanted)
    if lum_fg is not None and abs(lum_bg - lum_fg) >= min_gap:
        return wanted  # type: ignore[return-value]
    return "#FFFFFF" if lum_bg < 150 else "#1a2a3a"


def _gradient(c1: Optional[str], c2: Optional[str], angle: Any) -> Optional[str]:
    """Заливка: градиент при двух цветах, иначе сплошной цвет."""
    if not c1:
        return None
    if not c2 or c2 == c1:
        return c1
    try:
        deg = int(angle if angle is not None else 45)
    except (TypeError, ValueError):
        deg = 45
    return f"linear-gradient({deg}deg, {c1}, {c2})"


def _rgba(hex_color: Optional[str], alpha: float) -> Optional[str]:
    """`#FFCFA4`, 0.2 → `rgba(255,207,164,0.2)`."""
    rgb = _rgb(hex_color)
    if not rgb:
        return None
    return f"rgba({rgb[0]},{rgb[1]},{rgb[2]},{alpha})"


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    """Целое в границах; мусор → значение по умолчанию."""
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def theme_dict(row: Any) -> Optional[dict[str, Any]]:
    """Собирает тему из строки clients. None = фирменные цвета не включены."""
    if row is None:
        return None
    d = dict(row) if not isinstance(row, dict) else row
    if not d.get("miniapp_use_brand_theme"):
        return None
    # ⚠️ Фича «Фирменный стиль Mini App» (мигр. 332) — платная, Экстра и выше.
    # Проверяем ЗДЕСЬ, а не только при сохранении галочки: клиент мог включить
    # её на Экстра и позже перейти на Профи — галочка осталась, права нет.
    # Поле не передали (старый вызов) → считаем, что фича есть, иначе тема
    # молча пропала бы у тех, у кого всё оплачено.
    if d.get("has_theme_feature") is False:
        return None

    bg     = d.get("ma_bg_color")
    bg2    = d.get("ma_bg_color_2")
    accent = d.get("ma_accent_color")

    return {
        # ── 1. СИНИЙ ────────────────────────────────────────────────────
        "bg": _gradient(bg, bg2, d.get("ma_bg_angle")),
        "bg_color": bg,
        "bg_color_2": bg2,
        # 20% синего — светлые подложки на белом фоне (зебра строк, плашки).
        "bg_tint": _rgba(bg, TINT_OPACITY),
        # Текст и иконки ПОВЕРХ синего. Считаются от него, а не задаются:
        # акцент клиента может сливаться с его же фоном.
        "on_bg_text": _readable_on(bg),
        "on_bg_icon": _readable_on(bg, accent),

        # ── 2. ПЕРСИКОВЫЙ (акцент) ──────────────────────────────────────
        "icon": accent,
        # 20% акцента — заливка карточек спикеров и блока «Об основателе».
        "card_tint": _rgba(accent, TINT_OPACITY),
        # Текст на такой карточке: подложка светлая, но считаем честно.
        "card_text": _readable_on("#FFFFFF"),
        # Вкладка выбранного дня — сплошной акцент, надпись по контрасту.
        "day_tab": accent,
        "day_tab_text": _readable_on(accent),
        # Заголовки на светлой странице: акцент там почти не виден, поэтому
        # берём тёмный от синего.
        "heading": _readable_on("#FFFFFF", bg),

        # ── 3. CTA ──────────────────────────────────────────────────────
        "btn": _gradient(d.get("ma_cta_color"), d.get("ma_cta_color_2"),
                         d.get("ma_cta_angle")),
        "btn_text": _readable_on(d.get("ma_cta_color")),
        "btn_border": d.get("ma_cta_border"),

        # ── 4. СКРУГЛЕНИЕ ───────────────────────────────────────────────
        # Одно значение на карточки, кнопки и плашки. Ограничиваем 0..28:
        # выше — «таблетка», которая в узкой колонке Mini App ломает ритм
        # (на лендинге у клиента 1 стоит 34 px, там кнопка широкая).
        "radius": _clamp_int(d.get("ma_radius"), 0, 28, 14),
    }
