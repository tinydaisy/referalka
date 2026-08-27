"""Стартовые тумблеры «что человек видит в своей форме» (миграция 336).

Организатор задаёт их ОДИН раз на событие (подвкладка «Ссылки» раздела
людей), и они подставляются каждой НОВОЙ карточке. Уже заведённые карточки
не трогаются: заданное человеку лично главнее общей настройки.

⚠️ Единая точка на все три способа завести карточку — «Новый спикер»,
«Добавить из базы» и саморегистрация по ссылке. Свою копию дефолтов в
модуле-потребителе не писать: разъедется, и человек получит разный набор
полей в зависимости от того, как его добавили.

⚠️ У жюри темы выступления и подарок после эфира выключены ВСЕГДА — это
правило роли (жюри не выступает и не дарит), а не преференция события.
Поэтому настройка события к нему не применяется.
"""
from typing import Dict

__all__ = ["default_show_flags", "FALLBACK_FLAGS"]

# Поведение до миграции 336 — на случай, если строки conf_conferences ещё нет
# (обычное мероприятие, конференцию для него не заводили).
FALLBACK_FLAGS: Dict[str, bool] = {
    "show_topic_field": True,
    "show_gift_after_speech_field": True,
    "show_knowledge_base_field": False,
    "show_notes_field": False,
    "show_partner_registration_link": True,
}

# Роли, которые выступают: им темы и подарок имеют смысл.
_SPEAKER_LIKE = ("speaker", "headliner", "organizer")


async def default_show_flags(db, event_id: int, role: str) -> Dict[str, bool]:
    """Набор из пяти флагов для новой карточки человека в этом событии."""
    row = None
    try:
        row = await db.fetchrow(
            """SELECT default_show_topic_field              AS show_topic_field,
                      default_show_gift_after_speech_field  AS show_gift_after_speech_field,
                      default_show_knowledge_base_field     AS show_knowledge_base_field,
                      default_show_notes_field              AS show_notes_field,
                      default_show_partner_registration_link AS show_partner_registration_link
                 FROM conf_conferences WHERE event_id = $1""",
            event_id,
        )
    except Exception:
        row = None
    flags = dict(row) if row else dict(FALLBACK_FLAGS)

    is_speaker_like = (role or "") in _SPEAKER_LIKE and (role or "") != "jury"
    if not is_speaker_like:
        flags["show_topic_field"] = False
        flags["show_gift_after_speech_field"] = False
    return {k: bool(v) for k, v in flags.items()}
