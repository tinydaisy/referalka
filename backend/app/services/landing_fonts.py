"""
Справочник шрифтов конструктора лендингов — ОДНА точка истины.

Файлы шрифтов лежат у нас (`web/public/fonts/<key>/`), не подтягиваются с
Google Fonts: у части пользователей в РФ внешние fonts.googleapis.com тормозят
или режутся, и лендинг мигает системным шрифтом. Свои файлы = предсказуемо.

Ключ (`key`) хранится в `event_landing_pages.font_heading` / `font_body`.
При добавлении шрифта: положить .woff2 в `web/public/fonts/<key>/`, дописать
строку сюда и сгенерировать @font-face (см. `landing_css.py`).
"""

# category: sans | serif | display — только для группировки в выпадающем списке.
# weights — какие начертания реально лежат в папке (лишние не грузим, это вес страницы).
FONTS: list[dict] = [
    # ── Без засечек: рабочие лошадки для основного текста ──────────────────
    {"key": "Manrope",        "label": "Manrope",         "category": "sans",    "weights": [400, 600, 800]},
    {"key": "Inter",          "label": "Inter",           "category": "sans",    "weights": [400, 600, 800]},
    {"key": "Roboto",         "label": "Roboto",          "category": "sans",    "weights": [400, 500, 700]},
    {"key": "OpenSans",       "label": "Open Sans",       "category": "sans",    "weights": [400, 600, 700]},
    {"key": "Montserrat",     "label": "Montserrat",      "category": "sans",    "weights": [400, 600, 800]},
    {"key": "Nunito",         "label": "Nunito",          "category": "sans",    "weights": [400, 600, 800]},
    {"key": "Rubik",          "label": "Rubik",           "category": "sans",    "weights": [400, 500, 700]},
    {"key": "PTSans",         "label": "PT Sans",         "category": "sans",    "weights": [400, 700]},
    {"key": "Golos",          "label": "Golos Text",      "category": "sans",    "weights": [400, 600, 800]},
    {"key": "Onest",          "label": "Onest",           "category": "sans",    "weights": [400, 600, 800]},

    # ── С засечками: солиднее, хороши для заголовков премиальных событий ───
    {"key": "PlayfairDisplay", "label": "Playfair Display", "category": "serif",  "weights": [400, 700, 900]},
    {"key": "Merriweather",   "label": "Merriweather",    "category": "serif",   "weights": [400, 700]},
    {"key": "PTSerif",        "label": "PT Serif",        "category": "serif",   "weights": [400, 700]},
    {"key": "Lora",           "label": "Lora",            "category": "serif",   "weights": [400, 600, 700]},

    # ── Акцидентные: только заголовки, для текста не годятся ───────────────
    # ⚠️ У Bebas Neue НЕТ кириллицы (Google отдаёт только латиницу). Русские
    # буквы подставляются из Oswald — ближайший узкий гротеск с заглавными,
    # внешне разница минимальна. Цепочка задаётся в `_FALLBACK_BY_KEY`.
    {"key": "BebasNeue",      "label": "Bebas Neue",      "category": "display", "weights": [400],
     "note": "Латиница — Bebas, кириллица — Oswald (у Bebas нет русских букв)"},
    {"key": "Oswald",         "label": "Oswald",          "category": "display", "weights": [400, 600, 700]},
    {"key": "Unbounded",      "label": "Unbounded",       "category": "display", "weights": [400, 700, 900]},
    {"key": "AlumniSans",     "label": "Alumni Sans",     "category": "display", "weights": [400, 700]},
    {"key": "Cormorant",      "label": "Cormorant",       "category": "display", "weights": [400, 600, 700]},
    {"key": "RussoOne",       "label": "Russo One",       "category": "display", "weights": [400]},
]

FONT_KEYS = {f["key"] for f in FONTS}

DEFAULT_FONT = "Manrope"

# Запасная цепочка на случай, если файл не догрузился.
_FALLBACK = {
    "sans": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "serif": "Georgia, 'Times New Roman', serif",
    "display": "Impact, system-ui, sans-serif",
}


def normalize_font(key: str | None) -> str:
    """Неизвестный/пустой ключ → дефолт. Защищает от мусора в БД и в payload."""
    return key if key in FONT_KEYS else DEFAULT_FONT


# Шрифты без кириллицы: подставляем следом похожий с русскими буквами.
# Браузер берёт из первого шрифта те символы, что в нём есть, остальные — из
# следующего. Так латиница остаётся фирменной, а русский текст не «слетает»
# в системный шрифт.
_FALLBACK_BY_KEY = {
    "BebasNeue": "'Oswald'",
}


def font_family_css(key: str | None) -> str:
    """CSS-значение font-family с запасной цепочкой: 'Bebas Neue', 'Oswald', ..."""
    key = normalize_font(key)
    font = next(f for f in FONTS if f["key"] == key)
    chain = [f"'{font['label']}'"]
    if key in _FALLBACK_BY_KEY:
        chain.append(_FALLBACK_BY_KEY[key])
    chain.append(_FALLBACK[font["category"]])
    return ", ".join(chain)
