"""
Менеджер отвечает клиенту РЕПЛАЕМ на уведомление — прямо из бота.

⚠️⚠️ ЗАЧЕМ ЭТО ВООБЩЕ. Внедренец работает из бота, а не из кабинета (владелец,
19.09.2026). Уведомление «#вопрос_от_клиента» без возможности ответить — это
сигнал «иди в кабинет», то есть лишний шаг в самый частый момент работы.
Ответил реплаем — текст ушёл клиенту на ту площадку, откуда он написал.

⚠️ РОУТЕР ДОЛЖЕН СТОЯТЬ ПЕРЕД `start.router` в bot/main.py: у того есть общий
текстовый хендлер, и он перехватит реплай раньше.

⚠️ Отвечаем ТОЛЬКО на реплай к НАШЕМУ уведомлению: пара «чат + сообщение»
ищется в `tech_notify_messages`. Не нашли — молча пропускаем дальше, это
обычное сообщение, а не ответ клиенту.
"""
import logging

from aiogram import F, Router
from aiogram.types import Message

from app.database import get_pool

log = logging.getLogger(__name__)

router = Router(name="tech_reply")


@router.message(F.reply_to_message, F.text)
async def handle_tech_reply(message: Message):
    """Реплай на уведомление → сообщение клиенту."""
    if not message.from_user or not message.reply_to_message:
        return

    chat_id = str(message.chat.id)
    reply_to = message.reply_to_message.message_id
    text = (message.text or "").strip()
    if not text:
        return

    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            link = await db.fetchrow(
                # ⚠️ Имя внедренца — из клиента (миграция 486): внедренец роль
                # над клиентом, своей копии имени у него нет.
                """SELECT m.id, m.spec_id, m.contact_id, m.client_id, m.platform,
                          sc.name AS spec_name, ts.is_active
                     FROM tech_notify_messages m
                     JOIN tech_specialists ts ON ts.id = m.spec_id
                     JOIN clients sc ON sc.id = ts.client_id
                    WHERE m.chat_id = $1 AND m.message_id = $2""",
                chat_id, reply_to,
            )
            # Не наше уведомление — пропускаем дальше по цепочке хендлеров.
            if not link or not link["contact_id"]:
                return
            if not link["is_active"]:
                await message.answer("Ваш доступ отключён — ответ не отправлен.")
                return

            ok = await _send_to_contact(
                db, contact_id=link["contact_id"],
                platform=link["platform"], text=text,
                client_id=link["client_id"],
            )
    except Exception as e:  # noqa: BLE001
        log.warning("tech reply failed: %s", e)
        await message.answer("Не смог отправить — попробуйте из кабинета.")
        return

    if ok:
        await message.answer("✅ Отправлено клиенту.")
    else:
        await message.answer(
            "Не получилось отправить: клиент не писал нам на этой площадке "
            "или закрыл переписку. Попробуйте из кабинета."
        )


async def _send_to_contact(db, *, contact_id: int, platform: str,
                           text: str, client_id: int | None) -> bool:
    """Шлёт текст человеку и записывает сообщение в ленту диалога.

    ⚠️⚠️ ОТПРАВКА И ЗАПИСЬ — ШТАТНЫМИ ФУНКЦИЯМИ (`_tg_send`/`_vk_send`/
    `_max_send` + `archive_direct_message`), а НЕ своей копией. Свой запрос к
    API и свой INSERT означали бы вторую точку записи истории: сообщение ушло
    бы человеку, а в кабинете его не было — и следующий менеджер ответил бы то
    же самое второй раз. Плюс там уже учтены ошибки доставки и id сообщения у
    площадки (без него ответ нельзя потом ни отредактировать, ни удалить).
    """
    from app.api.dialogs import _max_send, _resolve_channel_token, _tg_send, _vk_send
    from app.services.dialog_archive import archive_direct_message

    platform = (platform or "telegram").lower()
    if platform not in ("telegram", "vk", "max"):
        return False

    pu = await db.fetchval(
        """SELECT pu.platform_user_id
             FROM platform_users pu
            WHERE pu.contact_id = $1 AND pu.platform_slug = $2
            ORDER BY pu.id DESC LIMIT 1""",
        contact_id, platform,
    )
    if not pu or not client_id:
        return False

    channel_id, token = await _resolve_channel_token(db, client_id, platform, None)
    if not token:
        return False

    if platform == "telegram":
        mid, err = await _tg_send(token, str(pu), text)
    elif platform == "vk":
        mid, err = await _vk_send(token, str(pu), text)
    else:
        mid, err = await _max_send(token, str(pu), text)

    # ⚠️ Пишем в ленту ДАЖЕ при ошибке доставки — с пометкой: иначе пропавшее
    # сообщение не отличить от неотправленного.
    await archive_direct_message(
        client_id=client_id, platform=platform, channel_id=channel_id,
        platform_user_id=str(pu), direction="out", author_kind="operator",
        text=text, platform_message_id=mid, contact_id=contact_id, error=err,
    )
    if err:
        log.warning("tech reply: не доставлено (%s): %s", platform, err)
        return False
    return True
