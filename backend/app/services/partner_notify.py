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


# ─── Уведомления партнёру: интерес и покупка ─────────────────────────────────
#
# ⚠️⚠️ ПАРТНЁР УЗНАЁТ О СВОЕЙ РАБОТЕ САМ, а не заходя в кабинет. До этого ему
# не приходило НИЧЕГО: ни про переход по ссылке, ни про покупку с начислением.
# Молчание системы после продажи читается как «мне не начислили».
#
# ⚠️ Шлём в БОТ И НА ПОЧТУ сразу: бот быстрее, но у партнёра его может не быть
# вовсе (он мог прийти с веб-страницы), а почта есть всегда — это ключ входа
# в кабинет.
#
# ⚠️ Отправку переиспользуем из product_notify (`_send_to_bot`, `_email_channel`)
# — своей копии заводить нельзя: она разъедется с остальными письмами клиента
# (домен отправителя, токен отписки, выбор площадки).

async def _cabinet_people_url(db, client_id: int) -> str:
    """Ссылка на раздел «Мои люди» в кабинете партнёра.

    ⚠️ Номер кабинета в адресе ОБЯЗАТЕЛЕН: на общем домене `pluson.ru/my`
    определить клиента нечем, и вход отвечает «Не удалось определить кабинет».
    """
    from app.services.client_domains import client_public_link
    return await client_public_link(db, client_id, f"/my?client_id={client_id}&tab=people")


async def _partner_email(db, contact_id: int) -> Optional[str]:
    return await db.fetchval(
        """SELECT platform_user_id FROM platform_users
            WHERE contact_id = $1 AND platform_slug = 'email'
            ORDER BY id LIMIT 1""",
        contact_id,
    )


async def _deliver(db, *, client_id: int, partner_contact_id: int,
                   subject: str, html: str, text: str) -> None:
    """Одно сообщение партнёру — в бот и на почту. Сбой одного канала не
    отменяет другой: партнёр должен узнать хоть как-то."""
    from app.services.product_notify import _send_to_bot, _email_channel

    try:
        await _send_to_bot(db, client_id, partner_contact_id, html)
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: сообщение в бот не ушло: %s", e)

    email = await _partner_email(db, partner_contact_id)
    channel = await _email_channel(db, client_id) if email else None
    if not (email and channel):
        return
    try:
        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token
        from app.services.client_domains import client_mail_domain, client_public_url

        brand = await db.fetchval(
            "SELECT COALESCE(NULLIF(brand_name, ''), name) FROM clients WHERE id = $1",
            client_id) or ""
        channel_dict = dict(channel)
        mail = await client_mail_domain(db, client_id)
        if mail:
            channel_dict["email_domain"] = mail["domain"]
            channel_dict["email_from_local"] = mail["local"]
            if mail["from_name"]:
                channel_dict["email_from_name"] = mail["from_name"]

        EmailSender().send(
            channel=channel_dict,
            client_brand_name=brand,
            to_email=email,
            subject=subject,
            body_text=text,
            unsubscribe_token=make_email_unsubscribe_token(
                client_id=client_id, contact_id=partner_contact_id,
                client_channel_id=channel["client_channel_id"],
            ),
            public_base_url=await client_public_url(db, client_id),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: письмо партнёру не ушло: %s", e)


async def notify_interest(db, *, client_id: int, partner_id: int,
                          contact_id: int) -> bool:
    """«По вашей ссылке пришёл человек» — партнёру, за которым он закрепился.

    ⚠️ Не чаще раза в сутки на пару «партнёр + человек» (решение владельца):
    один и тот же человек заходит по ссылке помногу раз, и без ограничения
    партнёр получил бы поток одинаковых сообщений и отписался бы от всего.
    """
    if _recently_sent(partner_id, contact_id):
        return False

    row = await db.fetchrow(
        """SELECT p.contact_id FROM client_partners p
            WHERE p.id = $1 AND p.client_id = $2 AND p.is_active = TRUE""",
        partner_id, client_id)
    if not row:
        return False

    who = await _person_name(db, contact_id)
    url = await _cabinet_people_url(db, client_id)

    html = (f"👋 <b>{who}</b> перешёл по вашей ссылке.\n\n"
            f"Пока он только интересуется — самое время связаться.\n"
            f"Его контакты и кнопка «написать» — в разделе «Мои люди»:\n{url}")
    text = (f"{who} перешёл по вашей ссылке.\n\n"
            f"Пока он только интересуется — самое время связаться.\n"
            f"Его контакты и кнопка «написать» — в разделе «Мои люди»:\n{url}")
    await _deliver(db, client_id=client_id, partner_contact_id=row["contact_id"],
                   subject=f"По вашей ссылке пришёл человек: {who}",
                   html=html, text=text)
    return True


async def notify_sale(db, *, client_id: int, partner_id: int,
                      buyer_contact_id: int, source_title: str,
                      base_amount: float, reward: float, level: int = 1) -> bool:
    """«По вашей рекомендации купили» — с суммой покупки и вознаграждением.

    ⚠️ Ограничения раз в сутки здесь НЕТ: покупка — событие редкое и важное,
    пропустить её нельзя. Тот же человек может купить дважды, и оба раза это
    деньги партнёра.

    ⚠️ Называем И сумму покупки, И вознаграждение: одна цифра начисления не
    даёт партнёру проверить расчёт (та же ошибка была в реф-программе
    платформы — приходило «+199 ₽» без основания).
    """
    row = await db.fetchrow(
        """SELECT p.contact_id FROM client_partners p
            WHERE p.id = $1 AND p.client_id = $2 AND p.is_active = TRUE""",
        partner_id, client_id)
    if not row:
        return False

    who = await _person_name(db, buyer_contact_id)
    url = await _cabinet_people_url(db, client_id)
    lvl = f" (уровень {level})" if level and int(level) > 1 else ""
    what = f" «{source_title}»" if source_title else ""

    html = (f"💰 <b>{who}</b> купил{what} по вашей рекомендации{lvl}.\n\n"
            f"Сумма покупки: <b>{base_amount:,.0f} ₽</b>\n"
            f"Ваше вознаграждение: <b>{reward:,.0f} ₽</b>\n\n"
            f"Все продажи и люди — в кабинете:\n{url}").replace(",", " ")
    text = (f"{who} купил{what} по вашей рекомендации{lvl}.\n\n"
            f"Сумма покупки: {base_amount:,.0f} ₽\n"
            f"Ваше вознаграждение: {reward:,.0f} ₽\n\n"
            f"Все продажи и люди — в кабинете:\n{url}").replace(",", " ")
    await _deliver(db, client_id=client_id, partner_contact_id=row["contact_id"],
                   subject=f"Покупка по вашей рекомендации: +{reward:,.0f} ₽".replace(",", " "),
                   html=html, text=text)
    return True
