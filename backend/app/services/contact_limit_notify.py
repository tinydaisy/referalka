"""Уведомления о лимите контактов: письмо, бот платформы, отметка для плашки.

⚠️ Шлём в @pluson_bot и на почту КЛИЕНТА, а не в его канал уведомлений.
Канал уведомлений (`clients.notifications_telegram_chat_id`) — это про события
клиента, туда смотрит его команда; лимит тарифа — разговор платформы с самим
клиентом о его подписке, как истечение тарифа и реф-программа.

⚠️ Идемпотентность через `clients.contact_limit_notified_kind`: проверка
вызывается на КАЖДОМ созданном контакте, а контакты могут идти пачками
(импорт, поток из бота). Без отметки клиент получил бы сотню одинаковых писем.
Отметка сбрасывается, когда состояние меняется (предупреждали → перевели), и
снимается, когда клиент почистил базу и опустился ниже порога.
"""
import logging
from typing import Optional

log = logging.getLogger(__name__)


def _texts(event: dict, brand: Optional[str]) -> tuple[str, str]:
    """(тема письма, текст). Один текст на письмо и на бот — расхождений быть не должно."""
    used, kind = event["used"], event["kind"]

    if kind == "warn":
        limit = event["limit"]
        left = max(0, limit - used)
        return (
            "ПЛЮСОН: контакты подходят к лимиту тарифа",
            f"В вашей базе {used} контактов из {limit} по тарифу — осталось {left}.\n\n"
            "Когда контактов станет больше лимита, тариф автоматически сменится на "
            "подходящий. Доплачивать не нужно: оплаченные дни просто пересчитаются "
            "по цене нового тарифа, поэтому оплаченный срок закончится раньше.\n\n"
            "Если менять тариф не нужно — удалите лишние контакты в разделе «Контакты»."
        )

    if kind == "upgrade":
        return (
            "ПЛЮСОН: тариф изменён — контактов стало больше лимита",
            f"В вашей базе {used} контактов — это больше лимита прежнего тарифа, "
            f"поэтому тариф «{event['from']}» изменён на «{event['to']}».\n\n"
            "Доплачивать не нужно. Оплаченные дни пересчитаны по цене нового тарифа: "
            f"оплаченный доступ действует ещё {event['days']} дн.\n\n"
            "Если тариф вам не нужен — удалите лишние контакты в разделе «Контакты», "
            "и прежний срок восстановится."
        )

    # exceeded — перейти некуда, клиент уже на самом ёмком тарифе
    return (
        "ПЛЮСОН: превышен лимит контактов",
        f"В вашей базе {used} контактов при лимите {event['limit']}. "
        "Подходящего тарифа для такого объёма нет — напишите нам, подберём решение."
    )


async def notify_contact_limit(db, client_id: int, event: dict) -> None:
    """Уведомляет клиента о состоянии лимита. Никогда не бросает исключение."""
    try:
        kind = event["kind"]

        # Уже уведомляли об этом же состоянии — молчим (см. про идемпотентность выше)
        prev = await db.fetchval(
            "SELECT contact_limit_notified_kind FROM clients WHERE id = $1", client_id)
        if prev == kind:
            return

        row = await db.fetchrow(
            "SELECT email, name, brand_name FROM clients WHERE id = $1", client_id)
        if not row:
            return

        subject, body = _texts(event, row["brand_name"] or row["name"])

        # Отметка ДО отправки: письмо может не уйти, но повторять попытку на
        # каждом новом контакте нельзя — это спам.
        await db.execute(
            """UPDATE clients
                  SET contact_limit_notified_kind = $2,
                      contact_limit_notified_at = NOW()
                WHERE id = $1""",
            client_id, kind,
        )

        # Почта — через системный email-канал платформы (как welcome-письмо)
        try:
            if row["email"]:
                ch = await db.fetchrow(
                    """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                              ch.email_subdomain, ch.email_from_local
                         FROM client_channels cc
                         JOIN channels ch ON ch.id = cc.channel_id
                        WHERE cc.client_id = $1
                          AND ch.platform_slug = 'email'
                          AND ch.is_system = TRUE
                        LIMIT 1""",
                    client_id,
                )
                if ch:
                    from app.services.email_sender import EmailSender
                    channel_dict = dict(ch)
                    channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"
                    EmailSender().send(
                        channel=channel_dict,
                        client_brand_name="iViSiON: ПЛЮСОН",
                        to_email=row["email"],
                        subject=subject,
                        body_text=body + "\n\n— Команда iViSiON: ПЛЮСОН",
                    )
        except Exception as e:  # noqa: BLE001
            log.warning("contact limit email failed (client %s): %s", client_id, e)

        # Бот платформы — в личку от @pluson_bot (не в канал клиента, см. docstring)
        try:
            from app.services.plusson_referral_notify import _notify_referrer
            html = body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            await _notify_referrer(db, client_id, html, kind="contact_limit")
        except Exception as e:  # noqa: BLE001
            log.info("contact limit bot notify skipped (client %s): %s", client_id, e)

    except Exception as e:  # noqa: BLE001
        log.warning("notify_contact_limit failed (client %s): %s", client_id, e)


async def clear_contact_limit_notice(db, client_id: int) -> None:
    """Снимает отметку — клиент опустился ниже порога предупреждения."""
    await db.execute(
        """UPDATE clients
              SET contact_limit_notified_kind = NULL, contact_limit_notified_at = NULL
            WHERE id = $1 AND contact_limit_notified_kind IS NOT NULL""",
        client_id,
    )
