"""
POST /api/v1/max/event — аналог /api/v1/event и /api/v1/vk/event для MAX Mini App.

Принимает launch params от MAX Bridge (window.WebApp.initData / initDataUnsafe).
Валидирует подпись (если есть), делает upsert contact + platform_users,
шлёт контекстное приветствие в личку пользователя от системного либо клиентского
MAX-бота.

В MAX Mini App SDK (`https://st.max.ru/js/max-web-app.js`) глобальный объект
`window.WebApp` повторяет API Telegram WebApp:
  - initData (raw query-string, может быть подписана ботом)
  - initDataUnsafe.user.{user_id, first_name, last_name, username}
  - initDataUnsafe.start_param  (содержимое ?startapp=...)
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..database import get_pool
from ..services.contact_merge import upsert_contact_with_identity, resolve_ref_code
from ..services.max_auth import validate_max_launch_params, parse_startapp_ref_payload
from ..services.max_api import send_message as max_send_message, tg_inline_to_max_keyboard
from ..services.share_links import max_link as build_max_link
from ..services.event_welcome import _send_event_organizer_notification

logger = logging.getLogger(__name__)
router = APIRouter()


class MaxEventRequest(BaseModel):
    # raw initData строка от MAX Bridge (для проверки подписи)
    init_data: str = ""
    # Параметры пользователя из initDataUnsafe.user (фронт прокидывает явно)
    user_id: int = 0
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    # Параметры запуска (распарсенные фронтом из start_param или переданные напрямую)
    event_slug: str = ""
    client_id: int = 0
    partner_id: str = ""   # ref_code партнёра
    utm_source: str = ""
    initial_tab: str = ""
    contact_id: int = 0    # сквозной contact_id (из startapp ct<N>) — против дублей
    # Возврат с лендинга клиента (флаг _reg в startapp) — нужен для авто-регистрации
    reg_from_landing: bool = False


@router.post("/max/event")
async def handle_max_event(body: MaxEventRequest):
    """Сигнал от MAX Mini App при открытии. Регистрирует контакт, шлёт welcome."""
    # 1. Валидация launch params. На MVP это best-effort: подпись принимаем если
    #    совпала с HMAC от токена системного бота, но не блокируем запрос если
    #    не совпала (документации подписи MAX пока нет публично).
    validation = validate_max_launch_params(
        body.init_data,
        bot_token=settings.max_system_bot_token,
    )
    if not validation["signed"]:
        logger.info(
            f"MAX launch params unsigned (accepted on MVP): user_id={body.user_id} "
            f"init_data_len={len(body.init_data)}"
        )

    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id required")
    max_user_id = body.user_id

    pool = await get_pool()
    if not pool:
        return {"ok": True, "warning": "db not available", "max_user_id": max_user_id}

    async with pool.acquire() as conn:
        # Резолв client_id: 1) явный из тела 2) из event_slug 3) системный «ПЛЮСОН Сервис»
        client_id = body.client_id
        if not client_id and body.event_slug:
            row = await conn.fetchrow("SELECT (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE slug = $1", body.event_slug)
            if row:
                client_id = row["client_id"]
        if not client_id:
            row = await conn.fetchrow("SELECT id FROM clients WHERE email = $1", "system@pluson.ru")
            client_id = row["id"] if row else 0
        if not client_id:
            return {"ok": False, "error": "no_client_resolved"}

        contact_id, pu_id, is_new = await upsert_contact_with_identity(
            conn,
            client_id=client_id,
            platform_slug="max",
            platform_user_id=str(max_user_id),
            username=body.username or None,
            first_name=body.first_name or None,
            last_name=body.last_name or None,
            utm_source=body.utm_source or None,
            known_contact_id=body.contact_id or None,
        )

        # Подписка на главный MAX-канал клиента — без этого человек не попадает
        # в platform_user_channels → не считается подписчиком и не получает
        # рассылки (зеркало register_telegram_subscription для TG / VK-флоу).
        try:
            from app.services.channels import register_platform_channel_subscription
            await register_platform_channel_subscription(client_id, "max", pu_id, conn)
        except Exception as e:
            logger.warning(f"MAX event register channel subscription failed (pu={pu_id}): {e}")

        # Реферер из startapp pid
        resolved_ref_code = None
        referrer_contact_id = None
        if body.partner_id:
            resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                conn, body.partner_id, client_id=client_id,
            )

        # event_participants — только если есть event_slug
        event_title = None
        if body.event_slug:
            ev = await conn.fetchrow(
                "SELECT id, title, status FROM events WHERE slug = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
                body.event_slug, client_id,
            )
            if ev:
                event_title = ev["title"]
                referrer_participant_id = None
                if referrer_contact_id:
                    referrer_participant_id = await conn.fetchval(
                        """SELECT id FROM event_participants
                            WHERE contact_id = $1 AND event_id = $2 LIMIT 1""",
                        referrer_contact_id, ev["id"],
                    )
                inserted = await conn.fetchval(
                    """INSERT INTO event_participants
                          (event_id, contact_id, referrer_participant_id, referrer_ref_code)
                       VALUES ($1, $2, $3, $4)
                       ON CONFLICT (event_id, contact_id) DO NOTHING
                       RETURNING id""",
                    ev["id"], contact_id, referrer_participant_id, resolved_ref_code,
                )

                # Welcome: шлём от клиентского MAX-бота (если подключён), иначе от системного.
                client_max = await conn.fetchrow(
                    """SELECT ch.bot_token, ch.handle
                         FROM client_channels cc
                         JOIN channels ch ON ch.id = cc.channel_id
                        WHERE cc.client_id = $1
                          AND cc.is_active = TRUE
                          AND ch.platform_slug = 'max'
                          AND ch.is_system = FALSE
                        LIMIT 1""",
                    client_id,
                )
                client_token = client_max["bot_token"] if client_max else None
                client_bot_handle = client_max["handle"] if client_max else None
                token = client_token or settings.max_system_bot_token
                bot_handle = client_bot_handle or settings.max_system_bot_username

                try:
                    msg = (
                        f"👋 Здравствуйте, {body.first_name or 'друг'}!\n\n"
                        f"Вы открыли событие «{event_title}». Жмите кнопку ниже, чтобы вернуться "
                        f"в приложение — там программа, друзья и подарки за приглашения."
                    )
                    buttons = tg_inline_to_max_keyboard([[
                        {"text": f"Войти в «{event_title[:30]}»",
                         "url": build_max_link(body.event_slug, bot_handle=bot_handle)},
                    ]])
                    if token:
                        await max_send_message(max_user_id, msg, token=token, buttons=buttons, recipient_kind="user")
                except Exception as e:
                    logger.warning(f"MAX welcome message failed for max_id={max_user_id}: {e}")

                # Воронка догрева
                try:
                    from app.api.event_nurture import start_nurture_run_if_eligible
                    is_reg = await conn.fetchval(
                        "SELECT is_registered FROM event_participants WHERE event_id=$1 AND contact_id=$2",
                        ev["id"], contact_id,
                    )
                    await start_nurture_run_if_eligible(
                        conn, event_id=ev["id"], contact_id=contact_id,
                        is_registered=bool(is_reg),
                    )
                except Exception as e:
                    logger.warning(f"MAX event_nurture start failed: {e}")

                # Уведомление организатору
                if inserted and event_title:
                    try:
                        await _send_event_organizer_notification(
                            conn,
                            client_id=client_id,
                            event_id=ev["id"],
                            event_title=event_title,
                            contact_id=contact_id,
                            platform_slug="max",
                            referrer_contact_id=referrer_contact_id,
                            tg_id=None,
                        )
                    except Exception as e:
                        logger.warning(f"MAX organizer notification failed: {e}")

        existing = await conn.fetchrow(
            """SELECT COALESCE((SELECT pe.platform_user_id FROM platform_users pe
                                 WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                                 ORDER BY pe.id LIMIT 1), '') AS email,
                      COALESCE(c.phone_normalized, '') AS phone
                 FROM contacts c WHERE c.id = $1""",
            contact_id,
        )
        has_email = bool(existing and existing["email"])
        has_phone = bool(existing and existing["phone"])

    return {
        "ok": True,
        "max_user_id": max_user_id,
        "contact_id": contact_id,
        "client_id": client_id,
        "is_new_contact": is_new,
        "event_title": event_title,
        "has_email": has_email,
        "has_phone": has_phone,
        "signed": validation["signed"],
    }
