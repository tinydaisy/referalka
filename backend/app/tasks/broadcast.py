"""
Рассыльщик PLUSSON.

Celery Beat каждую минуту вызывает check_and_send_broadcasts.
Она находит рассылки у которых fire_at <= NOW() и status = 'pending',
и запускает send_broadcast для каждой.

Список получателей и текст сообщения собираются в момент отправки —
всегда актуальные данные о спикерах и участниках.
"""
import asyncio
import asyncpg
import httpx
import logging
from datetime import datetime
from app.celery_app import celery
from app.config import settings

logger = logging.getLogger(__name__)


def get_db_url() -> str:
    return settings.database_url


async def _get_conn():
    return await asyncpg.connect(get_db_url())


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ─────────────────────────────────────────
# Задача: проверить расписание и запустить рассылки
# ─────────────────────────────────────────
@celery.task(name="app.tasks.broadcast.check_and_send_broadcasts")
def check_and_send_broadcasts():
    run_async(_check_and_send())


async def _check_and_send():
    conn = await _get_conn()
    try:
        # Берём все рассылки которые пора запустить
        schedules = await conn.fetch(
            """
            SELECT id, event_id, session_id, template_id, type, is_test, test_recipients
            FROM broadcast_schedules
            WHERE fire_at <= NOW() AND status = 'pending'
            ORDER BY fire_at
            """
        )
        for s in schedules:
            # Помечаем как running чтобы не запустить дважды
            await conn.execute(
                "UPDATE broadcast_schedules SET status='running', started_at=NOW() WHERE id=$1",
                s["id"]
            )
            # Запускаем задачу отправки
            send_broadcast.delay(s["id"])
    finally:
        await conn.close()


# ─────────────────────────────────────────
# Задача: отправить одну рассылку
# ─────────────────────────────────────────
@celery.task(name="app.tasks.broadcast.send_broadcast")
def send_broadcast(schedule_id: int):
    run_async(_send_broadcast(schedule_id))


async def _send_broadcast(schedule_id: int):
    conn = await _get_conn()
    try:
        # Загружаем расписание
        schedule = await conn.fetchrow(
            """
            SELECT bs.*, e.client_id,
                   bt.text as tmpl_text, bt.photo_url as tmpl_photo,
                   bt.button_text as tmpl_btn_text, bt.button_url as tmpl_btn_url
            FROM broadcast_schedules bs
            JOIN events e ON e.id = bs.event_id
            LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
            WHERE bs.id = $1
            """,
            schedule_id
        )
        if not schedule:
            return

        # Загружаем данные сессии и спикера (актуальные на момент отправки)
        session_data = {}
        if schedule["session_id"]:
            session = await conn.fetchrow(
                """
                SELECT cs.title as session_title,
                       cs.start_datetime, cs.end_datetime,
                       cs.gift_description as gift,
                       cs.day,
                       c.name as speaker_name,
                       c.poster_url as speaker_poster,
                       c.personal_tg_username as speaker_personal_tg,
                       cst.topic as speaker_topic,
                       cse.gift_after_speech_title as gift_title,
                       cse.gift_after_speech_url as gift_url,
                       cd.stream_url
                FROM conf_sessions cs
                LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                LEFT JOIN collaborators c ON c.id = cse.collaborator_id
                LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
                LEFT JOIN conf_days cd ON cd.event_id = cs.event_id AND cd.day_number = cs.day
                WHERE cs.id = $1
                """,
                schedule["session_id"]
            )
            if session:
                session_data = dict(session)

        # Получаем токен бота клиента
        bot_token = await conn.fetchval(
            "SELECT bot_token FROM clients WHERE id = $1", schedule["client_id"]
        )
        if not bot_token:
            bot_token = settings.telegram_bot_token

        if not bot_token:
            await conn.execute(
                "UPDATE broadcast_schedules SET status='cancelled', error_log=$1, finished_at=NOW() WHERE id=$2",
                "Нет токена бота", schedule_id
            )
            return

        # Формируем текст сообщения из шаблона с подстановкой переменных
        text = _render_template(schedule["tmpl_text"] or "", session_data, schedule.get("type", ""))
        # Для pre_start — фото берём из афиши спикера, если в шаблоне не задано явно
        photo_url = schedule["tmpl_photo"] or (
            session_data.get("speaker_poster") if schedule["type"] == "pre_start" else None
        )
        button_text = schedule["tmpl_btn_text"]
        button_url = schedule["tmpl_btn_url"]

        # Собираем список получателей прямо перед отправкой
        if schedule["is_test"]:
            # Тестовая рассылка — только указанные tg_id
            recipients = schedule["test_recipients"] or []
            # Формат: [{"platform": "telegram", "platform_user_id": "123"}]
        else:
            # Боевая рассылка — все участники события (не отписавшиеся)
            rows = await conn.fetch(
                """
                SELECT pu.platform_user_id, pu.platform
                FROM event_participants ep
                JOIN platform_users pu ON pu.id = ep.platform_user_id
                WHERE ep.event_id = $1
                  AND pu.is_unsubscribed = FALSE
                  AND pu.platform = 'telegram'
                """,
                schedule["event_id"]
            )
            recipients = [{"platform": r["platform"], "platform_user_id": r["platform_user_id"]} for r in rows]

        # Отправляем каждому
        sent = 0
        async with httpx.AsyncClient(timeout=10) as client:
            for r in recipients:
                if r["platform"] != "telegram":
                    continue
                tg_id = r["platform_user_id"]
                success = await _send_telegram_message(
                    client, bot_token, tg_id, text, photo_url, button_text, button_url
                )
                # Логируем
                await conn.execute(
                    """
                    INSERT INTO broadcast_log (schedule_id, platform_user_id, status, sent_at)
                    SELECT $1, pu.id, $2, NOW()
                    FROM platform_users pu
                    WHERE pu.platform_user_id = $3 AND pu.client_id = $4
                    """,
                    schedule_id,
                    "sent" if success else "failed",
                    tg_id,
                    schedule["client_id"]
                )
                if success:
                    sent += 1

        # Помечаем рассылку как выполненную
        await conn.execute(
            """
            UPDATE broadcast_schedules
            SET status='done', finished_at=NOW(), recipients_sent=$1
            WHERE id=$2
            """,
            sent, schedule_id
        )
        logger.info(f"Рассылка {schedule_id} завершена: отправлено {sent} сообщений")

    except Exception as e:
        logger.error(f"Ошибка рассылки {schedule_id}: {e}")
        await conn.execute(
            "UPDATE broadcast_schedules SET status='cancelled', error_log=$1, finished_at=NOW() WHERE id=$2",
            str(e), schedule_id
        )
    finally:
        await conn.close()


def _render_template(text: str, data: dict, tpl_type: str = "") -> str:
    """Подставляет переменные в текст шаблона."""
    import re

    # Для шаблона gift — умная логика блока подарка
    if tpl_type == "gift":
        gift_title = (data.get("gift_title") or "").strip()
        gift_url = (data.get("gift_url") or "").strip()
        tg_url = (data.get("speaker_personal_tg") or "").strip()

        # Убираем строки с переменными подарка
        text = re.sub(r"^.*\{gift_title\}.*$\n?", "", text, flags=re.MULTILINE)
        text = re.sub(r"^.*\{gift_url\}.*$\n?", "", text, flags=re.MULTILINE)

        tg_mention = ("@" + tg_url.lstrip("@")) if tg_url else ""
        if not gift_title:
            gift_block = (
                f"🎁 Чтобы забрать материалы — пишите в личку {tg_mention}"
                if tg_mention else
                "🎁 Чтобы забрать материалы — напишите спикеру в личку"
            )
        elif not gift_url:
            gift_block = f"{gift_title}\nПишите в личку {tg_mention}" if tg_mention else gift_title
        else:
            gift_block = f"{gift_title}\n{gift_url}"

        text = text.rstrip() + "\n\n" + gift_block

    replacements = {
        "{speaker_name}": data.get("speaker_name") or "",
        "{session_title}": data.get("session_title") or "",
        "{gift}": data.get("gift") or "",
        "{speaker_topic}": data.get("speaker_topic") or "",
        "{start_time}": _fmt_time(data.get("start_datetime")),
        "{end_time}": _fmt_time(data.get("end_datetime")),
        "{stream_url}": data.get("stream_url") or "",
        "{gift_title}": data.get("gift_title") or "",
        "{gift_url}": data.get("gift_url") or "",
    }
    for key, val in replacements.items():
        text = text.replace(key, val)

    # Схлопываем 3+ пустых строки
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _fmt_time(dt) -> str:
    if not dt:
        return ""
    if isinstance(dt, datetime):
        return dt.strftime("%H:%M")
    return str(dt)


async def _send_telegram_message(
    client: httpx.AsyncClient,
    bot_token: str,
    chat_id: str,
    text: str,
    photo_url: str = None,
    button_text: str = None,
    button_url: str = None
) -> bool:
    """Отправляет сообщение через Telegram Bot API. Возвращает True если успешно."""
    try:
        # Inline-кнопка если есть
        reply_markup = None
        if button_text and button_url:
            reply_markup = {
                "inline_keyboard": [[{"text": button_text, "url": button_url}]]
            }

        if photo_url and len(text) <= 1024:
            # Фото + подпись (Telegram лимит caption = 1024 символа)
            payload = {
                "chat_id": chat_id,
                "photo": photo_url,
                "caption": text,
                "parse_mode": "HTML",
            }
            if reply_markup:
                payload["reply_markup"] = reply_markup
            resp = await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                json=payload
            )
            return resp.status_code == 200
        elif photo_url:
            # Текст длиннее 1024 — сначала фото, потом текст отдельно
            await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                json={"chat_id": chat_id, "photo": photo_url}
            )
            payload = {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            }
            if reply_markup:
                payload["reply_markup"] = reply_markup
            resp = await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json=payload
            )
            return resp.status_code == 200
        else:
            # Только текст
            payload = {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            }
            if reply_markup:
                payload["reply_markup"] = reply_markup
            resp = await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json=payload
            )
            return resp.status_code == 200
    except Exception as e:
        logger.warning(f"Ошибка отправки в {chat_id}: {e}")
        return False
