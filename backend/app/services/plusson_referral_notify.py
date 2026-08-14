"""Уведомления рефоводу по реф-программе САМОГО ПЛЮСОНа.

Две точки, обе адресованы РЕФОВОДУ (тому, чей код в ссылке), а не владельцу
бота, куда человек зашёл. Это разные клиенты: человек может прийти по ссылке
Марго в бот Марго, а может — по её же ссылке в чужой VIP-бот. Партнёрская
программа принадлежит рефоводу, поэтому и уведомление идёт ему.

  1. `notify_referrer_new_interest` — «новый интерес»: человек ТОЛЬКО зашёл в
     бота по реф-ссылке ПЛЮСОНа. Он ещё не клиент — не зарегистрировался, ничего
     не купил. Уходит в каналы уведомлений рефовода (TG + MAX + VK).

  2. `notify_referrer_about_purchase` — приведённый КУПИЛ подписку. Уходит в
     каналы уведомлений (kind='payments' — у оплат может быть свой канал) И
     письмом на почту рефовода: оплата — событие с деньгами, его нельзя терять
     среди сообщений в мессенджере.

⚠️ Обе функции НИКОГДА не бросают исключение. Уведомление — вспомогательный
шаг: сорванная отправка не должна ронять ни обработку /start, ни — тем более —
проведение оплаты.
"""
from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

# Человекочитаемое имя площадки, откуда пришёл человек.
PLATFORM_LABEL = {
    "telegram": "Telegram",
    "max": "MAX",
    "vk": "ВКонтакте",
}


def _msk_now_str() -> str:
    return datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M МСК")


def _rub(kopecks: int) -> str:
    """Копейки → «1 990 ₽». Дробную часть показываем, только если она есть."""
    rub = (kopecks or 0) / 100
    s = f"{rub:,.2f}".replace(",", " ").replace(".", ",")
    return (s[:-3] if s.endswith(",00") else s) + " ₽"


async def notify_referrer_new_interest(
    db,
    *,
    referrer_client_id: int,
    platform: str,
    user_id: str | int | None,
    username: str | None,
    first_name: str | None = None,
    last_name: str | None = None,
) -> dict:
    """«По вашей ссылке зашёл человек» — рефоводу во все его каналы.

    ⚠️ Это ещё НЕ регистрация. Формулировка намеренно говорит «заинтересовался»,
    а не «зарегистрировался»: человек только открыл бота, до создания аккаунта
    может не дойти. Обещать рефоводу нового клиента раньше времени нельзя.

    Ника у человека может не быть вовсе (в Telegram username необязателен) —
    тогда `profile_links` отдаёт deep-link по числовому id, и написать ему всё
    равно можно в один клик.
    """
    try:
        from app.services.channels import notify_organizer_all_channels
        from app.services.profile_links import nick_html, link_html

        name = " ".join(p for p in [(first_name or "").strip(),
                                    (last_name or "").strip()] if p).strip()
        nick = nick_html(platform, user_id=user_id, username=username)
        link = link_html(platform, user_id=user_id, username=username)
        label = PLATFORM_LABEL.get((platform or "").lower(), platform or "—")

        parts = [
            "🆕 <b>Новый интерес по вашей реферальной ссылке</b>",
            "",
            f"<b>Имя:</b> {name or '—'}",
            f"<b>Никнейм:</b> {nick or '—'}",
            f"<b>Площадка:</b> {label}",
            f"<b>Когда:</b> {_msk_now_str()}",
        ]
        if link:
            parts.append(f"<b>Ссылка:</b> {link}")
        parts += [
            "",
            "Человек перешёл по вашей ссылке и открыл бота. "
            "Аккаунт в ПЛЮСОНе он ещё не создал — если создаст, "
            "закрепится за вами автоматически.",
        ]

        return await notify_organizer_all_channels(
            referrer_client_id, "\n".join(parts), db
        )
    except Exception as e:  # noqa: BLE001 — уведомление не роняет /start
        log.warning("notify_referrer_new_interest failed: %s", e)
        return {"tg": False, "max": False, "vk": False}


async def notify_referrer_about_purchase(
    db,
    *,
    referrer_client_id: int,
    payer_name: str | None,
    what_paid: str,
    amount_kopecks: int,
    percent: int,
    cashback_kopecks: int,
    balance_kopecks: int,
) -> dict:
    """«Ваш реферал купил» — в каналы уведомлений И письмом на почту.

    Показываем ЧЕТЫРЕ цифры, а не только начисленную: сумму покупки, процент,
    начисление и новый баланс. Без процента и суммы уведомление не проверяемо —
    рефовод видит «+199 ₽» и не может сойтись, правильно ли ему посчитали.

    Почта обязательна: оплата — событие с деньгами, а сообщение в мессенджере
    легко теряется среди прочих уведомлений.
    """
    result = {"tg": False, "max": False, "vk": False, "email": False}
    payer = (payer_name or "").strip() or "Клиент"

    lines = [
        "💰 <b>Покупка по вашей реферальной ссылке</b>",
        "",
        f"<b>Кто купил:</b> {payer}",
        f"<b>Что купил:</b> {what_paid}",
        f"<b>Сумма покупки:</b> {_rub(amount_kopecks)}",
        "",
        f"<b>Ваш процент:</b> {percent}%",
        f"<b>Начислено вам:</b> {_rub(cashback_kopecks)}",
        f"<b>Баланс:</b> {_rub(balance_kopecks)}",
        "",
        f"<b>Когда:</b> {_msk_now_str()}",
    ]
    text_html = "\n".join(lines)

    # ── Мессенджеры ──
    # kind='payments' — у оплат может быть отдельный канал (миграция 259); если
    # он не задан, notify_organizer_all_channels сама падает на общий.
    try:
        from app.services.channels import notify_organizer_all_channels
        res = await notify_organizer_all_channels(
            referrer_client_id, text_html, db, kind="payments"
        )
        result.update(res)
    except Exception as e:  # noqa: BLE001 — не роняем оплату
        log.warning("notify purchase (messengers) failed: %s", e)

    # ── Почта ──
    try:
        result["email"] = await _send_purchase_email(
            db,
            referrer_client_id=referrer_client_id,
            payer=payer,
            what_paid=what_paid,
            amount_kopecks=amount_kopecks,
            percent=percent,
            cashback_kopecks=cashback_kopecks,
            balance_kopecks=balance_kopecks,
        )
    except Exception as e:  # noqa: BLE001 — не роняем оплату
        log.warning("notify purchase (email) failed: %s", e)

    return result


async def _send_purchase_email(
    db,
    *,
    referrer_client_id: int,
    payer: str,
    what_paid: str,
    amount_kopecks: int,
    percent: int,
    cashback_kopecks: int,
    balance_kopecks: int,
) -> bool:
    """Письмо рефоводу о покупке. Шлём через СИСТЕМНЫЙ email-канал ПЛЮСОНа —
    это письмо от платформы самому клиенту, а не рассылка по его базе.
    """
    client = await db.fetchrow(
        "SELECT email, name FROM clients WHERE id = $1", referrer_client_id
    )
    if not client or not client["email"]:
        return False

    ch = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'email'
              AND ch.is_system = TRUE
            LIMIT 1""",
        referrer_client_id,
    )
    if not ch:
        return False

    from app.config import settings as _s
    from app.services.email_sender import EmailSender
    from app.services.unsubscribe_token import make_email_unsubscribe_token

    channel_dict = dict(ch)
    channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"

    # Токен отписки нужен формально (подвал письма). Это транзакционное письмо
    # об оплате, а не рассылка — contact_id=0, как в письме подтверждения email.
    unsub = make_email_unsubscribe_token(
        client_id=referrer_client_id, contact_id=0,
        client_channel_id=ch["client_channel_id"],
    )

    name = (client["name"] or "").strip()
    greeting = f"Здравствуйте, {name}!" if name else "Здравствуйте!"
    dash_url = f"{_s.frontend_url.rstrip('/')}/dashboard/partner-program"

    body_text = (
        f"{greeting}\n\n"
        f"По вашей реферальной ссылке совершена покупка.\n\n"
        f"Кто купил: {payer}\n"
        f"Что купил: {what_paid}\n"
        f"Сумма покупки: {_rub(amount_kopecks)}\n\n"
        f"Ваш процент: {percent}%\n"
        f"Начислено вам: {_rub(cashback_kopecks)}\n"
        f"Текущий баланс: {_rub(balance_kopecks)}\n\n"
        f"Бонусы можно потратить на подписку или вывести — "
        f"всё в вашем кабинете:\n{dash_url}\n\n"
        f"— Команда iViSiON: ПЛЮСОН"
    )

    EmailSender().send(
        channel=channel_dict,
        client_brand_name="iViSiON: ПЛЮСОН",
        to_email=client["email"],
        subject=f"Начислено {_rub(cashback_kopecks)} — покупка по вашей ссылке",
        body_text=body_text,
        unsubscribe_token=unsub,
    )
    return True
