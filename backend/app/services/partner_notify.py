"""Уведомление партнёру, под которого человек НЕ зачислился (решение № 35).

Ситуация: партнёр А2 привёл Катю, а она уже закреплена за А1. Закрепление не
перебивается (№ 13), значит доход с её покупок идёт А1.

⚠️⚠️ ПИШЕМ ПРО ЗАКРЕПЛЕНИЕ, А НЕ ПРО ДЕНЬГИ. Формулировок вида «вы привели, но
денег вам не дадим» быть не должно: партнёр не сделал ничего плохого, а такая
фраза читается как обвинение и обесценивает его работу.

    Нельзя: «вы привели, но денег вам не дадим»
    Можно:  «человек не зачисляется под вас — его привёл ранее такой-то»

⚠️ Шлём В МОМЕНТ ПЕРЕХОДА по ссылке, а не после покупки: партнёр должен узнать
сразу, а не обнаружить сюрприз в отчёте через месяц.

⚠️ НЕ ПАРТНЁРАМ НЕ ШЛЁМ НИЧЕГО — человек в партнёрской программе не участвует,
сообщать ему не о чем.

⚠️ Пишет бот КЛИЕНТА, а не @pluson_bot: это партнёрская программа клиента, и
сообщение от постороннего бота выглядело бы как чужая реклама.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def notify_binding_taken(
    db, *, client_id: int, partner_id: int, contact_id: int
) -> bool:
    """«Человек уже закреплён за другим» — партнёру, который его привёл.

    Возвращает True, если сообщение ушло. Fail-open: сбой уведомления не должен
    ломать сам переход человека по ссылке.
    """
    try:
        return await _notify(db, client_id=client_id, partner_id=partner_id,
                             contact_id=contact_id)
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: уведомление о закреплении не ушло: %s", e)
        return False


# Не чаще раза в сутки на пару «партнёр + человек»: по ссылке заходят
# повторно (закрыл, открыл снова, перешёл с другого устройства), и без
# ограничения партнёр получил бы серию одинаковых сообщений про одного
# и того же человека. Ключ живёт в памяти процесса — переживать рестарт
# ему незачем: худшее следствие сброса — одно лишнее сообщение.
_SENT: dict[tuple[int, int], float] = {}
_COOLDOWN_SEC = 24 * 3600


def _recently_sent(partner_id: int, contact_id: int) -> bool:
    import time
    key = (partner_id, contact_id)
    now = time.time()
    last = _SENT.get(key)
    if last and now - last < _COOLDOWN_SEC:
        return True
    _SENT[key] = now
    # Чистим старое, чтобы словарь не рос бесконечно на долгоживущем процессе.
    if len(_SENT) > 5000:
        for k, v in list(_SENT.items()):
            if now - v > _COOLDOWN_SEC:
                _SENT.pop(k, None)
    return False


async def _notify(db, *, client_id: int, partner_id: int, contact_id: int) -> bool:
    from app.services.channels import get_client_telegram_token

    if _recently_sent(partner_id, contact_id):
        return False

    # Кому пишем — контакт самого партнёра.
    partner = await db.fetchrow(
        """SELECT p.contact_id, c.name
             FROM client_partners p
             JOIN contacts c ON c.id = p.contact_id
            WHERE p.id = $1 AND p.client_id = $2 AND p.is_active = TRUE""",
        partner_id, client_id,
    )
    if not partner:
        return False

    # Telegram-идентичность партнёра. ⚠️ Только ЧИСЛОВАЯ: псевдо-запись «@ник»
    # для отправки не годится — Telegram её не примет.
    tg_id = await db.fetchval(
        """SELECT platform_user_id FROM platform_users
            WHERE contact_id = $1 AND platform_slug = 'telegram'
              AND platform_user_id ~ '^[0-9]+$'
            ORDER BY id LIMIT 1""",
        partner["contact_id"],
    )
    if not tg_id:
        return False

    token = await get_client_telegram_token(client_id, db)
    if not token:
        # Нет своего бота у клиента — писать нечем. Системный бот здесь не
        # используется: это переписка партнёра с КЛИЕНТОМ, а не с платформой.
        return False

    who = await _person_name(db, contact_id)
    holder = await _holder_name(db, contact_id)

    text = (
        f"👋 {who} перешёл по вашей ссылке.\n\n"
        f"Этот человек уже закреплён за другим партнёром"
        + (f" — его раньше привёл {holder}." if holder else ".")
        + "\n\nЗа новых людей, которые придут по вашей ссылке первыми, "
          "вознаграждение будет вашим."
    )

    # ⚠️ Прямой вызов Bot API, как в plusson_referral_notify: общая
    # `send_telegram_message` первым аргументом принимает httpx-клиент и
    # рассчитана на рассылки — заводить её ради одного сообщения незачем.
    import httpx

    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": int(tg_id), "text": text,
                      "disable_web_page_preview": True},
            )
        if r.status_code == 200 and r.json().get("ok"):
            return True
        logger.warning("Партнёрка: уведомление не доставлено: %s %s",
                       r.status_code, r.text[:200])
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: ошибка отправки уведомления: %s", e)
    return False


async def _person_name(db, contact_id: int) -> str:
    name = await db.fetchval("SELECT name FROM contacts WHERE id = $1", contact_id)
    return (name or "").strip() or "Человек"


async def _holder_name(db, contact_id: int) -> Optional[str]:
    """Имя партнёра, за которым человек уже закреплён.

    ⚠️ Имя называем сознательно: без него сообщение звучит как отписка, а
    партнёр всё равно спросит у клиента, кто именно его опередил.
    """
    return await db.fetchval(
        """SELECT pc.name FROM contacts c
             JOIN client_partners p ON p.id = c.partner_id
             JOIN contacts pc ON pc.id = p.contact_id
            WHERE c.id = $1""",
        contact_id,
    )
