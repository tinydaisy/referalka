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
import re
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
    """Ищет `ref=prt_<int>` — старый прокси-формат партнёрки (deprecated)."""
    return _extract_ref_with_prefix(message_or_event, "prt_")


def _extract_partner_direct_ref(message_or_event: dict) -> str | None:
    """Ищет `ref=prtc_<n>` или `ref=prtp_<n>` — прямые партнёрские ссылки (рефакторинг 24.05.2026).

    Возвращает полную строку ref (включая префикс) или None.
    """
    candidates = []
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
        if s.startswith("prtc_") or s.startswith("prtp_"):
            return s
    return None


def _extract_partner_done_client_id(message_or_event: dict) -> int | None:
    """Ищет `ref=partner_done_<int>` — возврат после сабмита партнёрской формы.

    Партнёрский сервис в редирект-после-формы ставит vk.me/{group}?ref=
    partner_done_<client_id>. VK кладёт ref в первое сообщение пользователя.
    """
    return _extract_ref_with_prefix(message_or_event, "partner_done_")


def _extract_speaker_self_register_event_id(message_or_event: dict) -> int | None:
    """Ищет `ref=spkreg_<event_id>` — корневая ссылка саморегистрации спикером
    (2026-05-29). VK: одношаговая регистрация — пользователь нажал по ссылке,
    мы сразу создаём коллаба и шлём ссылку spkinv_<access_code>."""
    return _extract_ref_with_prefix(message_or_event, "spkreg_")


def _extract_speaker_invite_code(message_or_event: dict) -> str | None:
    """Ищет `ref=spkinv_<access_code>` — invite-ссылка кабинета спикера (миграция 108).

    Access_code — 8 симв строка из безопасного алфавита, не int. Поэтому свой
    мини-экстрактор: тот же поиск кандидатов, но без try-int.
    """
    candidates = []
    msg = message_or_event.get("message") or {}
    if isinstance(msg, dict):
        candidates.extend([msg.get("ref"), msg.get("ref_source")])
        payload_raw = msg.get("payload")
        if payload_raw:
            try:
                import json as _json
                payload = _json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
                if isinstance(payload, dict):
                    candidates.append(payload.get("ref"))
            except Exception:
                pass
    candidates.extend([message_or_event.get("ref"), message_or_event.get("ref_source")])
    for c in candidates:
        if not c:
            continue
        s = str(c).strip()
        if s.startswith("spkinv_"):
            return s.removeprefix("spkinv_") or None
    return None


# Триггер «ИВЕНТ<id>» в свободном тексте личных сообщений ВК-сообщества.
# Клиент говорит подписчикам: «напиши ИВЕНТ24» — бот по числу = events.id
# шлёт воронку события (незарег → 2 кнопки, зарег → меню кабинета).
# Ловим: «ивент24», «ИВЕНТ 24», «Ивент-24», «event24», «menu24» — рус. «ивент»
# и лат. «event»/«menu» + число, любой регистр, опциональный пробел/дефис между.
# Слово должно быть отдельным (а не куском другого слова), число — первое после.
_EVENT_TRIGGER_RE = re.compile(
    r"(?:^|\b)(?:ивент|event|menu)\s*[-–—]?\s*(\d{1,9})\b",
    re.IGNORECASE,
)


def _extract_event_trigger_id(text: str) -> int | None:
    """Из текста вида «ИВЕНТ24» возвращает 24. Иначе None."""
    if not text:
        return None
    m = _EVENT_TRIGGER_RE.search(text)
    if not m:
        return None
    try:
        return int(m.group(1))
    except (ValueError, TypeError):
        return None


async def _handle_speaker_self_register_vk(
    event_id: int, user_id: int, db, ctx: "GroupCtx",
) -> None:
    """Саморегистрация спикером события (2026-05-29). Одношаговая для VK:
    пользователь явно кликнул по `vk.me/{group}?ref=spkreg_<event_id>` →
    апсертим contact, создаём коллаба + event_collaborators, шлём ссылку
    spkinv_<access_code> для входа в кабинет."""
    from app.services.speaker_self_register import (
        get_event_for_self_register, complete_speaker_self_register,
    )
    from app.services.contact_merge import upsert_contact_with_identity
    from app.services.channels import get_client_telegram_token
    ev = await get_event_for_self_register(db, event_id)
    if not ev:
        try:
            await vk_send_message(user_id, "😕 Событие не найдено.", token=ctx.token)
        except Exception:
            pass
        return

    contact_id, _pu, _is_new = await upsert_contact_with_identity(
        db,
        client_id=ev["client_id"],
        platform_slug='vk',
        platform_user_id=str(user_id),
        username="",
        first_name="",
        last_name="",
    )
    contact_name = await db.fetchval(
        "SELECT name FROM contacts WHERE id = $1", contact_id,
    )
    # Если контакт уже спикер этого события → не регистрируем заново,
    # просто шлём ссылку на кабинет (универсальная ссылка работает для
    # уже-добавленных).
    from app.services.speaker_self_register import find_existing_speaker
    existing = await find_existing_speaker(
        db, event_id=event_id, client_id=ev["client_id"], contact_id=contact_id,
    )
    try:
        if existing:
            coll_id = existing["collaborator_id"]
            access_code = existing["access_code"]
            slug = existing["event_slug"]
            already = True
        else:
            coll_id, access_code, slug, already = await complete_speaker_self_register(
                db,
                event_id=event_id,
                client_id=ev["client_id"],
                contact_id=contact_id,
                contact_name=contact_name or "Спикер",
            )
    except Exception as e:
        logger.exception("VK speaker_self_register failed: %s", e)
        try:
            await vk_send_message(user_id, "Что-то пошло не так. Попробуйте позже.", token=ctx.token)
        except Exception:
            pass
        return

    # Ссылка на TG-бот клиента (или системный) с spkinv_<code>.
    # У клиента может быть только TG-канал для кабинета — даём универсальную
    # ссылку через @pluson_bot если своего TG-бота нет.
    tg_token = await get_client_telegram_token(ev["client_id"], db)
    bot_handle = "pluson_bot"
    if tg_token:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=5) as http:
                r = await http.get(f"https://api.telegram.org/bot{tg_token}/getMe")
            data = r.json()
            if data.get("ok"):
                bot_handle = (data["result"].get("username") or bot_handle).lstrip("@")
        except Exception:
            pass
    spkinv_url = f"https://t.me/{bot_handle}?start=spkinv_{access_code}"

    if already:
        text = (
            f"Вы уже спикер «{ev['title']}».\n\nОткройте свой кабинет: {spkinv_url}\n"
            f"Код доступа: {access_code}"
        )
    else:
        text = (
            f"Готово! Вы включены в спикеры «{ev['title']}».\n\n"
            f"Откройте свой кабинет и заполните данные: {spkinv_url}\n"
            f"Код доступа: {access_code}"
        )
    try:
        await vk_send_message(user_id, text, token=ctx.token)
    except Exception as e:
        logger.warning("VK spkreg send_message failed: %s", e)


async def _handle_speaker_invite_vk(access_code: str, user_id: int, db, ctx: "GroupCtx") -> bool:
    """Если код доступа коллаба совпал — шлём в личку код + ссылку на лендинг.
    Возвращает True если обработка произошла (и дальнейшие хендлеры пропускаются).
    """
    coll = await db.fetchrow(
        """SELECT c.id AS collaborator_id, c.name, c.contact_id, c.created_by_client_id
             FROM collaborators c
            WHERE LOWER(c.access_code) = LOWER($1)""",
        access_code,
    )
    if not coll:
        return False

    from app.api.collaborators import _upsert_personal_identity
    foreign_owner = False
    if coll["contact_id"] and coll["created_by_client_id"]:
        try:
            res = await _upsert_personal_identity(
                db, coll["created_by_client_id"], coll["contact_id"],
                'vk', str(user_id), None,
            )
            if isinstance(res, dict) and res.get("status") == "foreign_owner":
                foreign_owner = True
        except Exception as e:
            logger.warning("VK spkinv upsert identity failed: %s", e)

    if foreign_owner:
        sp_name = (coll["name"] or "").strip() or "спикер"
        try:
            await vk_send_message(
                int(user_id),
                (
                    f"⚠️ Вы зашли не с того аккаунта.\n\n"
                    f"Эта ссылка выдана спикеру «{sp_name}». Ваш VK-аккаунт уже привязан к другому контакту у этого клиента, "
                    f"поэтому я не могу записать вас как спикера.\n\n"
                    f"Попросите самого спикера открыть ссылку со своего личного VK, либо передайте ссылку его ассистенту."
                ),
                token=ctx.token,
            )
        except Exception as e:
            logger.warning("VK spkinv foreign-owner message failed: %s", e)
        return True

    ev = await db.fetchrow(
        """SELECT e.slug, e.title
             FROM event_collaborators ec
             JOIN events e ON e.id = ec.event_id
            WHERE ec.speaker_id = $1
            ORDER BY ec.id DESC LIMIT 1""",
        coll["collaborator_id"],
    )
    event_slug = ev["slug"] if ev else ""
    event_title = ev["title"] if ev else "событие"
    name = (coll["name"] or "").strip() or "спикер"
    cabinet_url = f"https://pluson.ru/speaker/{event_slug}" if event_slug else "https://pluson.ru/speaker/"

    text = (
        f"Здравствуйте, {name}!\n\n"
        f"Вы — спикер «{event_title}». Чтобы заполнить свои данные для участников события, "
        f"откройте свой кабинет:\n{cabinet_url}\n\n"
        f"Код доступа: {access_code}\n\n"
        f"На странице выберите свою фамилию из списка и введите этот код. "
        f"Сессия живёт 24 часа. Можно передать ссылку и код ассистенту."
    )
    try:
        keyboard = None
        if event_slug:
            keyboard = tg_inline_to_vk_keyboard([[
                {"text": "📝 Открыть мой кабинет", "url": cabinet_url},
            ]])
        await vk_send_message(int(user_id), text, keyboard=keyboard, token=ctx.token)
    except Exception as e:
        logger.warning("VK spkinv messages.send failed: %s", e)
    return True


async def handle_message_allow(event: dict, db, ctx: GroupCtx) -> None:
    """message_allow: пользователь разрешил сообществу писать ему в личку.
    Регистрируем контакт + платформу + канал ЭТОГО клиента.

    Если в событии есть ref=fnl_<run_id> — запускаем VK-воронку лид-магнита."""
    user_id = event.get("user_id")
    if not user_id:
        return

    _ref = event.get("ref") or event.get("ref_source")
    try:
        logger.info(
            "VK message_allow group=%s user=%s ref=%r",
            ctx.group_id, user_id, _ref,
        )
    except Exception:
        pass
    # ЛОГ ССЫЛКИ ПЕРЕХОДА — ref из vk.me?ref=... приходит сюда при первом разрешении ЛС.
    try:
        from app.services.entry_link_log import log_entry_link
        await log_entry_link(
            db, platform="vk", platform_user_id=user_id, raw_param=_ref,
            launch_params={"src": "message_allow", "group_id": ctx.group_id},
        )
    except Exception:
        pass
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

    # Регистрация партнёра — прямые ссылки (рефакторинг 24.05.2026)
    partner_direct_ref = _extract_partner_direct_ref(event)
    if partner_direct_ref:
        try:
            user_info = await get_user_info(int(user_id))
            from app.services.partner_service import start_partner_flow_vk
            handled = await start_partner_flow_vk(
                partner_direct_ref, str(user_id),
                username=(user_info or {}).get("screen_name", "") if user_info else "",
                first_name=(user_info or {}).get("first_name", "") if user_info else "",
                last_name=(user_info or {}).get("last_name", "") if user_info else "",
                db=db,
                channel_id=ctx.channel_id,
                token=ctx.token,
            )
            if handled:
                return
        except Exception as e:
            logger.warning("VK message_allow partner direct start failed: %s", e)

    # Старый прокси-формат prt_<run_id> (deprecated, для совместимости)
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

    # Саморегистрация спикером (2026-05-29): ref=spkreg_<event_id>.
    # Одношаговая для VK — пользователь явно кликнул по корневой ссылке.
    spkreg_event_id = _extract_speaker_self_register_event_id(event)
    if spkreg_event_id:
        try:
            await _handle_speaker_self_register_vk(spkreg_event_id, int(user_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK message_allow spkreg failed: %s", e)

    # Самообслуживание спикера: ref=spkinv_<access_code> (миграция 108).
    spk_code = _extract_speaker_invite_code(event)
    if spk_code:
        try:
            handled = await _handle_speaker_invite_vk(spk_code, int(user_id), db, ctx)
            if handled:
                return
        except Exception as e:
            logger.warning("VK message_allow spkinv failed: %s", e)

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
        return

    # Меню события (порт TG evchat_/evmenu_/evlive_ из handlers/funnel.py).
    if cb.startswith("evchat_") or cb.startswith("evmenu_") or cb.startswith("evlive_"):
        prefix, _, id_raw = cb.partition("_")
        try:
            ev_id = int(id_raw)
        except ValueError:
            await _send_event_answer("Ошибка кнопки")
            return
        from bot.vk_event_menu import (
            handle_vk_event_chat, handle_vk_event_menu_back, handle_vk_event_live,
        )
        try:
            if prefix == "evchat":
                await handle_vk_event_chat(ev_id, int(user_id), db, ctx)
            elif prefix == "evmenu":
                await handle_vk_event_menu_back(ev_id, int(user_id), db, ctx)
            elif prefix == "evlive":
                await handle_vk_event_live(ev_id, int(user_id), db, ctx)
            await _send_event_answer("Готово 👇")
        except Exception as e:
            logger.warning(f"VK event menu callback '{cb}' failed: {e}")
            await _send_event_answer("Что-то пошло не так. Попробуйте позже.")
        return


_MERGE_USAGE_VK = (
    "Объединение аккаунтов\n\n"
    "Если вы заходили к этому организатору и в ВКонтакте, и в Telegram, и в MAX — "
    "можно слить всё в один профиль (рефералы, регистрации и подарки сложатся вместе).\n\n"
    "1. Узнайте свой ID на другой площадке командой /getmyid в её боте.\n"
    "2. Пришлите сюда:\n"
    "/merge tg ВАШ_TG_ID\n"
    "/merge max ВАШ_MAX_ID\n"
    "/merge vk ВАШ_VK_ID\n\n"
    "Например: /merge tg 12345678"
)


async def _handle_vk_merge(text: str, from_id: int, db, ctx: GroupCtx) -> None:
    """Объединить VK-аккаунт человека с его аккаунтом на другой площадке.
    Главный контакт — самый ранний, реферер на событие — непустой/от раннего."""
    from app.services.vk_api import send_message as _vk_send
    from app.services.contact_merge import (
        merge_my_account_with_identity, find_contact_by_identity,
    )

    async def _reply(msg: str):
        try:
            await _vk_send(from_id, msg, token=ctx.token)
        except Exception as e:
            logger.warning(f"VK merge reply failed: {e}")

    parts = text.strip().split()
    # parts[0] = '/merge'
    if len(parts) < 3:
        await _reply(_MERGE_USAGE_VK)
        return
    aliases = {"telegram": "telegram", "tg": "telegram", "vk": "vk",
               "вк": "vk", "max": "max", "макс": "max", "мах": "max"}
    other_platform = aliases.get(parts[1].lower())
    other_id_raw = parts[2].lstrip("@").strip()
    if other_platform not in ("telegram", "vk", "max") or not other_id_raw.isdigit():
        await _reply(_MERGE_USAGE_VK)
        return

    if other_platform == "vk" and other_id_raw == str(from_id):
        await _reply("Это ваш текущий VK-аккаунт — объединять не с чем.")
        return

    current_contact_id = await find_contact_by_identity(
        db, client_id=ctx.client_id, platform_slug="vk",
        platform_user_id=str(from_id),
    )
    if not current_contact_id:
        await _reply(
            "Сначала зайдите в любое событие этого организатора, "
            "чтобы создать профиль, потом повторите объединение."
        )
        return

    res = await merge_my_account_with_identity(
        db, client_id=ctx.client_id, current_contact_id=current_contact_id,
        other_platform_slug=other_platform, other_platform_user_id=other_id_raw,
    )
    if res["status"] == "not_found":
        plat_name = {"telegram": "Telegram", "vk": "ВКонтакте", "max": "MAX"}[other_platform]
        await _reply(
            f"😕 Не нашёл аккаунт {plat_name} с ID {other_id_raw} у этого организатора.\n\n"
            "Проверьте ID (узнайте его командой /getmyid в нужном боте) "
            "и заходили ли вы к этому организатору с той площадки."
        )
    elif res["status"] == "already":
        await _reply("✅ Эти аккаунты уже объединены — ничего делать не нужно.")
    else:
        await _reply(
            "✅ Готово! Аккаунты объединены в один профиль. "
            "Рефералы, регистрации и подарки теперь общие."
        )


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

    # Обрабатываем ТОЛЬКО личку с сообществом (один на один). Сообщения из
    # беседы/мультичата сообщества (peer_id = 2000000000 + chat_id) игнорируем —
    # иначе бот реагирует на каждую реплику в общем чате (досылает воронку,
    # пересылает организатору и т.п.). В личке VK всегда peer_id == from_id.
    peer_id = message.get("peer_id")
    if peer_id is not None and int(peer_id) != int(from_id):
        return

    # /getmyid — узнать свой VK ID для поля тестовых ID в Настройках.
    if (message.get("text") or "").strip().lower().startswith("/getmyid"):
        try:
            from app.services.vk_api import send_message as _vk_send
            await _vk_send(
                int(from_id),
                f"Ваш VK ID: {from_id}\n\n"
                "Вставьте это число в поле тестовых VK-ID в Настройках → Технические, "
                "чтобы получать тестовые рассылки.",
                token=ctx.token,
            )
        except Exception as e:
            logger.warning(f"VK /getmyid failed: {e}")
        return

    # /merge <платформа> <id> — объединить аккаунты с другой площадки.
    if (message.get("text") or "").strip().lower().startswith("/merge"):
        await _handle_vk_merge(message.get("text") or "", int(from_id), db, ctx)
        return

    # Диагностика для spkinv: логируем что VK прислал в ref-полях.
    try:
        diag_ref = message.get("ref") or message.get("ref_source") or event_obj.get("ref")
        diag_payload = message.get("payload")
        logger.info(
            "VK message_new group=%s from=%s ref=%r payload=%r text=%r",
            ctx.group_id, from_id, diag_ref, diag_payload,
            (message.get("text") or "")[:50],
        )
    except Exception:
        pass

    # ЛОГ ССЫЛКИ ПЕРЕХОДА — ref/payload из входящего сообщения (vk.me?ref=evl_..._pid...).
    try:
        from app.services.entry_link_log import log_entry_link
        _ref_new = message.get("ref") or message.get("ref_source") or event_obj.get("ref")
        await log_entry_link(
            db, platform="vk", platform_user_id=from_id, raw_param=_ref_new,
            launch_params={"src": "message_new", "group_id": ctx.group_id,
                           "payload": message.get("payload"), "text": (message.get("text") or "")[:80]},
        )
    except Exception:
        pass

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

    # Прямые партнёрские ссылки prtc_/prtp_ (рефакторинг 24.05.2026)
    partner_direct_ref = _extract_partner_direct_ref(event_obj)
    if partner_direct_ref:
        try:
            user_info = await get_user_info(int(from_id))
            from app.services.partner_service import start_partner_flow_vk
            handled = await start_partner_flow_vk(
                partner_direct_ref, str(from_id),
                username=(user_info or {}).get("screen_name", "") if user_info else "",
                first_name=(user_info or {}).get("first_name", "") if user_info else "",
                last_name=(user_info or {}).get("last_name", "") if user_info else "",
                db=db,
                channel_id=ctx.channel_id,
                token=ctx.token,
            )
            if handled:
                return
        except Exception as e:
            logger.warning("VK message_new partner direct start failed: %s", e)

    # Старый прокси-формат (deprecated)
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

    # Саморегистрация спикером (2026-05-29): ref=spkreg_<event_id>.
    spkreg_event_id = _extract_speaker_self_register_event_id(event_obj)
    if spkreg_event_id:
        try:
            await _handle_speaker_self_register_vk(spkreg_event_id, int(from_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK message_new spkreg failed: %s", e)

    # Самообслуживание спикера (миграция 108).
    spk_code = _extract_speaker_invite_code(event_obj)
    if spk_code:
        try:
            handled = await _handle_speaker_invite_vk(spk_code, int(from_id), db, ctx)
            if handled:
                return
        except Exception as e:
            logger.warning("VK message_new spkinv failed: %s", e)

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

    # Триггер «ИВЕНТ<id>» — человек написал в личку слово вроде «ИВЕНТ24».
    # Шлём воронку события №24 (незарег → 2 кнопки, зарег → меню кабинета).
    # ВАЖНО: этот блок ВЫШЕ «досыла evl_» ниже — явный номер от пользователя
    # имеет приоритет над «угадай по недавней активности» (иначе бот пришлёт
    # последнее открытое событие, а не запрошенное).
    # Событие обязано принадлежать ЭТОМУ клиенту (нельзя дёрнуть чужой ивент
    # из чужого сообщества). Нет такого события → честно говорим, что не нашли.
    trigger_text = (message.get("text") or "").strip()
    trigger_event_id = _extract_event_trigger_id(trigger_text)
    if trigger_event_id is not None:
        try:
            from app.api.vk_event import send_vk_event_funnel, _EVENT_FUNNEL_FIELDS
            from app.services.external_landing import resolve_or_create_participant

            ev_row = await db.fetchrow(
                f"SELECT {_EVENT_FUNNEL_FIELDS} FROM events e "
                f"WHERE e.id = $1 AND e.id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status = 'accepted') LIMIT 1",
                trigger_event_id, ctx.client_id,
            )
            if not ev_row:
                # Нет события с таким номером у этого клиента — не молчим.
                await vk_send_message(
                    int(from_id),
                    f"Не нашёл событие №{trigger_event_id} 🤔\n\n"
                    "Возможно, в номере опечатка — проверьте и напишите ещё раз.",
                    token=ctx.token,
                )
                return

            _pid, contact_id = await resolve_or_create_participant(
                db, client_id=ctx.client_id, event_id=ev_row["id"],
                platform_slug="vk", platform_user_id=str(from_id),
            )
            is_registered = bool(await db.fetchval(
                "SELECT is_registered FROM event_participants "
                "WHERE event_id = $1 AND contact_id = $2",
                ev_row["id"], contact_id,
            )) if contact_id else False

            client_vk_app_id = await db.fetchval(
                """SELECT (ch.platform_meta->>'vk_app_id')::int
                     FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id = $1 AND cc.is_active = TRUE
                      AND ch.platform_slug = 'vk' AND ch.is_system = FALSE LIMIT 1""",
                ctx.client_id,
            )

            await send_vk_event_funnel(
                db,
                vk_user_id=int(from_id),
                token=ctx.token,
                client_vk_app_id=client_vk_app_id,
                event_row=ev_row,
                contact_id=contact_id,
                is_registered=is_registered,
            )
            return
        except Exception as e:
            logger.warning("VK message_new event-trigger (ИВЕНТ%s) failed: %s",
                           trigger_event_id, e)
            # Падать молча не хотим, но и спамить ошибкой юзеру незачем —
            # дальше пойдёт обычная обработка.

    # Досыл event-воронки (evl_): если человек открыл событие через лёгкую
    # заглушку, но ЛС не дошло из-за задержки разрешения VK — а теперь он САМ
    # написал боту (его явный «отправить» = разрешение точно есть), досылаем
    # воронку. Аналог «свежего landed-забега» у лид-магнита. Берём последнее
    # событие, открытое этим vk-контактом за 30 минут.
    try:
        recent_ev = await db.fetchval(
            """SELECT ep.event_id
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id
                                       AND pu.platform_slug = 'vk'
                                       AND pu.platform_user_id = $1
                 JOIN events e ON e.id = ep.event_id
                                AND e.id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status = 'accepted')
                WHERE ep.last_open_msg_at > NOW() - INTERVAL '30 minutes'
                ORDER BY ep.last_open_msg_at DESC
                LIMIT 1""",
            str(from_id), ctx.client_id,
        )
        if recent_ev:
            from app.api.vk_event import send_vk_event_funnel, _EVENT_FUNNEL_FIELDS
            ev_row = await db.fetchrow(
                f"SELECT {_EVENT_FUNNEL_FIELDS} FROM events e WHERE e.id = $1 LIMIT 1",
                recent_ev,
            )
            if ev_row:
                cinfo = await db.fetchrow(
                    """SELECT ep.contact_id, ep.is_registered,
                              (SELECT (ch.platform_meta->>'vk_app_id')::int
                                 FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
                                WHERE cc.client_id = $2 AND cc.is_active = TRUE
                                  AND ch.platform_slug = 'vk' AND ch.is_system = FALSE LIMIT 1) AS vk_app_id
                         FROM event_participants ep
                        WHERE ep.event_id = $1
                          AND ep.contact_id = (SELECT contact_id FROM platform_users
                                                WHERE platform_slug='vk' AND platform_user_id=$3
                                                  AND client_id=$2 LIMIT 1)
                        LIMIT 1""",
                    recent_ev, ctx.client_id, str(from_id),
                )
                if cinfo:
                    await send_vk_event_funnel(
                        db,
                        vk_user_id=int(from_id),
                        token=ctx.token,
                        client_vk_app_id=cinfo["vk_app_id"],
                        event_row=ev_row,
                        contact_id=cinfo["contact_id"],
                        is_registered=bool(cinfo["is_registered"]),
                    )
                    return
    except Exception as e:
        logger.warning("VK message_new event-funnel resend failed: %s", e)

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


async def handle_group_join(event: dict, db, ctx: GroupCtx) -> None:
    """group_join: пользователь подписался на СООБЩЕСТВО (стену).

    Записываем его в базу как контакт + VK-идентичность + подписку на VK-канал
    клиента. ВАЖНО: подписка на сообщество ≠ разрешение писать в ЛС — рассылку
    этому человеку слать нельзя, пока он отдельно не нажал «Разрешить сообщения»
    (message_allow). Но контакт фиксируем для аналитики и связки.
    """
    user_id = event.get("user_id")
    if not user_id:
        return
    join_type = event.get("join_type")  # join | unsure | accepted | approved | request
    logger.info("VK group_join group=%s user=%s type=%s", ctx.group_id, user_id, join_type)

    # ЛОГ ССЫЛКИ ПЕРЕХОДА — фиксируем вступление в сообщество и весь event (вдруг ref).
    try:
        from app.services.entry_link_log import log_entry_link
        await log_entry_link(
            db, platform="vk", platform_user_id=user_id,
            raw_param=event.get("ref") or event.get("ref_source"),
            launch_params={"src": "group_join", "group_id": ctx.group_id,
                           "join_type": join_type, "event": {k: v for k, v in event.items() if k != "user_id"}},
        )
    except Exception:
        pass

    try:
        user_info = await get_user_info(int(user_id))
    except Exception:
        user_info = None
    await upsert_contact_with_identity(
        db,
        client_id=ctx.client_id,
        platform_slug="vk",
        platform_user_id=str(user_id),
        username=(user_info or {}).get("screen_name") or None,
        first_name=(user_info or {}).get("first_name") or None,
        last_name=(user_info or {}).get("last_name") or None,
    )
    # Подписка на VK-канал клиента (тот же паттерн, что в handle_message_allow).
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
    logger.info("VK group_join: group=%s user=%s recorded", ctx.group_id, user_id)


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
        elif t == "group_join":
            await handle_group_join(obj, db, ctx)
        # message_reply, group_leave — не обрабатываем пока
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
