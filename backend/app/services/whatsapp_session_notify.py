"""Уведомление клиента о том, что WhatsApp-сессия отвалилась.

⚠️ Почему это вообще нужно. У WhatsApp нет бота с токеном: сообщения шлёт
залогиненная через WhatsApp Web сессия на мосту (wa-bridge). Человек снимает
привязку в «Связанные устройства» на телефоне — и отправка умирает молча.
У клиента 1 так и вышло: с 15.07.2026 по 22.09.2026 — 54 упавшие отправки
подряд, все с «session not ready», и ни одного сигнала наружу. В кабинете
WhatsApp всё это время выглядел подключённым, потому что запись канала в БД
никуда не делась.

⚠️ Шлём в @pluson_bot и на почту КЛИЕНТА, а не в его канал уведомлений — это
разговор платформы с самим клиентом о его подключении, как лимит контактов
(см. contact_limit_notify.py, оттуда же взята схема отправки).

⚠️ Идемпотентность через `clients.wa_session_dead_notified_at`: проверка зовётся
на КАЖДОЙ упавшей отправке, а чатов в одной рассылке несколько и рассылок за
день несколько. Без отметки вышел бы спам вместо предупреждения. Отметка
снимается при успешной привязке заново (channels.connect_whatsapp), чтобы о
следующем слёте клиент снова узнал.
"""
import logging

log = logging.getLogger(__name__)

SUBJECT = "ПЛЮСОН: WhatsApp отвязался — рассылки в чаты не уходят"

BODY = (
    "Рассылка в ваши общие чаты WhatsApp не доставлена: привязка аккаунта слетела.\n\n"
    "Так бывает, когда WhatsApp на телефоне убирает связанное устройство — сам, "
    "по неактивности, либо если привязку сняли вручную. Пока WhatsApp не привязан "
    "заново, сообщения в чаты WhatsApp уходить не будут; на Telegram, VK и MAX это "
    "никак не влияет.\n\n"
    "Как починить (2 минуты):\n"
    "1. Кабинет → Каналы → «Добавить канал» → WhatsApp → «Подключить».\n"
    "2. На телефоне: WhatsApp → Настройки → Связанные устройства → «Привязать устройство».\n"
    "3. Наведите камеру на QR-код в кабинете.\n\n"
    "Выбранные группы для рассылок сохранены — заново выбирать их не нужно."
)


def is_session_dead_error(error: str | None) -> bool:
    """Ошибка отправки говорит именно о мёртвой сессии, а не о сбое чата?

    Мост отвечает 409 «session not ready», когда сессии нет или она не в
    ready/authenticated. Остальные ошибки (чат удалён, медиа не скачалось,
    мост недоступен) — не повод писать клиенту про повторную привязку.
    """
    if not error:
        return False
    e = str(error).lower()
    return "session not ready" in e or "session not found" in e


async def notify_wa_session_dead(db, client_id: int) -> None:
    """Сообщает клиенту, что WhatsApp-сессия умерла. Никогда не бросает исключение."""
    try:
        # Уже сообщали про этот слёт — молчим (см. про идемпотентность выше)
        already = await db.fetchval(
            "SELECT wa_session_dead_notified_at FROM clients WHERE id = $1", client_id)
        if already:
            return

        row = await db.fetchrow("SELECT email FROM clients WHERE id = $1", client_id)
        if not row:
            return

        # Отметка ДО отправки: письмо может не уйти, но повторять попытку на
        # каждой следующей упавшей отправке нельзя — это спам.
        await db.execute(
            "UPDATE clients SET wa_session_dead_notified_at = NOW() WHERE id = $1",
            client_id,
        )

        # Почта — через системный email-канал платформы
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
                        subject=SUBJECT,
                        body_text=BODY + "\n\n— Команда iViSiON: ПЛЮСОН",
                    )
        except Exception as e:  # noqa: BLE001
            log.warning("wa session dead email failed (client %s): %s", client_id, e)

        # Бот платформы — в личку от @pluson_bot
        try:
            from app.services.plusson_referral_notify import _notify_referrer
            html = BODY.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            await _notify_referrer(db, client_id, f"⚠️ <b>{SUBJECT}</b>\n\n{html}",
                                   kind="wa_session_dead")
        except Exception as e:  # noqa: BLE001
            log.info("wa session dead bot notify skipped (client %s): %s", client_id, e)

    except Exception as e:  # noqa: BLE001
        log.warning("notify_wa_session_dead failed (client %s): %s", client_id, e)


async def clear_wa_session_notice(db, client_id: int) -> None:
    """Снимает отметку — клиент привязал WhatsApp заново, о следующем слёте скажем."""
    await db.execute(
        """UPDATE clients SET wa_session_dead_notified_at = NULL
            WHERE id = $1 AND wa_session_dead_notified_at IS NOT NULL""",
        client_id,
    )
