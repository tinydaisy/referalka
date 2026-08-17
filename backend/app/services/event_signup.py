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
    UPSERT по (event_id, contact_id) + `finalize_participant_registration` сам
    выходит молча, если участник уже был зарегистрирован.
    """
    from app.services.participant_registration import (
        finalize_participant_registration,
    )
    try:
        await db.execute(
            """INSERT INTO event_participants (event_id, contact_id, is_registered)
                 VALUES ($1, $2, TRUE)
                 ON CONFLICT (event_id, contact_id)
                 DO UPDATE SET is_registered = TRUE""",
            event_id, contact_id,
        )
        # ⚠️ send_menu=False — меню шлёт сам вызывающий, ответом на нажатие
        # кнопки в боте. Иначе человек получил бы два одинаковых меню подряд.
        await finalize_participant_registration(
            db, event_id=event_id, contact_id=contact_id, send_menu=False)
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
