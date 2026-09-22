"""
Уведомления внедренцу о его клиентах — ОДНА точка на все виды событий.

⚠️⚠️ ШЛЁМ В ДВА МЕСТА СРАЗУ: в личку менеджера в @pluson_bot и в его группу
уведомлений. Не «или-или»: у лички свойство «увидит быстро», у группы —
«не потеряется и видят коллеги». Владелец: «можно отправлять и в бот
персональному менеджеру, и ещё в группу уведомлений — чтобы не пропустил».

⚠️⚠️ МЕНЕДЖЕР РАБОТАЕТ ИЗ БОТА, А НЕ ИЗ КАБИНЕТА. Поэтому уведомление о вопросе
клиента — не сигнал «сходи в кабинет», а рабочее место: на него отвечают
РЕПЛАЕМ, и ответ уходит клиенту на его площадку. Разбор реплая — в
bot/handlers/tech_reply.py.

⚠️ @pluson_bot общий на всех, и это не мешает личным уведомлениям: внутри бота
у каждого свой чат по telegram_user_id. Связка ставится автоматически, когда
внедренец переходит по ссылке из кабинета.
"""
import html as _html
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Виды событий и их теги. ⚠️ Теги — часть сообщения, по ним менеджер фильтрует
# поиском в телефоне; менять их формулировки нельзя без спроса.
KINDS = {
    "question": "#вопрос_от_клиента",
    "lead": "#новый_лид",
    "trial": "#новый_триал",
    "payment": "#новая_оплата",
    "expiring": "#через_3_дня_истекает",
    "expired": "#истекла_подписка",
    "order": "#персональный_заказ",
}


def _esc(text) -> str:
    return _html.escape(str(text or ""))


async def _bot_token(db) -> Optional[str]:
    """Токен @pluson_bot — бота СЕРВИСНОГО КЛИЕНТА.

    ⚠️⚠️ ИЩЕМ ПО ВЛАДЕЛЬЦУ, А НЕ ПО ФЛАГУ `is_system`. @pluson_bot — обычный
    бот сервисного клиента, и `is_system` у него FALSE (правило владельца
    2026-07-10). Поиск по `is_system = TRUE` не находил НИЧЕГО, и уведомления
    молча не уходили: «tech notify: системный бот не настроен» в логе.

    Поэтому идём от клиента с `is_system_service = TRUE` через его каналы.
    """
    return await db.fetchval(
        """SELECT ch.bot_token
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
             JOIN clients c ON c.id = cc.client_id
            WHERE ch.platform_slug = 'telegram'
              AND c.is_system_service = TRUE
              AND cc.is_active = TRUE
              AND COALESCE(ch.bot_token, '') <> ''
            ORDER BY ch.id LIMIT 1"""
    )


async def _send_tg(token: str, chat_id: str, text: str,
                   reply_markup: Optional[dict] = None) -> Optional[int]:
    """Отправка в Telegram. Возвращает message_id — он нужен, чтобы потом
    опознать реплай менеджера на это уведомление."""
    import aiohttp

    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json=payload, timeout=aiohttp.ClientTimeout(total=15),
            ) as r:
                data = await r.json()
                if not data.get("ok"):
                    logger.warning("tech notify: telegram отказал: %s",
                                   data.get("description"))
                    return None
                return data["result"]["message_id"]
    except Exception as e:  # noqa: BLE001
        logger.warning("tech notify: отправка не прошла: %s", e)
        return None


async def notify_tech(
    db, spec_id: int, kind: str, text: str, *,
    contact_id: Optional[int] = None,
    client_id: Optional[int] = None,
    platform: Optional[str] = None,
) -> dict:
    """Отправляет уведомление внедренцу в ОБА канала.

    `contact_id` и `platform` запоминаются вместе с сообщением: по ним разбор
    реплая понимает, КОМУ отвечать. Без них ответить из бота нельзя — будет
    только текст уведомления.
    """
    if kind not in KINDS:
        logger.warning("tech notify: неизвестный вид %s", kind)
        return {"sent": 0}

    spec = await db.fetchrow(
        # ⚠️ Имя и почта — из клиента (миграция 486): внедренец роль над
        # клиентом. А `notify_*` остаются здесь: это уведомления про клиентов,
        # которых он ВЕДЁТ, а не про его собственный кабинет.
        """SELECT ts.id, c.name, c.email, ts.notify_tg_user_id, ts.notify_chat_id,
                  ts.notify_kinds, ts.is_active
             FROM tech_specialists ts
             JOIN clients c ON c.id = ts.client_id
            WHERE ts.id = $1""",
        spec_id,
    )
    if not spec or not spec["is_active"]:
        return {"sent": 0}

    # ⚠️ Уволенному не шлём, отключённый вид — не шлём. Проверяем ЗДЕСЬ, а не у
    # каждого вызывающего: иначе один забудет и человек получит лишнее.
    kinds = spec["notify_kinds"] or []
    if isinstance(kinds, str):
        import json as _json
        kinds = _json.loads(kinds)
    if kind not in kinds:
        return {"sent": 0}

    token = await _bot_token(db)
    if not token:
        logger.warning("tech notify: системный бот не настроен")
        return {"sent": 0}

    body = f"{KINDS[kind]}\n\n{text}"

    sent, first_msg_id, first_chat = 0, None, None
    for chat_id in (spec["notify_tg_user_id"], spec["notify_chat_id"]):
        if not chat_id:
            continue
        msg_id = await _send_tg(token, str(chat_id), body)
        if msg_id:
            sent += 1
            if first_msg_id is None:
                first_msg_id, first_chat = msg_id, str(chat_id)

    # Запоминаем, на что менеджер может ответить реплаем.
    # ⚠️ Только для вопросов: на «новый лид» или «истекла подписка» отвечать
    # некому — там нет входящего сообщения, на которое идёт ответ.
    if first_msg_id and contact_id and kind == "question":
        try:
            await db.execute(
                """INSERT INTO tech_notify_messages
                       (spec_id, chat_id, message_id, contact_id, client_id, platform)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (chat_id, message_id) DO NOTHING""",
                spec_id, first_chat, first_msg_id, contact_id, client_id,
                platform or "telegram",
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("tech notify: связка реплая не записана: %s", e)

    return {"sent": sent}


def format_person(*, name: Optional[str], email: Optional[str] = None,
                  phone: Optional[str] = None,
                  tg_username: Optional[str] = None,
                  max_username: Optional[str] = None,
                  platform: Optional[str] = None) -> str:
    """Человек одним блоком: имя, контакты, площадка.

    ⚠️ Ник в Telegram даём ССЫЛКОЙ, а ник MAX — упоминанием: у MAX нет адреса
    профиля вида t.me/ник, ссылка вела бы в никуда.
    """
    lines = [f"<b>{_esc(name or 'Без имени')}</b>"]
    contacts = []
    if email:
        contacts.append(_esc(email))
    if phone:
        contacts.append(_esc(phone))
    if contacts:
        lines.append(" · ".join(contacts))
    if tg_username:
        u = str(tg_username).lstrip("@")
        lines.append(f'TG: <a href="https://t.me/{_esc(u)}">@{_esc(u)}</a>')
    if max_username:
        lines.append(f"MAX: @{_esc(str(max_username).lstrip('@'))}")
    if platform:
        lines.append(f"Площадка: {_esc(platform)}")
    return "\n".join(lines)
