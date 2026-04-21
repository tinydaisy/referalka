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
from zoneinfo import ZoneInfo
from app.services.message_builder import (
    build_speaker_intro_message,
    build_gift_message,
    build_pre_start_message,
    build_day_message,
    send_telegram_message,
)
from app.celery_app import celery
from app.config import settings

logger = logging.getLogger(__name__)

RU_MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"]


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


def _fmt_time(dt) -> str:
    if not dt:
        return ""
    if isinstance(dt, datetime):
        return dt.strftime("%H:%M")
    return str(dt)


# ─────────────────────────────────────────
# Задача: проверить расписание и запустить рассылки
# ─────────────────────────────────────────
@celery.task(name="app.tasks.broadcast.check_and_send_broadcasts")
def check_and_send_broadcasts():
    run_async(_check_and_send())


async def _check_and_send():
    conn = await _get_conn()
    try:
        schedules = await conn.fetch(
            """
            SELECT id, event_id, session_id, template_id, type, is_test, test_recipients
            FROM broadcast_schedules
            WHERE fire_at <= NOW() AND status = 'pending'
            ORDER BY fire_at
            """
        )
        for s in schedules:
            await conn.execute(
                "UPDATE broadcast_schedules SET status='running', started_at=NOW() WHERE id=$1",
                s["id"]
            )
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
        schedule = await conn.fetchrow(
            """
            SELECT bs.*, e.client_id,
                   bt.text as tmpl_text, bt.photo_url as tmpl_photo,
                   bt.button_text as tmpl_btn_text, bt.button_url as tmpl_btn_url,
                   COALESCE(bs.audience_include, 'all_event') as audience_include,
                   COALESCE(bs.audience_exclude, 'none') as audience_exclude
            FROM broadcast_schedules bs
            JOIN events e ON e.id = bs.event_id
            LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
            WHERE bs.id = $1
            """,
            schedule_id
        )
        if not schedule:
            return

        tpl_type = schedule.get("type", "")
        event_id = schedule["event_id"]

        # Загружаем токен бота
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

        # Загружаем часовой пояс клиента
        client_row = await conn.fetchrow("SELECT timezone FROM clients WHERE id=$1", schedule["client_id"])
        tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
        tz = ZoneInfo(tz_str)

        tmpl_text = schedule["tmpl_text"] or ""
        photo_url = schedule["tmpl_photo"]
        button_text = schedule["tmpl_btn_text"]
        button_url = schedule["tmpl_btn_url"] or ""

        # ── Формируем текст сообщения ──
        if tpl_type == "speaker_intro":
            if schedule["session_id"]:
                sp = await conn.fetchrow(
                    """
                    SELECT c.name as speaker_name, c.poster_url as speaker_poster,
                           c.personal_tg_username, c.tg_channel_url, c.instagram_url,
                           c.achievements,
                           cse.role, cse.gift_after_speech_title, cse.gift_after_speech_url,
                           cse.gift_raffle_title,
                           cc.registration_url
                    FROM conf_speaker_events cse
                    JOIN collaborators c ON c.id = cse.speaker_id
                    LEFT JOIN conf_conferences cc ON cc.event_id = cse.event_id
                    WHERE cse.id = $1
                    """,
                    schedule["session_id"]
                )
                if sp:
                    topics = await conn.fetch(
                        "SELECT topic FROM conf_speaker_topics WHERE cse_id=$1 ORDER BY sort_order LIMIT 1",
                        schedule["session_id"]
                    )
                    topic = (topics[0]["topic"] if topics else "").strip()
                    text = build_speaker_intro_message(
                        tmpl_text,
                        sp["speaker_name"], sp["personal_tg_username"],
                        sp["tg_channel_url"], sp["instagram_url"],
                        sp["achievements"], sp["role"],
                        topic, sp["gift_after_speech_title"],
                        sp["gift_raffle_title"], sp["registration_url"],
                    )
                    if not photo_url:
                        photo_url = sp["speaker_poster"]
                else:
                    text = tmpl_text
            else:
                text = tmpl_text

        elif tpl_type in ("gift", "pre_start"):
            session_data = {}
            if schedule["session_id"]:
                session = await conn.fetchrow(
                    """
                    SELECT cs.title as session_title,
                           cs.start_datetime, cs.end_datetime, cs.day,
                           c.name as speaker_name,
                           c.poster_url as speaker_poster,
                           c.personal_tg_username as speaker_personal_tg,
                           cst.topic as speaker_topic,
                           cse.gift_after_speech_title as gift_title,
                           cse.gift_after_speech_url as gift_url,
                           cd.stream_url
                    FROM conf_sessions cs
                    LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                    LEFT JOIN collaborators c ON c.id = cse.speaker_id
                    LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
                    LEFT JOIN conf_days cd ON cd.event_id = cs.event_id AND cd.day_number = cs.day
                    WHERE cs.id = $1
                    """,
                    schedule["session_id"]
                )
                if session:
                    session_data = dict(session)

            if not photo_url:
                photo_url = session_data.get("speaker_poster")

            if tpl_type == "gift":
                text = build_gift_message(
                    session_data.get("speaker_name"),
                    session_data.get("speaker_personal_tg"),
                    session_data.get("gift_title"),
                    session_data.get("gift_url"),
                )
            else:  # pre_start
                text = build_pre_start_message(
                    tmpl_text,
                    session_data.get("speaker_name"),
                    session_data.get("speaker_topic") or session_data.get("session_title"),
                    session_data.get("stream_url"),
                )

        elif tpl_type.startswith("day_"):
            # Определяем номер дня по fire_at
            fire_at = schedule["fire_at"]
            day = 1
            if fire_at:
                fire_local = fire_at.astimezone(tz)
                fire_date = fire_local.date()
                day_row = await conn.fetchrow(
                    """
                    SELECT cs.day FROM conf_sessions cs
                    WHERE cs.event_id=$1 AND DATE(cs.start_datetime AT TIME ZONE $2) = $3
                    ORDER BY cs.start_datetime LIMIT 1
                    """,
                    event_id, tz_str, fire_date
                )
                if day_row:
                    day = day_row["day"]

            conf_row = await conn.fetchrow(
                """
                SELECT e.title as conf_title, cc.registration_url, cc.raffle_url,
                       cd.stream_url, cd.day_date
                FROM events e
                JOIN conf_conferences cc ON cc.event_id = e.id
                LEFT JOIN conf_days cd ON cd.event_id = e.id AND cd.day_number = $2
                WHERE e.id = $1
                """,
                event_id, day
            )
            conf_title = (conf_row["conf_title"] or "") if conf_row else ""
            stream_url = (conf_row["stream_url"] or "") if conf_row else ""
            reg_url = (conf_row["registration_url"] or "") if conf_row else ""
            raffle_url = (conf_row["raffle_url"] or "") if conf_row else ""
            raw_date = conf_row["day_date"] if conf_row else None
            if raw_date:
                day_date_str = f"{raw_date.day} {RU_MONTHS[raw_date.month - 1]}"
            else:
                day_date_str = f"День {day}"

            ROLE_LABELS = {"headliner": "Хедлайнер", "partner": "Партнёр", "organizer": "Организатор"}
            day_sessions = await conn.fetch(
                """
                SELECT cs.start_datetime, cs.end_datetime, cs.title as session_title,
                       c.name as speaker_name, cse.role
                FROM conf_sessions cs
                LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                LEFT JOIN collaborators c ON c.id = cse.speaker_id
                WHERE cs.event_id=$1 AND cs.day=$2
                ORDER BY cs.sort_order, cs.start_datetime
                """,
                event_id, day
            )
            program_lines = []
            for s in day_sessions:
                t_start = s["start_datetime"].astimezone(tz).strftime("%H:%M") if s["start_datetime"] else ""
                t_end = s["end_datetime"].astimezone(tz).strftime("%H:%M") if s["end_datetime"] else ""
                time_part = f"{t_start}–{t_end}" if t_start and t_end else t_start
                bold_time = f"<b>{time_part}</b>" if time_part else ""
                topic = s["session_title"] or ""
                name = s["speaker_name"] or ""
                role_label = ROLE_LABELS.get(s["role"] or "", "")
                speaker_part = f" (<b>{name}{' — ' + role_label if role_label else ''}</b>)" if name else ""
                program_lines.append(f"{bold_time}: {topic}{speaker_part}".strip(": "))
            day_program = "\n".join(program_lines)

            day_speakers_gifts = ""
            next_day_mention = ""
            if tpl_type == "day_end":
                gift_sessions = await conn.fetch(
                    """
                    SELECT c.name as speaker_name, c.personal_tg_username,
                           cse.gift_after_speech_title, cse.gift_after_speech_url, cse.role, cse.is_commercial
                    FROM conf_sessions cs
                    JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                    JOIN collaborators c ON c.id = cse.speaker_id
                    WHERE cs.event_id=$1 AND cs.day=$2
                    ORDER BY cse.priority, cs.sort_order
                    """,
                    event_id, day
                )
                gift_blocks = []
                for gs in gift_sessions:
                    title = (gs["gift_after_speech_title"] or "").strip()
                    url = (gs["gift_after_speech_url"] or "").strip()
                    tg = (gs["personal_tg_username"] or "").strip()
                    tg_mention = ("@" + tg.lstrip("@")) if tg else ""
                    if not title:
                        block = f"🎁 <b>{gs['speaker_name']}:</b> пишите в личку {tg_mention}" if tg_mention else f"🎁 <b>{gs['speaker_name']}:</b> уточните у спикера"
                    elif not url:
                        block = f"🎁 <b>{gs['speaker_name']}:</b> {title}" + (f"\nПишите в личку {tg_mention}" if tg_mention else "")
                    else:
                        block = f"🎁 <b>{gs['speaker_name']}:</b> {title}\n{url}"
                    gift_blocks.append(block)
                if gift_blocks:
                    day_speakers_gifts = f"А сейчас ловите подарки от спикеров Дня {day}:\n\n" + "\n\n".join(gift_blocks)

                first_next = await conn.fetchrow(
                    "SELECT start_datetime FROM conf_sessions WHERE event_id=$1 AND day=$2 ORDER BY sort_order, start_datetime LIMIT 1",
                    event_id, day + 1
                )
                first_cur = await conn.fetchrow(
                    "SELECT start_datetime FROM conf_sessions WHERE event_id=$1 AND day=$2 ORDER BY sort_order, start_datetime LIMIT 1",
                    event_id, day
                )
                if first_next and first_next["start_datetime"]:
                    next_dt = first_next["start_datetime"].astimezone(tz)
                    next_time = next_dt.strftime("%H:%M")
                    next_date = next_dt.date()
                    cur_date = first_cur["start_datetime"].astimezone(tz).date() if first_cur and first_cur["start_datetime"] else None
                    diff = (next_date - cur_date).days if cur_date else 999
                    when = "завтра" if diff == 1 else f"{next_date.day} {RU_MONTHS[next_date.month - 1]}"
                    next_day_mention = f"Встречаемся {when} в {next_time} на День {day + 1}."

            text = build_day_message(
                tmpl_text, day, conf_title, day_date_str, day_program,
                stream_url, reg_url, raffle_url,
                day_speakers_gifts=day_speakers_gifts,
                next_day_mention=next_day_mention,
            )
            button_url = button_url.replace("{stream_url}", stream_url).replace("{registration_url}", reg_url).replace("{raffle_url}", raffle_url)

        else:
            text = tmpl_text

        # Собираем аудиторию
        final_ids = await _build_audience(conn, schedule)

        if schedule["is_test"]:
            tids = await conn.fetchval(
                "SELECT test_telegram_ids FROM clients WHERE id=$1", schedule["client_id"]
            )
            test_ids = {str(t) for t in (tids or [])}
            final_ids = final_ids & test_ids

        # Отправляем каждому
        sent = 0
        async with httpx.AsyncClient(timeout=10) as http_client:
            for tg_id in final_ids:
                success, tg_error = await send_telegram_message(
                    http_client, bot_token, tg_id, text, photo_url, button_text, button_url or None
                )
                await conn.execute(
                    """
                    INSERT INTO broadcast_log (schedule_id, platform_user_id, status, error, sent_at)
                    SELECT $1, pu.id, $2, $3, NOW()
                    FROM platform_users pu
                    WHERE pu.platform_user_id = $4 AND pu.client_id = $5
                    """,
                    schedule_id,
                    "sent" if success else "failed",
                    tg_error or None,
                    tg_id,
                    schedule["client_id"]
                )
                if success:
                    sent += 1

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


async def _build_audience(conn, schedule) -> set:
    """Возвращает множество platform_user_id (telegram) по правилам audience_include/exclude."""
    aud_include = schedule["audience_include"] or "all_event"
    aud_exclude = schedule["audience_exclude"] or "none"
    event_id = schedule["event_id"]
    client_id = schedule["client_id"]

    if aud_include == "all_client":
        rows = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM platform_users pu
            WHERE pu.client_id = $1 AND pu.is_unsubscribed = FALSE AND pu.platform = 'telegram'
            """,
            client_id
        )
    elif aud_include == "registered_event":
        rows = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.id = ep.platform_user_id
            WHERE ep.event_id = $1 AND ep.is_registered = TRUE
              AND pu.is_unsubscribed = FALSE AND pu.platform = 'telegram'
            """,
            event_id
        )
    else:  # all_event
        rows = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.id = ep.platform_user_id
            WHERE ep.event_id = $1 AND pu.is_unsubscribed = FALSE AND pu.platform = 'telegram'
            """,
            event_id
        )
    include_ids = {r["platform_user_id"] for r in rows}

    exclude_ids: set = set()
    if aud_exclude == "registered_event":
        ex = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.id = ep.platform_user_id
            WHERE ep.event_id = $1 AND ep.is_registered = TRUE AND pu.platform = 'telegram'
            """,
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}
    elif aud_exclude == "unregistered_event":
        ex = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.id = ep.platform_user_id
            WHERE ep.event_id = $1 AND ep.is_registered = FALSE AND pu.platform = 'telegram'
            """,
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}
    elif aud_exclude == "all_event":
        ex = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.id = ep.platform_user_id
            WHERE ep.event_id = $1 AND pu.platform = 'telegram'
            """,
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}

    return include_ids - exclude_ids
