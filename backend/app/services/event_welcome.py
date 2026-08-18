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
from typing import Optional
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


async def _send_event_organizer_notification(
    conn,
    *,
    client_id: int,
    event_id: int,
    event_title: str,
    contact_id: int,
    platform_slug: str,
    referrer_contact_id: int | None,
    tg_id: str | None = None,
) -> None:
    """Уведомление в notifications_telegram_chat_id организатора о новом интересе на событие.
    Зеркало `funnel_service._send_organizer_notification` для лид-магнитов, формат тот же,
    но первая строка — «Событие: <title>». Всегда шлёт от @pluson_bot."""
    # Уведомление дублируется во все каналы клиента (TG+MAX+VK). Если ни один
    # не настроен — выходим.
    _ch = await conn.fetchrow(
        """SELECT notifications_telegram_chat_id, notifications_max_chat_id,
                  notifications_vk_peer_id FROM clients WHERE id = $1""",
        client_id,
    )
    if not _ch or not (
        _ch["notifications_telegram_chat_id"]
        or _ch["notifications_max_chat_id"]
        or _ch["notifications_vk_peer_id"]
    ):
        return

    contact = await conn.fetchrow(
        """SELECT c.name, c.utm_source,
                  pu.username, pu.platform_user_id
             FROM contacts c
        LEFT JOIN platform_users pu
               ON pu.contact_id = c.id AND pu.platform_slug = $2
            WHERE c.id = $1""",
        contact_id, platform_slug,
    )
    referrer = None
    referrer_role_label = "Участник"
    if referrer_contact_id:
        # Ник реферера ищем по ЛЮБОЙ его платформе (не по платформе пришедшего):
        # реферер мог быть заведён в TG, а пришедший прийти через VK — тогда
        # совпадения по platform_slug не будет и ник терялся. Берём первый ник.
        referrer = await conn.fetchrow(
            """SELECT c.name,
                      (SELECT pu.username FROM platform_users pu
                        WHERE pu.contact_id = c.id AND pu.username IS NOT NULL
                        ORDER BY pu.id LIMIT 1) AS username
                 FROM contacts c
                WHERE c.id = $1""",
            referrer_contact_id,
        )
        # Роль реферера В ЭТОМ событии: если он коллаборатор (organizer/jury/
        # speaker/headliner/partner) — берём его роль, иначе он обычный участник.
        ref_role = await conn.fetchval(
            """SELECT ec.role
                 FROM collaborators co
                 JOIN event_collaborators ec ON ec.speaker_id = co.id
                WHERE co.contact_id = $1 AND ec.event_id = $2
                LIMIT 1""",
            referrer_contact_id, event_id,
        )
        _ROLE_LABELS = {
            "organizer": "Организатор",
            "jury": "Жюри",
            "speaker": "Спикер",
            "headliner": "Спикер",
            "partner": "Партнёр",
        }
        referrer_role_label = _ROLE_LABELS.get((ref_role or "").lower(), "Участник")

    # Активный бот клиента — события и лид-магниты слушает именно он.
    from .channels import get_bot_handle_for_user
    bot_handle = None
    if tg_id and platform_slug == 'telegram':
        bot_handle = await get_bot_handle_for_user(client_id, tg_id, conn)

    when_str = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
    from .profile_links import nick_html, link_html
    c_username = contact['username'] if contact else None
    c_puid = contact['platform_user_id'] if contact else None
    came_nick = nick_html(platform_slug, user_id=c_puid, username=c_username)
    came_link = link_html(platform_slug, user_id=c_puid, username=c_username)
    parts = [
        "🆕 <b>Новый интерес</b>",
        "",
        f"<b>Событие:</b> {event_title or '—'}",
        f"<b>Бот:</b> {bot_handle or '—'}",
        f"<b>Когда:</b> {when_str}",
        "",
        "<b>Кто пришёл</b>",
        f"<b>Никнейм:</b> {came_nick}",
        f"<b>Имя:</b> {(contact['name'] if contact else None) or '—'}",
        f"<b>ID контакта:</b> #{contact_id}",
        f"<b>Платформа:</b> {'ВКонтакте' if platform_slug == 'vk' else ('MAX' if platform_slug == 'max' else 'Telegram')}",
        f"<b>ID в платформе:</b> {c_puid or '—'}",
    ]
    if came_link:
        parts.append(f"<b>Ссылка:</b> {came_link}")
    parts += [
        f"<b>Источник (utm_source):</b> {(contact['utm_source'] if contact else None) or '—'}",
        f"<b>Карточка:</b> {settings.frontend_url}/dashboard/clients?contact={contact_id}",
        "",
    ]
    if referrer_contact_id and referrer:
        # Ник реферера ищется по любой его платформе — у него нет platform_user_id
        # в контексте этого события, ссылку строим по username (если есть).
        ref_nick = nick_html(platform_slug, username=referrer['username'])
        ref_link = link_html(platform_slug, username=referrer['username'])
        parts.append("<b>Кто привёл</b>")
        parts.append(f"<b>Роль:</b> {referrer_role_label}")
        parts.append(f"<b>Никнейм:</b> {ref_nick}")
        parts.append(f"<b>Имя:</b> {referrer['name'] or '—'}")
        parts.append(f"<b>ID контакта:</b> #{referrer_contact_id}")
        if ref_link:
            parts.append(f"<b>Ссылка:</b> {ref_link}")
        parts.append(f"<b>Карточка:</b> {settings.frontend_url}/dashboard/clients?contact={referrer_contact_id}")
    else:
        parts.append("<b>Кто привёл:</b> —")

    text = "\n".join(parts)
    # Дублируем во ВСЕ каналы уведомлений клиента: TG + MAX + VK.
    from .channels import notify_organizer_all_channels
    res = await notify_organizer_all_channels(client_id, text, conn)
    if not any(res.values()):
        logger.warning(
            f"event organizer notify failed client={client_id} event={event_id}"
        )


async def send_event_binding_error_notification(
    conn,
    *,
    chat_id: str | int,
    title: str,
    details: dict,
) -> None:
    """Уведомление в TG-канал ошибок: что-то пошло не так при привязке человека к
    событию (например, VK Mini App открылся без slug → fallback на системного
    клиента, участие не создалось). Шлёт от @pluson_bot. `details` — пары
    «label → value», выводятся списком «что/как/с кем».
    """
    if not chat_id:
        return
    token = settings.telegram_bot_token
    if not token:
        return
    when_str = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
    parts = [f"⚠️ <b>ОШИБКА: {title}</b>", "", f"<b>Когда:</b> {when_str}", ""]
    for label, value in details.items():
        parts.append(f"<b>{label}:</b> {value if value not in (None, '') else '—'}")
    text = "\n".join(parts)
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
            )
            if r.status_code != 200:
                logger.warning(f"binding-error notify failed: {r.status_code} {r.text[:200]}")
    except Exception as e:
        logger.warning(f"binding-error notify error: {e}")


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


async def resolve_event_finish_state(conn, event_id: int) -> dict:
    """Завершилось ли событие и какое у клиента следующее предстоящее.

    Единая точка расчёта для всех мест, где нужно поведение «событие
    закончилось» (меню бота `/menu{id}`, приветствие при открытии события).
    Даты конференций/турниров берутся из программы (`conf_days`) и этапов
    (`conf_stages`) — так же, как в календаре Mini App; `events.start_at/end_at`
    для этих модулей игнорируются.

    Возвращает:
        {
          "is_ended": bool,            # событие уже прошло
          "title": str,                # название текущего события
          "start_at" / "end_at",       # эффективные даты текущего
          "is_conference": bool,
          "successor": dict | None,    # ближайшее предстоящее событие клиента
        }
    Событие не найдено → `{"is_ended": False, "successor": None, ...}`.
    """
    ev = await conn.fetchrow(
        """SELECT e.id, e.slug, e.title, e.status, e.module_slug,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = e.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id,
                  CASE WHEN e.module_slug IN ('conference','turnir') THEN LEAST(
                      (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                AT TIME ZONE 'Europe/Moscow'
                         FROM conf_days d
                        WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                        ORDER BY d.day_date ASC LIMIT 1),
                      (SELECT MIN(st.start_date::timestamp AT TIME ZONE 'Europe/Moscow')
                         FROM conf_stages st
                        WHERE st.event_id = e.id AND st.start_date IS NOT NULL)
                  ) ELSE e.start_at END AS effective_start_at,
                  CASE WHEN e.module_slug IN ('conference','turnir') THEN GREATEST(
                      (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                AT TIME ZONE 'Europe/Moscow'
                         FROM conf_days d
                        WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                        ORDER BY d.day_date DESC LIMIT 1),
                      (SELECT MAX((st.end_date + '23:59'::time) AT TIME ZONE 'Europe/Moscow')
                         FROM conf_stages st
                        WHERE st.event_id = e.id AND st.end_date IS NOT NULL)
                  ) ELSE e.end_at END AS effective_end_at
             FROM events e WHERE e.id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return {"is_ended": False, "title": "", "start_at": None, "end_at": None,
                "is_conference": False, "successor": None}

    now_msk = datetime.now(ZoneInfo("Europe/Moscow"))
    is_ended = (ev["status"] == "ended") or (
        ev["effective_end_at"] is not None and ev["effective_end_at"] < now_msk
    )

    successor = None
    if is_ended and ev["client_id"]:
        successor = await conn.fetchrow(
            """
            SELECT * FROM (
                SELECT e.id, e.slug, e.title, e.module_slug,
                       CASE WHEN e.module_slug IN ('conference','turnir') THEN LEAST(
                           (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                     AT TIME ZONE 'Europe/Moscow'
                              FROM conf_days d
                             WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                             ORDER BY d.day_date ASC LIMIT 1),
                           (SELECT MIN(st.start_date::timestamp AT TIME ZONE 'Europe/Moscow')
                              FROM conf_stages st
                             WHERE st.event_id = e.id AND st.start_date IS NOT NULL)
                       ) ELSE e.start_at END AS effective_start_at,
                       CASE WHEN e.module_slug IN ('conference','turnir') THEN GREATEST(
                           (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                     AT TIME ZONE 'Europe/Moscow'
                              FROM conf_days d
                             WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                             ORDER BY d.day_date DESC LIMIT 1),
                           (SELECT MAX((st.end_date + '23:59'::time) AT TIME ZONE 'Europe/Moscow')
                              FROM conf_stages st
                             WHERE st.event_id = e.id AND st.end_date IS NOT NULL)
                       ) ELSE e.end_at END AS effective_end_at
                  FROM events e
                 WHERE EXISTS(SELECT 1 FROM event_owners eo
                               WHERE eo.event_id = e.id AND eo.client_id = $1
                                 AND eo.status = 'accepted')
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

    return {
        "is_ended": is_ended,
        "title": ev["title"] or "",
        "start_at": ev["effective_start_at"],
        "end_at": ev["effective_end_at"],
        "is_conference": ev["module_slug"] in ("conference", "turnir"),
        "successor": dict(successor) if successor else None,
    }


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
    utm_source: str = "",
    known_contact_id: Optional[int] = None,
) -> dict:
    """Возвращает диагностический dict (для логов / API-ответов): {ok, kind, sent, deduped, ...}."""
    if not pool or not event_slug or not tg_id:
        return {"ok": True, "skipped": "preconditions"}

    try:
        async with pool.acquire() as conn:
            ev = await conn.fetchrow(
                """
                SELECT e.id, e.slug, e.title, e.module_slug, e.status,
                       (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id,
                       CASE WHEN e.module_slug IN ('conference','turnir') THEN
                         (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                  AT TIME ZONE 'Europe/Moscow'
                            FROM conf_days d
                           WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                           ORDER BY d.day_date ASC LIMIT 1)
                         ELSE e.start_at
                       END AS effective_start_at,
                       CASE WHEN e.module_slug IN ('conference','turnir') THEN
                         (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                  AT TIME ZONE 'Europe/Moscow'
                            FROM conf_days d
                           WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                           ORDER BY d.day_date DESC LIMIT 1)
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
            # ⚠️ В КОЛЛАБЕ базу определяет РЕФОВОД, а не порядок владельцев.
            # `client_id_hint` — клиент Mini App (из адреса `/c/{N}/tg/`), но он
            # приходит пустым, если организатор прописал Main Mini App в
            # @BotFather без номера (проверить это со стороны платформы нельзя —
            # Telegram такой настройки по API не отдаёт). Тогда без учёта
            # реф-кода человек уезжал к «первому владельцу»: пришёл по ссылке
            # одного организатора, а контакт, рассылки и привлечение доставались
            # другому (проверено на проде 2026-08-17, событие 92).
            # ⚠️ Площадочный id обязателен: если человек УЖЕ участник события,
            # база берётся из его участия — и повторный заход (кнопка в боте,
            # возврат, календарь) не заведёт ему второй контакт у другого
            # организатора. Без этого именно event_start создавал дубль через
            # 10 секунд после верного захода (прод, 2026-08-18).
            from app.services.external_landing import _collab_base_client
            client_id = await _collab_base_client(
                conn, event_id=event_id,
                client_id=client_id_hint or ev["client_id"],
                partner_id=partner_id or None,
                source_client_id=client_id_hint or None,
                platform_slug="telegram", platform_user_id=str(tg_id),
            )

            async with conn.transaction():
                contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                    conn,
                    client_id=client_id,
                    platform_slug='telegram',
                    platform_user_id=str(tg_id),
                    username=username or None,
                    first_name=first_name or None,
                    last_name=last_name or None,
                    utm_source=utm_source or None,
                    known_contact_id=known_contact_id,
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

            # Уведомление организатору — один раз, при первом «интересе» (новой записи).
            # Вне транзакции upsert, чтобы внешний HTTP в Telegram не блокировал коммит.
            if inserted is not None:
                await _send_event_organizer_notification(
                    conn,
                    client_id=client_id,
                    event_id=event_id,
                    event_title=ev["title"] or "",
                    contact_id=contact_id,
                    platform_slug='telegram',
                    referrer_contact_id=referrer_contact_id,
                    tg_id=str(tg_id),
                )

            # Регистрируем подписку на главный TG-канал клиента. Раз бот сейчас
            # реально шлёт человеку register_cta — значит он подписан (Mini App
            # может открываться минуя /start, тогда _record_subscription не
            # срабатывает, и в platform_user_channels пусто).
            try:
                from app.services.channels import (
                    get_client_telegram_channel_id,
                    register_telegram_subscription,
                )
                ch_id = await get_client_telegram_channel_id(client_id, conn)
                if ch_id:
                    await register_telegram_subscription(
                        client_id, ch_id, str(tg_id),
                        username=username or "",
                        first_name=first_name or "",
                        last_name=last_name or "",
                        db=conn,
                    )
            except Exception as e:
                logger.warning(
                    f"event_start register_telegram_subscription failed "
                    f"client={client_id} tg={tg_id}: {e}"
                )

            part = await conn.fetchrow(
                """SELECT id, is_registered, last_open_msg_kind, last_open_msg_at
                     FROM event_participants
                    WHERE event_id = $1 AND contact_id = $2""",
                event_id, contact_id,
            )
            if not part:
                return {"ok": True, "skipped": "no participant after upsert"}

            # Воронка догрева: запускаем если человек открыл и не зарегистрирован.
            # Если is_registered=true и есть активный run — функция его закроет.
            try:
                from app.api.event_nurture import start_nurture_run_if_eligible
                await start_nurture_run_if_eligible(
                    conn,
                    event_id=event_id,
                    contact_id=contact_id,
                    is_registered=bool(part["is_registered"]),
                )
            except Exception as e:
                logger.warning(f"event_nurture start failed for event={event_id} contact={contact_id}: {e}")

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
                           CASE WHEN e.module_slug IN ('conference','turnir') THEN
                             (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                      AT TIME ZONE 'Europe/Moscow'
                                FROM conf_days d WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                                ORDER BY d.day_date ASC LIMIT 1)
                             ELSE e.start_at
                           END AS effective_start_at,
                           CASE WHEN e.module_slug IN ('conference','turnir') THEN
                             (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                      AT TIME ZONE 'Europe/Moscow'
                                FROM conf_days d WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                                ORDER BY d.day_date DESC LIMIT 1)
                             ELSE e.end_at
                           END AS effective_end_at
                      FROM events e
                     WHERE EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=$1 AND eo.status='accepted')
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
                """SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                     FROM channels ch
                     JOIN client_channels cc ON cc.channel_id = ch.id
                    WHERE cc.client_id = $1
                      AND ch.platform_slug = 'telegram'
                      AND cc.is_active = TRUE
                      AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
                    ORDER BY ch.is_system ASC, ch.id ASC
                    LIMIT 1""",
                client_id,
            )
    except Exception as e:
        logger.warning(f"event_welcome prep failed tg_id={tg_id} slug={event_slug}: {e}")
        return {"ok": True, "warning": "prep failed"}

    # Системный @pluson_bot как fallback убран: приветствие при открытии события
    # шлёт только свой TG-бот клиента. Нет токена ИЛИ нет handle (ссылки кнопок
    # вести некуда) → приветствие не отправляем (graceful, без падения).
    if not bot_token or not bot_handle:
        return {"ok": True, "warning": "no client bot token/handle"}

    bot_url_base = f"https://telegram.me/{bot_handle}"
    name = display_name or "друг"
    ev_title = ev["title"] or "событие"

    is_conf = ev["module_slug"] == "conference"

    # Вторая кнопка-фолбэк: «Войти в кабинет» — открывает хаб бота.
    # ⚠️ Обязательно `?startapp=hub`: без startapp Telegram у VIP-бота
    # открывает обычный чат с ботом (не Mini App), потому что short-name
    # каждого клиента нам неизвестен. С `startapp=hub` Telegram
    # гарантированно запускает Mini App; App.tsx видит sp='hub'
    # → парсит как пустой start_param → рендерит Hub клиента по cid
    # из path (`/c/{N}/tg/`). Для общего @pluson_bot bot_url_base уже
    # содержит short-name (`/pluson`), но `?startapp=hub` не мешает.
    cabinet_btn = {"text": "Войти в кабинет", "url": f"{bot_url_base}?startapp=hub"}
    extra_buttons: list[list[dict]] = []

    if kind == "register_cta":
        text = f"Привет, {name}! 👋\n\nДобро пожаловать на «{ev_title}» 🎉"
        text += "\n\nДля регистрации нажмите на кнопку."
        btn_text = "Зарегистрироваться"
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}"
    elif kind == "referral_reminder":
        date_str = _fmt_event_period(ev["effective_start_at"], ev["effective_end_at"], is_conf)
        text = f"Привет, {name}! 👋\n\nВы записаны на «{ev_title}»."
        if date_str:
            text += f"\n\n🗓 {date_str}"
        btn_text = "Получить подарки"
        pid_part = f"_pid{ref_code}" if ref_code else ""
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}_tabgame{pid_part}"
        extra_buttons.append([cabinet_btn])
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
                        "inline_keyboard": [[{"text": btn_text, "url": btn_url}]] + extra_buttons
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
