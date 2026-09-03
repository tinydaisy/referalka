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

⚠️ Но ДОГРЕВ гасим (2026-09-03). Раньше «не слать письма» понималось как «не
трогать вообще ничего» — и незавершённая воронка догрева оставалась висеть.
Спикер помечен зарегистрированным и при этом продолжал получать письма
«зарегистрируйтесь на событие», в состав которого его только что вписали.
Погасить воронку и отправить письмо — разные вещи: первое обязательно, второе
здесь не нужно.

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
        # ⚠️ finalize=False — единственное место, где регистрация ставится БЕЗ
        # писем и меню (см. шапку файла): карточку заводит организатор, пока
        # набирает состав, человек о событии может ещё не знать.
        from app.services.event_participant import upsert_event_participant
        await upsert_event_participant(
            db, event_id=event_id, contact_id=contact_id,
            is_registered=True, finalize=False,
        )
        # Догрев при этом гасим — он к письмам отношения не имеет.
        # Отдельным try: сбой здесь не должен отменять само участие.
        try:
            from app.api.event_nurture import start_nurture_run_if_eligible
            await start_nurture_run_if_eligible(
                db, event_id=event_id, contact_id=contact_id, is_registered=True)
        except Exception as e:
            logger.warning(
                "nurture stop failed (event=%s contact=%s): %s",
                event_id, contact_id, e)
        return True
    except Exception as e:
        logger.warning(
            "ensure_contact_participant failed (event=%s contact=%s): %s",
            event_id, contact_id, e)
        return False
