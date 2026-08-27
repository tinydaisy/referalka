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

from typing import Any, Dict, Optional

__all__ = [
    "wording", "person_word", "DEFAULT_WORDING",
    "wording_for_event", "wording_for_collaborator",
]

_DICTS: Dict[str, Dict[str, str]] = {
    # nom — именительный, gen — родительный, acc — винительный,
    # dat — дательный, ins — творительный («оформить вас спикером»),
    # plural — множественное, plural_gen — «список спикеров»,
    # plural_dat — «доступен другим спикерам».
    "speaker": {
        "nom": "спикер", "gen": "спикера", "acc": "спикера", "dat": "спикеру",
        "ins": "спикером",
        "plural": "спикеры", "plural_gen": "спикеров", "plural_dat": "спикерам",
        "title": "Спикер", "title_plural": "Спикеры",
    },
    "nominee": {
        "nom": "номинант", "gen": "номинанта", "acc": "номинанта", "dat": "номинанту",
        "ins": "номинантом",
        "plural": "номинанты", "plural_gen": "номинантов", "plural_dat": "номинантам",
        "title": "Номинант", "title_plural": "Номинанты",
    },
    "member": {
        "nom": "участник", "gen": "участника", "acc": "участника", "dat": "участнику",
        "ins": "участником",
        "plural": "участники", "plural_gen": "участников", "plural_dat": "участникам",
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


async def wording_for_event(db, event_id: Optional[int]) -> Dict[str, str]:
    """Слово по событию. Сбой чтения → «спикер» (как было до миграции 304):
    сообщение человеку важнее точной формулировки."""
    if not event_id:
        return wording(None)
    try:
        return wording(await db.fetchval(
            "SELECT person_wording FROM events WHERE id = $1", event_id,
        ))
    except Exception:
        return wording(None)


async def wording_for_collaborator(
    db, collaborator_id: int, event_id: Optional[int] = None,
) -> Dict[str, str]:
    """Слово для сообщений о КАРТОЧКЕ человека (кабинет, приглашение).

    Карточка живёт вне события, а слово — свойство события. Поэтому берём
    событие, к которому его пригласили (`event_id` из ссылки), иначе — то же
    событие, которое откроется в кабинете: опубликованное → завершённое →
    черновик, внутри — позже добавленное (тот же порядок, что в `spkinv_`).
    """
    try:
        val = None
        if event_id:
            val = await db.fetchval(
                """SELECT e.person_wording
                     FROM event_collaborators ec
                     JOIN events e ON e.id = ec.event_id
                    WHERE ec.speaker_id = $1 AND e.id = $2
                    LIMIT 1""",
                collaborator_id, event_id,
            )
        if val is None:
            val = await db.fetchval(
                """SELECT e.person_wording
                     FROM event_collaborators ec
                     JOIN events e ON e.id = ec.event_id
                    WHERE ec.speaker_id = $1
                    ORDER BY CASE e.status
                               WHEN 'published' THEN 0
                               WHEN 'ended'     THEN 1
                               ELSE 2
                             END, ec.id DESC
                    LIMIT 1""",
                collaborator_id,
            )
        return wording(val)
    except Exception:
        return wording(None)
