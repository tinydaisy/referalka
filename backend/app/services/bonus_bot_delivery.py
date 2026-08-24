"""
Доставка сообщения о бонусе ПЛЮСОНа в боты.

Куда шлём:
  1. Бот ПЛЮСОНа (@pluson_bot) — если человек в нём есть.
  2. Бот КЛИЕНТА, у которого он купил, — там он точно есть, ведь покупка
     шла через этого клиента.

⚠️ Текст ОДИН на все каналы (`plusson_bonus_texts`): в письме ссылка
кликается сама, в боте идёт кнопкой. Второй копии текста быть не должно —
разъедутся, и человек получит разные обещания в почте и мессенджере.

⚠️ В боте КЛИЕНТА сообщение допустимо только потому, что текст называет,
от кого и за что подарок. Без этого оно выглядит как посторонняя реклама
платформы в чужом боте — и жалобы пойдут клиенту, а не нам.

⚠️ Ничего не бросаем наружу: не дошло сообщение в мессенджер — человек всё
равно получил письмо, и терять из-за этого выданный бонус неправильно.
"""
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

BUTTON_TEXT = "Активировать доступ"


async def _tg_id(db, contact_id: int, client_id: int) -> Optional[str]:
    """Числовой Telegram-id человека в базе КОНКРЕТНОГО клиента.

    ⚠️ Только числовой: псевдо-запись «@ник» (её создают, когда резолв ника
    не удался) для отправки не годится — Telegram такой chat_id не примет.
    """
    return await db.fetchval(
        """SELECT pu.platform_user_id
             FROM platform_users pu
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE pu.contact_id = $1 AND pu.platform_slug = 'telegram'
              AND c_own.client_id = $2
              AND pu.platform_user_id ~ '^[0-9]+$'
            ORDER BY pu.id LIMIT 1""",
        contact_id, client_id,
    )


async def send_bonus_to_bots(db, *, contact_id: int, client_id: int,
                             text: str, link: str) -> dict:
    """Шлёт текст с кнопкой-ссылкой в доступные боты. Возвращает, куда ушло."""
    sent = {"pluson": False, "client": False}

    # Текст в боте — без «голой» ссылки в теле: она уходит на кнопку, иначе
    # сообщение выглядит захламлённым.
    body = text.replace(link, "").replace("\n\n\n", "\n\n").strip()

    async with httpx.AsyncClient(timeout=20) as http:
        from app.services.message_builder import send_telegram_message

        # 1. Бот ПЛЮСОНа — сервисный клиент.
        try:
            svc = await db.fetchrow(
                """SELECT cl.id AS client_id, ch.bot_token
                     FROM clients cl
                     JOIN client_channels cc ON cc.client_id = cl.id
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cl.is_system_service = TRUE
                      AND ch.platform_slug = 'telegram'
                      AND COALESCE(ch.bot_token, '') <> ''
                    LIMIT 1""")
            if svc:
                chat = await _tg_id(db, contact_id, svc["client_id"])
                if chat:
                    ok, _ = await send_telegram_message(
                        http, svc["bot_token"], chat, body,
                        button_text=BUTTON_TEXT, button_url=link)
                    sent["pluson"] = bool(ok)
        except Exception:
            logger.warning("bonus: не отправили в бот ПЛЮСОНа (contact %s)", contact_id)

        # 2. Бот клиента, у которого человек купил.
        try:
            from app.services.channels import get_client_telegram_token
            token = await get_client_telegram_token(client_id, db)
            if token:
                chat = await _tg_id(db, contact_id, client_id)
                if chat:
                    ok, _ = await send_telegram_message(
                        http, token, chat, body,
                        button_text=BUTTON_TEXT, button_url=link)
                    sent["client"] = bool(ok)
        except Exception:
            logger.warning("bonus: не отправили в бот клиента %s (contact %s)",
                           client_id, contact_id)

    return sent
