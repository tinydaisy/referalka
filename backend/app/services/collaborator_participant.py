"""Карточка человека в событии → он же участник события (2026-08-27).

Зачем. Спикер, номинант, жюри и партнёр заводятся карточкой
(`event_collaborators`), а участником события (`event_participants`) при этом
не становились. Из-за этого человек, открыв ссылку на СВОЁ событие — из
каталога номинантов, из письма, из кабинета — упирался в форму регистрации:
для витрины он посторонний, его карточки для него самого не существует.

Поэтому в момент создания карточки заводим ему участие и сразу помечаем
зарегистрированным. Точка одна на все способы завести карточку (из базы,
новый, самозапись по ссылке, соорганизатор мероприятия, копия события) —
иначе следующий способ снова окажется забыт.

⚠️ Письма и меню бота отсюда НЕ шлём: `finalize_participant_registration`
здесь не зовётся сознательно. Карточку заводит организатор, пока набирает
состав, — человеку в этот момент не нужно письмо «вы зарегистрированы на
событие», он о событии, возможно, ещё и не знает. Веб-самозапись шлёт своё
письмо (с доступом в кабинет) сама.

⚠️ Идемпотентно: повторный вызов не плодит записей и не сбрасывает уже
проставленное время регистрации.
"""
import logging

logger = logging.getLogger(__name__)


async def ensure_collaborator_participant(
    db, *, event_id: int, collaborator_id: int,
) -> bool:
    """Заводит участие контакта коллаборатора в событии. True — участие есть.

    Ошибки глушим: не сумели завести участие — это не повод не создать
    карточку, ради которой вызов и делался.
    """
    try:
        contact_id = await db.fetchval(
            "SELECT contact_id FROM collaborators WHERE id = $1", collaborator_id)
        if not contact_id:
            return False
        return await ensure_contact_participant(
            db, event_id=event_id, contact_id=int(contact_id))
    except Exception as e:
        logger.warning(
            "ensure_collaborator_participant failed (event=%s collaborator=%s): %s",
            event_id, collaborator_id, e)
        return False


async def ensure_contact_participant(
    db, *, event_id: int, contact_id: int,
) -> bool:
    """То же самое, когда контакт уже известен (веб-самозапись)."""
    try:
        await db.execute(
            """INSERT INTO event_participants (event_id, contact_id, is_registered, registered_at)
                 VALUES ($1, $2, TRUE, NOW())
               ON CONFLICT (event_id, contact_id)
               DO UPDATE SET is_registered = TRUE,
                             registered_at = COALESCE(event_participants.registered_at, NOW())""",
            event_id, contact_id,
        )
        return True
    except Exception as e:
        logger.warning(
            "ensure_contact_participant failed (event=%s contact=%s): %s",
            event_id, contact_id, e)
        return False
