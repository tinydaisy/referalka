"""
VK Long Poll consumer — multi-group.

Слушает Long Poll одновременно для:
  - системного сообщества (settings.vk_system_group_id) — все клиенты без своего VK;
  - всех VIP-клиентских сообществ (channels.platform_slug='vk' AND is_system=FALSE AND is_active в client_channels).

Каждая группа в отдельной asyncio-таске, ошибки изолированы (одна группа упала — остальные продолжают).

События:
  - message_allow   → пользователь разрешил сообществу писать
  - message_new     → входящее сообщение в личку
  - message_event   → клик callback-кнопки VK keyboard
  - message_deny    → пользователь запретил писать → глобальная отписка

Перезапуск процесса (`systemctl restart plusson-vk-bot`) перечитывает список групп.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings
from app.database import get_pool
from app.services.vk_api import vk_call, send_message as vk_send_message, tg_inline_to_vk_keyboard, get_user_info
from app.services.contact_merge import upsert_contact_with_identity

logger = logging.getLogger(__name__)

POLL_TIMEOUT = 25  # seconds


@dataclass
class GroupCtx:
    """Контекст одной обслуживаемой VK-группы — передаётся во все handlers."""
    channel_id: int    # channels.id
    client_id: int     # clients.id — кому принадлежит группа (для системной = системный клиент)
    group_id: int      # ID сообщества VK
    token: str         # access token сообщества
    vk_app_id: int     # ID привязанного Mini App (для CTA "Открыть приложение")
    is_system: bool


async def enable_long_poll(ctx: GroupCtx) -> None:
    """Включить Long Poll API для сообщества + подписаться на нужные события. Идемпотентно."""
    await vk_call("groups.setLongPollSettings", {
        "group_id": ctx.group_id,
        "enabled": 1,
        "api_version": "5.199",
        "message_new": 1,
        "message_reply": 0,
        "message_allow": 1,
        "message_deny": 1,
        "message_edit": 0,
        "message_event": 1,
        "message_typing_state": 0,
        # message_read нужен для статистики прочтений рассылок — при открытии
        # юзером чата с сообществом VK кидает событие с last_message_id, по
        # которому мы помечаем broadcast_log.read_at для всех сообщений
        # рассылок <= этого id.
        "message_read": 1,
    }, token=ctx.token)
    logger.info(f"VK Long Poll enabled for group {ctx.group_id}")


async def get_long_poll_server(ctx: GroupCtx) -> dict[str, Any]:
    try:
        return await vk_call("groups.getLongPollServer", {"group_id": ctx.group_id}, token=ctx.token)
    except RuntimeError as e:
        if "longpoll for this group is not enabled" in str(e).lower():
            await enable_long_poll(ctx)
            return await vk_call("groups.getLongPollServer", {"group_id": ctx.group_id}, token=ctx.token)
        raise


async def poll_once(server: str, key: str, ts: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=POLL_TIMEOUT + 5) as cli:
        r = await cli.get(server, params={
            "act": "a_check",
            "key": key,
            "ts": ts,
            "wait": POLL_TIMEOUT,
            "mode": 2,
        })
    return r.json()


def _extract_ref_with_prefix(message_or_event: dict, prefix: str) -> int | None:
    """Ищет `ref={prefix}<int>` в полях VK события и возвращает int-часть.

    Возможные источники (для message_new + message_allow):
      - object.message.ref     — VK кладёт сюда метку из vk.me/group?ref=...
      - object.message.payload — JSON с ключом ref (на случай stub-кнопки «Начать»)
      - object.ref             — поле самого события (message_allow)
      - object.message.ref_source — иногда содержит метку
    """
    candidates: list[Any] = []
    msg = message_or_event.get("message") if isinstance(message_or_event, dict) else None
    if isinstance(msg, dict):
        candidates.extend([msg.get("ref"), msg.get("ref_source")])
        payload_raw = msg.get("payload")
        if payload_raw:
            try:
                payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
                if isinstance(payload, dict):
                    candidates.append(payload.get("ref"))
            except Exception:
                pass
    candidates.extend([message_or_event.get("ref"), message_or_event.get("ref_source")])
    for c in candidates:
        if not c:
            continue
        s = str(c).strip()
        if s.startswith(prefix):
            try:
                return int(s[len(prefix):])
            except ValueError:
                continue
    return None


def _extract_funnel_run_id(message_or_event: dict) -> int | None:
    """Ищет `ref=fnl_<int>` — воронка лид-магнита."""
    return _extract_ref_with_prefix(message_or_event, "fnl_")


def _extract_partner_run_id(message_or_event: dict) -> int | None:
    """Ищет `ref=prt_<int>` — регистрация партнёра, начало (миграция 105)."""
    return _extract_ref_with_prefix(message_or_event, "prt_")


def _extract_partner_done_client_id(message_or_event: dict) -> int | None:
    """Ищет `ref=partner_done_<int>` — возврат после сабмита партнёрской формы.

    Партнёрский сервис в редирект-после-формы ставит vk.me/{group}?ref=
    partner_done_<client_id>. VK кладёт ref в первое сообщение пользователя.
    """
    return _extract_ref_with_prefix(message_or_event, "partner_done_")


async def handle_message_allow(event: dict, db, ctx: GroupCtx) -> None:
    """message_allow: пользователь разрешил сообществу писать ему в личку.
    Регистрируем контакт + платформу + канал ЭТОГО клиента.

    Если в событии есть ref=fnl_<run_id> — запускаем VK-воронку лид-магнита."""
    user_id = event.get("user_id")
    if not user_id:
        return
    await upsert_contact_with_identity(
        db,
        client_id=ctx.client_id,
        platform_slug="vk",
        platform_user_id=str(user_id),
    )
    # Подписка на этот канал через client_channels
    cc_id = await db.fetchval(
        """SELECT cc.id FROM client_channels cc
            WHERE cc.client_id = $1 AND cc.channel_id = $2 LIMIT 1""",
        ctx.client_id, ctx.channel_id,
    )
    if cc_id:
        pu_id = await db.fetchval(
            """SELECT id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'vk' AND platform_user_id = $2""",
            ctx.client_id, str(user_id),
        )
        if pu_id:
            await db.execute(
                """INSERT INTO platform_user_channels (platform_user_id, client_channel_id, is_unsubscribed, subscribed_at)
                   VALUES ($1, $2, FALSE, NOW())
                   ON CONFLICT (platform_user_id, client_channel_id)
                   DO UPDATE SET is_unsubscribed=FALSE, subscribed_at=NOW(), unsubscribed_at=NULL""",
                pu_id, cc_id,
            )
    logger.info("VK message_allow: group=%s user=%s recorded", ctx.group_id, user_id)

    # Если пришёл с реф-меткой лид-магнита (fnl_<run_id>) — запускаем воронку
    # и НЕ шлём дженерик welcome (приветствие будет от воронки).
    funnel_run_id = _extract_funnel_run_id(event)
    if funnel_run_id:
        try:
            user_info = await get_user_info(int(user_id))
            from app.services.funnel_service import run_started_vk
            await run_started_vk(
                funnel_run_id, str(user_id),
                username=(user_info or {}).get("screen_name", "") if user_info else "",
                first_name=(user_info or {}).get("first_name", "") if user_info else "",
                last_name=(user_info or {}).get("last_name", "") if user_info else "",
                db=db,
                channel_id=ctx.channel_id,
                token=ctx.token,
            )
            return
        except Exception as e:
            logger.warning("VK message_allow funnel start failed: %s", e)

    # Регистрация партнёра (prt_<run_id> — миграция 105). Аналог funnel-флоу,
    # но шлёт другое сообщение (без проверки подписки, c web-кнопкой на лендинг).
    partner_run_id = _extract_partner_run_id(event)
    if partner_run_id:
        try:
            user_info = await get_user_info(int(user_id))
            from app.services.partner_service import run_started_partner_vk
            await run_started_partner_vk(
                partner_run_id, str(user_id),
                username=(user_info or {}).get("screen_name", "") if user_info else "",
                first_name=(user_info or {}).get("first_name", "") if user_info else "",
                last_name=(user_info or {}).get("last_name", "") if user_info else "",
                db=db,
                channel_id=ctx.channel_id,
                token=ctx.token,
            )
            return
        except Exception as e:
            logger.warning("VK message_allow partner start failed: %s", e)

    # Возврат после сабмита партнёрской формы (миграция 105).
    # Партнёрский сервис ставит редирект на vk.me/{group}?ref=partner_done_<cid>.
    partner_done_cid = _extract_partner_done_client_id(event)
    if partner_done_cid:
        try:
            from app.services.partner_service import send_partner_done_vk
            await send_partner_done_vk(partner_done_cid, str(user_id), db, token=ctx.token)
            return
        except Exception as e:
            logger.warning("VK message_allow partner_done failed: %s", e)

    # Generic welcome шлём только если не пришёл с event-контекстом (60-сек защита от дубля)
    recent_event_ctx = await db.fetchval(
        """SELECT 1 FROM event_participants ep
            JOIN platform_users pu ON pu.contact_id = ep.contact_id
                                   AND pu.platform_slug = 'vk'
                                   AND pu.platform_user_id = $1
                                   AND pu.client_id = $2
           WHERE ep.registered_at > NOW() - INTERVAL '60 seconds'
              OR pu.updated_at    > NOW() - INTERVAL '60 seconds'
           LIMIT 1""",
        str(user_id), ctx.client_id,
    )
    if recent_event_ctx:
        return

    try:
        welcome_text = (
            "👋 Здравствуйте! Спасибо что разрешили нам писать.\n\n"
            "Откройте приложение, чтобы посмотреть свои события и партнёрские ссылки."
        )
        keyboard = tg_inline_to_vk_keyboard([[
            {"text": "Открыть приложение", "url": f"https://vk.com/app{ctx.vk_app_id}"},
        ]])
        await vk_send_message(int(user_id), welcome_text, keyboard=keyboard, token=ctx.token)
    except Exception as e:
        logger.warning(f"VK welcome on message_allow failed for user={user_id}: {e}")


async def handle_message_deny(event: dict, db, ctx: GroupCtx) -> None:
    """message_deny: пользователь запретил сообществу писать. Отписываем от ВСЕХ контекстов
    (если бот реально заблокирован — он не дойдёт ни через какой client_channel)."""
    user_id = event.get("user_id")
    if not user_id:
        return
    await db.execute(
        """UPDATE platform_user_channels puc
              SET is_unsubscribed = TRUE, unsubscribed_at = NOW()
             FROM platform_users pu
            WHERE puc.platform_user_id = pu.id
              AND pu.platform_slug = 'vk' AND pu.platform_user_id = $1""",
        str(user_id),
    )
    logger.info("VK message_deny: group=%s user=%s unsubscribed globally", ctx.group_id, user_id)


async def handle_message_event(event_obj: dict, db, ctx: GroupCtx) -> None:
    """message_event: клик callback-кнопки VK keyboard."""
    user_id = event_obj.get("user_id")
    payload_raw = event_obj.get("payload")
    event_id = event_obj.get("event_id")
    peer_id = event_obj.get("peer_id")
    if not user_id or not payload_raw:
        return
    try:
        payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
    except Exception:
        payload = {}
    cb = payload.get("cb") if isinstance(payload, dict) else None
    if not cb:
        return

    async def _send_event_answer(text: str, type_: str = "show_snackbar"):
        try:
            await vk_call("messages.sendMessageEventAnswer", {
                "event_id": event_id,
                "user_id": user_id,
                "peer_id": peer_id,
                "event_data": json.dumps({"type": type_, "text": text}, ensure_ascii=False),
            }, token=ctx.token)
        except Exception as e:
            logger.warning(f"VK sendMessageEventAnswer failed: {e}")

    if cb.startswith("fnl_check_"):
        try:
            run_id = int(cb.removeprefix("fnl_check_"))
        except ValueError:
            await _send_event_answer("Ошибка кнопки")
            return
        from app.services.funnel_service import run_check_subscription, _get_brand_context
        result = await run_check_subscription(run_id, str(user_id), db, platform="vk")
        if result == "subscribed":
            # На subscribed бэк уже сам шлёт Текст 2 со ссылками в личку. Здесь только
            # короткое подтверждение через snackbar — оно нужно VK чтобы убрать
            # «вращающийся индикатор» на кнопке.
            await _send_event_answer("Готово! Проверяйте сообщения 🎁")
        elif result == "not_subscribed":
            client_id = await db.fetchval("SELECT client_id FROM funnel_runs WHERE id=$1", run_id)
            brand_ctx = await _get_brand_context(client_id, db, platform="vk") if client_id else {}
            chan_url = brand_ctx.get("subscription_channel", "")
            # Сообщение в чат (видимое), а не snackbar — пользователь должен понять
            # что и куда подписаться. Кнопка «ГОТОВО» под текстом — для повторной
            # проверки после подписки.
            text = (
                "❗ Не вижу вашей подписки на сообщество.\n\n"
                f"Подпишитесь, пожалуйста, на:\n{chan_url}\n\n"
                "И нажмите «ГОТОВО» ещё раз — я отправлю подарки."
            )
            keyboard = tg_inline_to_vk_keyboard([[
                {"text": "ГОТОВО", "callback_data": f"fnl_check_{run_id}"},
            ]])
            try:
                await vk_send_message(int(user_id), text, keyboard=keyboard, token=ctx.token)
            except Exception as e:
                logger.warning(f"VK not_subscribed message failed: {e}")
            # Snackbar тоже шлём — короткое, чтобы кнопка убрала спиннер.
            await _send_event_answer("Не вижу подписки. Смотрите сообщение в чате.")
        else:
            await _send_event_answer("Что-то пошло не так. Попробуйте позже.")


async def handle_message_new(event_obj: dict, db, ctx: GroupCtx) -> None:
    """message_new: входящее сообщение в личку сообщества.

    Что делаем:
      1. Upsert контакт (если ещё не было) — VK даёт нам новую идентичность.
      2. Если payload-кнопка fnl_check — запускаем проверку подписки воронки.
      3. Иначе свободный текст пользователя — пересылаем в #user_message
         (notifications_telegram_chat_id) + отвечаем что делать дальше.
    """
    message = event_obj.get("message") or event_obj
    from_id = message.get("from_id")
    if not from_id or from_id < 0:  # отрицательные = от сообщества
        return

    await upsert_contact_with_identity(
        db, client_id=ctx.client_id, platform_slug="vk",
        platform_user_id=str(from_id),
    )

    # Реф-метка лид-магнита (vk.me/group?ref=fnl_xxx) — запускаем воронку.
    # Проверяем до payload-кнопок, чтобы выдача шла даже если пользователь
    # написал произвольный текст вместо нажатия Start.
    funnel_run_id = _extract_funnel_run_id(event_obj)
    # Страховка: если ref не пришёл, но у юзера есть СВЕЖИЙ landed-забег
    # без started_at (он пришёл через Mini App, но Текст 1 ещё не успел уйти —
    # например, не дал права на сообщения) — продолжаем последний.
    if not funnel_run_id:
        recent_run = await db.fetchval(
            """SELECT id FROM funnel_runs
                WHERE client_id = $1
                  AND type = 'lead_magnet'
                  AND platform_slug = 'vk'
                  AND stage = 'landed'
                  AND landed_at > NOW() - INTERVAL '10 minutes'
                ORDER BY landed_at DESC
                LIMIT 1""",
            ctx.client_id,
        )
        # Дополнительно подтянем по vk_user_id если он уже был связан с забегом
        if not recent_run:
            recent_run = await db.fetchval(
                """SELECT id FROM funnel_runs
                    WHERE client_id = $1
                      AND type = 'lead_magnet'
                      AND platform_slug = 'vk'
                      AND platform_user_id = $2
                      AND stage IN ('landed', 'started')
                      AND landed_at > NOW() - INTERVAL '24 hours'
                    ORDER BY landed_at DESC
                    LIMIT 1""",
                ctx.client_id, str(from_id),
            )
        if recent_run:
            funnel_run_id = recent_run
    if funnel_run_id:
        try:
            user_info = await get_user_info(int(from_id))
            from app.services.funnel_service import run_started_vk
            await run_started_vk(
                funnel_run_id, str(from_id),
                username=(user_info or {}).get("screen_name", "") if user_info else "",
                first_name=(user_info or {}).get("first_name", "") if user_info else "",
                last_name=(user_info or {}).get("last_name", "") if user_info else "",
                db=db,
                channel_id=ctx.channel_id,
                token=ctx.token,
            )
            return
        except Exception as e:
            logger.warning("VK message_new funnel start failed: %s", e)

    # Регистрация партнёра (prt_<run_id>, миграция 105) — аналог funnel
    partner_run_id = _extract_partner_run_id(event_obj)
    if partner_run_id:
        try:
            user_info = await get_user_info(int(from_id))
            from app.services.partner_service import run_started_partner_vk
            await run_started_partner_vk(
                partner_run_id, str(from_id),
                username=(user_info or {}).get("screen_name", "") if user_info else "",
                first_name=(user_info or {}).get("first_name", "") if user_info else "",
                last_name=(user_info or {}).get("last_name", "") if user_info else "",
                db=db,
                channel_id=ctx.channel_id,
                token=ctx.token,
            )
            return
        except Exception as e:
            logger.warning("VK message_new partner start failed: %s", e)

    # Возврат после сабмита партнёрской формы (миграция 105).
    partner_done_cid = _extract_partner_done_client_id(event_obj)
    if partner_done_cid:
        try:
            from app.services.partner_service import send_partner_done_vk
            await send_partner_done_vk(partner_done_cid, str(from_id), db, token=ctx.token)
            return
        except Exception as e:
            logger.warning("VK message_new partner_done failed: %s", e)

    # Проверяем payload — может быть нажата кнопка с payload
    payload_raw = message.get("payload")
    if payload_raw:
        try:
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
        except Exception:
            payload = {}
        cb = payload.get("cb") if isinstance(payload, dict) else None
        if cb and cb.startswith("fnl_check_"):
            try:
                run_id = int(cb.removeprefix("fnl_check_"))
                from app.services.funnel_service import run_check_subscription
                await run_check_subscription(run_id, str(from_id), db, platform="vk")
            except Exception as e:
                logger.warning(f"VK fnl_check via message payload failed: {e}")
            return  # payload-action обработан, в #user_message не дублируем

    # Свободный текст. Игнорируем служебные старты (action: chat_invite_user и т.п.)
    text = (message.get("text") or "").strip()
    if not text:
        return

    # Уведомление организатору шлём ТОЛЬКО для VIP-сообществ. В системном
    # сообществе @pluson_bot/ivision_pluson мы не знаем, какому организатору
    # пользователь хочет написать — поэтому никаких уведомлений никому.
    work_tg: str | None = None
    if not ctx.is_system:
        await _forward_user_message_to_organizer(db, ctx, from_id=int(from_id), text=text)
        # Для VIP — берём личный TG-ник клиента (work_tg_username из настроек),
        # чтобы предложить пользователю написать туда напрямую.
        work_tg = await db.fetchval(
            "SELECT work_tg_username FROM clients WHERE id = $1", ctx.client_id,
        )
        if work_tg:
            work_tg = work_tg.lstrip("@") or None
    await _reply_to_user_message(ctx, peer_id=int(from_id), work_tg=work_tg)


async def _forward_user_message_to_organizer(db, ctx: "GroupCtx", *, from_id: int, text: str) -> None:
    """Шлёт уведомление #user_message в TG-канал клиента (notifications_telegram_chat_id).
    Делает best-effort: ошибки логируются, ничего не блокируется.
    """
    from app.config import settings as _s
    import httpx as _httpx
    from datetime import datetime
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore
    import html as _html

    try:
        row = await db.fetchrow(
            """SELECT c.notifications_telegram_chat_id,
                      pu.contact_id, ct.name AS contact_name, ct.utm_source
                 FROM clients c
            LEFT JOIN platform_users pu
                   ON pu.client_id = c.id AND pu.platform_slug = 'vk' AND pu.platform_user_id = $2
            LEFT JOIN contacts ct ON ct.id = pu.contact_id
                WHERE c.id = $1""",
            ctx.client_id, str(from_id),
        )
        if not row or not row["notifications_telegram_chat_id"]:
            return

        # Имя/ник пользователя VK — через users.get
        display_name = ""
        vk_screen = ""
        try:
            ui_resp = await vk_call("users.get",
                {"user_ids": str(from_id), "fields": "screen_name"},
                token=ctx.token)
            ui_list = ui_resp if isinstance(ui_resp, list) else (ui_resp.get("response") or [])
            if ui_list:
                ui = ui_list[0]
                display_name = f"{ui.get('first_name','')} {ui.get('last_name','')}".strip()
                vk_screen = ui.get("screen_name", "")
        except Exception:
            pass

        when_str = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
        user_nick = f"@{vk_screen}" if vk_screen else "—"
        card_url = (
            f"{_s.frontend_url}/dashboard/clients?contact={row['contact_id']}"
            if row['contact_id'] else "—"
        )
        parts = [
            "#user_message 💬",
            "",
            f"<b>Когда:</b> {when_str}",
            f"<b>Платформа:</b> ВКонтакте",
            "",
            "<b>Кто написал</b>",
            f"<b>Никнейм:</b> {user_nick}",
            f"<b>Имя:</b> {_html.escape(display_name or row['contact_name'] or '—')}",
            f"<b>VK ID:</b> <code>{from_id}</code>",
            f"<b>ID контакта:</b> {('#' + str(row['contact_id'])) if row['contact_id'] else '—'}",
            f"<b>Источник (utm_source):</b> {_html.escape(row['utm_source']) if row['utm_source'] else '—'}",
            f"<b>Карточка:</b> {card_url}",
            "",
            "<b>Сообщение:</b>",
            _html.escape(text),
        ]
        notif_text = "\n".join(parts)

        token = _s.telegram_bot_token
        if not token:
            return
        async with _httpx.AsyncClient(timeout=10) as http:
            await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": row["notifications_telegram_chat_id"],
                    "text": notif_text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
            )
    except Exception as e:
        logger.warning(f"VK user_message notify failed for from_id={from_id}: {e}")


async def _reply_to_user_message(
    ctx: "GroupCtx", *, peer_id: int, work_tg: str | None = None,
) -> None:
    """Шлёт пользователю короткий ответ.

    - Системное сообщество → текст про «Лидеры» + кнопка на эту вкладку Mini App.
    - VIP-сообщество с work_tg → «напишите лично @{work_tg}» + URL-кнопка
      «НАПИСАТЬ ЛИЧНО» → t.me/{work_tg}?text=Есть+вопрос (открывается в TG-приложении).
    - VIP без work_tg → fallback на кнопку «Открыть Экосистему».
    """
    if ctx.is_system:
        reply = (
            "Спасибо за сообщение 💛\n\n"
            "Чтобы связаться с конкретным организатором — откройте приложение, "
            "перейдите на вкладку «Лидеры», выберите нужного лидера и в разделе "
            "«Экосистема» найдите его контакты для вопросов."
        )
        button_url = f"https://vk.com/app{ctx.vk_app_id}#hub_tableaders"
        button_text = "Открыть «Лидеры»"
    elif work_tg:
        from urllib.parse import quote
        prefill = quote("Есть вопрос")
        reply = (
            "Спасибо, видим ваше сообщение 💛\n\n"
            f"Для оперативного ответа напишите лично — @{work_tg} в Telegram."
        )
        button_url = f"https://t.me/{work_tg}?text={prefill}"
        button_text = "НАПИСАТЬ ЛИЧНО"
    else:
        reply = (
            "Спасибо за сообщение 💛\n\n"
            "Если нужно связаться с организатором — откройте приложение, "
            "вкладка «Экосистема». Там вся информация и контакты."
        )
        button_url = f"https://vk.com/app{ctx.vk_app_id}#hub_tabecosystem"
        button_text = "Открыть «Экосистему»"
    kb = tg_inline_to_vk_keyboard([[{"text": button_text, "url": button_url}]])
    try:
        await vk_send_message(peer_id, reply, keyboard=kb, token=ctx.token)
    except Exception as e:
        logger.warning(f"VK reply to user message failed peer={peer_id}: {e}")


async def handle_message_read(event_obj: dict, db, ctx: GroupCtx) -> None:
    """message_read: юзер прочитал сообщение от сообщества в личке.

    VK кидает событие с парой (from_id, last_message_id). last_message_id —
    максимальный id исходящего сообщения сообщества, до которого юзер «дочитал»
    (точнее — открыл чат, и VK поднял read marker до этого id).

    Что делаем: помечаем broadcast_log.read_at для всех записей где
    - channel_id = текущая VK-группа (ctx.channel_id)
    - platform_users.platform_user_id = from_id
    - external_message_id <= last_message_id
    - read_at IS NULL (не помечать повторно)
    """
    try:
        from_id = int(event_obj.get("from_id") or 0)
        last_msg_id = int(event_obj.get("last_message_id") or 0)
    except (TypeError, ValueError):
        return
    if not from_id or not last_msg_id:
        return
    try:
        rows = await db.execute(
            """UPDATE broadcast_log AS bl
                  SET read_at = NOW()
                 FROM platform_users pu
                WHERE bl.platform_user_id = pu.id
                  AND bl.channel_id = $1
                  AND pu.platform_user_id = $2
                  AND pu.platform_slug = 'vk'
                  AND bl.external_message_id IS NOT NULL
                  AND bl.external_message_id <= $3
                  AND bl.read_at IS NULL
                  AND bl.status = 'sent'""",
            ctx.channel_id, str(from_id), last_msg_id,
        )
        # rows здесь — строка вида "UPDATE N", логируем только если что-то помечено
        if isinstance(rows, str) and rows.startswith("UPDATE "):
            n = int(rows.split()[1])
            if n > 0:
                logger.info(f"VK message_read group={ctx.group_id} from={from_id} last_id={last_msg_id} → +{n} read")
    except Exception as e:
        logger.warning(f"VK message_read UPDATE failed group={ctx.group_id} from={from_id}: {e}")


async def process_event(ev: dict, db, ctx: GroupCtx) -> None:
    """Диспетчер событий Long Poll."""
    t = ev.get("type")
    obj = ev.get("object") or {}
    try:
        if t == "message_allow":
            await handle_message_allow(obj, db, ctx)
        elif t == "message_deny":
            await handle_message_deny(obj, db, ctx)
        elif t == "message_event":
            await handle_message_event(obj, db, ctx)
        elif t == "message_new":
            await handle_message_new(obj, db, ctx)
        elif t == "message_read":
            await handle_message_read(obj, db, ctx)
        # message_reply, group_join, group_leave — не обрабатываем пока
    except Exception as e:
        logger.exception(f"VK process_event group={ctx.group_id} type={t} failed: {e}")


async def long_poll_loop(ctx: GroupCtx):
    """Бесконечный цикл polling одной группы."""
    server_data = None
    while True:
        try:
            if not server_data:
                server_data = await get_long_poll_server(ctx)
                logger.info(f"VK Long Poll server obtained for group {ctx.group_id}")

            result = await poll_once(server_data["server"], server_data["key"], server_data["ts"])

            if "failed" in result:
                code = result.get("failed")
                if code == 1 and "ts" in result:
                    server_data["ts"] = str(result["ts"])
                else:
                    server_data = None
                continue

            server_data["ts"] = result.get("ts", server_data["ts"])
            updates = result.get("updates", []) or []
            if updates:
                pool = await get_pool()
                async with pool.acquire() as db:
                    for ev in updates:
                        await process_event(ev, db, ctx)
        except Exception as e:
            logger.exception(f"VK long_poll_loop error group={ctx.group_id}: {e}")
            await asyncio.sleep(5)
            server_data = None


async def load_groups() -> list[GroupCtx]:
    """Собирает список обслуживаемых VK-групп: системная + все клиентские VIP."""
    out: list[GroupCtx] = []

    # 1. Системная группа — из settings
    sys_gid = settings.vk_system_group_id
    sys_token = settings.vk_system_group_token
    if sys_gid and sys_token:
        pool = await get_pool()
        async with pool.acquire() as db:
            sys_client_id = await db.fetchval("SELECT id FROM clients WHERE email='system@pluson.ru' LIMIT 1")
            sys_channel_id = settings.vk_system_channel_id
        if sys_client_id and sys_channel_id:
            out.append(GroupCtx(
                channel_id=sys_channel_id,
                client_id=sys_client_id,
                group_id=int(sys_gid),
                token=sys_token,
                vk_app_id=int(settings.vk_app_id or 0),
                is_system=True,
            ))
        else:
            logger.warning("System VK group skipped: system client or channel id missing")
    else:
        logger.warning("VK_SYSTEM_GROUP_ID/TOKEN not set, system VK polling skipped")

    # 2. Клиентские VIP-группы — все active в client_channels, не системные
    pool = await get_pool()
    async with pool.acquire() as db:
        rows = await db.fetch(
            """SELECT ch.id AS channel_id, cc.client_id, ch.bot_token,
                      ch.platform_meta
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE ch.platform_slug = 'vk'
                  AND ch.is_system = FALSE
                  AND cc.is_active = TRUE
                  AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
                  AND (ch.platform_meta->>'vk_group_id') IS NOT NULL"""
        )
    for r in rows:
        meta = r["platform_meta"] or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        try:
            gid = int(meta.get("vk_group_id"))
            app_id = int(meta.get("vk_app_id") or 0)
        except (TypeError, ValueError):
            logger.warning(f"VK channel {r['channel_id']} has invalid meta, skip")
            continue
        out.append(GroupCtx(
            channel_id=r["channel_id"],
            client_id=r["client_id"],
            group_id=gid,
            token=r["bot_token"],
            vk_app_id=app_id,
            is_system=False,
        ))

    return out


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    groups = await load_groups()
    if not groups:
        logger.error("No VK groups to poll (system unset and no VIP VK channels)")
        return
    logger.info(f"Starting VK Long Poll for {len(groups)} groups: " + ", ".join(
        f"{g.group_id}{'(sys)' if g.is_system else ''}" for g in groups
    ))
    # Параллельные таски — одна на группу, ошибки изолированы long_poll_loop'ом
    await asyncio.gather(*(long_poll_loop(g) for g in groups), return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
