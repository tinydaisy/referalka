"""
Единая точка финализации регистрации участника на событие.

Вызывается после ЛЮБОГО действия, которое могло сделать
event_participants.is_registered = TRUE — из Mini App, webhook GetCourse,
webhook Salebot. Не дублирует логику в 4 местах: добавил здесь — работает
во всех путях входа.

Действия:
1. Остановить nurture-воронку догрева (если была запущена)
2. Re-opt-in на email-канал клиента (если был отписан)
3. Welcome-email (если у события включён шаблон и не отправлялось ранее)

Все три шага идемпотентны — повторный вызов не сделает дублей.
Все три обёрнуты в try/except — не блокируют основной flow регистрации.
"""
import logging

logger = logging.getLogger(__name__)


async def finalize_participant_registration(
    db, *, event_id: int, contact_id: int, send_menu: bool = True,
) -> None:
    """Финализация регистрации — общая для всех путей входа.

    Сначала проверяет, что у участника is_registered=TRUE. Если нет —
    выходит молча (вызов из ветки, где регистрации не случилось).

    `send_menu=False` — когда вызывающий сам шлёт меню события (регистрация
    ПРЯМО В БОТЕ: там оно уходит ответом на нажатие кнопки). Иначе человек
    получил бы два одинаковых меню подряд.
    """
    is_reg = await db.fetchval(
        """SELECT TRUE FROM event_participants
            WHERE event_id = $1 AND contact_id = $2 AND is_registered = TRUE
            LIMIT 1""",
        event_id, contact_id,
    )
    if not is_reg:
        return

    try:
        from app.api.event_nurture import start_nurture_run_if_eligible
        await start_nurture_run_if_eligible(
            db, event_id=event_id, contact_id=contact_id, is_registered=True,
        )
    except Exception as e:
        logger.warning(f"nurture stop failed for event={event_id} contact={contact_id}: {e}")

    # Меню события (кабинет, чат, эфир, поддержка) — ДО воронки догрева.
    # ⚠️ Порядок значим: первый шаг догрева зовёт «закрепите этот бот», и если
    # меню придёт после него, человек сначала увидит призыв к пустому боту.
    # Раньше меню слалось только при заходе В БОТА по ссылке события —
    # зарегистрировавшийся из Mini App или с веб-формы не получал ни чата,
    # ни эфира, пока сам не перейдёт по ссылке ещё раз.
    if send_menu:
        try:
            from bot.handlers.start import send_event_menu_after_signup
            await send_event_menu_after_signup(
                db, event_id=event_id, contact_id=contact_id,
            )
        except Exception as e:
            logger.warning(f"event menu after signup failed for event={event_id} contact={contact_id}: {e}")

    try:
        from app.api.event_nurture_reg import start_nurture_reg_run_if_eligible
        await start_nurture_reg_run_if_eligible(
            db, event_id=event_id, contact_id=contact_id,
        )
    except Exception as e:
        logger.warning(f"nurture_reg start failed for event={event_id} contact={contact_id}: {e}")

    try:
        await _resubscribe_email(db, contact_id=contact_id, event_id=event_id)
    except Exception as e:
        logger.warning(f"email re-opt-in failed for event={event_id} contact={contact_id}: {e}")

    # У КОЛЛАБЫ почта и телефон участника попадают в базу каждого организатора:
    # они приводят людей вместе и равноправны, поэтому связь с участником должна
    # быть у всех. Мессенджеры при этом НЕ раздаём — человек не запускал чужого
    # бота (см. share_contact_with_all_owners).
    try:
        from app.services.event_client import share_contact_with_all_owners
        await share_contact_with_all_owners(db, event_id=event_id, contact_id=contact_id)
    except Exception as e:
        logger.warning(f"share contact with owners failed for event={event_id} contact={contact_id}: {e}")

    try:
        from app.services.event_welcome_email import send_welcome_email_if_needed
        await send_welcome_email_if_needed(
            db, event_id=event_id, contact_id=contact_id,
        )
    except Exception as e:
        logger.warning(f"welcome_email failed for event={event_id} contact={contact_id}: {e}")


async def _resubscribe_email(db, *, contact_id: int, event_id: int) -> None:
    """Возвращаем email-подписку, если контакт был ранее отписан.
    Затрагиваем ВСЕ email-каналы клиента, к которому принадлежит событие."""
    await db.execute(
        """UPDATE platform_user_channels
              SET is_unsubscribed = FALSE,
                  unsubscribed_at = NULL
            WHERE id IN (
                SELECT puc.id
                  FROM platform_user_channels puc
                  JOIN platform_users pu ON pu.id = puc.platform_user_id
                  JOIN client_channels cc ON cc.id = puc.client_channel_id
                  JOIN events e ON EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=cc.client_id AND eo.status='accepted')
                 WHERE pu.contact_id = $1
                   AND pu.platform_slug = 'email'
                   AND e.id = $2
                   AND puc.is_unsubscribed = TRUE
            )""",
        contact_id, event_id,
    )
