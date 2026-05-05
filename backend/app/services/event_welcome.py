"""
Контекстное приветствие в бота при открытии события из Mini App.

Вызывается из двух мест:
  1) POST /api/v1/event (event_start) — обычный запуск Mini App
  2) GET /api/v1/public/events/{slug}/landing-redirect — когда у события задан
     events.landing_url, webview редиректится на сторонний лендинг ДО запуска
     React-bundle, и (1) уже не сработает.

Что делает:
- upsert contact + telegram identity, запись «интересовался» в event_participants
  (с резолвом реферера через merged_ref_codes)
- определяет kind по статусу регистрации и состоянию события
- дедупит через event_participants.last_open_msg_kind/at + broadcast_log
- шлёт сообщение через бот клиента (или fallback @pluson_bot)
- обновляет last_open_msg_kind/at при успехе

См. CLAUDE.md → «Приветствие при открытии события (миграция 064 от 05.05.2026)».
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo
import httpx
import logging

from ..config import settings
from .channels import get_client_telegram_token
from .contact_merge import upsert_contact_with_identity, resolve_ref_code
from .message_builder import RU_MONTHS

logger = logging.getLogger(__name__)


def _to_msk(dt):
    if not dt:
        return None
    return dt.astimezone(ZoneInfo("Europe/Moscow")) if dt.tzinfo else dt


def _fmt_date(dt) -> str:
    return f"{dt.day} {RU_MONTHS[dt.month - 1]}"


def _fmt_event_period(start_at, end_at, is_conference: bool) -> str:
    """Человеческий период события для бот-сообщений.

    Конференция (многодневная) — только диапазон дней:
        «23–24 июля», «30 июля – 2 августа», «23 июля» (один день)

    Мероприятие — дата + время:
        «23 июля 14:00–18:00 МСК» (один день)
        «23 июля 14:00 — 24 июля 12:00 МСК» (через день)
        «23 июля 14:00 МСК» (без end_at)
        «23 июля» (если у обоих 00:00 — время не задано)
    """
    s = _to_msk(start_at)
    e = _to_msk(end_at)
    if not s:
        return ""

    if is_conference:
        if e and e.date() != s.date():
            if s.year == e.year and s.month == e.month:
                return f"{s.day}–{e.day} {RU_MONTHS[s.month - 1]}"
            return f"{_fmt_date(s)} – {_fmt_date(e)}"
        return _fmt_date(s)

    # мероприятие
    s_no_time = (s.hour == 0 and s.minute == 0)
    e_no_time = (not e) or (e.hour == 0 and e.minute == 0)
    if s_no_time and e_no_time:
        if e and e.date() != s.date():
            return f"с {_fmt_date(s)} по {_fmt_date(e)}"
        return _fmt_date(s)

    s_time = f"{s.hour:02d}:{s.minute:02d}"
    if e and e.date() == s.date() and not e_no_time:
        e_time = f"{e.hour:02d}:{e.minute:02d}"
        return f"{_fmt_date(s)} {s_time}–{e_time} МСК"
    if e and e.date() != s.date() and not e_no_time:
        e_time = f"{e.hour:02d}:{e.minute:02d}"
        return f"{_fmt_date(s)} {s_time} — {_fmt_date(e)} {e_time} МСК"
    return f"{_fmt_date(s)} {s_time} МСК"


async def send_event_open_message(
    pool,
    *,
    tg_id: int,
    event_slug: str,
    client_id_hint: int = 0,
    first_name: str = "",
    last_name: str = "",
    username: str = "",
    partner_id: str = "",
) -> dict:
    """Возвращает диагностический dict (для логов / API-ответов): {ok, kind, sent, deduped, ...}."""
    if not pool or not event_slug or not tg_id:
        return {"ok": True, "skipped": "preconditions"}

    try:
        async with pool.acquire() as conn:
            ev = await conn.fetchrow(
                """
                SELECT e.id, e.slug, e.title, e.module_slug, e.status,
                       e.client_id,
                       CASE WHEN e.module_slug = 'conference' THEN
                         (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                  AT TIME ZONE 'Europe/Moscow'
                            FROM conf_days d
                           WHERE d.event_id = e.id
                           ORDER BY d.day_number ASC LIMIT 1)
                         ELSE e.start_at
                       END AS effective_start_at,
                       CASE WHEN e.module_slug = 'conference' THEN
                         (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                  AT TIME ZONE 'Europe/Moscow'
                            FROM conf_days d
                           WHERE d.event_id = e.id
                           ORDER BY d.day_number DESC LIMIT 1)
                         ELSE e.end_at
                       END AS effective_end_at
                  FROM events e
                 WHERE e.slug = $1
                """,
                event_slug,
            )
            if not ev:
                return {"ok": True, "skipped": "event not found"}

            event_id = ev["id"]
            client_id = client_id_hint or ev["client_id"]

            async with conn.transaction():
                contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                    conn,
                    client_id=client_id,
                    platform_slug='telegram',
                    platform_user_id=str(tg_id),
                    username=username or None,
                    first_name=first_name or None,
                    last_name=last_name or None,
                )

                resolved_ref_code = None
                referrer_contact_id = None
                if partner_id:
                    resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                        conn, partner_id, client_id=client_id
                    )

                referrer_participant_id = None
                if referrer_contact_id:
                    referrer_participant_id = await conn.fetchval(
                        """SELECT id FROM event_participants
                            WHERE contact_id = $1 AND event_id = $2 LIMIT 1""",
                        referrer_contact_id, event_id,
                    )

                inserted = await conn.fetchval(
                    """INSERT INTO event_participants
                          (event_id, contact_id, is_registered, referrer_ref_code, referrer_participant_id)
                        VALUES ($1, $2, FALSE, $3, $4)
                       ON CONFLICT DO NOTHING
                     RETURNING id""",
                    event_id, contact_id, resolved_ref_code, referrer_participant_id,
                )
                if inserted is None and resolved_ref_code:
                    await conn.execute(
                        """UPDATE event_participants
                              SET referrer_ref_code = $3,
                                  referrer_participant_id = COALESCE(referrer_participant_id, $4)
                            WHERE event_id = $1 AND contact_id = $2
                              AND referrer_ref_code IS NULL""",
                        event_id, contact_id, resolved_ref_code, referrer_participant_id,
                    )

            part = await conn.fetchrow(
                """SELECT id, is_registered, last_open_msg_kind, last_open_msg_at
                     FROM event_participants
                    WHERE event_id = $1 AND contact_id = $2""",
                event_id, contact_id,
            )
            if not part:
                return {"ok": True, "skipped": "no participant after upsert"}

            ref_code = await conn.fetchval(
                "SELECT ref_code FROM contacts WHERE id = $1", contact_id
            )

            # Если first_name не передали (зов из landing-redirect) — берём из БД
            display_name = first_name
            if not display_name:
                display_name = await conn.fetchval(
                    """SELECT COALESCE(NULLIF(pu.first_name, ''), NULLIF(c.name, ''), '')
                         FROM platform_users pu
                         JOIN contacts c ON c.id = pu.contact_id
                        WHERE pu.contact_id = $1 AND pu.platform_slug = 'telegram'
                        LIMIT 1""",
                    contact_id,
                ) or ""

            # Успешник — автоматически: ближайшее предстоящее опубликованное
            # событие того же клиента. Текущее исключаем.
            successor_ev = await conn.fetchrow(
                """
                SELECT * FROM (
                    SELECT e.id, e.slug, e.title, e.status, e.module_slug,
                           CASE WHEN e.module_slug = 'conference' THEN
                             (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                      AT TIME ZONE 'Europe/Moscow'
                                FROM conf_days d WHERE d.event_id = e.id
                                ORDER BY d.day_number ASC LIMIT 1)
                             ELSE e.start_at
                           END AS effective_start_at,
                           CASE WHEN e.module_slug = 'conference' THEN
                             (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                      AT TIME ZONE 'Europe/Moscow'
                                FROM conf_days d WHERE d.event_id = e.id
                                ORDER BY d.day_number DESC LIMIT 1)
                             ELSE e.end_at
                           END AS effective_end_at
                      FROM events e
                     WHERE e.client_id = $1
                       AND e.status = 'published'
                       AND e.id <> $2
                ) t
                WHERE t.effective_start_at IS NOT NULL
                  AND t.effective_start_at > NOW()
                ORDER BY t.effective_start_at ASC
                LIMIT 1
                """,
                ev["client_id"], ev["id"],
            )

            now_msk = datetime.now(ZoneInfo("Europe/Moscow"))
            is_ended = (ev["status"] == "ended") or (
                ev["effective_end_at"] is not None and ev["effective_end_at"] < now_msk
            )

            if not part["is_registered"]:
                kind = "register_cta"
            elif is_ended:
                kind = "next_event_cta" if successor_ev else "ecosystem_thanks"
            else:
                kind = "referral_reminder"

            # Дедуп: молчим только если ровно это же событие подряд с тем же kind,
            # и за это время человек не открывал других событий и не получал рассылок.
            if part["last_open_msg_kind"] == kind and part["last_open_msg_at"]:
                opened_other = await conn.fetchval(
                    """SELECT 1 FROM event_participants
                        WHERE contact_id = $1
                          AND id <> $2
                          AND last_open_msg_at IS NOT NULL
                          AND last_open_msg_at > $3
                        LIMIT 1""",
                    contact_id, part["id"], part["last_open_msg_at"],
                )
                had_broadcast = await conn.fetchval(
                    """SELECT 1 FROM broadcast_log bl
                         JOIN platform_users pu ON pu.id = bl.platform_user_id
                        WHERE pu.contact_id = $1 AND pu.platform_slug = 'telegram'
                          AND bl.sent_at > $2 AND bl.status = 'sent'
                        LIMIT 1""",
                    contact_id, part["last_open_msg_at"],
                )
                if not opened_other and not had_broadcast:
                    return {"ok": True, "deduped": True, "kind": kind}

            bot_token = await get_client_telegram_token(client_id, conn)
            bot_handle = await conn.fetchval(
                """SELECT REGEXP_REPLACE(handle, '^@', '')
                     FROM channels
                    WHERE client_id=$1 AND platform_slug='telegram'
                      AND is_active=true AND bot_token IS NOT NULL
                    LIMIT 1""",
                client_id,
            )
    except Exception as e:
        logger.warning(f"event_welcome prep failed tg_id={tg_id} slug={event_slug}: {e}")
        return {"ok": True, "warning": "prep failed"}

    if not bot_token:
        bot_token = settings.telegram_bot_token
    if not bot_token:
        return {"ok": True, "warning": "no bot token configured"}

    bot_url_base = f"https://t.me/{bot_handle}" if bot_handle else "https://t.me/pluson_bot/pluson"
    name = display_name or "друг"
    ev_title = ev["title"] or "событие"

    is_conf = ev["module_slug"] == "conference"

    if kind == "register_cta":
        date_str = _fmt_event_period(ev["effective_start_at"], ev["effective_end_at"], is_conf)
        text = f"Привет, {name}! 👋\n\nДобро пожаловать на «{ev_title}» 🎉"
        if date_str:
            text += f"\n\n🗓 {date_str}"
        text += "\n\nДля регистрации нажмите на кнопку."
        btn_text = "Зарегистрироваться"
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}"
    elif kind == "referral_reminder":
        date_str = _fmt_event_period(ev["effective_start_at"], ev["effective_end_at"], is_conf)
        text = f"Привет, {name}! 👋\n\nВы записаны на «{ev_title}»."
        if date_str:
            text += f"\n\n🗓 {date_str}"
        text += "\n\nВы ещё успеваете получить подарки за приглашение друзей 🎁"
        btn_text = "Получить подарки"
        pid_part = f"_pid{ref_code}" if ref_code else ""
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}_tabgame{pid_part}"
    elif kind == "next_event_cta":
        succ_title = (successor_ev["title"] if successor_ev else "") or "следующее событие"
        succ_date = ""
        if successor_ev:
            succ_date = _fmt_event_period(
                successor_ev["effective_start_at"],
                successor_ev["effective_end_at"],
                successor_ev["module_slug"] == "conference",
            )
        text = (
            f"Привет, {name}! 👋\n\n"
            f"Событие «{ev_title}» завершилось — спасибо за ваш интерес!\n\n"
            f"Следующее: «{succ_title}»"
        )
        if succ_date:
            text += f" {succ_date}"
        text += " 🎯"
        btn_text = "Записаться на следующее"
        btn_url = f"{bot_url_base}?startapp=ref_pg{successor_ev['slug']}"
    else:  # ecosystem_thanks
        text = (
            f"Привет, {name}! 👋\n\n"
            f"Событие «{ev_title}» завершилось — спасибо за ваш интерес!\n\n"
            f"Пока ждём следующее — заходите в Экосистему организатора, "
            f"там полезные материалы."
        )
        btn_text = "Открыть Экосистему"
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}_tabecosystem"

    sent_ok = False
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={
                    "chat_id": tg_id,
                    "text": text,
                    "disable_web_page_preview": True,
                    "reply_markup": {
                        "inline_keyboard": [[{"text": btn_text, "url": btn_url}]]
                    },
                },
            )
            sent_ok = r.status_code == 200
            if not sent_ok:
                logger.warning(f"sendMessage {r.status_code} tg_id={tg_id} kind={kind}: {r.text[:200]}")
    except Exception as e:
        logger.warning(f"sendMessage failed tg_id={tg_id} kind={kind}: {e}")

    if sent_ok:
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE event_participants SET last_open_msg_kind=$1, last_open_msg_at=NOW() WHERE id=$2",
                    kind, part["id"],
                )
        except Exception as e:
            logger.warning(f"update last_open_msg failed for participant={part['id']}: {e}")

    return {"ok": True, "client_id": client_id, "kind": kind, "sent": sent_ok}
