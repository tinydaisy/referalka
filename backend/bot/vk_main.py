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
from app.services.vk_api import vk_call, send_message as vk_send_message, tg_inline_to_vk_keyboard
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


async def handle_message_allow(event: dict, db, ctx: GroupCtx) -> None:
    """message_allow: пользователь разрешил сообществу писать ему в личку.
    Регистрируем контакт + платформу + канал ЭТОГО клиента."""
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
            await _send_event_answer("Готово! Проверяйте сообщения 🎁")
        elif result == "not_subscribed":
            client_id = await db.fetchval("SELECT client_id FROM funnel_runs WHERE id=$1", run_id)
            brand_ctx = await _get_brand_context(client_id, db) if client_id else {}
            chan = brand_ctx.get("subscription_channel", "")
            await _send_event_answer(f"Не вижу подписки на {chan}. Подпишитесь и нажмите снова.")
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

    # Уведомление организатору в его TG-канал #user_message + отвечаем юзеру.
    await _forward_user_message_to_organizer(db, ctx, from_id=int(from_id), text=text)
    await _reply_to_user_message(ctx, peer_id=int(from_id))


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


async def _reply_to_user_message(ctx: "GroupCtx", *, peer_id: int) -> None:
    """Шлёт пользователю короткий ответ с направлением в Экосистему.

    К ответу прикрепляем VK-клавиатуру с inline-кнопкой, которая открывает
    Mini App сразу на нужной вкладке (через #hub_tab{name}).
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
