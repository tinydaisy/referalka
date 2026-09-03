"""Регистрация участника ПРЯМО В БОТЕ — кнопка «ЗАРЕГИСТРИРОВАТЬСЯ».

Одна логика на все три площадки (TG / MAX / VK). Используется, когда у события
включено «Регистрировать без ввода контактных данных» (`events.skip_contact_form`)
и не задан сторонний лендинг: форма не нужна — человек уже в боте, имя и ник у
нас есть.

⚠️ Меню события НЕ приходит само по себе. Кнопка «ЗАРЕГИСТРИРОВАТЬСЯ» остаётся,
и регистрация происходит по её НАЖАТИЮ (callback `evsignup_<event_id>`) — это
осознанное действие пользователя. Отправку меню делает вызывающая сторона: у
каждой площадки своя функция меню (TG `send_event_menu`, MAX `_send_max_event_menu`,
VK `send_vk_event_funnel`).
"""

import logging

log = logging.getLogger(__name__)


async def signup_participant_in_bot(db, *, event_id: int, contact_id: int) -> bool:
    """Регистрирует контакт на событие. True — регистрация есть (или уже была).

    Идемпотентно: повторное нажатие кнопки не плодит записи и не ломает ничего —
    запись идёт через `upsert_event_participant`, а он сам решает, случилась
    ли регистрация именно сейчас, и только тогда шлёт письма.
    """
    try:
        # ⚠️ send_menu=False — меню шлёт сам вызывающий, ответом на нажатие
        # кнопки в боте. Иначе человек получил бы два одинаковых меню подряд.
        from app.services.event_participant import upsert_event_participant
        await upsert_event_participant(
            db, event_id=event_id, contact_id=contact_id,
            is_registered=True, send_menu=False,
        )
        return True
    except Exception as e:
        log.warning("signup_participant_in_bot failed (event=%s contact=%s): %s",
                    event_id, contact_id, e)
        return False


async def is_signup_in_bot(db, event_id: int) -> bool:
    """Регистрировать ли это событие прямо в боте (без формы и без лендинга)."""
    row = await db.fetchrow(
        "SELECT skip_contact_form, landing_url FROM events WHERE id = $1",
        event_id,
    )
    if not row:
        return False
    return bool(row["skip_contact_form"]) and not (row["landing_url"] or "").strip()
