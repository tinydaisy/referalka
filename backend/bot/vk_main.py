"""
VK Long Poll consumer для системного сообщества ПЛЮСОН.

Аналог backend/bot/main.py (aiogram polling) — но для VK community Long Poll API.
Слушает события:
  - message_allow   → пользователь дал разрешение сообществу писать (~/start в TG)
  - message_new     → новое сообщение от пользователя (включая первое после кнопки «Начать»)
  - message_event   → клик по callback-кнопке VK keyboard (аналог TG callback_query)

Для каждого события создаём/находим contact + platform_users(platform_slug='vk').
Если в payload-кнопке `fnl_check_<run_id>` — проверяем подписку через funnel_service.

VK Long Poll docs: https://dev.vk.com/ru/api/community-events/getting-started
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from app.config import settings
from app.database import get_pool
from app.services.vk_api import vk_call, send_message as vk_send_message, tg_inline_to_vk_keyboard
from app.services.contact_merge import upsert_contact_with_identity

logger = logging.getLogger(__name__)

POLL_TIMEOUT = 25  # seconds


async def enable_long_poll(group_id: int, token: str) -> None:
    """Включить Long Poll API для сообщества + подписаться на нужные события.

    Идемпотентно: можно вызывать каждый раз при старте.
    """
    await vk_call("groups.setLongPollSettings", {
        "group_id": group_id,
        "enabled": 1,
        "api_version": "5.199",
        "message_new": 1,
        "message_reply": 0,
        "message_allow": 1,
        "message_deny": 1,
        "message_edit": 0,
        "message_event": 1,  # callback кнопки VK keyboard
        "message_typing_state": 0,
    }, token=token)
    logger.info(f"VK Long Poll enabled for group {group_id}")


async def get_long_poll_server(group_id: int, token: str) -> dict[str, Any]:
    """Получить server/key/ts для Long Poll сообщества."""
    try:
        return await vk_call("groups.getLongPollServer", {"group_id": group_id}, token=token)
    except RuntimeError as e:
        if "longpoll for this group is not enabled" in str(e).lower():
            await enable_long_poll(group_id, token)
            return await vk_call("groups.getLongPollServer", {"group_id": group_id}, token=token)
        raise


async def poll_once(server: str, key: str, ts: str) -> dict[str, Any]:
    """Один цикл polling. Возвращает {ts, updates} или {failed} при ошибке/таймауте."""
    async with httpx.AsyncClient(timeout=POLL_TIMEOUT + 5) as cli:
        r = await cli.get(server, params={
            "act": "a_check",
            "key": key,
            "ts": ts,
            "wait": POLL_TIMEOUT,
            "mode": 2,
        })
    return r.json()


async def handle_message_allow(event: dict, db) -> None:
    """message_allow: пользователь разрешил сообщество писать ему в личку.
    Регистрируем контакт + платформу + системный канал."""
    user_id = event.get("user_id")
    if not user_id:
        return
    # Определяем системный клиент «ПЛЮСОН Сервис»
    sys_client = await db.fetchval("SELECT id FROM clients WHERE email='system@pluson.ru' LIMIT 1")
    if not sys_client:
        logger.warning("System client 'ПЛЮСОН Сервис' not found, message_allow skipped")
        return
    await upsert_contact_with_identity(
        db,
        client_id=sys_client,
        platform_slug="vk",
        platform_user_id=str(user_id),
    )
    # Регистрируем подписку на системный VK-канал через client_channels
    cc_id = await db.fetchval(
        """SELECT cc.id FROM client_channels cc
            WHERE cc.client_id = $1 AND cc.channel_id = $2 LIMIT 1""",
        sys_client, settings.vk_system_channel_id,
    )
    if cc_id:
        # platform_user_channels.subscribed
        pu_id = await db.fetchval(
            """SELECT id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'vk' AND platform_user_id = $2""",
            sys_client, str(user_id),
        )
        if pu_id:
            await db.execute(
                """INSERT INTO platform_user_channels (platform_user_id, client_channel_id, is_unsubscribed, subscribed_at)
                   VALUES ($1, $2, FALSE, NOW())
                   ON CONFLICT (platform_user_id, client_channel_id)
                   DO UPDATE SET is_unsubscribed=FALSE, subscribed_at=NOW(), unsubscribed_at=NULL""",
                pu_id, cc_id,
            )
    logger.info("VK message_allow: user_id=%s recorded", user_id)

    # Generic welcome шлём ТОЛЬКО если человек не пришёл с event-контекстом.
    # Проверяем: были ли у него за последние 60 секунд upsert в platform_users
    # с привязкой к event_participants. Если был — значит /api/v1/vk/event сейчас
    # сам отправит контекстное приветствие, наше generic было бы лишним.
    recent_event_ctx = await db.fetchval(
        """SELECT 1 FROM event_participants ep
            JOIN platform_users pu ON pu.contact_id = ep.contact_id
                                   AND pu.platform_slug = 'vk'
                                   AND pu.platform_user_id = $1
           WHERE ep.registered_at > NOW() - INTERVAL '60 seconds'
              OR pu.updated_at    > NOW() - INTERVAL '60 seconds'
           LIMIT 1""",
        str(user_id),
    )
    if recent_event_ctx:
        logger.info("VK welcome skipped for user=%s (event-context welcome on the way)", user_id)
        return

    # Иначе — generic welcome (юзер просто написал в сообщество или открыл его страницу)
    try:
        from app.services.vk_api import send_message as vk_send_msg, tg_inline_to_vk_keyboard
        welcome_text = (
            "👋 Здравствуйте! Спасибо что разрешили нам писать.\n\n"
            "Это iViSiON: ПЛЮСОН — платформа для организаторов и экспертов. "
            "Откройте приложение, чтобы посмотреть свои события и партнёрские ссылки."
        )
        keyboard = tg_inline_to_vk_keyboard([[
            {"text": "Открыть приложение", "url": f"https://vk.com/app{settings.vk_app_id}"},
        ]])
        await vk_send_msg(int(user_id), welcome_text, keyboard=keyboard)
    except Exception as e:
        logger.warning(f"VK welcome on message_allow failed for user={user_id}: {e}")


async def handle_message_deny(event: dict, db) -> None:
    """message_deny: пользователь запретил сообществу писать. Отписываем глобально."""
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
    logger.info("VK message_deny: user_id=%s unsubscribed", user_id)


async def handle_message_event(event_obj: dict, db) -> None:
    """message_event: клик по inline-кнопке VK keyboard. Аналог TG callback_query.

    payload = {"cb": "fnl_check_<run_id>"} — запускаем run_check_subscription.
    """
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

    # Отвечаем VK что событие принято (показать всплывашку)
    async def _send_event_answer(text: str, type_: str = "show_snackbar"):
        try:
            await vk_call("messages.sendMessageEventAnswer", {
                "event_id": event_id,
                "user_id": user_id,
                "peer_id": peer_id,
                "event_data": json.dumps({"type": type_, "text": text}, ensure_ascii=False),
            })
        except Exception as e:
            logger.warning(f"VK sendMessageEventAnswer failed: {e}")

    # Воронка лид-магнита: проверка подписки
    if cb.startswith("fnl_check_"):
        try:
            run_id = int(cb.removeprefix("fnl_check_"))
        except ValueError:
            await _send_event_answer("Ошибка кнопки")
            return
        from app.services.funnel_service import run_check_subscription, _get_brand_context
        result = await run_check_subscription(run_id, str(user_id), db, platform="vk")
        if result == "subscribed":
            await _send_event_answer("Готово! Проверяйте сообщения 🎁")
        elif result == "not_subscribed":
            client_id = await db.fetchval("SELECT client_id FROM funnel_runs WHERE id=$1", run_id)
            ctx = await _get_brand_context(client_id, db) if client_id else {}
            chan = ctx.get("subscription_channel", "")
            await _send_event_answer(f"Не вижу подписки на {chan}. Подпишитесь и нажмите снова.")
        else:
            await _send_event_answer("Что-то пошло не так. Попробуйте позже.")


async def handle_message_new(event_obj: dict, db) -> None:
    """message_new: входящее сообщение от пользователя в личку сообщества.

    Если есть payload (нажата keyboard-кнопка с payload) — обрабатываем как fnl_check.
    Иначе — просто записываем контакт (если его ещё нет).
    """
    message = event_obj.get("message") or event_obj
    from_id = message.get("from_id")
    if not from_id or from_id < 0:  # отрицательные = от сообщества
        return

    sys_client = await db.fetchval("SELECT id FROM clients WHERE email='system@pluson.ru' LIMIT 1")
    if sys_client:
        await upsert_contact_with_identity(
            db, client_id=sys_client, platform_slug="vk",
            platform_user_id=str(from_id),
        )

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


async def process_event(ev: dict, db) -> None:
    """Диспетчер событий Long Poll."""
    t = ev.get("type")
    obj = ev.get("object") or {}
    try:
        if t == "message_allow":
            await handle_message_allow(obj, db)
        elif t == "message_deny":
            await handle_message_deny(obj, db)
        elif t == "message_event":
            await handle_message_event(obj, db)
        elif t == "message_new":
            await handle_message_new(obj, db)
        else:
            # message_reply, group_join, group_leave, etc — пока не обрабатываем
            pass
    except Exception as e:
        logger.exception(f"VK process_event {t} failed: {e}")


async def long_poll_loop(group_id: int, token: str):
    """Бесконечный цикл polling сообщества."""
    server_data = None
    while True:
        try:
            if not server_data:
                server_data = await get_long_poll_server(group_id, token)
                logger.info(f"VK Long Poll server obtained for group {group_id}")

            result = await poll_once(server_data["server"], server_data["key"], server_data["ts"])

            if "failed" in result:
                # 1 = ts устарел, 2 = key устарел, 3 = oба
                code = result.get("failed")
                if code == 1 and "ts" in result:
                    server_data["ts"] = str(result["ts"])
                else:
                    server_data = None  # перезапросить server
                continue

            server_data["ts"] = result.get("ts", server_data["ts"])
            updates = result.get("updates", []) or []
            if updates:
                pool = await get_pool()
                async with pool.acquire() as db:
                    for ev in updates:
                        await process_event(ev, db)
        except Exception as e:
            logger.exception(f"VK long_poll_loop error: {e}")
            await asyncio.sleep(5)
            server_data = None


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    group_id = settings.vk_system_group_id
    token = settings.vk_system_group_token
    if not group_id or not token:
        logger.error("VK_SYSTEM_GROUP_ID and VK_SYSTEM_GROUP_TOKEN must be set")
        return
    logger.info(f"Starting VK Long Poll for group {group_id}")
    await long_poll_loop(group_id, token)


if __name__ == "__main__":
    asyncio.run(main())
