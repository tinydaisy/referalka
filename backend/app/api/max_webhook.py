"""
Webhook от MAX Bot API.

URL: POST /api/v1/max/webhook/{secret}

`secret` — детерминированный хэш от токена (sha256(token)[:32]), чтобы не плодить
лишнюю переменную окружения. Любой запрос с неверным secret → 404.

В одном handler собраны update'ы для:
- bot_started — пользователь впервые открыл бота (с payload из startapp)
- message_created — текстовое сообщение (включая команды /start, /getchatid)
- message_callback — клик по inline-кнопке (для будущих воронок лид-магнитов)
- bot_stopped — пользователь остановил/заблокировал бота → глобальная отписка

Регистрация webhook — разово через max_api.set_webhook (см. scripts/setup_max_webhook.py).
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..config import settings
from ..database import get_pool
from ..services.contact_merge import upsert_contact_with_identity, resolve_ref_code
from ..services.max_api import send_message as max_send_message, tg_inline_to_max_keyboard
from ..services.max_auth import parse_startapp_ref_payload
from ..services.share_links import max_link as build_max_link
from ..services.event_welcome import _send_event_organizer_notification

logger = logging.getLogger(__name__)
router = APIRouter()


def webhook_secret_for_token(token: str) -> str:
    """Детерминированный secret для URL webhook'а. Меняется при ротации токена."""
    if not token:
        return ""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:32]


async def _resolve_token_by_secret(secret: str) -> tuple[str, int | None] | None:
    """Найти бот-токен и client_id по secret из URL.

    1) Сравниваем с системным токеном.
    2) Иначе ищем среди клиентских MAX-каналов (bot_token в channels).

    :return: (token, client_id) либо None.
    """
    sys_secret = webhook_secret_for_token(settings.max_system_bot_token)
    if sys_secret and secret == sys_secret:
        return settings.max_system_bot_token, None  # системный бот, client_id=None

    pool = await get_pool()
    if not pool:
        return None
    async with pool.acquire() as conn:
        # Перебираем все клиентские MAX-каналы — у каждого свой токен → свой secret
        rows = await conn.fetch(
            """SELECT ch.bot_token,
                      (SELECT client_id FROM client_channels cc
                        WHERE cc.channel_id = ch.id AND cc.is_active = TRUE LIMIT 1) AS client_id
                 FROM channels ch
                WHERE ch.platform_slug = 'max'
                  AND ch.is_system = FALSE
                  AND ch.bot_token IS NOT NULL
                  AND ch.bot_token <> ''"""
        )
        for r in rows:
            tok = r["bot_token"]
            if webhook_secret_for_token(tok) == secret:
                return tok, r["client_id"]
    return None


@router.post("/max/webhook/{secret}")
async def handle_max_update(secret: str, request: Request):
    """Принимает update от MAX Bot API.

    MAX шлёт JSON в теле, формат update'а — см. lever_agent.max_bot.handle_update.
    """
    resolved = await _resolve_token_by_secret(secret)
    if not resolved:
        logger.warning(f"MAX webhook: unknown secret prefix={secret[:8]}")
        raise HTTPException(status_code=404, detail="Not found")
    bot_token, client_id_override = resolved

    try:
        update = await request.json()
    except Exception as e:
        logger.warning(f"MAX webhook: invalid JSON: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON")

    update_type = update.get("update_type", "")
    logger.info(f"MAX update_type={update_type!r} keys={list(update.keys())[:8]}")

    if update_type == "bot_stopped":
        await _handle_bot_stopped(update, bot_token=bot_token, client_id_override=client_id_override)
        return {"ok": True}

    if update_type == "bot_started":
        await _handle_bot_started(update, bot_token=bot_token, client_id_override=client_id_override)
        return {"ok": True}

    if update_type == "message_created":
        await _handle_message_created(update, bot_token=bot_token, client_id_override=client_id_override)
        return {"ok": True}

    if update_type == "message_callback":
        # На MVP — просто логируем, обработчики воронок добавим в этапе 4.
        logger.info(f"MAX message_callback (not handled on MVP): {str(update)[:300]}")
        return {"ok": True}

    logger.info(f"MAX unknown update_type {update_type!r} ignored")
    return {"ok": True}


def _extract_user_and_chat(update: dict) -> tuple[dict, int | None, int | None]:
    """Из update достаём sender-объект, user_id и chat_id."""
    msg = update.get("message", {}) or {}
    sender = msg.get("sender") or update.get("user") or {}
    recipient = msg.get("recipient") or {}
    chat_id = recipient.get("chat_id") or update.get("chat_id")
    user_id = sender.get("user_id")
    return sender, user_id, chat_id


async def _handle_bot_stopped(update: dict, *, bot_token: str, client_id_override: int | None) -> None:
    user = update.get("user", {}) or {}
    uid = user.get("user_id")
    if not uid:
        return
    pool = await get_pool()
    if not pool:
        return
    async with pool.acquire() as conn:
        # Глобальная отписка пользователя по всем MAX-подпискам этого бота.
        await conn.execute(
            """UPDATE platform_user_channels puc
                  SET is_unsubscribed = TRUE,
                      unsubscribed_at = NOW()
                FROM platform_users pu, client_channels cc, channels ch
               WHERE puc.platform_user_id = pu.id
                 AND puc.client_channel_id = cc.id
                 AND cc.channel_id = ch.id
                 AND ch.platform_slug = 'max'
                 AND pu.platform_user_id = $1""",
            str(uid),
        )
    logger.info(f"MAX user {uid} blocked bot — marked unsubscribed")


async def _handle_bot_started(update: dict, *, bot_token: str, client_id_override: int | None) -> None:
    """Первый запуск бота: если payload — обрабатываем как /start <payload>."""
    sender = update.get("user", {}) or {}
    payload = update.get("payload", "") or ""
    chat_id = update.get("chat_id") or sender.get("user_id")
    user_id = sender.get("user_id")
    if not user_id or not chat_id:
        logger.warning(f"MAX bot_started without user/chat: {str(update)[:300]}")
        return
    await _process_start(
        user_id=user_id,
        chat_id=chat_id,
        sender=sender,
        payload=payload,
        bot_token=bot_token,
        client_id_override=client_id_override,
    )


async def _handle_message_created(update: dict, *, bot_token: str, client_id_override: int | None) -> None:
    msg = update.get("message", {}) or {}
    body = msg.get("body", {}) or {}
    text = (body.get("text") or "").strip()
    sender, user_id, chat_id = _extract_user_and_chat(update)
    if not user_id or not chat_id:
        return
    low = text.lower()

    if low.startswith("/getchatid"):
        await max_send_message(
            chat_id,
            f"user_id: {user_id}\nchat_id: {chat_id}\n\n"
            "Чтобы получать уведомления о новых интересах — добавьте бота админом "
            "в ваш служебный канал и перешлите сюда любое сообщение из него.",
            token=bot_token,
        )
        return

    if low.startswith("/start"):
        payload = text[len("/start"):].strip()
        await _process_start(
            user_id=user_id,
            chat_id=chat_id,
            sender=sender,
            payload=payload,
            bot_token=bot_token,
            client_id_override=client_id_override,
        )
        return

    # Любое другое сообщение — лёгкий ответ-эхо чтобы не молчать
    await max_send_message(
        chat_id,
        "Привет! Это бот iViSiON: ПЛЮСОН. Откройте мини-приложение по кнопке ниже, "
        "чтобы попасть в свой кабинет — там события, рейтинги и подарки.",
        token=bot_token,
        buttons=tg_inline_to_max_keyboard([[
            {"text": "Открыть приложение", "url": f"https://max.ru/{settings.max_system_bot_username}"},
        ]]),
    )


async def _process_start(
    *,
    user_id: int,
    chat_id: int,
    sender: dict,
    payload: str,
    bot_token: str,
    client_id_override: int | None,
) -> None:
    """Общий код для /start и bot_started. Регистрирует контакт и шлёт welcome."""
    name = sender.get("name", "") or ""
    first_name = name.split()[0] if name else "друг"
    last_name = " ".join(name.split()[1:]) if len(name.split()) > 1 else ""
    username = sender.get("username", "") or ""

    # Самообслуживание спикера (миграция 108): /start spkinv_<access_code>
    if payload and payload.startswith("spkinv_"):
        access_code = payload.removeprefix("spkinv_").strip()
        if access_code:
            try:
                pool0 = await get_pool()
                if pool0:
                    async with pool0.acquire() as conn0:
                        coll = await conn0.fetchrow(
                            """SELECT c.id AS collaborator_id, c.name, c.contact_id,
                                      c.created_by_client_id
                                 FROM collaborators c
                                WHERE LOWER(c.access_code) = LOWER($1)""",
                            access_code,
                        )
                        if not coll:
                            await max_send_message(
                                chat_id,
                                "😕 Ссылка устарела или код доступа изменился. Попросите организатора прислать актуальное сообщение.",
                                token=bot_token,
                            )
                            return

                        from app.api.collaborators import _upsert_personal_identity
                        foreign_owner = False
                        if coll["contact_id"] and coll["created_by_client_id"]:
                            try:
                                res = await _upsert_personal_identity(
                                    conn0,
                                    coll["created_by_client_id"], coll["contact_id"],
                                    'max', str(user_id), username or None,
                                )
                                if isinstance(res, dict) and res.get("status") == "foreign_owner":
                                    foreign_owner = True
                            except Exception as e:
                                logger.warning("MAX spkinv upsert identity failed: %s", e)

                        if foreign_owner:
                            sp_name = (coll["name"] or "").strip() or "спикер"
                            await max_send_message(
                                chat_id,
                                (
                                    f"⚠️ Вы зашли не с того аккаунта.\n\n"
                                    f"Эта ссылка выдана спикеру «{sp_name}». Ваш MAX-аккаунт уже привязан к другому контакту у этого клиента, "
                                    f"поэтому я не могу записать вас как спикера.\n\n"
                                    f"Попросите самого спикера открыть ссылку со своего личного MAX, либо передайте ссылку его ассистенту."
                                ),
                                token=bot_token,
                            )
                            return

                        ev = await conn0.fetchrow(
                            """SELECT e.slug, e.title
                                 FROM event_collaborators ec
                                 JOIN events e ON e.id = ec.event_id
                                WHERE ec.speaker_id = $1
                                ORDER BY ec.id DESC LIMIT 1""",
                            coll["collaborator_id"],
                        )
                        event_slug = ev["slug"] if ev else ""
                        event_title = ev["title"] if ev else "событие"
                        sp_name = (coll["name"] or "").strip() or "спикер"
                        cabinet_url = f"https://pluson.ru/speaker/{event_slug}" if event_slug else "https://pluson.ru/speaker/"
                        await max_send_message(
                            chat_id,
                            (
                                f"Здравствуйте, {sp_name}!\n\n"
                                f"Вы — спикер «{event_title}». Чтобы заполнить свои данные, откройте свой кабинет:\n"
                                f"{cabinet_url}\n\n"
                                f"Код доступа: {access_code}\n\n"
                                "На странице выберите свою фамилию и введите этот код. "
                                "Сессия живёт 24 часа. Можно передать ссылку и код ассистенту."
                            ),
                            token=bot_token,
                        )
            except Exception as e:
                logger.exception(f"MAX spkinv handler failed: {e}")
            return

    # Парсим payload: ref_pg{slug}_pid{partner_id}_src{utm}_tab{tab}_reg
    parsed = parse_startapp_ref_payload(payload) if payload else {
        "event_slug": "", "partner_ref_code": "", "utm_source": "", "tab": "", "reg_from_landing": False,
    }
    event_slug = parsed["event_slug"]
    partner_ref_code = parsed["partner_ref_code"]
    utm_source = parsed["utm_source"]

    pool = await get_pool()
    if not pool:
        return
    async with pool.acquire() as conn:
        # Резолв client_id
        client_id = client_id_override or 0
        if not client_id and event_slug:
            row = await conn.fetchrow("SELECT client_id FROM events WHERE slug = $1", event_slug)
            if row:
                client_id = row["client_id"]
        if not client_id:
            row = await conn.fetchrow("SELECT id FROM clients WHERE email = $1", "system@pluson.ru")
            client_id = row["id"] if row else 0
        if not client_id:
            logger.warning(f"MAX /start: no client resolved (user_id={user_id})")
            return

        contact_id, _pu_id, is_new = await upsert_contact_with_identity(
            conn,
            client_id=client_id,
            platform_slug="max",
            platform_user_id=str(user_id),
            username=username or None,
            first_name=first_name or None,
            last_name=last_name or None,
            utm_source=utm_source or None,
        )

        # Реферер из startapp pid
        resolved_ref_code = None
        referrer_contact_id = None
        if partner_ref_code:
            resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                conn, partner_ref_code, client_id=client_id,
            )

        event_title = None
        if event_slug:
            ev = await conn.fetchrow(
                "SELECT id, title, status FROM events WHERE slug = $1 AND client_id = $2",
                event_slug, client_id,
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

    # Welcome — отправляем ВСЕГДА (новый юзер или нет)
    if event_slug and event_title:
        msg_text = (
            f"👋 Здравствуйте, {first_name}!\n\n"
            f"Вы открыли событие «{event_title}». Жмите кнопку ниже, чтобы войти в приложение — "
            f"там программа, друзья и подарки за приглашения."
        )
        link_to_app = build_max_link(event_slug, partner_id=partner_ref_code or None)
        buttons = tg_inline_to_max_keyboard([[
            {"text": f"Войти в «{event_title[:30]}»", "url": link_to_app},
        ]])
    else:
        msg_text = (
            f"👋 Здравствуйте, {first_name}!\n\n"
            "Добро пожаловать в iViSiON: ПЛЮСОН — платформу для организаторов и экспертов. "
            "Откройте мини-приложение, чтобы увидеть события и подарки."
        )
        buttons = tg_inline_to_max_keyboard([[
            {"text": "Открыть приложение", "url": f"https://max.ru/{settings.max_system_bot_username}"},
        ]])
    try:
        await max_send_message(chat_id, msg_text, token=bot_token, buttons=buttons)
    except Exception as e:
        logger.warning(f"MAX welcome failed for user={user_id}: {e}")
