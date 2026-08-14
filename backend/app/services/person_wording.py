"""Как называть участника события — ЕДИНАЯ точка (миграция 304).

На конференции он «спикер», в премии «номинант», в турнире «участник».
Слово хранится в `events.person_wording` и подставляется ВЕЗДЕ: интерфейс,
рассылки, кабинет, публичные страницы.

⚠️ Точечно подменять слово в UI нельзя — сразу получается вразнобой:
   в карточке «номинант», а в рассылке тому же человеку «спикер».

⚠️ Роль в БД (`event_collaborators.role='speaker'`) НЕ меняется — это
   техническое значение, на нём держатся сортировка, гейты и рассылки.
   Здесь только человеческое слово.

Формы нужны в разных падежах: «карточка спикера», «пригласить спикера»,
«выступает спикер» — поэтому словарь, а не одна строка.
"""

from typing import Any, Dict

__all__ = ["wording", "person_word", "DEFAULT_WORDING"]

_DICTS: Dict[str, Dict[str, str]] = {
    # nom — именительный, gen — родительный, acc — винительный,
    # dat — дательный, plural — множественное, plural_gen — «список спикеров».
    "speaker": {
        "nom": "спикер", "gen": "спикера", "acc": "спикера", "dat": "спикеру",
        "plural": "спикеры", "plural_gen": "спикеров",
        "title": "Спикер", "title_plural": "Спикеры",
    },
    "nominee": {
        "nom": "номинант", "gen": "номинанта", "acc": "номинанта", "dat": "номинанту",
        "plural": "номинанты", "plural_gen": "номинантов",
        "title": "Номинант", "title_plural": "Номинанты",
    },
    "member": {
        "nom": "участник", "gen": "участника", "acc": "участника", "dat": "участнику",
        "plural": "участники", "plural_gen": "участников",
        "title": "Участник", "title_plural": "Участники",
    },
}

DEFAULT_WORDING = "speaker"


def wording(preset: Any) -> Dict[str, str]:
    """Словарь форм по значению `events.person_wording`.

    Неизвестное значение или NULL → «спикер»: так вело себя всё до миграции 304.
    """
    key = (str(preset).strip().lower() if preset else "") or DEFAULT_WORDING
    return _DICTS.get(key, _DICTS[DEFAULT_WORDING])


def person_word(preset: Any, form: str = "nom") -> str:
    """Одна форма слова. `form` — ключ из словаря выше."""
    d = wording(preset)
    return d.get(form, d["nom"])
