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
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..config import settings
from ..database import get_pool
from ..services.contact_merge import upsert_contact_with_identity, resolve_ref_code
# ⚠️ Модуль целиком — часть кода зовёт `max_api.send_message(...)`; без этого
# импорта такие вызовы падали NameError (в ветке чёрного списка при /start
# заблокированный получал контент вместо заглушки).
from ..services import max_api
from ..services.max_api import send_message as max_send_message, tg_inline_to_max_keyboard
from ..services.max_auth import parse_startapp_ref_payload
from ..services.share_links import max_link as build_max_link
from ..services.client_domains import (
    client_public_link, client_public_url, platform_base_url, public_url_for,
)
from ..services.event_welcome import _send_event_organizer_notification
from ..services.webinar_service import day_stream_url

logger = logging.getLogger(__name__)
router = APIRouter()

_RU_MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
              "июля", "августа", "сентября", "октября", "ноября", "декабря"]


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

    Системный MAX-бот ПЛЮСОНа больше НЕ обслуживает клиентские флоу (системным
    остаётся только email) — его secret здесь не резолвится, webhook от него
    игнорируется. Резолвим ТОЛЬКО клиентские MAX-каналы (bot_token в channels).

    :return: (token, client_id) либо None.
    """
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
    # TEMP DEBUG: полный dump апдейта — чтобы выцепить chat_id каналов MAX.
    # Убрать после разовой задачи получения ID каналов.
    try:
        logger.info("MAX RAW UPDATE: %s", json.dumps(update, ensure_ascii=False)[:2000])
    except Exception:
        pass

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


def _is_getmyid_command(text: str | None) -> bool:
    """Команда /getmyid — узнать ID. Работает в личке, беседе и канале.
    Терпима к регистру, слэшу и хвосту (например '/getmyid@bot').
    """
    t = (text or "").strip().lower().lstrip("/")
    t = t.split("@", 1)[0].strip()
    parts = t.split()
    return bool(parts) and parts[0] == "getmyid"


def _extract_user_and_chat(update: dict) -> tuple[dict, int | None, int | None]:
    """Из update достаём sender-объект, user_id и chat_id."""
    msg = update.get("message", {}) or {}
    sender = msg.get("sender") or update.get("user") or {}
    recipient = msg.get("recipient") or {}
    chat_id = recipient.get("chat_id") or update.get("chat_id")
    user_id = sender.get("user_id")
    return sender, user_id, chat_id


async def _resolve_max_contact_id(conn, event_id: int, user_id) -> int | None:
    """contact_id участника MAX для события. Приоритет:
    1) участие в ЭТОМ событии по MAX-идентичности;
    2) fallback — любой контакт этого человека (MAX-идентичность) У КЛИЕНТА-
       владельца события. Нужно чтобы кнопка «Кабинет и подарки» подставляла
       ?c={contact_id} даже когда участия в событии ещё нет (иначе веб-кабинет
       показывает форму ввода email)."""
    cid = await conn.fetchval(
        """SELECT ep.contact_id FROM event_participants ep
             JOIN platform_users pu ON pu.contact_id = ep.contact_id
              AND pu.platform_slug='max' AND pu.platform_user_id = $2
            WHERE ep.event_id = $1 LIMIT 1""",
        event_id, str(user_id))
    if cid:
        return cid
    # fallback: контакт по MAX-идентичности у владельца события
    return await conn.fetchval(
        """SELECT pu.contact_id FROM platform_users pu
             JOIN contacts c ON c.id = pu.contact_id AND c.merged_into IS NULL
            WHERE pu.platform_slug='max' AND pu.platform_user_id = $1
              AND c.client_id = (SELECT eo.client_id FROM event_owners eo
                                   WHERE eo.event_id = $2 AND eo.status='accepted'
                                   ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
            LIMIT 1""",
        str(user_id), event_id)


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


def _max_attachment_info(body: dict) -> tuple[bool, str | None]:
    """Есть ли вложение в MAX-сообщении и какого рода (первое)."""
    atts = body.get("attachments") or []
    if not atts:
        return False, None
    kind = (atts[0] or {}).get("type")  # image | video | file | audio | ...
    norm = {"image": "photo", "file": "document"}.get(kind, kind)
    return True, norm


def _max_attachment_urls(body: dict) -> list[dict]:
    """MAX-вложения → [{kind, url}]. URL берём из payload вложения, если есть."""
    out: list[dict] = []
    for a in (body.get("attachments") or []):
        t = (a or {}).get("type")
        p = (a or {}).get("payload") or {}
        out.append({"kind": {"image": "photo", "file": "document"}.get(t, t), "url": p.get("url")})
    return out


async def _archive_max_chat_message(
    msg: dict, body: dict, text: str, chat_id: str, user_id: str,
    *, bot_token: str, client_id_override: int | None,
) -> None:
    """Слушалка чатов: архивирует сообщение MAX-беседы события (для подсчёта заданий).

    ⚠️ Отдельно от логики лички — ничего не отвечает, только пишет в
    event_chat_messages, если беседа привязана к событию (по events.max_chat_id).
    Команда /getmyid обрабатывается ВЫШЕ по стеку (до этой слушалки), здесь её нет.
    """
    from app.services.chat_archive import archive_chat_message, remember_known_chat

    # Слушалка НЕМАЯ — только архивирует.
    has_att, att_kind = _max_attachment_info(body)
    sender = msg.get("sender") or {}
    author_name = sender.get("name") or None
    username = sender.get("username") or None
    mid = (body.get("mid") or msg.get("seq") or "")

    written = await archive_chat_message(
        platform="max",
        chat_id=chat_id,
        platform_user_id=user_id,
        username=username,
        author_name=author_name,
        text=text or None,
        has_attachment=has_att,
        attachment_kind=att_kind,
        message_ref=str(mid) if mid else None,
        sent_at=None,
    )
    if not written:
        return
    await remember_known_chat(
        platform="max", chat_id=chat_id, title=None,
        bot_id=None, client_id=client_id_override, can_read=True,
    )

    # ── Контроль заданий: ловим кодовые фразы критериев.
    from app.services.chat_archive import process_task_submissions
    try:
        submissions = await process_task_submissions(
            platform="max",
            chat_id=chat_id,
            platform_user_id=user_id,
            username=username,
            author_name=author_name,
            text=text or None,
            attachments=_max_attachment_urls(body),
            message_ref=str(mid) if mid else None,
            sent_at=None,
        )
        if submissions:
            from app.services.chat_archive import build_submission_reply_text
            m = build_submission_reply_text(submissions[0], html=False)
            if m:
                await max_send_message(chat_id, m, token=bot_token)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"MAX task submissions failed: {e}")

    # ── Приветствие в чатах: кодовое слово → ОТВЕТ случайной фразой (reply),
    # через случайную задержку 30..180 сек (естественнее). Фоном — вебхук не
    # должен висеть всё время задержки.
    from app.services.chat_archive import process_chat_greeting, pick_greeting_delay_sec
    try:
        greeting = await process_chat_greeting(
            platform="max",
            chat_id=chat_id,
            author_name=author_name,
            username=username,
            text=text or None,
        )
        if greeting:
            import asyncio
            delay = pick_greeting_delay_sec()
            reply_mid = str(mid) if mid else None

            async def _send_greeting_later(cid=chat_id, txt=greeting, tok=bot_token, rmid=reply_mid, d=delay):
                try:
                    await asyncio.sleep(d)
                    await max_send_message(cid, txt, token=tok, reply_to_mid=rmid)
                except Exception as ex:  # noqa: BLE001
                    logger.warning(f"MAX delayed greeting failed: {ex}")

            asyncio.create_task(_send_greeting_later())
    except Exception as e:  # noqa: BLE001
        logger.warning(f"MAX greeting failed: {e}")


async def _forward_max_user_message_to_organizer(
    *, client_id: int, user_id: str, username: str | None,
    display_name: str | None, text: str,
) -> None:
    """Шлёт уведомление #user_message в TG-канал клиента (notifications_telegram_chat_id)
    о личном сообщении в MAX-бот. Никнейм MAX — кликабельной ссылкой на профиль,
    чтобы из Telegram попасть в диалог с человеком.
    """
    import html as _html
    import httpx as _httpx
    from datetime import datetime
    try:
        from zoneinfo import ZoneInfo
    except ImportError:  # pragma: no cover
        from backports.zoneinfo import ZoneInfo  # type: ignore
    from app.services.profile_links import nick_html, link_html

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT c.notifications_telegram_chat_id,
                      c.notifications_max_chat_id, c.notifications_vk_peer_id,
                      COALESCE(NULLIF(c.brand_name,''), c.name) AS brand,
                      pu.contact_id, ct.name AS contact_name, ct.utm_source
                 FROM clients c
            LEFT JOIN platform_users pu
                   ON pu.client_id = c.id AND pu.platform_slug = 'max'
                  AND pu.platform_user_id = $2
            LEFT JOIN contacts ct ON ct.id = pu.contact_id
                WHERE c.id = $1""",
            client_id, str(user_id),
        )
    if not row or not (
        row["notifications_telegram_chat_id"]
        or row["notifications_max_chat_id"]
        or row["notifications_vk_peer_id"]
    ):
        return

    when_str = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
    user_nick = nick_html("max", user_id=user_id, username=username)
    # Рабочая https-ссылка на профиль MAX есть ТОЛЬКО если у человека задан
    # публичный username (max.ru/{username}). По числовому id MAX ссылку не даёт
    # (закрыто ради приватности) — поэтому max://user/{id} в Telegram мёртв, не
    # показываем его. Без username отвечаем человеку через карточку → Диалоги.
    _max_url = f"https://max.ru/{username.lstrip('@')}" if username else None
    contact_id = row["contact_id"]
    card_url = (
        f"{settings.frontend_url}/dashboard/clients?contact={contact_id}"
        if contact_id else "—"
    )
    name = display_name or row["contact_name"] or "—"
    parts = [
        "#user_message 💬",
        "",
        f"<b>Когда:</b> {when_str}",
        # Платформа + бренд кабинета: сразу видно, В КАКОЙ кабинет пришло сообщение.
        f"<b>Платформа:</b> MAX · {_html.escape(row['brand'] or '—')}",
        "",
        "<b>Кто написал</b>",
        f"<b>Никнейм:</b> {user_nick}",
        f"<b>Имя:</b> {_html.escape(name)}",
        f"<b>MAX ID:</b> <code>{_html.escape(str(user_id))}</code>",
    ]
    # Ссылка на человека в MAX. Официально (dev.max.ru) единственный формат —
    # max://user/{id} (аналог tg://user?id=). https-ссылки по id у MAX НЕТ.
    # max:// кликается только там, где приложение перехватывает схему: внутри
    # MAX, в мобильном браузере с установленным MAX. В Telegram max:// мёртв
    # (TG линкует лишь http(s)/tg) — поэтому в TG-канале это просто текст для
    # копирования, а в MAX-канале уведомлений (notifications_max_chat_id) — клик.
    _uid = _html.escape(str(user_id))
    if _max_url:
        parts.append(f'<b>Ссылка:</b> <a href="{_max_url}">{_max_url}</a>')
    else:
        parts.append(f'<b>Ссылка:</b> <a href="max://user/{_uid}">написать в MAX</a>')
        if contact_id:
            parts.append(f'<b>Или:</b> <a href="{card_url}">в карточке → Диалоги</a>')
    parts += [
        f"<b>ID контакта:</b> {('#' + str(contact_id)) if contact_id else '—'}",
        f"<b>Источник (utm_source):</b> {_html.escape(row['utm_source']) if row['utm_source'] else '—'}",
        f"<b>Карточка:</b> {card_url}",
        "",
        "<b>Сообщение:</b>",
        _html.escape(text or ""),
    ]
    notif_text = "\n".join(parts)

    # Дублируем во ВСЕ каналы уведомлений клиента (TG+MAX+VK).
    from app.services.channels import notify_organizer_all_channels
    pool2 = await get_pool()
    async with pool2.acquire() as conn2:
        await notify_organizer_all_channels(client_id, notif_text, conn2)


async def _handle_message_created(update: dict, *, bot_token: str, client_id_override: int | None) -> None:
    msg = update.get("message", {}) or {}
    body = msg.get("body", {}) or {}
    text = (body.get("text") or "").strip()
    sender, user_id, chat_id = _extract_user_and_chat(update)
    if not user_id or not chat_id:
        return
    # ── /getmyid — работает ВЕЗДЕ: личка / беседа / канал ────────────────────
    # Бот отвечает chat_id этого места + ваш user_id. Стоит ВЫШЕ ветки chat_type,
    # иначе в беседе/канале не сработает (там ранний return в слушалку). Бот
    # обязан быть в этом чате/канале.
    if _is_getmyid_command(text):
        try:
            await max_send_message(
                chat_id,
                f"ID этого чата/канала: {chat_id}\nВаш ID: {user_id}",
                token=bot_token,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"MAX /getmyid reply failed chat={chat_id}: {e}")
        return

    # /pluson_connect — связать свой ПЛЮСОН-аккаунт (ссылка на форму pluson.ru).
    if (text or "").strip().lower().split("@", 1)[0].lstrip("/") == "pluson_connect":
        try:
            from app.services.pluson_connect_token import make_pluson_connect_token
            from app.config import settings as _s
            cid = client_id_override
            if not cid:
                _p = await get_pool()
                async with _p.acquire() as _c:
                    cid = await _c.fetchval(
                        """SELECT cc.client_id FROM channels ch
                             JOIN client_channels cc ON cc.channel_id = ch.id
                            WHERE ch.platform_slug='max' AND ch.bot_token=$1
                            ORDER BY cc.is_active DESC, cc.id LIMIT 1""",
                        bot_token,
                    )
            if not cid:
                await max_send_message(chat_id, "Эта команда доступна только в боте организатора.", token=bot_token)
                return
            token = make_pluson_connect_token(
                client_id=int(cid), platform="max", user_id=str(user_id))
            url = f"{_s.frontend_url.rstrip('/')}/link-pluson?token={token}"
            await max_send_message(
                chat_id,
                "Свяжите свой аккаунт ПЛЮСОН — тогда все, кто зарегистрируются "
                "на событие и заберут в подарок доступ к ПЛЮСОН, закрепятся за "
                f"вами. Откройте форму (ссылка на 1 час):\n{url}",
                token=bot_token,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"MAX /pluson_connect failed chat={chat_id}: {e}")
        return

    # Команда /menu24 (со слешем) в личке — открыть меню события по id.
    # Резолвим slug по event_id и делегируем _process_start как ref_pg{slug}
    # (зеркало TG /menu{id} и VK «menu24»).
    import re as _re_menu
    _mm = _re_menu.match(r"^\s*/menu\s*(\d{1,9})\b", (text or "").strip(), _re_menu.IGNORECASE)
    if _mm:
        ev_id = int(_mm.group(1))
        _p = await get_pool()
        async with _p.acquire() as _c:
            _slug = await _c.fetchval("SELECT slug FROM events WHERE id = $1", ev_id)
        if _slug:
            await _process_start(
                user_id=user_id, chat_id=chat_id, sender=sender,
                payload=f"ref_pg{_slug}", bot_token=bot_token,
                client_id_override=client_id_override,
            )
        else:
            await max_send_message(chat_id, "Событие не найдено. Проверьте номер.", token=bot_token)
        return

    # Сообщения из групповых чатов/бесед (chat_type='chat'): НЕ запускаем логику
    # лички (бот ничего не слать в чаты), но СЛУШАЕМ для архива заданий
    # (отдельная слушалка чатов). chat_archive сам проверит привязку чата к событию.
    recipient = msg.get("recipient") or {}
    chat_type = (recipient.get("chat_type") or "").strip().lower()
    if chat_type and chat_type != "dialog":
        try:
            await _archive_max_chat_message(
                msg, body, text, str(chat_id), str(user_id),
                bot_token=bot_token, client_id_override=client_id_override,
            )
        except Exception as e:  # noqa: BLE001 — слушалка не должна ронять вебхук
            logger.warning(f"MAX chat archive failed: {e}")
        return
    low = text.lower()

    # /getmyid и алиасы обработаны выше универсально (_is_max_id_command) —
    # отдельные ветки здесь больше не нужны.

    if low.startswith("/support"):
        from app.services.support_message import build_support_message_plain
        wtg = wvk = wmax = ""
        if client_id_override:
            _sp = await get_pool()
            async with _sp.acquire() as _sc:
                _r = await _sc.fetchrow(
                    "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
                    client_id_override,
                )
            if _r:
                wtg, wvk, wmax = (_r["work_tg_username"] or "", _r["work_vk"] or "", _r["work_max"] or "")
        await max_send_message(
            chat_id,
            build_support_message_plain(work_tg=wtg, work_vk=wvk, work_max=wmax),
            token=bot_token,
        )
        return

    if low.startswith("/merge"):
        await _handle_max_merge(
            text=text, user_id=user_id, chat_id=chat_id,
            bot_token=bot_token, client_id_override=client_id_override,
        )
        return

    if low.lstrip("/").startswith("vip_link"):
        import re as _re
        mvip = _re.match(r"(?i)^\s*/?vip_link\s*(\d+)", text.strip())
        if not mvip:
            await max_send_message(chat_id, "Укажите событие: /vip_link24", token=bot_token)
            return
        event_id = int(mvip.group(1))
        pool = await get_pool()
        async with pool.acquire() as conn:
            # VIP-бот клиента (client_id_override) видит только свои события;
            # системный бот (None) — любые.
            if client_id_override is not None:
                owns = await conn.fetchval(
                    """SELECT 1 FROM event_owners
                        WHERE event_id = $1 AND client_id = $2 AND status='accepted' LIMIT 1""",
                    event_id, client_id_override)
                if not owns:
                    await max_send_message(chat_id, "Неизвестное событие — возможно, вы ошиблись с идентификатором события.", token=bot_token)
                    return
            contact_id = await conn.fetchval(
                """SELECT ep.contact_id FROM event_participants ep
                     JOIN platform_users pu ON pu.contact_id = ep.contact_id
                      AND pu.platform_slug='max' AND pu.platform_user_id = $2
                    WHERE ep.event_id = $1 LIMIT 1""",
                event_id, str(user_id))
            from app.services.external_landing import build_event_vip_target
            vip = await build_event_vip_target(conn, event_id, contact_id)
            if not vip:
                ev_exists = await conn.fetchval("SELECT 1 FROM events WHERE id=$1 LIMIT 1", event_id)
                if not ev_exists:
                    await max_send_message(chat_id, "Неизвестное событие — возможно, вы ошиблись с идентификатором события.", token=bot_token)
                else:
                    await max_send_message(chat_id, "У этого события не настроен формат участия (VIP).", token=bot_token)
                return
            msg_text = (
                f"Выберите формат участия в событии {vip['title']}\n\n"
                "👇👇👇\n"
            )
            btn = tg_inline_to_max_keyboard([[{"text": vip["vip_label"], "url": vip["vip_target"]}]])
            await max_send_message(chat_id, msg_text, token=bot_token, buttons=btn)
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

    # Любое другое сообщение (свободный текст / медиа) — архивируем в «Диалоги»
    # (только для VIP-бота клиента: client_id известен) и отвечаем.
    has_att, att_kind = _max_attachment_info(body)
    if client_id_override:
        try:
            from app.services.dialog_archive import archive_incoming, VOICE_REPLY
            channel_id = None
            _p = await get_pool()
            async with _p.acquire() as _c:
                channel_id = await _c.fetchval(
                    """SELECT cc.channel_id FROM client_channels cc
                         JOIN channels ch ON ch.id = cc.channel_id
                        WHERE cc.client_id = $1 AND ch.platform_slug = 'max'
                        ORDER BY cc.is_active DESC, cc.id ASC LIMIT 1""",
                    client_id_override,
                )
            file_url = None
            if has_att and att_kind != "voice":
                urls = _max_attachment_urls(body)
                file_url = urls[0]["url"] if urls else None
            await archive_incoming(
                client_id=client_id_override, platform="max", channel_id=channel_id,
                platform_user_id=str(user_id), text=(text or None),
                media_kind=(att_kind if has_att else None), file_url=file_url,
                platform_message_id=str(body.get("mid") or msg.get("seq") or "") or None,
            )
            if att_kind == "voice" and not text:
                await max_send_message(chat_id, VOICE_REPLY, token=bot_token)
                return
        except Exception as e:  # noqa: BLE001
            logger.warning(f"MAX dialog archive failed: {e}")

        # Уведомление #user_message организатору в его TG-канал (с кликабельной
        # ссылкой на профиль MAX — чтобы из Telegram попасть в диалог с человеком).
        try:
            await _forward_max_user_message_to_organizer(
                client_id=client_id_override,
                user_id=str(user_id),
                username=(sender.get("username") if isinstance(sender, dict) else None),
                display_name=(sender.get("name") if isinstance(sender, dict) else None),
                text=(text or ("[медиа]" if has_att else "")),
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"MAX user_message notify failed: {e}")

    # VIP-бот клиента: приветствие + прямые контакты поддержки клиента.
    # ⚠️ Никаких упоминаний ПЛЮСОНа — у VIP/PRO клиента бот «свой».
    if client_id_override:
        from app.services.support_message import build_user_reply_plain
        from app.services.dialog_archive import archive_outgoing_bot
        wtg = wvk = wmax = ""
        _p = await get_pool()
        async with _p.acquire() as _c:
            _r = await _c.fetchrow(
                "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
                client_id_override,
            )
        if _r:
            wtg, wvk, wmax = (_r["work_tg_username"] or "", _r["work_vk"] or "", _r["work_max"] or "")
        reply = build_user_reply_plain(work_tg=wtg, work_vk=wvk, work_max=wmax)
        await max_send_message(chat_id, reply, token=bot_token)
        try:
            await archive_outgoing_bot(
                client_id=client_id_override, platform="max", channel_id=None,
                platform_user_id=str(user_id), text=reply,
            )
        except Exception:  # noqa: BLE001
            pass
        return

    # Системный MAX-бот (контекста клиента нет) — лёгкий ответ-эхо чтобы не молчать.
    await max_send_message(
        chat_id,
        "Привет! Откройте мини-приложение по кнопке ниже — там события, "
        "рейтинги и подарки.",
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

    # Воронка лид-магнита: кнопка «ГОТОВО» (payload `fnl_check_<run_id>`).
    # Проверяем подписку на MAX-каналы основателя и выдаём материалы (Текст 2).
    if payload.startswith("fnl_check_"):
        rest = payload.removeprefix("fnl_check_").strip()
        if not rest.isdigit():
            return
        run_id = int(rest)
        pool = await get_pool()
        if not pool:
            return
        from app.services.funnel_service import run_check_subscription
        async with pool.acquire() as conn:
            try:
                status = await run_check_subscription(run_id, str(user_id), conn, platform="max")
            except Exception as e:
                logger.warning(f"MAX fnl_check failed (run={run_id}, user={user_id}): {e}")
                return
            if status == "survey_required":
                # Перед подарком нужна анкета. В ссылке зашиты человек, номер
                # подарка и площадка — файл придёт сразу после отправки.
                try:
                    from app.services.survey_gate import (
                        required_survey_for_run, survey_link_for_run,
                        survey_prompt_text, survey_text_for_client,
                    )
                    run_row = await conn.fetchrow(
                        """SELECT id, client_id, contact_id, lead_magnet_id,
                                  package_id, platform_slug
                             FROM funnel_runs WHERE id = $1""", run_id)
                    survey = await required_survey_for_run(conn, dict(run_row)) \
                        if run_row else None
                    if survey:
                        url = await survey_link_for_run(conn, survey, dict(run_row))
                        # Текст общий для всех площадок (правится в шаблоне
                        # воронки). MAX без parse_mode HTML не понимает —
                        # отдаём чистым текстом.
                        custom = await survey_text_for_client(
                            conn, run_row["client_id"])
                        body = re.sub(
                            r"<[^>]+>", "", survey_prompt_text(survey, custom))
                        await max_api.send_message(
                            int(user_id), f"{body}\n\n{url}",
                            token=bot_token, recipient_kind="user",
                        )
                except Exception as e:
                    logger.warning(f"MAX survey gate failed (run={run_id}): {e}")
                return

            if status == "not_subscribed":
                # Не подписан на канал(ы) основателя — просим подписаться и жать снова.
                not_sub = []
                try:
                    from app.services.funnel_service import _check_max_founder_subscription
                    not_sub = await _check_max_founder_subscription(
                        (await conn.fetchval("SELECT client_id FROM funnel_runs WHERE id=$1", run_id)),
                        str(user_id), bot_token, conn,
                    )
                except Exception:
                    pass
                lines = ["Похоже, вы ещё не подписаны на канал(ы):"]
                for ch in not_sub[:3]:
                    nm = ch.get("name") or "MAX-канал"
                    url = ch.get("url") or ""
                    lines.append(f"• {nm}{(' — ' + url) if url else ''}")
                lines.append("\nПодпишитесь и нажмите «ГОТОВО» снова.")
                await max_send_message(chat_id, "\n".join(lines), token=bot_token)
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
            contact_id = await _resolve_max_contact_id(conn, event_id, user_id)
            try:
                await _handle_max_chat_join(chat_id, event_id, contact_id, bot_token, conn, user_id=user_id)
            except Exception as e:
                logger.warning(f"MAX chat join failed (event={event_id}, user={user_id}): {e}")
        return

    if payload.startswith("evlive_"):
        try:
            event_id = int(payload.removeprefix("evlive_"))
        except ValueError:
            logger.warning(f"MAX evlive callback bad payload: {payload!r}")
            return
        pool = await get_pool()
        if not pool:
            return
        async with pool.acquire() as conn:
            contact_id = await _resolve_max_contact_id(conn, event_id, user_id)
            try:
                await _handle_max_live(chat_id, event_id, contact_id, bot_token, conn)
            except Exception as e:
                logger.warning(f"MAX evlive failed (event={event_id}, user={user_id}): {e}")
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
            contact_id = await _resolve_max_contact_id(conn, event_id, user_id)
            try:
                await _send_max_event_menu(chat_id, event_id, contact_id, bot_token, conn)
            except Exception as e:
                logger.warning(f"MAX evmenu failed (event={event_id}, user={user_id}): {e}")
        return

    # «ЗАРЕГИСТРИРОВАТЬСЯ» у события со skip_contact_form — регистрируем по
    # НАЖАТИЮ прямо в боте и присылаем меню (зеркало TG handle_event_signup).
    if payload.startswith("evsignup_"):
        try:
            event_id = int(payload.removeprefix("evsignup_"))
        except ValueError:
            logger.warning(f"MAX evsignup callback bad payload: {payload!r}")
            return
        pool = await get_pool()
        if not pool:
            return
        async with pool.acquire() as conn:
            contact_id = await _resolve_max_contact_id(conn, event_id, user_id)
            if not contact_id:
                logger.warning(f"MAX evsignup: contact not found (event={event_id}, user={user_id})")
                return
            from app.services.event_signup import signup_participant_in_bot
            await signup_participant_in_bot(
                conn, event_id=event_id, contact_id=contact_id)
            try:
                await _send_max_event_menu(chat_id, event_id, contact_id, bot_token, conn)
            except Exception as e:
                logger.warning(f"MAX evsignup menu failed (event={event_id}): {e}")
        return

    if payload.startswith("evsupport_"):
        try:
            event_id = int(payload.removeprefix("evsupport_"))
        except ValueError:
            logger.warning(f"MAX evsupport callback bad payload: {payload!r}")
            return
        await _handle_max_support(chat_id, event_id, bot_token)
        return

    logger.info(f"MAX message_callback unknown payload={payload!r}")


async def _handle_max_support(chat_id, event_id: int, bot_token: str | None) -> None:
    """Сообщение «Тех.поддержка» — каналы связи клиента-владельца события.
    Вызывается из callback `evsupport_<id>` и deeplink `/start evsupport_<id>`
    (кнопка «Тех.поддержка» в рассылках)."""
    # ⚠️ У КОЛЛАБЫ — контакты ВСЕХ организаторов (см. support_text_for_event).
    from app.services.support_message import support_text_for_event
    pool = await get_pool()
    if not pool:
        return
    async with pool.acquire() as conn:
        text = await support_text_for_event(conn, event_id, html=False)
    await max_send_message(chat_id, text, token=bot_token)


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
                "SELECT id FROM clients WHERE is_system_service=TRUE LIMIT 1"
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

    # Deeplink VIP: `?start=vip_link24` (id) или `?start=vip_link_cygum` (slug) —
    # сразу шлём сообщение с VIP-ссылкой события (как команда /vip_link).
    if payload and payload.lower().startswith("vip_link"):
        rest = payload[len("vip_link"):].lstrip("_").strip()
        _vp = await get_pool()
        if _vp:
            async with _vp.acquire() as conn:
                if rest.isdigit():
                    event_id = int(rest)
                else:
                    event_id = await conn.fetchval("SELECT id FROM events WHERE slug = $1 LIMIT 1", rest)
                if not event_id:
                    await max_send_message(chat_id, "Неизвестное событие — возможно, вы ошиблись с идентификатором события.", token=bot_token)
                    return
                contact_id = await _resolve_max_contact_id(conn, event_id, user_id)
                from app.services.external_landing import build_event_vip_target
                vip = await build_event_vip_target(conn, event_id, contact_id)
                if not vip:
                    await max_send_message(chat_id, "У этого события не настроен формат участия (VIP).", token=bot_token)
                    return
                msg_text = f"Выберите формат участия в событии {vip['title']}\n\n👇👇👇\n"
                btn = tg_inline_to_max_keyboard([[{"text": vip["vip_label"], "url": vip["vip_target"]}]])
                await max_send_message(chat_id, msg_text, token=bot_token, buttons=btn)
        return

    # Кнопка «Чат события» с веб-страницы /event/{slug}: `/start evchat_<event_id>`.
    # Ведём сразу на «вступить в чат» — проверка подписки + выдача чат-ссылок
    # (та же логика, что callback `evchat_` из меню кабинета).
    if payload and payload.startswith("evchat_"):
        try:
            event_id = int(payload.removeprefix("evchat_"))
        except ValueError:
            event_id = None
        if event_id:
            _ecp = await get_pool()
            if _ecp:
                async with _ecp.acquire() as conn:
                    contact_id = await _resolve_max_contact_id(conn, event_id, user_id)
                    try:
                        await _handle_max_chat_join(chat_id, event_id, contact_id, bot_token, conn, user_id=user_id)
                    except Exception as e:  # noqa: BLE001
                        logger.warning(f"MAX evchat deeplink failed (event={event_id}): {e}")
            return

    # Внешняя ссылка на эфир: `/start evlive_<event_id>` — то же сообщение,
    # что кнопка «Ссылка на эфир» в меню события, но сразу, без прохода по меню.
    if payload and payload.startswith("evlive_"):
        try:
            event_id = int(payload.removeprefix("evlive_"))
        except ValueError:
            event_id = None
        if event_id:
            _elp = await get_pool()
            if _elp:
                async with _elp.acquire() as conn:
                    contact_id = await _resolve_max_contact_id(conn, event_id, user_id)
                    try:
                        await _handle_max_live(chat_id, event_id, contact_id, bot_token, conn)
                    except Exception as e:  # noqa: BLE001
                        logger.warning(f"MAX evlive deeplink failed (event={event_id}): {e}")
            return

    # Регистрация на событие из вебинара: `/start evreg_<event_id>_ct<contact_id>`.
    # Привязываем реальную MAX-идентичность к контакту + регистрируем + подтверждаем.
    if payload and payload.startswith("evreg_"):
        from app.services import webinar_service as _ws
        parsed = _ws.parse_evreg_payload(payload)
        if parsed:
            _eid, _ct_hint = parsed
            _rp = await get_pool()
            if _rp:
                async with _rp.acquire() as conn:
                    _clid = await conn.fetchval(
                        "SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=$1 "
                        "AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1", _eid)
                    if _clid:
                        try:
                            res = await _ws.register_event_from_deeplink(
                                conn, client_id=_clid, event_id=_eid, contact_id_hint=_ct_hint,
                                platform="max", platform_user_id=user_id,
                                username=username, first_name=first_name)
                            await max_send_message(
                                chat_id,
                                f"✅ Вы зарегистрированы на «{res['event_title']}»! "
                                "Мы сохранили ваше участие.",
                                token=bot_token)
                            # Открываем меню события штатной веткой.
                            if res.get("event_slug"):
                                await _process_start(
                                    user_id=user_id, chat_id=chat_id, sender=sender,
                                    payload=f"ref_pg{res['event_slug']}", bot_token=bot_token,
                                    client_id_override=_clid)
                        except Exception as e:  # noqa: BLE001
                            logger.warning(f"MAX evreg deeplink failed (event={_eid}): {e}")
            return

    # Тех.поддержка: `/start evsupport_<event_id>` — то же, что кнопка «Тех.поддержка»
    # в меню события. Кнопка «Тех.поддержка» в рассылках ведёт сюда deeplink-ом.
    if payload and payload.startswith("evsupport_"):
        try:
            event_id = int(payload.removeprefix("evsupport_"))
        except ValueError:
            event_id = None
        if event_id:
            try:
                await _handle_max_support(chat_id, event_id, bot_token)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"MAX evsupport deeplink failed (event={event_id}): {e}")
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
                        # Кабинет спикера — публичная страница клиента, который
                        # завёл коллаба.
                        cabinet_url = await client_public_link(
                            conn0, coll["created_by_client_id"],
                            f"speaker/{event_slug}" if event_slug else "speaker/",
                        )
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

    # Партнёрский реф-код ПЛЮСОНа: `?start=ref<8симв>` (миграция 206). Зеркало
    # TG-ветки в bot/handlers/start.py — формат ссылки один на все площадки.
    # Без этой ветки payload проваливался в разбор `ref_pg{slug}` и код рефовода
    # молча терялся: человек регистрировался, но за партнёром не закреплялся.
    if payload:
        from app.services.plusson_referral import parse_plusson_ref_payload
        _ref_code = parse_plusson_ref_payload(payload)
        if _ref_code:
            try:
                await _handle_max_plusson_ref(
                    _ref_code, user_id=user_id, chat_id=chat_id,
                    username=username, first_name=first_name, last_name=last_name,
                    bot_token=bot_token, client_id_override=client_id_override,
                )
            except Exception as e:  # noqa: BLE001
                logger.exception(f"MAX plusson ref handler failed: {e}")
            return

    # Воронка лид-магнита: прямой формат `?start=m_<slug>` (лид-магнит) или
    # `?start=p_<slug>` (пакет), опционально `_pid<ref>_src<utm>`. Это тот же
    # формат, что у TG-бота (max.ru/{handle}?start=m_<slug>) — MAX присылает его
    # в payload bot_started/message. Создаём funnel_run(platform='max') и шлём
    # Текст 1 + кнопку «ГОТОВО» через run_started_max.
    # (Старый формат `fnl_<run_id>` через landing pluson.ru/m/... тоже поддержан.)
    if payload and (payload.startswith("m_") or payload.startswith("p_") or payload.startswith("fnl_")):
        try:
            await _start_max_lead_magnet_funnel(
                payload, str(user_id), username or None,
                first_name, last_name, bot_token,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception(f"MAX lead-magnet funnel handler failed: {e}")
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
            row = await conn.fetchrow("SELECT id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE slug = $1", event_slug)
            if row:
                # ⚠️ КОЛЛАБА: база — по рефоводу из ссылки, а не «первый
                # владелец» (services/event_client.py). Клиент бота здесь
                # неизвестен — иначе он уже стоял бы в client_id_override.
                from app.services.event_client import resolve_event_client
                client_id = await resolve_event_client(
                    conn, event_id=row["id"], client_id=row["client_id"],
                    partner_id=partner_ref_code or None,
                )
        if not client_id:
            row = await conn.fetchrow("SELECT id FROM clients WHERE is_system_service=TRUE LIMIT 1")
            client_id = row["id"] if row else 0
        if not client_id:
            logger.warning(f"MAX /start: no client resolved (user_id={user_id})")
            return

        # ЧЁРНЫЙ СПИСОК (миграция 228) — до выдачи любого контента
        try:
            from app.services.blacklist import is_identity_blacklisted, blocked_message
            if await is_identity_blacklisted(conn, client_id, "max", str(user_id)):
                await max_api.send_message(
                    user_id,
                    await blocked_message(conn, client_id, platform="max"),
                    token=bot_token,
                    recipient_kind="user",
                )
                return
        except Exception as e:  # noqa: BLE001 — fail-open
            logger.warning(f"MAX blacklist check failed: {e}")

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
        event_skip_contact_form = False
        is_registered = False
        event_poster_url = ""
        if event_slug:
            ev = await conn.fetchrow(
                """SELECT id, title, status, landing_url, skip_contact_form,
                          (SELECT url FROM event_posters
                             WHERE event_id = events.id AND day IS NULL
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
                event_skip_contact_form = bool(ev["skip_contact_form"])
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
            # «Регистрировать без ввода контактных данных»: кнопка
            # «ЗАРЕГИСТРИРОВАТЬСЯ» ОСТАЁТСЯ, но ведёт на callback `evsignup_<id>` —
            # регистрируем по НАЖАТИЮ и присылаем меню (как в TG). Меню само, без
            # нажатия, НЕ шлём.
            # ⚠️ Уступаем дорогу лендингу, только если он ВЫБРАН способом
            # регистрации. Просто заполненное поле landing_url выбором не
            # считается — см. тот же порядок в TG/VK.
            reg_in_bot = bool(
                event_skip_contact_form and contact_id and event_id
                and (await conn.fetchval(
                    "SELECT registration_mode FROM events WHERE id=$1", event_id))
                    not in ("landing", "external")
            )

            # НЕ зарегистрирован → 1 кнопка «ЗАРЕГИСТРИРОВАТЬСЯ» + афиша (как в TG).
            # Веб-ссылка: сторонний лендинг (если задан и опубликован) с ПОЛНЫМ
            # набором параметров (pluson_contact_id, pluson_participant_id, pid,
            # utm, external_ref_param рефовода, поля контакта) — иначе встроенный
            # веб pluson.ru/event/{slug}/register?c={contact_id}.
            # participant_id ОБЯЗАТЕЛЕН: GetCourse/Tilda присылают его обратно в
            # webhook getcourse/register — без него регистрация на лендинге не
            # привязывается к участию (is_registered не проставляется).
            # ⚠️ Куда ведёт кнопка — решает СПОСОБ РЕГИСТРАЦИИ события
            # (общая resolve_landing_url, та же во всех ботах и в рассылках).
            # Раньше про наш лендинг-конструктор МАКС не знал и вёл на форму.
            from app.services.message_builder import resolve_landing_url
            _reg_page = await resolve_landing_url(conn, event_id) if event_id else ""
            if not _reg_page:
                # Встроенная страница регистрации — публичная страница клиента,
                # поэтому открываем её на его домене.
                _reg_page = await client_public_link(
                    conn, client_id, f"event/{event_slug}/register"
                )
            _sep = "&" if "?" in _reg_page else "?"
            internal_web = f"{_reg_page}{_sep}c={contact_id}" if contact_id else _reg_page
            _reg_mode = await conn.fetchval(
                "SELECT registration_mode FROM events WHERE id=$1", event_id) if event_id else None
            # ⚠️ Сторонний лендинг — только при явно выбранном способе.
            if event_landing_url and event_status == "published" and _reg_mode == "external":
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
            msg_text = (
                "Добрейшего-богатейшего! 🤝\n\n"
                "Здесь вы можете зарегистрироваться на наше событие:\n"
                f"{event_title}\n\n"
                "Нажмите на кнопку ниже.\n\n"
                "Если проблемы с регистрацией — нажмите кнопку «Тех. поддержка»."
            )
            # skip_contact_form → callback (регистрируем по нажатию), иначе URL.
            _reg_btn = ({"text": "ЗАРЕГИСТРИРОВАТЬСЯ", "callback_data": f"evsignup_{event_id}"}
                        if reg_in_bot
                        else {"text": "ЗАРЕГИСТРИРОВАТЬСЯ", "url": web_url})
            buttons = tg_inline_to_max_keyboard([
                [_reg_btn],
                [{"text": "🆘 Тех. поддержка", "callback_data": f"evsupport_{event_id}"}],
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

    # ── Событие не задано (прямой /start без контекста) ──
    # VIP-бот клиента (client_id_override) → приветствие из НАСТРОЕК клиента
    # (как в TG): режим «конкретное событие» / кастомный текст / дефолт + кнопки
    # «Все события» и «Об основателе» + фото основателя.
    # Системный бот (client_id_override is None) → молчим: один клиент не
    # определён, вести некуда (и не шлём рекламно-платформенный текст).
    if client_id_override:
        try:
            from app.services.start_greeting import resolve_start_greeting, greeting_text_plain
            _wp = await get_pool()
            async with _wp.acquire() as _wc:
                g = await resolve_start_greeting(
                    _wc, client_id_override, greet_name=first_name or "",
                )
            # Режим «конкретное событие» → штатный флоу события (ref_pg{slug}),
            # ровно как по ссылке. Защита от петли: рекурсим только при пустом payload.
            if g.get("kind") == "event" and not (payload or "").strip():
                await _process_start(
                    user_id=user_id, chat_id=chat_id, sender=sender,
                    payload=f"ref_pg{g['event_slug']}",
                    bot_token=bot_token, client_id_override=client_id_override,
                )
                return
            # Режим «лид-магнит» из НАСТРОЕК старта (start_mode=lead_magnet) —
            # это НЕ воронка по ссылке fnl_ (та обработана выше). Здесь просто
            # показываем обычное приветствие с кнопками.
            _txt = greeting_text_plain(g.get("text") or "")
            _gbtns = g.get("buttons") or [
                {"label": g["events_label"], "url": g["events_url"]},
                {"label": g["owner_label"], "url": g["owner_url"]},
            ]
            _btn = tg_inline_to_max_keyboard([[{"text": b["label"], "url": b["url"]}] for b in _gbtns])
            _att = None
            if g.get("photo_url"):
                try:
                    a = await _max_image_attachment_from_url(g["photo_url"], bot_token)
                    if a:
                        _att = [a]
                except Exception as _pe:  # noqa: BLE001
                    logger.warning(f"MAX direct-start photo failed: {_pe}")
            await max_send_message(
                chat_id, _txt, token=bot_token, buttons=_btn, attachments=_att,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"MAX direct-start welcome failed for user={user_id}: {e}")
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
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = events.tg_chat_ref) AS chat_url_tg,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = events.vk_chat_ref) AS chat_url_vk,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = events.max_chat_ref) AS chat_url_max,
                  hide_stream_button, start_at,
                  (SELECT url FROM event_posters
                     WHERE event_id = events.id AND day IS NULL
                     ORDER BY CASE orientation
                                WHEN 'square' THEN 1 WHEN 'horizontal' THEN 2
                                WHEN 'vertical' THEN 3 ELSE 4 END, sort, id
                     LIMIT 1) AS poster_url
             FROM events WHERE id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return

    slug = ev["slug"]
    title = ev["title"] or ""
    cid_q = f"?c={contact_id}" if contact_id else ""

    # ⚠️ КОЛЛАБА: кабинет и программу человек ОТКРЫВАЕТ — вести они должны на
    # домен ТОГО организатора, в чьей базе его контакт, а не первого владельца.
    from app.services.event_client import resolve_event_client
    link_client_id = await resolve_event_client(
        conn, event_id=ev["id"], client_id=ev["client_id"], contact_id=contact_id)

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
            # Реф-код приведшего ищется В БАЗЕ человека: у коллабы в чужой базе
            # его нет, и партнёрский параметр молча терялся бы.
            erp = await resolve_referrer_external_ref_param(
                conn, link_client_id, contact_id=contact_id,
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

    # 3. Ссылка на эфир (callback evlive_ — ближайший эфир + кнопка стрима).
    tg_rows.append([{"text": "📺 Ссылка на эфир", "callback_data": f"evlive_{event_id}"}])

    # 4. Программа (и спикеры для конференций/турниров).
    prog_label = ("Программа и Спикеры"
                  if ev["module_slug"] in ("conference", "turnir")
                  else "Программа")
    # Страницы события — публичные страницы клиента: домен клиента, если есть.
    _pub_base = await client_public_url(conn, link_client_id)
    tg_rows.append([{"text": prog_label,
                     "url": public_url_for(_pub_base, f"event/{slug}{cid_q}#program")}])

    # 5. Кабинет и подарки → вкладка кабинета (#cabinet).
    tg_rows.append([{"text": "Кабинет и подарки",
                     "url": public_url_for(_pub_base, f"event/{slug}{cid_q}#cabinet")}])

    # 6. Тех. поддержка — единое сообщение с каналами связи клиента.
    tg_rows.append([{"text": "🆘 Тех. поддержка", "callback_data": f"evsupport_{event_id}"}])

    # Афиша события вложением к меню (как фото с подписью в TG).
    attachments = None
    poster_url = ev["poster_url"]
    if poster_url:
        try:
            att = await _max_image_attachment_from_url(poster_url, bot_token)
            if att:
                attachments = [att]
        except Exception as e:
            logger.warning(f"MAX menu poster failed ({poster_url}): {e}")
    await max_send_message(
        chat_id, text, token=bot_token,
        buttons=tg_inline_to_max_keyboard(tg_rows),
        attachments=attachments,
    )


async def _handle_max_live(
    chat_id: int,
    event_id: int,
    contact_id: int | None,
    bot_token: str,
    conn,
) -> None:
    """«📺 Ссылка на эфир» в MAX — зеркало handle_event_live из TG.
    Ближайший эфир (сессия/старт события) + кнопка ВОЙТИ В ЭФИР (если есть
    stream_url и не скрыт) + кнопка Программа + Меню."""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    # client_id владельца нужен, чтобы страница программы открылась на домене
    # клиента, если он подключён.
    ev = await conn.fetchrow(
        """SELECT id, slug, title, start_at, module_slug, landing_url, hide_stream_button,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
             FROM events WHERE id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return
    now_msk = datetime.now(ZoneInfo("Europe/Moscow"))
    live_when = ""
    live_what = ""
    sessions = await conn.fetch(
        """SELECT cd.day_date, s.start_time, s.title
             FROM conf_sessions s
             JOIN conf_days cd ON cd.event_id = s.event_id AND cd.day_number = s.day
            WHERE s.event_id = $1 AND s.start_time IS NOT NULL AND cd.day_date IS NOT NULL
            ORDER BY cd.day_date, s.start_time""",
        event_id,
    )
    chosen = None
    for r in sessions:
        try:
            hh, mm = str(r["start_time"])[:5].split(":")
            dt = datetime(r["day_date"].year, r["day_date"].month, r["day_date"].day,
                          int(hh), int(mm), tzinfo=ZoneInfo("Europe/Moscow"))
        except Exception:
            continue
        if dt >= now_msk - timedelta(minutes=90):
            chosen = (dt, r["title"]); break
    if chosen is None and sessions:
        r = sessions[-1]
        try:
            hh, mm = str(r["start_time"])[:5].split(":")
            chosen = (datetime(r["day_date"].year, r["day_date"].month, r["day_date"].day,
                               int(hh), int(mm), tzinfo=ZoneInfo("Europe/Moscow")), r["title"])
        except Exception:
            chosen = None
    if chosen:
        dt, what = chosen
        live_when = f"{dt.day} {_RU_MONTHS[dt.month]} {dt.hour:02d}:{dt.minute:02d} МСК"
        live_what = what or ""
    elif ev["start_at"]:
        dt = ev["start_at"]
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo("UTC"))
        dt = dt.astimezone(ZoneInfo("Europe/Moscow"))
        live_when = f"{dt.day} {_RU_MONTHS[dt.month]} {dt.hour:02d}:{dt.minute:02d} МСК"
        live_what = ev["title"] or ""

    text = "Ближайший эфир" + (f" — {live_when}" if live_when else "")
    if live_what:
        text += f"\n{live_what}"
    # Ссылка эфира = вебинарная комната дня.
    # Мероприятие (base) — день 1; конференция/турнир — первый день с комнатой;
    # конкурс — сторонний лендинг голосования (events.landing_url).
    module_slug = ev["module_slug"] or "base"
    stream_url = ""
    if module_slug == "contest":
        stream_url = (ev["landing_url"] or "").strip()
    else:
        from ..services.webinar_service import current_event_day
        _sd = await current_event_day(conn, event_id)
        stream_url = await day_stream_url(conn, event_id, _sd, contact_id=contact_id)
    hide = bool(ev["hide_stream_button"])
    rows = []
    if stream_url and not hide:
        rows.append([{"text": "ВОЙТИ В ЭФИР", "url": stream_url}])
    else:
        text += "\n\nКнопка на стрим появится тут перед эфиром."
    cid_q = f"?c={contact_id}" if contact_id else ""
    # Страница программы — публичная страница клиента → его домен.
    # ⚠️ КОЛЛАБА: домен ТОГО организатора, в чьей базе контакт человека.
    from app.services.event_client import resolve_event_client
    _prog_url = await client_public_link(
        conn,
        await resolve_event_client(
            conn, event_id=ev["id"], client_id=ev["client_id"], contact_id=contact_id),
        f"event/{ev['slug']}{cid_q}#program",
    )
    rows.append([{"text": "Программа", "url": _prog_url}])
    rows.append([{"text": "Меню", "callback_data": f"evmenu_{event_id}"}])
    await max_send_message(chat_id, text, token=bot_token, buttons=tg_inline_to_max_keyboard(rows))


async def _handle_max_plusson_ref(
    referral_code: str, *, user_id: int, chat_id: int,
    username: str | None, first_name: str | None, last_name: str | None,
    bot_token: str, client_id_override: int | None,
) -> None:
    """Вход по ПЛЮСОН-реф-ссылке в MAX: `max.ru/{handle}?start=ref<8симв>`.

    Зеркало TG-ветки в bot/handlers/start.py:
      1) резолвим код через общий `resolve_plusson_referrer` — он понимает и
         клиентский код, и код-контакт спикера с привязанным ПЛЮСОНом;
      2) заводим контакт человека в базе клиента ЭТОГО бота и закрепляем за ним
         СЫРОЙ код (contacts.plusson_referrer_code) — чтобы привязка пережила то,
         что кнопку регистрации нажмут не сразу. `/register` возьмёт код отсюда,
         если в URL нет pid;
      3) шлём приветствие с кнопкой регистрации.

    Код не резолвится (мусор/чужой) → приветствие без имени рефовода, регистрация
    всё равно предлагается: человек уже пришёл, терять его из-за битой ссылки нельзя.
    """
    from app.services.plusson_referral import (
        resolve_plusson_referrer, persist_plusson_referrer_code,
    )
    pool = await get_pool()
    if not pool:
        return

    referrer_name: str | None = None
    referrer_client_id: int | None = None
    async with pool.acquire() as conn:
        # Клиент этого бота: явный override (VIP-бот) → системный сервисный клиент.
        client_id = client_id_override or await conn.fetchval(
            "SELECT id FROM clients WHERE is_system_service=TRUE LIMIT 1"
        )

        # ЧЁРНЫЙ СПИСОК — до выдачи любого контента (миграция 228).
        try:
            from app.services.blacklist import is_identity_blacklisted, blocked_message
            if client_id and await is_identity_blacklisted(conn, client_id, "max", str(user_id)):
                await max_api.send_message(
                    user_id, await blocked_message(conn, client_id, platform="max"),
                    token=bot_token, recipient_kind="user",
                )
                return
        except Exception as e:  # noqa: BLE001 — fail-open
            logger.warning(f"MAX blacklist check (ref) failed: {e}")

        referrer_client_id = await resolve_plusson_referrer(conn, referral_code)
        if referrer_client_id:
            referrer_name = await conn.fetchval(
                "SELECT name FROM clients WHERE id = $1", referrer_client_id
            )
            # Контакт нужен ДО закрепления кода: persist ищет его по platform_users.
            if client_id:
                try:
                    await upsert_contact_with_identity(
                        conn, client_id=client_id, platform_slug="max",
                        platform_user_id=str(user_id), username=username or None,
                        first_name=first_name or None, last_name=last_name or None,
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"MAX ref upsert contact failed: {e}")
            await persist_plusson_referrer_code(
                conn, client_id=client_id, platform="max",
                platform_user_id=str(user_id), referral_code=referral_code,
            )
            # «Новый интерес» — РЕФОВОДУ, а не владельцу бота: партнёрская
            # программа принадлежит тому, чей код в ссылке.
            from app.services.plusson_referral_notify import (
                notify_referrer_new_interest,
            )
            await notify_referrer_new_interest(
                conn,
                referrer_client_id=referrer_client_id,
                platform="max",
                user_id=user_id,
                username=username,
                first_name=first_name,
                last_name=last_name,
            )

    # Регистрация в САМОЙ платформе — всегда основной домен, не клиентский.
    register_url = f"{platform_base_url()}/register?pid={referral_code}"
    hello = (first_name or "").strip()
    if referrer_client_id:
        text = (
            f"Привет{', ' + hello if hello else ''}! 👋\n\n"
            f"Вас пригласил(а) {referrer_name or 'партнёр'} в iViSiON: ПЛЮСОН — "
            f"платформу для организаторов и экспертов.\n\n"
            f"Создайте аккаунт и попробуйте всё сами 👇"
        )
    else:
        text = (
            f"Привет{', ' + hello if hello else ''}! 👋\n\n"
            f"iViSiON: ПЛЮСОН — платформа для организаторов и экспертов: "
            f"события, спикеры, рассылки и рефералы в одном месте.\n\n"
            f"Создайте аккаунт и попробуйте всё сами 👇"
        )
    await max_api.send_message(
        user_id, text, token=bot_token, recipient_kind="user",
        buttons=tg_inline_to_max_keyboard([[
            {"text": "📝 Зарегистрироваться", "url": register_url},
        ]]),
    )


async def _start_max_lead_magnet_funnel(
    payload: str, max_user_id: str, username: str | None,
    first_name: str | None, last_name: str | None, bot_token: str,
) -> bool:
    """MAX-аналог bot/handlers/start._start_lead_magnet_funnel.

    Поддерживает три формата payload:
      • `m_<slug>[_pid<ref>_src<utm>]` — лид-магнит по slug
      • `p_<slug>[_pid<ref>_src<utm>]` — пакет по slug
      • `fnl_<run_id>` — уже созданный забег (старый landing-формат)
    Создаёт funnel_run(platform='max') (для m_/p_) и вызывает run_started_max
    (Текст 1 + кнопка «ГОТОВО»). Возвращает True если воронка запущена."""
    from app.services.funnel_service import run_started_max
    pool = await get_pool()
    if not pool:
        return False

    # Старый формат fnl_<run_id> — забег уже есть.
    if payload.startswith("fnl_"):
        rest = payload.removeprefix("fnl_").strip()
        if not rest.isdigit():
            return False
        async with pool.acquire() as conn:
            await run_started_max(int(rest), max_user_id, username,
                                  first_name, last_name, conn, bot_token)
        return True

    kind = "m" if payload.startswith("m_") else "p"
    rest = payload[2:]
    parts = rest.split("_") if rest else []
    slug = parts[0] if parts else ""
    pid: str | None = None
    utm_source: str | None = None
    for chunk in parts[1:]:
        if chunk.startswith("pid"):
            pid = chunk[3:] or None
        elif chunk.startswith("src"):
            utm_source = chunk[3:] or None
    if not slug:
        return False

    async with pool.acquire() as conn:
        if kind == "m":
            row = await conn.fetchrow(
                "SELECT id, client_id FROM lead_magnets WHERE slug = $1", slug)
            client_id = row["client_id"] if row else None
            lm_id = row["id"] if row else None
            pkg_id = None
        else:
            row = await conn.fetchrow(
                "SELECT id, client_id FROM lead_magnet_packages WHERE slug = $1", slug)
            client_id = row["client_id"] if row else None
            lm_id = None
            pkg_id = row["id"] if row else None
        if not client_id:
            logger.info(f"MAX lead-magnet: slug {slug!r} ({kind}) not found")
            return False
        referrer_id = None
        if pid:
            referrer_id = await conn.fetchval(
                "SELECT id FROM contacts WHERE client_id = $1 AND ref_code = $2",
                client_id, pid)
        utm_json = {"utm_source": utm_source} if utm_source else {}
        run_id = await conn.fetchval(
            """INSERT INTO funnel_runs
                  (client_id, type, lead_magnet_id, package_id,
                   contact_id, referrer_contact_id, utm, stage, landed_at,
                   platform_slug)
               VALUES ($1, 'lead_magnet', $2, $3, NULL, $4, $5::jsonb, 'landed', NOW(), 'max')
               RETURNING id""",
            client_id, lm_id, pkg_id, referrer_id, json.dumps(utm_json),
        )
        await run_started_max(run_id, max_user_id, username,
                              first_name, last_name, conn, bot_token)
    return True


async def _gather_max_founder_channels(conn, client_id: int | None) -> list[dict]:
    """MAX-каналы ОСНОВАТЕЛЯ клиента (clients.social_links.max_channels) с числовым
    chat_id. Формат элемента: {chat_id, url, name}."""
    if not client_id:
        return []
    from app.services.social_links import normalize_max_channels
    row = await conn.fetchrow("SELECT social_links FROM clients WHERE id = $1", client_id)
    if not row:
        return []
    social = row["social_links"]
    if isinstance(social, str):
        import json as _json
        try:
            social = _json.loads(social)
        except Exception:
            social = {}
    channels = normalize_max_channels((social or {}).get("max_channels") or [])
    return [
        {"chat_id": (c.get("chat_id") or "").strip(),
         "url": c.get("url") or "", "name": c.get("name") or "MAX-канал основателя"}
        for c in channels if (c.get("chat_id") or "").strip()
    ]


async def _gather_max_event_collab_channels(
    conn, event_id: int, client_id: int | None, mode: str,
) -> list[dict]:
    """MAX-каналы организаторов/спикеров события (collaborators.max_channel_id).
    mode: 'organizer' → только орги, иначе все. Дедуп self-коллаба
    (clients.self_collaborator_id). Только каналы с числовым max_channel_id."""
    role_filter = "AND cse.role = 'organizer'" if mode == "organizer" else ""
    rows = await conn.fetch(
        f"""SELECT sp.id AS speaker_id, sp.name, sp.max_channel_id, sp.max_url, cse.role
              FROM event_collaborators cse
              JOIN collaborators sp ON sp.id = cse.speaker_id
             WHERE cse.event_id = $1
               AND cse.exclude_channel_from_subscription = FALSE
               AND sp.max_channel_id IS NOT NULL
               AND sp.max_channel_id <> ''
               AND sp.id <> COALESCE((SELECT self_collaborator_id FROM clients WHERE id = $2), 0)
               {role_filter}
             ORDER BY COALESCE(cse.priority, 60), cse.sort_order, cse.id""",
        event_id, client_id or 0,
    )
    return [
        {"chat_id": (r["max_channel_id"] or "").strip(),
         "url": r["max_url"] or "", "name": r["name"] or "MAX-канал спикера"}
        for r in rows if (r["max_channel_id"] or "").strip()
    ]


async def _check_max_subscription(
    conn, client_id: int | None, event_id: int, mode: str, user_id, bot_token: str,
) -> list[dict]:
    """Возвращает список MAX-каналов (основателя + организаторов/спикеров события),
    на которые пользователь НЕ подписан. Проверяются только каналы с числовым
    chat_id/max_channel_id — без него MAX API не вызвать.

    Пустой список = подписан на всё / нечего проверять → пускаем.
    Бот не админ канала / MAX не дал данных → канал считаем пройденным
    (fail-open, как в TG-гейте).
    """
    from app.services.max_api import check_channel_membership
    founder = await _gather_max_founder_channels(conn, client_id)
    collabs = await _gather_max_event_collab_channels(conn, event_id, client_id, mode)
    # Дедуп по chat_id (основатель приоритетнее).
    seen: set[str] = set()
    to_check: list[dict] = []
    for ch in founder + collabs:
        cid = (ch.get("chat_id") or "").strip()
        if not cid or cid in seen:
            continue
        seen.add(cid)
        to_check.append(ch)
    if not to_check:
        return []
    not_subscribed: list[dict] = []
    for ch in to_check:
        is_member = await check_channel_membership(ch["chat_id"], user_id, token=bot_token)
        # None = нет данных (бот не админ) → fail-open, не блокируем.
        # False = достоверно не подписан → требуем подписку.
        if is_member is False:
            not_subscribed.append(ch)
    return not_subscribed


async def _handle_max_chat_join(
    chat_id: int,
    event_id: int,
    contact_id: int | None,
    bot_token: str,
    conn,
    user_id: int | str | None = None,
) -> None:
    """«Вступить в Чат» в MAX — зеркало `handle_event_chat_join` из TG.

    Проверка подписки на MAX-каналы основателя клиента — РЕАЛЬНАЯ (MAX Bot API
    умеет: GET /chats/{id}/members?user_ids=<uid> → непустой members = подписан,
    см. max_api.check_channel_membership). Источник каналов — массив
    `clients.social_links.max_channels` с заполненным числовым `chat_id` (зеркало
    TG-гейта на каналах основателя). Канал без числового chat_id в проверке не
    участвует (узнать его по одной ссылке MAX не даёт). Бот обязан быть админом
    канала, иначе ответ трактуем как «нет данных» и канал пропускаем (fail-open).

    Если пользователь не подписан хотя бы на один проверяемый канал — шлём список
    каналов с просьбой подписаться, ссылки на чаты не выдаём. Подписан / нет
    каналов с id → сразу выдаём ссылки на чаты.
    """
    ev = await conn.fetchrow(
        """SELECT id, require_subscription, disabled_platforms,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = events.tg_chat_ref) AS chat_url_tg,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = events.vk_chat_ref) AS chat_url_vk,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = events.max_chat_ref) AS chat_url_max,
                  primary_chat_platform
             FROM events WHERE id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return

    # Режим проверки: конференция → conf_conferences.subscription_mode,
    # мероприятие → require_subscription (true=organizer, false=none).
    conf = await conn.fetchrow(
        "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id
    )
    if conf:
        mode = (dict(conf).get("subscription_mode") or "all_speakers")
    else:
        mode = "organizer" if ev["require_subscription"] else "none"

    # ── Проверка подписки на MAX-каналы основателя + организаторов/спикеров ──
    # ⚠️ Проверять членство нужно по USER_ID человека, НЕ по chat_id диалога
    # (раньше передавался chat_id → MAX всегда отвечал «не подписан»).
    check_uid = user_id if user_id is not None else chat_id
    logger.info(f"MAX chat-join subcheck: event={event_id} user_id={check_uid} chat_id={chat_id} mode={mode}")
    not_subscribed_channels = [] if mode == "none" else await _check_max_subscription(
        conn, ev["client_id"], event_id, mode, check_uid, bot_token,
    )
    if not_subscribed_channels:
        lines = [
            "Чтобы войти в чаты события, подпишитесь на каналы организатора:",
            "",
        ]
        for idx, ch in enumerate(not_subscribed_channels, start=1):
            label = ch.get("name") or "MAX-канал"
            lines.append(f"{idx}. {label}: {ch['url']}")
        lines.append("")
        lines.append('Подпишитесь и нажмите «Готово».')
        again_btn = tg_inline_to_max_keyboard([
            [{"text": "Готово", "callback_data": f"evchat_{event_id}"}],
            [{"text": "Меню", "callback_data": f"evmenu_{event_id}"}],
        ])
        await max_send_message(chat_id, "\n".join(lines), token=bot_token, buttons=again_btn)
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
    # ⚠️ Только ВКЛЮЧЁННЫЕ площадки (галочки события, миграция 263) — как в
    # TG/VK-ботах и на веб-странице. Организаторы сами решают, куда вести.
    from app.services.event_platforms import enabled_from_row
    _enabled = enabled_from_row(ev)
    items = [it for it in items if it[0] in _enabled]
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
