"""
Сервис уведомлений PLUSSON.

3 автоматических сегмента:
1. 'no_game'  — пришёл по ссылке, но не открыл Игру (20 мин после клика)
2. 'no_share' — открыл Игру, но не поделился (24 ч после регистрации)
3. 'stalled'  — есть рефералы, но не было новых 48 ч
"""
import httpx
from app.config import settings


async def send_telegram_message(
    tg_id: int,
    text: str,
    bot_token: str | None = None,
    reply_markup: dict | None = None
) -> bool:
    """Отправляет сообщение через Telegram Bot API."""
    token = bot_token or settings.telegram_bot_token
    if not token:
        return False

    payload = {"chat_id": tg_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        import json
        payload["reply_markup"] = json.dumps(reply_markup)

    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json=payload,
            timeout=10
        )
        return r.status_code == 200


async def notify_gift_unlocked(tg_id: int, gift_title: str, gift_url: str | None = None, bot_token: str | None = None) -> bool:
    """Уведомление о разблокировке подарка."""
    text = f"🎁 <b>Поздравляем!</b>\n\nВы разблокировали подарок: <b>{gift_title}</b>"
    markup = None
    if gift_url:
        markup = {"inline_keyboard": [[{"text": "Получить подарок →", "url": gift_url}]]}
    return await send_telegram_message(tg_id, text, bot_token, markup)


async def notify_new_referral(tg_id: int, referral_name: str, bot_token: str | None = None) -> bool:
    """Уведомление о новом реферале."""
    text = f"🔥 По вашей ссылке зарегистрировался новый человек!\n\nПродолжайте — до следующего подарка осталось совсем чуть-чуть."
    return await send_telegram_message(tg_id, text, bot_token)


async def send_segment_message(tg_id: int, segment: str, event_title: str, mini_app_url: str, bot_token: str | None = None) -> bool:
    """
    Автоматические сегментные рассылки.
    """
    messages = {
        "no_game": (
            f"👋 Вы зарегистрировались на <b>{event_title}</b>, но ещё не открыли реферальную игру.\n\n"
            f"Получите личную ссылку и начните приглашать — за каждого другаполагается подарок!"
        ),
        "no_share": (
            f"🎯 Вы уже в игре на <b>{event_title}</b>!\n\n"
            f"Но ваша реферальная ссылка ещё ждёт. Поделитесь ею — и получите первый подарок уже за 1 человека."
        ),
        "stalled": (
            f"⚡️ У вас уже есть рефералы на <b>{event_title}</b> — отличный старт!\n\n"
            f"Осталось совсем немного до следующего подарка. Отправьте ссылку ещё нескольким людям сегодня."
        )
    }
    text = messages.get(segment, "")
    if not text:
        return False

    markup = {"inline_keyboard": [[{"text": "Открыть игру", "web_app": {"url": mini_app_url}}]]}
    return await send_telegram_message(tg_id, text, bot_token, markup)
