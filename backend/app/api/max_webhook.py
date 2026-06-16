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


async def _max_image_attachment_from_url(image_url: str, bot_token: str) -> dict | None:
    """Скачать картинку по URL (афиша в R2) во временный файл и загрузить в MAX.

    MAX `upload_media` принимает только локальный файл (двухшаговая загрузка),
    а афиши хранятся как URL в R2 — поэтому качаем во временный файл, грузим,
    удаляем. Возвращает attachment-dict для send_message.attachments или None.
    """
    import os
    import tempfile
    import httpx
    from urllib.parse import urlparse
    from ..services.max_api import upload_media

    ext = os.path.splitext(urlparse(image_url).path)[1].lower() or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        ext = ".jpg"
    tmp_path = None
    try:
        async with httpx.AsyncClient(timeout=60.0) as cli:
            resp = await cli.get(image_url)
        if resp.status_code != 200 or not resp.content:
            logger.warning(f"MAX poster download failed status={resp.status_code} url={image_url}")
            return None
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tf:
            tf.write(resp.content)
            tmp_path = tf.name
        return await upload_media(tmp_path, token=bot_token, kind="image")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


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
        await _handle_message_callback(update, bot_token=bot_token, client_id_override=client_id_override)
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
    # Обрабатываем ТОЛЬКО личку с ботом (chat_type='dialog'). Сообщения из
    # групповых чатов/бесед (chat_type='chat') игнорируем полностью — бот не
    # должен ничего слать в чаты (никаких приветствий/welcome про платформу).
    recipient = msg.get("recipient") or {}
    chat_type = (recipient.get("chat_type") or "").strip().lower()
    if chat_type and chat_type != "dialog":
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

    if low.startswith("/getmyid"):
        await max_send_message(
            chat_id,
            f"Ваш MAX ID: {user_id}\n\n"
            "Вставьте это число в поле тестовых MAX-ID в Настройках → Технические, "
            "чтобы получать тестовые рассылки. Также используется для объединения "
            "аккаунтов (/merge) на других площадках.",
            token=bot_token,
        )
        return

    if low.startswith("/merge"):
        await _handle_max_merge(
            text=text, user_id=user_id, chat_id=chat_id,
            bot_token=bot_token, client_id_override=client_id_override,
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

    # Слово-открыватель события (как в ВК, без зависимости от регистра):
    # русское «ивент<id>» и английские «event<id>» / «menu<id>» → открыть
    # событие: не зареган → приглашение, зареган → меню кабинета. Резолвим slug
    # по id и делегируем _process_start с payload ref_pg{slug}.
    import re as _re
    m = _re.match(r"(?i)^\s*(?:ивент|event|menu)\s*(\d+)\s*$", text)
    if m:
        event_id = int(m.group(1))
        pool = await get_pool()
        async with pool.acquire() as db:
            slug = await db.fetchval(
                "SELECT slug FROM events WHERE id = $1 LIMIT 1", event_id
            )
        if not slug:
            await max_send_message(chat_id, "Событие не найдено. Проверьте номер.", token=bot_token)
            return
        await _process_start(
            user_id=user_id,
            chat_id=chat_id,
            sender=sender,
            payload=f"ref_pg{slug}",
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


def _extract_callback_payload_and_user(update: dict) -> tuple[str, int | None, int | None]:
    """Из update message_callback достаём payload кнопки, user_id и chat_id.

    Структура MAX message_callback (dev.max.ru):
      {
        "update_type": "message_callback",
        "callback": {"callback_id": "...", "payload": "...", "user": {...}},
        "message": {"recipient": {"chat_id": ...}, "sender": {...}}
      }
    Бот может прислать payload в `callback.payload` либо (на других версиях API)
    в `message_callback.payload` — проверяем оба, чтобы не зависеть от ревизии.
    chat_id берём из message.recipient (диалог), иначе из callback.user.user_id.
    """
    cb = update.get("callback") or update.get("message_callback") or {}
    payload = (cb.get("payload") or update.get("payload") or "").strip()
    cb_user = cb.get("user") or {}
    user_id = cb_user.get("user_id")

    msg = update.get("message", {}) or {}
    recipient = msg.get("recipient") or {}
    chat_id = recipient.get("chat_id") or update.get("chat_id")
    if not user_id:
        sender = msg.get("sender") or update.get("user") or {}
        user_id = sender.get("user_id")
    if not chat_id and user_id:
        chat_id = user_id  # приватный диалог: chat_id == user_id
    return payload, user_id, chat_id


async def _handle_message_callback(update: dict, *, bot_token: str, client_id_override: int | None) -> None:
    """Клик по inline-кнопке в MAX. Сейчас обрабатываем кнопку «Вступить в Чат»
    (payload `evchat_{event_id}`) из меню кабинета участника."""
    payload, user_id, chat_id = _extract_callback_payload_and_user(update)
    if not payload or not user_id or not chat_id:
        logger.info(f"MAX message_callback without payload/user/chat: {str(update)[:300]}")
        return

    if payload.startswith("evchat_"):
        try:
            event_id = int(payload.removeprefix("evchat_"))
        except ValueError:
            logger.warning(f"MAX evchat callback bad payload: {payload!r}")
            return
        pool = await get_pool()
        if not pool:
            return
        async with pool.acquire() as conn:
            # Резолвим contact_id участника по MAX user_id.
            contact_id = await conn.fetchval(
                """SELECT ep.contact_id
                     FROM event_participants ep
                     JOIN platform_users pu
                       ON pu.contact_id = ep.contact_id
                      AND pu.platform_slug = 'max'
                      AND pu.platform_user_id = $2
                    WHERE ep.event_id = $1
                    LIMIT 1""",
                event_id, str(user_id),
            )
            try:
                await _handle_max_chat_join(chat_id, event_id, contact_id, bot_token, conn)
            except Exception as e:
                logger.warning(f"MAX chat join failed (event={event_id}, user={user_id}): {e}")
        return

    if payload.startswith("evmenu_"):
        try:
            event_id = int(payload.removeprefix("evmenu_"))
        except ValueError:
            logger.warning(f"MAX evmenu callback bad payload: {payload!r}")
            return
        pool = await get_pool()
        if not pool:
            return
        async with pool.acquire() as conn:
            contact_id = await conn.fetchval(
                """SELECT ep.contact_id
                     FROM event_participants ep
                     JOIN platform_users pu
                       ON pu.contact_id = ep.contact_id
                      AND pu.platform_slug = 'max'
                      AND pu.platform_user_id = $2
                    WHERE ep.event_id = $1
                    LIMIT 1""",
                event_id, str(user_id),
            )
            try:
                await _send_max_event_menu(chat_id, event_id, contact_id, bot_token, conn)
            except Exception as e:
                logger.warning(f"MAX evmenu failed (event={event_id}, user={user_id}): {e}")
        return

    logger.info(f"MAX message_callback unknown payload={payload!r}")


_MERGE_USAGE_MAX = (
    "Объединение аккаунтов\n\n"
    "Если вы заходили к этому организатору и в MAX, и в Telegram, и в ВКонтакте — "
    "можно слить всё в один профиль (рефералы, регистрации и подарки сложатся вместе).\n\n"
    "1. Узнайте свой ID на другой площадке командой /getmyid в её боте.\n"
    "2. Пришлите сюда:\n"
    "/merge tg ВАШ_TG_ID\n"
    "/merge vk ВАШ_VK_ID\n"
    "/merge max ВАШ_MAX_ID\n\n"
    "Например: /merge tg 12345678"
)


async def _handle_max_merge(
    *, text: str, user_id: int, chat_id: int,
    bot_token: str, client_id_override: int | None,
) -> None:
    """Объединить MAX-аккаунт человека с его аккаунтом на другой площадке.
    Главный контакт — самый ранний, реферер на событие — непустой/от раннего."""
    from app.services.contact_merge import (
        merge_my_account_with_identity, find_contact_by_identity,
    )

    parts = text.strip().split()
    if len(parts) < 3:
        await max_send_message(chat_id, _MERGE_USAGE_MAX, token=bot_token)
        return
    aliases = {"telegram": "telegram", "tg": "telegram", "vk": "vk",
               "вк": "vk", "max": "max", "макс": "max", "мах": "max"}
    other_platform = aliases.get(parts[1].lower())
    other_id_raw = parts[2].lstrip("@").strip()
    if other_platform not in ("telegram", "vk", "max") or not other_id_raw.isdigit():
        await max_send_message(chat_id, _MERGE_USAGE_MAX, token=bot_token)
        return
    if other_platform == "max" and other_id_raw == str(user_id):
        await max_send_message(chat_id, "Это ваш текущий MAX-аккаунт — объединять не с чем.", token=bot_token)
        return

    pool = await get_pool()
    async with pool.acquire() as conn:
        client_id = client_id_override or 0
        if not client_id:
            client_id = await conn.fetchval(
                "SELECT id FROM clients WHERE email = 'system@pluson.ru' LIMIT 1"
            ) or 0
        if not client_id:
            await max_send_message(chat_id, "😕 Не удалось определить организатора.", token=bot_token)
            return

        current_contact_id = await find_contact_by_identity(
            conn, client_id=client_id, platform_slug="max",
            platform_user_id=str(user_id),
        )
        if not current_contact_id:
            await max_send_message(
                chat_id,
                "Сначала зайдите в любое событие этого организатора, "
                "чтобы создать профиль, потом повторите объединение.",
                token=bot_token,
            )
            return

        res = await merge_my_account_with_identity(
            conn, client_id=client_id, current_contact_id=current_contact_id,
            other_platform_slug=other_platform, other_platform_user_id=other_id_raw,
        )

    if res["status"] == "not_found":
        plat_name = {"telegram": "Telegram", "vk": "ВКонтакте", "max": "MAX"}[other_platform]
        await max_send_message(
            chat_id,
            f"😕 Не нашёл аккаунт {plat_name} с ID {other_id_raw} у этого организатора.\n\n"
            "Проверьте ID (узнайте его командой /getmyid в нужном боте) "
            "и заходили ли вы к этому организатору с той площадки.",
            token=bot_token,
        )
    elif res["status"] == "already":
        await max_send_message(chat_id, "✅ Эти аккаунты уже объединены — ничего делать не нужно.", token=bot_token)
    else:
        await max_send_message(
            chat_id,
            "✅ Готово! Аккаунты объединены в один профиль. "
            "Рефералы, регистрации и подарки теперь общие.",
            token=bot_token,
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

    # Deeplink-слово в start-параметре: `?start=menu24`/`event24`/`ивент24`
    # (max.ru/{bot}?start=menu24). Резолвим slug по id события и подменяем payload
    # на ref_pg{slug} — дальше штатная ветка решит регистрация/меню.
    import re as _re_max
    _ev_m = _re_max.match(r"(?i)^(?:ивент|event|menu)\s*(\d+)$", (payload or "").strip())
    if _ev_m:
        _ev_pool = await get_pool()
        if _ev_pool:
            async with _ev_pool.acquire() as _db:
                _slug = await _db.fetchval(
                    "SELECT slug FROM events WHERE id = $1 LIMIT 1", int(_ev_m.group(1))
                )
            if _slug:
                payload = f"ref_pg{_slug}"
            else:
                await max_send_message(chat_id, "Событие не найдено. Проверьте номер.", token=bot_token)
                return

    # Самообслуживание спикера (миграция 108): /start spkinv_<access_code>
    if payload and payload.startswith("spkinv_"):
        access_code = payload.removeprefix("spkinv_").strip()
        # Опциональный суффикс `_e<event_id>` — жёсткая привязка к событию,
        # чтобы кабинет не открывался на «последнем по ec.id» (копии-черновике).
        invite_event_id = None
        if "_e" in access_code:
            base, _, ev_part = access_code.rpartition("_e")
            if ev_part.isdigit():
                access_code = base.strip()
                invite_event_id = int(ev_part)
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

                        ev = None
                        if invite_event_id:
                            ev = await conn0.fetchrow(
                                """SELECT e.slug, e.title
                                     FROM event_collaborators ec
                                     JOIN events e ON e.id = ec.event_id
                                    WHERE ec.speaker_id = $1 AND ec.event_id = $2
                                    LIMIT 1""",
                                coll["collaborator_id"], invite_event_id,
                            )
                        if not ev:
                            ev = await conn0.fetchrow(
                                """SELECT e.slug, e.title
                                     FROM event_collaborators ec
                                     JOIN events e ON e.id = ec.event_id
                                    WHERE ec.speaker_id = $1
                                    ORDER BY CASE e.status
                                               WHEN 'published' THEN 0
                                               WHEN 'ended'     THEN 1
                                               ELSE 2
                                             END, ec.id DESC
                                    LIMIT 1""",
                                coll["collaborator_id"],
                            )
                        event_slug = ev["slug"] if ev else ""
                        event_title = ev["title"] if ev else "событие"
                        sp_name = (coll["name"] or "").strip() or "спикер"
                        cabinet_url = f"https://pluson.ru/speaker/{event_slug}" if event_slug else "https://pluson.ru/speaker/"
                        spk_buttons = None
                        if event_slug:
                            spk_buttons = tg_inline_to_max_keyboard([[
                                {"text": "📝 Открыть мой кабинет", "url": cabinet_url},
                            ]])
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
                            buttons=spk_buttons,
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
    known_contact_id = parsed.get("known_contact_id")

    pool = await get_pool()
    if not pool:
        return
    async with pool.acquire() as conn:
        # Резолв client_id
        client_id = client_id_override or 0
        if not client_id and event_slug:
            row = await conn.fetchrow("SELECT (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE slug = $1", event_slug)
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
            known_contact_id=known_contact_id,
        )

        # Подписка на главный MAX-канал клиента — без этого человек не попадает
        # в platform_user_channels → не считается подписчиком и не получает
        # рассылки (зеркало register_telegram_subscription для TG / VK-флоу).
        try:
            from app.services.channels import register_platform_channel_subscription
            await register_platform_channel_subscription(client_id, "max", _pu_id, conn)
        except Exception as e:
            logger.warning(f"MAX register channel subscription failed (pu={_pu_id}): {e}")

        # Реферер из startapp pid
        resolved_ref_code = None
        referrer_contact_id = None
        if partner_ref_code:
            resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                conn, partner_ref_code, client_id=client_id,
            )

        event_title = None
        event_id = None
        event_status = None
        event_landing_url = ""
        is_registered = False
        event_poster_url = ""
        if event_slug:
            ev = await conn.fetchrow(
                """SELECT id, title, status, landing_url,
                          (SELECT url FROM event_posters
                             WHERE event_id = events.id
                             ORDER BY CASE orientation
                                        WHEN 'square'     THEN 1
                                        WHEN 'horizontal' THEN 2
                                        WHEN 'vertical'   THEN 3
                                        ELSE 4
                                      END, sort, id
                             LIMIT 1) AS poster_url
                     FROM events
                    WHERE slug = $1
                      AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')""",
                event_slug, client_id,
            )
            if ev:
                event_title = ev["title"]
                event_id = ev["id"]
                event_status = ev["status"]
                event_landing_url = (ev["landing_url"] or "").strip()
                event_poster_url = (ev["poster_url"] or "").strip()
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
                # Статус регистрации участника (только что вставленный → FALSE).
                is_registered = bool(await conn.fetchval(
                    "SELECT is_registered FROM event_participants WHERE event_id = $1 AND contact_id = $2",
                    ev["id"], contact_id,
                ))

        # ── Событие найдено → меню воронки (как в TG-боте) ──────────────────
        if event_id and event_title:
            work_tg = await conn.fetchval(
                "SELECT work_tg_username FROM clients WHERE id = $1", client_id
            ) or ""
            if is_registered:
                # Зарегистрирован → меню кабинета.
                try:
                    await _send_max_event_menu(
                        chat_id, event_id, contact_id, bot_token, conn,
                    )
                except Exception as e:
                    logger.warning(f"MAX event menu failed for user={user_id}: {e}")
                return
            # НЕ зарегистрирован → 1 кнопка «ЗАРЕГИСТРИРОВАТЬСЯ» + афиша (как в TG).
            # Веб-ссылка: сторонний лендинг (если задан и опубликован) с ПОЛНЫМ
            # набором параметров (pluson_contact_id, pluson_participant_id, pid,
            # utm, external_ref_param рефовода, поля контакта) — иначе встроенный
            # веб pluson.ru/event/{slug}/register?c={contact_id}.
            # participant_id ОБЯЗАТЕЛЕН: GetCourse/Tilda присылают его обратно в
            # webhook getcourse/register — без него регистрация на лендинге не
            # привязывается к участию (is_registered не проставляется).
            internal_web = (
                f"https://pluson.ru/event/{event_slug}/register?c={contact_id}"
                if contact_id else f"https://pluson.ru/event/{event_slug}/register"
            )
            if event_landing_url and event_status == "published":
                from app.services.external_landing import (
                    build_external_landing_url,
                    get_contact_landing_params,
                    resolve_referrer_external_ref_param,
                )
                participant_id = await conn.fetchval(
                    "SELECT id FROM event_participants WHERE event_id = $1 AND contact_id = $2 LIMIT 1",
                    event_id, contact_id,
                ) if contact_id else None
                contact_params = await get_contact_landing_params(conn, contact_id) if contact_id else {}
                erp = await resolve_referrer_external_ref_param(
                    conn, client_id, pid=partner_ref_code or None, contact_id=contact_id,
                )
                web_url = build_external_landing_url(
                    event_landing_url,
                    event_slug=event_slug,
                    contact_id=contact_id,
                    participant_id=participant_id,
                    pid=partner_ref_code or None,
                    utm_source=utm_source or None,
                    external_ref_param=erp,
                    flags=parsed.get("flags"),
                    **contact_params,
                )
            else:
                web_url = internal_web
            support_footer = (
                f"\n\nЕсть вопросы по регистрации? Напишите: https://t.me/{work_tg.lstrip('@')}"
                if work_tg else ""
            )
            msg_text = (
                "Добрейшего-богатейшего! 🤝\n\n"
                "Здесь вы можете зарегистрироваться на наше событие:\n"
                f"{event_title}\n\n"
                "Нажмите на кнопку ниже."
                f"{support_footer}"
            )
            buttons = tg_inline_to_max_keyboard([
                [{"text": "ЗАРЕГИСТРИРОВАТЬСЯ", "url": web_url}],
            ])
            # Афиша события — грузим в MAX и шлём вложением (как фото с подписью в TG).
            attachments = None
            logger.info(f"MAX welcome poster diag: event_poster_url={event_poster_url!r}")
            if event_poster_url:
                try:
                    att = await _max_image_attachment_from_url(event_poster_url, bot_token)
                    logger.info(f"MAX welcome poster diag: attachment_built={bool(att)}")
                    if att:
                        attachments = [att]
                except Exception as e:
                    logger.warning(f"MAX poster attach failed ({event_poster_url}): {e}")
            try:
                await max_send_message(
                    chat_id, msg_text, token=bot_token,
                    buttons=buttons, attachments=attachments,
                )
            except Exception as e:
                logger.warning(f"MAX welcome failed for user={user_id}: {e}")
            return

    # ── Событие не задано → НИЧЕГО не шлём. Общее welcome про «платформу ПЛЮСОН»
    #    отключено по требованию: бот не должен слать рекламно-платформенные
    #    сообщения. Реагируем только на конкретное событие/команду.
    return


async def _send_max_event_menu(
    chat_id: int,
    event_id: int,
    contact_id: int | None,
    bot_token: str,
    conn,
) -> None:
    """Меню кабинета зарегистрированного участника события в MAX.

    Зеркало `send_event_menu` из TG-бота (backend/bot/handlers/start.py).
    Кнопки (по одной в ряд):
      • «Выбрать формат участия» — url=vip_url, только если задан;
      • «Вступить в Чат» — callback evchat_{event_id}, только если есть чат;
      • «Программа и Спикеры» / «Программа» — внутренний веб с якорем #program;
      • «Кабинет и подарки» — внутренний веб события.
    """
    ev = await conn.fetchrow(
        """SELECT id, slug, title, module_slug,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id,
                  vip_url, vip_button_label,
                  chat_url_tg, chat_url_vk, chat_url_max
             FROM events WHERE id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return

    slug = ev["slug"]
    title = ev["title"] or ""
    cid_q = f"?c={contact_id}" if contact_id else ""

    text = (
        "Вы зарегистрированы на событие:\n"
        f"{title}\n\n"
        "Это ваше меню — открывайте кабинет, чат и программу по кнопкам ниже."
    )

    tg_rows: list[list[dict]] = []

    # 1. Выбрать формат участия (VIP) — только если задан vip_url.
    vip_url = (ev["vip_url"] or "").strip()
    if vip_url:
        vip_target = vip_url
        try:
            from app.services.external_landing import (
                get_contact_landing_params,
                resolve_referrer_external_ref_param,
                enrich_external_url,
            )
            contact_params = (
                await get_contact_landing_params(conn, contact_id) if contact_id else {}
            )
            erp = await resolve_referrer_external_ref_param(
                conn, ev["client_id"], contact_id=contact_id,
            )
            vip_target = enrich_external_url(
                vip_url,
                pluson_contact_id=contact_id,
                event_slug=slug,
                external_ref_param=erp,
                **contact_params,
            )
        except Exception as e:
            logger.warning(f"MAX vip enrich failed (event={event_id}): {e}")
            vip_target = vip_url
        vip_label = (ev["vip_button_label"] or "").strip() or "Выбрать формат участия"
        tg_rows.append([{"text": vip_label, "url": vip_target}])

    # 2. Вступить в Чат — только если есть хоть одна chat-ссылка.
    has_chat = bool((ev["chat_url_tg"] or "").strip()
                    or (ev["chat_url_vk"] or "").strip()
                    or (ev["chat_url_max"] or "").strip())
    if has_chat:
        tg_rows.append([{"text": "Вступить в Чат", "callback_data": f"evchat_{event_id}"}])

    # 3. Программа (и спикеры для конференций/турниров).
    prog_label = ("Программа и Спикеры"
                  if ev["module_slug"] in ("conference", "turnir")
                  else "Программа")
    tg_rows.append([{"text": prog_label,
                     "url": f"https://pluson.ru/event/{slug}{cid_q}#program"}])

    # 4. Кабинет и подарки.
    tg_rows.append([{"text": "Кабинет и подарки",
                     "url": f"https://pluson.ru/event/{slug}{cid_q}"}])

    await max_send_message(
        chat_id, text, token=bot_token,
        buttons=tg_inline_to_max_keyboard(tg_rows),
    )


async def _handle_max_chat_join(
    chat_id: int,
    event_id: int,
    contact_id: int | None,
    bot_token: str,
    conn,
) -> None:
    """«Вступить в Чат» в MAX — зеркало `handle_event_chat_join` из TG.

    Проверка подписки на MAX-каналы коллабов = ЗАГЛУШКА: MAX Bot API пока не
    умеет getChatMember, поэтому считаем что подписан ВСЕГДА и сразу выдаём
    ссылки на чаты.

    TODO: реальная проверка подписки MAX, когда у MAX появится API проверки
    участия в канале. Тогда здесь, по аналогии с TG (_gather_event_chat_channels
    + collaborators.max_url + subscription_mode / require_subscription), собрать
    каналы по ролям и проверять подписку.
    """
    ev = await conn.fetchrow(
        """SELECT id, chat_url_tg, chat_url_vk, chat_url_max, primary_chat_platform
             FROM events WHERE id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return

    tg = (ev["chat_url_tg"] or "").strip()
    vk = (ev["chat_url_vk"] or "").strip()
    mx = (ev["chat_url_max"] or "").strip()
    primary = (ev["primary_chat_platform"] or "telegram").strip()

    # (platform_key, подпись_строки, текст_кнопки, url)
    items = [
        ("telegram", "Телеграм", "Чат в Телеграм", tg),
        ("vk", "ВК", "Чат в ВК", vk),
        ("max", "Мах", "Чат в МАХ", mx),
    ]
    items = [it for it in items if it[3]]
    if not items:
        await max_send_message(
            chat_id,
            "У этого события пока не указаны чаты. Загляните позже или напишите организатору.",
            token=bot_token,
        )
        return
    # Главный — первым.
    items.sort(key=lambda it: 0 if it[0] == primary else 1)

    lines = [
        "Это чаты события:",
        'Добавьтесь во все и НАПИШИТЕ в чаты "Я С ВАМИ" и о себе, чтобы не потеряться!',
        "",
    ]
    # Ссылки на чаты — ТОЛЬКО текстом, БЕЗ кнопок-площадок. MAX строго валидирует
    # url в кнопках и давится на vk.me/join/...//...= ("Must have only http/https
    # links format in buttons") → всё сообщение не доходит. В тексте ссылки
    # кликабельны. Единственная кнопка — вернуться в меню кабинета.
    for idx, (pkey, label, btn, url) in enumerate(items):
        main_mark = " (главный чат)" if idx == 0 else ""
        lines.append(f"{label}: {url}{main_mark}")

    back_btn = tg_inline_to_max_keyboard([[{"text": "Меню", "callback_data": f"evmenu_{event_id}"}]])
    await max_send_message(
        chat_id, "\n".join(lines), token=bot_token, buttons=back_btn,
    )
