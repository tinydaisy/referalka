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
from app.services.client_domains import (
    client_public_link, client_public_url, platform_base_url, public_url_for,
)
from app.services.share_links import TG_DOMAIN

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
        # ⚠️ Вступление и выход из сообщества. Обработчики (handle_group_join /
        # handle_group_leave) были написаны давно, а события у ВКонтакте НЕ
        # запрашивались — то есть до нас они не доходили вовсе, и подписчики
        # сообщества в базе появлялись только побочно, через заходы в Mini App.
        # Это ровно то, что в Telegram делает my_chat_member.
        "group_join": 1,
        "group_leave": 1,
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


def _ref_candidates(message_or_event: dict) -> list[str]:
    """Все места, куда VK может положить метку `ref` из ссылки vk.me/group?ref=…

    Источники (для message_new + message_allow):
      - object.message.ref        — обычное место
      - object.message.payload    — JSON с ключом ref (stub-кнопка «Начать»)
      - object.ref                — поле самого события (message_allow)
      - object.message.ref_source — иногда содержит метку

    ⚠️ Один сборщик на всех потребителей: раньше список источников жил внутри
    `_extract_ref_with_prefix`, и «строковые» метки (реф-код ПЛЮСОНа) пришлось
    бы разбирать своей копией — она бы разъехалась с этой.
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
    return [str(c).strip() for c in candidates if c]


def _extract_ref_with_prefix(message_or_event: dict, prefix: str) -> int | None:
    """Ищет `ref={prefix}<int>` в полях VK события и возвращает int-часть."""
    for s in _ref_candidates(message_or_event):
        if s.startswith(prefix):
            try:
                return int(s[len(prefix):])
            except ValueError:
                continue
    return None


def _extract_plusson_ref(message_or_event: dict) -> tuple[str | None, str | None]:
    """Ищет ПЛЮСОН-реф-код: `ref=ref<8симв>[-<источник>]`. Вернёт (код, источник).

    ⚠️ Не путать с `ref_pg{slug}` (ссылка на событие) — там после `ref` идёт
    `_pg`, а строгий формат кода (8 символов безопасного алфавита) его не
    матчит. Проверять этот код надо ДО разбора ссылок событий.

    ⚠️ Источник достаём ЗДЕСЬ ЖЕ, одним проходом по кандидатам: вторым проходом
    он мог бы прийти из другой метки того же события и приписаться к чужому
    коду.
    """
    from app.services.plusson_referral import (
        parse_plusson_ref_payload, parse_plusson_ref_source,
    )
    for s in _ref_candidates(message_or_event):
        code = parse_plusson_ref_payload(s)
        if code:
            return code, parse_plusson_ref_source(s)
    return None, None


def _extract_partner_invite(message_or_event: dict) -> int | None:
    """Ищет `ref=bpr_<client_id>` — приглашение в партнёрскую программу.

    ⚠️ Метка строковая, поэтому разбирается тут, а не через
    `_extract_ref_with_prefix` (тот вытаскивает int-метки вроде `fnl_`).
    """
    from app.services.partner_invite import parse_invite_payload
    for s in _ref_candidates(message_or_event):
        cid = parse_invite_payload(s)
        if cid:
            return cid
    return None


def _extract_product_payload(message_or_event: dict) -> dict | None:
    """Ищет `ref=pr_<slug>[_pid<код>]` — ссылка на продукт (решение № 24).

    ⚠️ Метка СТРОКОВАЯ, поэтому идёт мимо `_extract_ref_with_prefix` (тот
    вытаскивает int-метки вроде `fnl_`/`evchat_`). Разбор — общий с TG и MAX,
    свой парсер здесь не пишем: разъедется.
    """
    from app.services.product_deeplink import parse_product_payload
    for s in _ref_candidates(message_or_event):
        parsed = parse_product_payload(s)
        if parsed:
            return parsed
    return None


def _extract_text_token(message_or_event: dict) -> str | None:
    """Ищет `ref=txt_<токен>` — человек пришёл с текстом, написанным на сайте.

    ⚠️ Метка СТРОКОВАЯ, поэтому мимо `_extract_ref_with_prefix` (тот тянет
    int-метки). Сам текст в метке не едет: он лежит у нас, разбор общий с TG и
    MAX (`services/bot_text_request`).
    """
    from app.services.bot_text_request import is_text_token
    for s in _ref_candidates(message_or_event):
        if is_text_token(s):
            return s
    return None


async def _vk_handle_saved_text(token: str, user_id: int, db, ctx) -> bool:
    """Показывает в ВК текст, написанный человеком на сайте.

    ⚠️ Зеркало телеграмной `_send_saved_text` и максовой `_send_max_saved_text`:
    чтение текста общее, различается только транспорт. ВК шлём БЕЗ HTML.
    """
    from app.services import bot_text_request

    try:
        saved = await bot_text_request.take_text(db, token, platform="vk")
    except Exception as e:  # noqa: BLE001
        logger.warning("VK saved text fetch failed: %s", e)
        return False
    if not saved:
        return False

    text = (saved.get("text") or "").strip()
    kind = saved.get("kind") or "service"
    intro = {
        "service": ("✅ Заявка принята — мы получили ваше описание.\n\n"
                    "Сейчас посмотрим, что нужно сделать, и напишем вам сюда: "
                    "уточним детали и назовём стоимость. Если что-то забыли "
                    "добавить — просто отправьте следующим сообщением."),
        "autosetup": ("✅ Заявка принята — мы получили ваше описание.\n\n"
                      "Ответим сюда, как разберёмся, что нужно настроить."),
        "support": ("✅ Вопрос принят — мы его получили.\n\n"
                    "Ответим вам сюда. Если нужно что-то добавить — "
                    "отправьте следующим сообщением."),
    }.get(kind, "✅ Заявка принята.")

    try:
        await vk_send_message(user_id, f"{intro}\n\nВы написали:\n{text}",
                              token=ctx.token)
    except Exception as e:  # noqa: BLE001
        logger.warning("VK saved text answer failed: %s", e)

    try:
        import html as _html

        from app.services.channels import notify_organizer_all_channels
        service_id = await db.fetchval(
            "SELECT id FROM clients WHERE is_system_service = TRUE ORDER BY id LIMIT 1"
        )
        if service_id:
            await notify_organizer_all_channels(
                client_id=service_id,
                text_html=(f"📝 <b>Новая заявка на персональную настройку</b>\n"
                           f"От: id {user_id} (ВКонтакте)\n\n"
                           f"{_html.escape(text)}"),
                db=db,
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("VK saved text notify failed: %s", e)

    return True


def _extract_funnel_run_id(message_or_event: dict) -> int | None:
    """Ищет `ref=fnl_<int>` — воронка лид-магнита."""
    return _extract_ref_with_prefix(message_or_event, "fnl_")


def _extract_lead_magnet_ref(message_or_event: dict):
    """Ищет `ref=m_<slug>` (лид-магнит) или `ref=p_<slug>` (пакет) в полях VK.

    Прямая ссылка в чат vk.me/{group}?ref=m_<slug> — альтернатива Mini App
    (vk.com/app{id}#m_slug), который при «холодном» запуске теряет payload
    (VK ставит vk_ref='other'). Возвращает ('m'|'p', slug) или None."""
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
        for kind in ("m", "p"):
            if s.startswith(f"{kind}_"):
                slug = s[len(kind) + 1:]
                # slug лид-магнита — [a-z0-9] (5 симв). Отсекаем ложные срабатывания
                # вроде "partner_done_" (начинается на p_? нет — на "partner").
                if slug and slug.replace("-", "").isalnum():
                    return (kind, slug)
    return None


async def _start_vk_lead_magnet_by_slug(kind: str, slug: str, user_id: int, db, ctx) -> bool:
    """Создаёт funnel_run по slug лид-магнита/пакета клиента этого сообщества и
    запускает VK-воронку (Текст 1). Возвращает True если воронка стартовала."""
    try:
        if kind == "m":
            row = await db.fetchrow(
                "SELECT id FROM lead_magnets WHERE slug=$1 AND client_id=$2", slug, ctx.client_id)
            lm_id, pkg_id = (row["id"] if row else None), None
        else:
            row = await db.fetchrow(
                "SELECT id FROM lead_magnet_packages WHERE slug=$1 AND client_id=$2", slug, ctx.client_id)
            lm_id, pkg_id = None, (row["id"] if row else None)
        if not row:
            return False
        run_id = await db.fetchval(
            """INSERT INTO funnel_runs
                  (client_id, type, lead_magnet_id, package_id, contact_id,
                   referrer_contact_id, utm, stage, landed_at, platform_slug)
               VALUES ($1,'lead_magnet',$2,$3,NULL,NULL,'{}'::jsonb,'landed',NOW(),'vk')
               RETURNING id""",
            ctx.client_id, lm_id, pkg_id,
        )
        user_info = await get_user_info(int(user_id))
        from app.services.funnel_service import run_started_vk
        await run_started_vk(
            run_id, str(user_id),
            username=(user_info or {}).get("screen_name", "") if user_info else "",
            first_name=(user_info or {}).get("first_name", "") if user_info else "",
            last_name=(user_info or {}).get("last_name", "") if user_info else "",
            db=db, channel_id=ctx.channel_id, token=ctx.token,
        )
        logger.info("VK lead-magnet by ref: kind=%s slug=%s run=%s client=%s user=%s",
                    kind, slug, run_id, ctx.client_id, user_id)
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("VK _start_vk_lead_magnet_by_slug failed (%s_%s): %s", kind, slug, e)
        return False


def _extract_event_chat_id(message_or_event: dict) -> int | None:
    """Ищет `ref=evchat_<event_id>` — кнопка «Чат события» с веб-страницы
    /event/{slug}. Ведёт сразу на «вступить в чат» (проверка подписки на
    VK-сообщества спикеров + выдача чат-ссылок)."""
    return _extract_ref_with_prefix(message_or_event, "evchat_")


def _extract_event_live_id(message_or_event: dict) -> int | None:
    """Ищет `ref=evlive_<event_id>` — внешняя ссылка на эфир. Даёт то же
    сообщение, что кнопка «Ссылка на эфир» в меню события, но сразу."""
    return _extract_ref_with_prefix(message_or_event, "evlive_")


def _extract_event_support_id(message_or_event: dict) -> int | None:
    """Ищет `ref=evsupport_<event_id>` — кнопка «Тех.поддержка» из рассылки.
    Даёт то же сообщение, что кнопка «Тех.поддержка» в меню события."""
    return _extract_ref_with_prefix(message_or_event, "evsupport_")


def _extract_evreg_payload(message_or_event: dict) -> str | None:
    """Возвращает сырой ref `evreg_<eid>_ct<cid>` (кнопка «Регистрация на событие»
    из вебинара) — тут нужен полный payload, а не только число, поэтому свой парс."""
    for key in ("ref", "ref_source"):
        v = message_or_event.get(key)
        if isinstance(v, str) and v.startswith("evreg_"):
            return v
    payload = message_or_event.get("payload")
    if isinstance(payload, dict):
        v = payload.get("ref")
        if isinstance(v, str) and v.startswith("evreg_"):
            return v
    return None


async def _vk_handle_evreg(payload: str, vk_user_id: int, username: str | None,
                           first_name: str | None, db, ctx) -> bool:
    """Регистрация на событие из вебинара (VK): привязать реальный VK-аккаунт к
    контакту + зарегистрировать + подтвердить + открыть меню. True если обработано."""
    from app.services import webinar_service as _ws
    from app.services.vk_api import send_message as _vk_send
    parsed = _ws.parse_evreg_payload(payload)
    if not parsed:
        return False
    eid, ct_hint = parsed
    clid = await db.fetchval(
        "SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=$1 "
        "AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1", eid)
    if not clid or clid != ctx.client_id:
        return False
    try:
        res = await _ws.register_event_from_deeplink(
            db, client_id=clid, event_id=eid, contact_id_hint=ct_hint,
            platform="vk", platform_user_id=vk_user_id,
            username=username, first_name=first_name)
        await _vk_send(vk_user_id,
                       f"✅ Вы зарегистрированы на «{res['event_title']}»! "
                       "Мы сохранили ваше участие.", token=ctx.token)
        from bot.vk_event_menu import handle_vk_event_menu_back
        await handle_vk_event_menu_back(eid, int(vk_user_id), db, ctx)
    except Exception as e:
        logger.warning(f"VK evreg failed (event={eid}): {e}")
    return True


async def _vk_handle_partner_invite(client_id_from_ref: int, vk_user_id: int,
                                    username: str | None, first_name: str | None,
                                    last_name: str | None, db, ctx) -> bool:
    """`vk.me/{group}?ref=bpr_<client_id>` — приглашение в партнёрку."""
    from app.services.vk_api import send_message as _vk_send, tg_inline_to_vk_keyboard
    from app.services.contact_merge import upsert_contact_with_identity
    from app.services.partner_invite import (
        build_invite_message, already_partner, build_cabinet_message,
    )

    # ⚠️ Клиент берётся у СООБЩЕСТВА, а не из метки: метку можно прислать
    # любую, а человек пишет в конкретный бот — его база и решает.
    client_id = ctx.client_id or client_id_from_ref
    if not client_id:
        return False

    contact_id = None
    try:
        contact_id, _pu, _new = await upsert_contact_with_identity(
            db, client_id=client_id, platform_slug="vk",
            platform_user_id=str(vk_user_id), username=username or None,
            first_name=first_name or None, last_name=last_name or None,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("VK bpr_: контакт не резолвлен: %s", e)

    if await already_partner(db, client_id, contact_id):
        msg = await build_cabinet_message(db, client_id, contact_id=contact_id)
    else:
        msg = await build_invite_message(db, client_id, contact_id=contact_id)
    if not msg:
        return False

    # ⚠️ VK не разбирает HTML — срезаем теги, иначе человек увидит <b> текстом.
    text = msg["text"].replace("<b>", "").replace("</b>", "")
    kb = tg_inline_to_vk_keyboard([[{"text": msg["button"], "url": msg["url"]}]])
    await _vk_send(vk_user_id, text, token=ctx.token, keyboard=kb)
    return True


async def _vk_handle_product_link(parsed: dict, vk_user_id: int,
                                  username: str | None, first_name: str | None,
                                  last_name: str | None, db, ctx) -> bool:
    """Вход по ссылке продукта в ВК: `vk.me/{group}?ref=pr_<slug>`.

    Зеркало TG- и MAX-веток. Возвращает True, если ответили.

    ⚠️ Внешняя ссылка идёт НАСТОЯЩЕЙ кнопкой: проверено живой отправкой —
    VK принимает и показывает open_link на чужой домен (прежнее правило
    «класть ссылку в текст» неверно).
    """
    from app.services.vk_api import send_message as _vk_send, tg_inline_to_vk_keyboard
    from app.services.contact_merge import upsert_contact_with_identity
    from app.services.product_deeplink import (
        resolve_product_for_bot, build_product_message,
        bind_partner_from_product_link,
    )

    product = await resolve_product_for_bot(
        db, slug=parsed["slug"], client_id=ctx.client_id)
    if not product:
        return False
    client_id = ctx.client_id or product["client_id"]

    contact_id = None
    try:
        contact_id, _pu, _new = await upsert_contact_with_identity(
            db, client_id=client_id, platform_slug="vk",
            platform_user_id=str(vk_user_id),
            username=username or None,
            first_name=first_name or None, last_name=last_name or None,
            utm_source=parsed.get("utm_source"),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("VK pr_: контакт не резолвлен: %s", e)

    await bind_partner_from_product_link(
        db, client_id=client_id, contact_id=contact_id, pid=parsed.get("pid"))

    msg = await build_product_message(db, product, pid=parsed.get("pid"))
    # ⚠️ VK не разбирает HTML — срезаем теги, иначе человек увидит <b> текстом.
    text = msg["text"].replace("<b>", "").replace("</b>", "")
    kb = tg_inline_to_vk_keyboard([[{"text": msg["button"], "url": msg["url"]}]])
    await _vk_send(vk_user_id, text, token=ctx.token, keyboard=kb)
    return True


async def _vk_handle_plusson_ref(referral_code: str, vk_user_id: int,
                                 username: str | None, first_name: str | None,
                                 last_name: str | None, db, ctx,
                                 source: str | None = None) -> None:
    """Вход по ПЛЮСОН-реф-ссылке в ВК: `vk.me/{group}?ref=ref<8симв>`.

    Зеркало TG-ветки в bot/handlers/start.py и MAX-ветки в max_webhook.py:
      1) резолвим код общим `resolve_plusson_referrer` (понимает и клиентский
         код, и код-контакт спикера с привязанным ПЛЮСОНом);
      2) заводим контакт человека в базе клиента ЭТОГО сообщества и закрепляем
         за ним СЫРОЙ код — привязка переживает то, что кнопку регистрации
         нажмут не сразу; `/register` возьмёт код отсюда, если в URL нет pid;
      3) шлём приветствие с кнопкой регистрации.

    Код не резолвится (мусор/чужой) → приветствие без имени рефовода: человек
    уже пришёл, терять его из-за битой ссылки нельзя.
    """
    from app.services.vk_api import send_message as _vk_send, tg_inline_to_vk_keyboard
    from app.services.contact_merge import upsert_contact_with_identity
    from app.services.plusson_referral import (
        resolve_plusson_referrer, persist_plusson_referrer_code,
    )

    referrer_client_id = await resolve_plusson_referrer(db, referral_code)
    referrer_name = None
    if referrer_client_id:
        referrer_name = await db.fetchval(
            "SELECT btrim(CASE WHEN COALESCE(btrim(last_name), '') = '' THEN COALESCE(name, '') ELSE COALESCE(name, '') || ' ' || COALESCE(last_name, '') END) FROM clients WHERE id = $1", referrer_client_id)
        # Контакт нужен ДО закрепления кода: persist ищет его по platform_users.
        try:
            await upsert_contact_with_identity(
                db, client_id=ctx.client_id, platform_slug="vk",
                platform_user_id=str(vk_user_id), username=username or None,
                first_name=first_name or None, last_name=last_name or None,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("VK plusson ref upsert contact failed: %s", e)
        await persist_plusson_referrer_code(
            db, client_id=ctx.client_id, platform="vk",
            platform_user_id=str(vk_user_id), referral_code=referral_code,
            source=source,
        )
        # «Новый интерес» — РЕФОВОДУ, а не владельцу сообщества: партнёрская
        # программа принадлежит тому, чей код в ссылке.
        from app.services.plusson_referral_notify import (
            notify_referrer_new_interest,
        )
        await notify_referrer_new_interest(
            db,
            referrer_client_id=referrer_client_id,
            platform="vk",
            user_id=vk_user_id,
            username=username,
            first_name=first_name,
            last_name=last_name,
        )

    hello = (first_name or "").strip()
    # Регистрация в САМОЙ платформе — всегда основной домен, не клиентский.
    # ⚠️ Источник тащим и в адрес: человек может зарегистрироваться сразу этой
    # кнопкой, до того как метку найдут по контакту.
    register_url = f"{platform_base_url()}/register?pid={referral_code}"
    if source:
        register_url += f"&src={source}"
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
    try:
        await _vk_send(
            vk_user_id, text, token=ctx.token,
            keyboard=tg_inline_to_vk_keyboard([[
                {"text": "📝 Зарегистрироваться", "url": register_url},
            ]]),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("VK plusson ref send failed: %s", e)


async def _event_belongs_to_client(db, event_id: int, client_id: int) -> bool:
    """Принадлежит ли событие этому клиенту (через event_owners). Защита от
    deeplink на чужое событие через бот другого клиента."""
    return bool(await db.fetchval(
        """SELECT 1 FROM event_owners
            WHERE event_id = $1 AND client_id = $2 AND status = 'accepted' LIMIT 1""",
        event_id, client_id,
    ))


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


async def _vk_open_event_funnel(event_id: int, user_id: int, db, ctx: "GroupCtx") -> bool:
    """Открыть событие №event_id в личке VK: воронка (незарег → 2 кнопки,
    зарег → меню кабинета). То же, что триггер «ИВЕНТ<id>». Возвращает True,
    если событие найдено и сообщение отправлено."""
    from app.api.vk_event import send_vk_event_funnel, _EVENT_FUNNEL_FIELDS
    from app.services.external_landing import resolve_or_create_participant

    ev_row = await db.fetchrow(
        f"SELECT {_EVENT_FUNNEL_FIELDS} FROM events e "
        f"WHERE e.id = $1 AND e.id IN (SELECT event_id FROM event_owners "
        f"WHERE client_id = $2 AND status = 'accepted') LIMIT 1",
        event_id, ctx.client_id,
    )
    if not ev_row:
        return False
    _pid, contact_id = await resolve_or_create_participant(
        db, client_id=ctx.client_id, event_id=ev_row["id"],
        platform_slug="vk", platform_user_id=str(user_id),
    )
    is_registered = bool(await db.fetchval(
        "SELECT is_registered FROM event_participants WHERE event_id = $1 AND contact_id = $2",
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
        db, vk_user_id=int(user_id), token=ctx.token,
        client_vk_app_id=client_vk_app_id, event_row=ev_row,
        contact_id=contact_id, is_registered=is_registered,
    )
    return True


async def _vk_direct_start_welcome(user_id: int, db, ctx: "GroupCtx") -> None:
    """Приветствие на голый /start в VIP-сообществе клиента — читает настройки
    клиента (start_mode/start_greeting_text/подписи кнопок), как TG-бот.

    Режим «конкретное событие» → штатная воронка события. Иначе — текст
    (кастомный/дефолт) + кнопки «Все события» и «Об основателе»."""
    from app.services.start_greeting import resolve_start_greeting, greeting_text_plain

    # Витрина «/o/{client_id}» — публичная страница клиента: если у него
    # подключён свой домен, кнопки приветствия ведут туда.
    greet_base = await client_public_url(db, ctx.client_id)

    g = await resolve_start_greeting(db, ctx.client_id, greet_name="", platform="vk")
    if g.get("kind") == "event":
        ev_id = await db.fetchval("SELECT id FROM events WHERE slug = $1 LIMIT 1", g["event_slug"])
        if ev_id and await _vk_open_event_funnel(ev_id, user_id, db, ctx):
            return
        # событие не отдалось — падаем в обычное приветствие ниже
        g = {**g, "kind": "greeting", "text": "",
             "events_label": "📅 Все события",
             "events_url": public_url_for(greet_base, f"o/{ctx.client_id}"),
             "owner_label": "🌐 Об основателе",
             "owner_url": public_url_for(greet_base, f"o/{ctx.client_id}?tab=ecosystem")}

    # Режим «лид-магнит»: создаём funnel_run и запускаем VK-воронку (Текст 1).
    if g.get("kind") == "lead_magnet":
        try:
            lm_kind = g.get("lm_kind")  # 'm' | 'p'
            slug = g.get("slug")
            if lm_kind == "m":
                row = await db.fetchrow("SELECT id FROM lead_magnets WHERE slug=$1 AND client_id=$2", slug, ctx.client_id)
                lm_id, pkg_id = (row["id"] if row else None), None
            else:
                row = await db.fetchrow("SELECT id FROM lead_magnet_packages WHERE slug=$1 AND client_id=$2", slug, ctx.client_id)
                lm_id, pkg_id = None, (row["id"] if row else None)
            if row:
                run_id = await db.fetchval(
                    """INSERT INTO funnel_runs
                          (client_id, type, lead_magnet_id, package_id, contact_id,
                           referrer_contact_id, utm, stage, landed_at, platform_slug)
                       VALUES ($1,'lead_magnet',$2,$3,NULL,NULL,'{}'::jsonb,'landed',NOW(),'vk')
                       RETURNING id""",
                    ctx.client_id, lm_id, pkg_id,
                )
                user_info = await get_user_info(int(user_id))
                from app.services.funnel_service import run_started_vk
                await run_started_vk(
                    run_id, str(user_id),
                    username=(user_info or {}).get("screen_name", "") if user_info else "",
                    first_name=(user_info or {}).get("first_name", "") if user_info else "",
                    last_name=(user_info or {}).get("last_name", "") if user_info else "",
                    db=db, channel_id=ctx.channel_id, token=ctx.token,
                )
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("vk_direct_start(lead_magnet) failed: %s", e)
        # не вышло — общее приветствие ниже
        g = {**g, "kind": "greeting", "text": "",
             "events_label": "📅 Все события",
             "events_url": public_url_for(greet_base, f"o/{ctx.client_id}"),
             "owner_label": "🌐 Об основателе",
             "owner_url": public_url_for(greet_base, f"o/{ctx.client_id}?tab=ecosystem")}

    txt = greeting_text_plain(g.get("text") or "")
    btns = g.get("buttons") or [
        {"label": g["events_label"], "url": g["events_url"]},
        {"label": g["owner_label"], "url": g["owner_url"]},
    ]
    kb = tg_inline_to_vk_keyboard([[{"text": b["label"], "url": b["url"]}] for b in btns])
    await vk_send_message(user_id, txt, keyboard=kb, token=ctx.token)


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
    from app.services.person_wording import wording
    ev = await get_event_for_self_register(db, event_id)
    if not ev:
        try:
            await vk_send_message(user_id, "😕 Событие не найдено.", token=ctx.token)
        except Exception:
            pass
        return
    # Спикер / номинант / участник — по настройке события.
    w = wording(ev["person_wording"])

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
                contact_name=contact_name or w["title"],
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
    spkinv_url = f"https://{TG_DOMAIN}/{bot_handle}?start=spkinv_{access_code}"

    if already:
        text = (
            f"Вы уже {w['nom']} «{ev['title']}».\n\nОткройте свой кабинет: {spkinv_url}\n"
            f"Код доступа: {access_code}"
        )
    else:
        from app.services.speaker_self_register import self_pick_nominations_hint
        text = (
            f"Готово! Вы включены в {w['plural']} «{ev['title']}».\n\n"
            f"Откройте свой кабинет и заполните данные: {spkinv_url}\n"
            f"Код доступа: {access_code}"
            f"{await self_pick_nominations_hint(db, event_id)}"
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

    # Спикер / номинант / участник — по событию, в которое человека позвали.
    from app.services.person_wording import wording_for_collaborator
    w = await wording_for_collaborator(db, coll["collaborator_id"])

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
        sp_name = (coll["name"] or "").strip() or w["nom"]
        try:
            await vk_send_message(
                int(user_id),
                (
                    f"⚠️ Вы зашли не с того аккаунта.\n\n"
                    f"Эта ссылка выдана {w['dat']} «{sp_name}». Ваш VK-аккаунт уже привязан к другому контакту у этого клиента, "
                    f"поэтому я не могу записать вас как {w['acc']}.\n\n"
                    f"Попросите самого {w['acc']} открыть ссылку со своего личного VK, либо передайте ссылку его ассистенту."
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
    name = (coll["name"] or "").strip() or w["nom"]
    # Кабинет спикера — публичная страница клиента, который завёл коллаба.
    cabinet_url = await client_public_link(
        db, coll["created_by_client_id"],
        f"speaker/{event_slug}" if event_slug else "speaker/",
    )

    text = (
        f"Здравствуйте, {name}!\n\n"
        f"Вы — {w['nom']} «{event_title}». Чтобы заполнить свои данные для участников события, "
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

    # ЧЁРНЫЙ СПИСОК (миграция 228) — подписку регистрируем, контент не выдаём.
    try:
        from app.services.blacklist import is_identity_blacklisted, blocked_message
        if await is_identity_blacklisted(db, ctx.client_id, "vk", str(user_id)):
            from app.services.vk_api import send_message as _vk_send
            await _vk_send(int(user_id),
                           await blocked_message(db, ctx.client_id, platform="vk"),
                           token=ctx.token)
            return
    except Exception as e:  # noqa: BLE001 — fail-open
        logger.warning(f"VK blacklist check (allow) failed: {e}")

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
            """SELECT pu.id FROM platform_users pu
                JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE c_own.client_id = $1 AND pu.platform_slug = 'vk' AND pu.platform_user_id = $2""",
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

    # ПЛЮСОН-реф-код: ref=ref<8симв>. Проверяем ПЕРВЫМ среди ref-веток — формат
    # строгий, с событийным `ref_pg{slug}` не пересекается.
    _pl_code, _pl_src = _extract_plusson_ref(event)
    if _pl_code:
        try:
            await _vk_handle_plusson_ref(
                _pl_code, int(user_id), None, None, None, db, ctx, source=_pl_src)
            return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK plusson ref (message_allow) failed: %s", e)

    # Ссылка на продукт: ref=pr_<slug> (решение № 24).
    # ⚠️ Метка строковая, поэтому проверяем её рядом с реф-кодом ПЛЮСОНа —
    # до разбора int-меток событий.
    _inv = _extract_partner_invite(event)
    if _inv:
        try:
            if await _vk_handle_partner_invite(
                _inv, int(user_id), None, None, None, db, ctx):
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK bpr_ (message_allow) failed: %s", e)

    _prod = _extract_product_payload(event)
    if _prod:
        try:
            if await _vk_handle_product_link(
                _prod, int(user_id), None, None, None, db, ctx):
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK pr_ (message_allow) failed: %s", e)

    # Текст, написанный на сайте: ref=txt_<токен>. Метка строковая — рядом с
    # остальными строковыми, до разбора int-меток событий.
    _txt = _extract_text_token(event)
    if _txt:
        try:
            if await _vk_handle_saved_text(_txt, int(user_id), db, ctx):
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK txt_ (message_allow) failed: %s", e)

    # Кнопка «Чат события» с веб-страницы /event/{slug}: ref=evchat_<event_id>.
    # Ведём сразу на «вступить в чат» — проверка подписки + выдача чат-ссылок.
    evchat_event_id = _extract_event_chat_id(event)
    if evchat_event_id and await _event_belongs_to_client(db, evchat_event_id, ctx.client_id):
        try:
            from bot.vk_event_menu import handle_vk_event_chat
            await handle_vk_event_chat(evchat_event_id, int(user_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK evchat (message_allow) failed: %s", e)

    # Внешняя ссылка на эфир: ref=evlive_<event_id>.
    evlive_event_id = _extract_event_live_id(event)
    if evlive_event_id and await _event_belongs_to_client(db, evlive_event_id, ctx.client_id):
        try:
            from bot.vk_event_menu import handle_vk_event_live
            await handle_vk_event_live(evlive_event_id, int(user_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK evlive (message_allow) failed: %s", e)

    # Кнопка «Тех.поддержка» из рассылки: ref=evsupport_<event_id>.
    evsupport_event_id = _extract_event_support_id(event)
    if evsupport_event_id and await _event_belongs_to_client(db, evsupport_event_id, ctx.client_id):
        try:
            from bot.vk_event_menu import handle_vk_event_support
            await handle_vk_event_support(evsupport_event_id, int(user_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK evsupport (message_allow) failed: %s", e)

    # Кнопка «Регистрация на событие» из вебинара: ref=evreg_<eid>_ct<cid>.
    _evreg = _extract_evreg_payload(event)
    if _evreg:
        try:
            if await _vk_handle_evreg(_evreg, int(user_id), None, None, db, ctx):
                return
        except Exception as e:
            logger.warning("VK evreg (message_allow) failed: %s", e)

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

    # Прямая ссылка в чат vk.me/{group}?ref=m_<slug> / p_<slug> — лид-магнит по slug.
    # Альтернатива Mini App (vk.com/app#m_slug), который теряет payload при
    # холодном запуске через экран «Запустить».
    lm_ref = _extract_lead_magnet_ref(event)
    if lm_ref and await _start_vk_lead_magnet_by_slug(lm_ref[0], lm_ref[1], int(user_id), db, ctx):
        return

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
            JOIN contacts c_own ON c_own.id = pu.contact_id AND c_own.client_id = $2
           WHERE ep.registered_at > NOW() - INTERVAL '60 seconds'
              OR pu.updated_at    > NOW() - INTERVAL '60 seconds'
           LIMIT 1""",
        str(user_id), ctx.client_id,
    )
    if recent_event_ctx:
        return

    try:
        if not ctx.is_system:
            # VIP-сообщество клиента → приветствие из НАСТРОЕК клиента (как в TG):
            # режим «конкретное событие» / кастомный текст / дефолт + кнопки.
            await _vk_direct_start_welcome(int(user_id), db, ctx)
        else:
            # Системное сообщество ПЛЮСОНа → Mini App (HubSelector по всем).
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


async def handle_group_leave(event: dict, db, ctx: GroupCtx) -> None:
    """group_leave: человек вышел из СООБЩЕСТВА (со стены).

    ⚠️⚠️ РАЗРЕШЕНИЕ ПИСАТЬ НЕ ТРОГАЕМ. Выход из сообщества и запрет сообщений —
    разные права ВКонтакте: человек может уйти со стены и продолжать получать
    личные сообщения (и наоборот). Снимать здесь `is_unsubscribed` значит
    молча выкинуть его из базы рассылки, хотя писать ему по-прежнему можно.
    Отписку от сообщений ставит только `message_deny`.

    Пишем факт в лог входов — по нему видно движение подписчиков сообщества,
    как это делает handle_group_join при вступлении.
    """
    user_id = event.get("user_id")
    if not user_id:
        return
    # self=1 — ушёл сам, self=0 — исключён администратором.
    self_leave = event.get("self")
    logger.info("VK group_leave group=%s user=%s self=%s", ctx.group_id, user_id, self_leave)
    try:
        from app.services.entry_link_log import log_entry_link
        await log_entry_link(
            db, platform="vk", platform_user_id=user_id, raw_param=None,
            launch_params={"src": "group_leave", "group_id": ctx.group_id,
                           "self": self_leave},
        )
    except Exception:
        # Лог не должен ронять обработку события.
        pass


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
        elif result == "survey_required":
            # Перед подарком нужна анкета. В ссылке зашиты человек, номер
            # подарка и площадка — после отправки файл придёт сразу и сюда же.
            await _send_event_answer("Остался один шаг 📝")
            try:
                from app.services.survey_gate import (
                    required_survey_for_run, survey_link_for_run,
                    survey_prompt_text, survey_text_for_client,
                )
                run_row = await db.fetchrow(
                    """SELECT id, client_id, contact_id, lead_magnet_id,
                              package_id, platform_slug
                         FROM funnel_runs WHERE id = $1""", run_id)
                survey = await required_survey_for_run(db, dict(run_row)) if run_row else None
                if survey:
                    url = await survey_link_for_run(db, survey, dict(run_row))
                    # Текст — общий для всех площадок (правится в шаблоне
                    # воронки). ⚠️ VK не понимает HTML — срезаем теги.
                    custom = await survey_text_for_client(db, run_row["client_id"])
                    body = survey_prompt_text(survey, custom)
                    body = re.sub(r"<[^>]+>", "", body)
                    await vk_send_message(
                        user_id, f"{body}\n\n{url}", token=ctx.token,
                    )
            except Exception as e:
                logger.warning(f"VK survey gate failed (run={run_id}): {e}")
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
            # ⚠️ Сюда попадают ТЕХНИЧЕСКИЕ отказы (`no_token` — у клиента не
            # подключён бот/канал, `not_found` — забег потерялся). Человек в
            # этом не виноват и починить это не может, а «что-то пошло не так»
            # он читает как «подарок не дали». Пишем нейтрально и зовём в
            # поддержку; сам сбой уходит в лог — разбираться должен клиент.
            logger.warning("VK fnl_check: неожиданный результат %r (run=%s)", result, run_id)
            await _send_event_answer("Секунду, материалы уже в пути 🎁")
        return

    # Меню события (порт TG evchat_/evmenu_/evlive_/evaddr_/evsupport_ из handlers/funnel.py).
    if (cb.startswith("evchat_") or cb.startswith("evmenu_")
            or cb.startswith("evlive_") or cb.startswith("evsupport_")
            or cb.startswith("evaddr_") or cb.startswith("evsignup_")):
        prefix, _, id_raw = cb.partition("_")
        try:
            ev_id = int(id_raw)
        except ValueError:
            await _send_event_answer("Ошибка кнопки")
            return
        from bot.vk_event_menu import (
            handle_vk_event_chat, handle_vk_event_menu_back, handle_vk_event_live,
            handle_vk_event_support, handle_vk_event_signup, handle_vk_event_address,
        )
        try:
            if prefix == "evchat":
                await handle_vk_event_chat(ev_id, int(user_id), db, ctx)
            elif prefix == "evsignup":
                await handle_vk_event_signup(ev_id, int(user_id), db, ctx)
            elif prefix == "evmenu":
                await handle_vk_event_menu_back(ev_id, int(user_id), db, ctx)
            elif prefix == "evlive":
                await handle_vk_event_live(ev_id, int(user_id), db, ctx)
            elif prefix == "evaddr":
                await handle_vk_event_address(ev_id, int(user_id), db, ctx)
            elif prefix == "evsupport":
                await handle_vk_event_support(ev_id, int(user_id), db, ctx)
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


def _vk_attachment_info(message: dict) -> tuple[bool, str | None]:
    """Есть ли вложение в VK-сообщении и какого рода (первое)."""
    atts = message.get("attachments") or []
    if not atts:
        return False, None
    kind = atts[0].get("type")  # photo | video | doc | audio | audio_message | wall | ...
    norm = {"audio_message": "voice", "doc": "document"}.get(kind, kind)
    return True, norm


async def _archive_vk_chat_message(message: dict, peer_id: int, from_id: int, ctx: GroupCtx) -> None:
    """Слушалка чатов: архивирует сообщение ВК-беседы события (для подсчёта заданий).

    ⚠️ Отдельно от логики лички — ничего не отвечает (кроме команды /getmyid),
    только пишет в event_chat_messages, если беседа привязана к событию.
    chat_id беседы VK = ПОЛНЫЙ peer_id (2000000000 + N), НЕ урезанный N —
    урезанный «1» неуникален между сообществами и ложно матчит чужие события.
    """
    from app.services.chat_archive import archive_chat_message, remember_known_chat

    chat_id = str(peer_id)
    text = message.get("text") or ""

    # Команда /getmyid — работает в беседе: отдаём peer_id беседы + ваш VK ID.
    # ⚠️ В беседу шлём через peer_id (НЕ user_id — send_message кладёт в user_id
    # и для беседы ВК отвечает «incorrect user_id»). Поэтому прямой messages.send.
    if text.strip().lower().split("@", 1)[0].lstrip("/") == "getmyid":
        try:
            import random as _rnd
            from_id = message.get("from_id") or "?"
            await vk_call("messages.send", {
                "peer_id": peer_id,
                "message": f"ID этого чата/беседы: {chat_id}\nВаш ID: {from_id}",
                "random_id": _rnd.randint(1, 2**31 - 1),
            }, token=ctx.token)
        except Exception:  # noqa: BLE001
            pass
        return

    # В остальном слушалка НЕМАЯ — только архивирует.
    has_att, att_kind = _vk_attachment_info(message)
    written = await archive_chat_message(
        platform="vk",
        chat_id=chat_id,
        platform_user_id=str(from_id),
        username=None,
        author_name=None,
        text=text or None,
        has_attachment=has_att,
        attachment_kind=att_kind,
        message_ref=str(message.get("conversation_message_id") or message.get("id") or ""),
        sent_at=None,
        owner_client_id=ctx.client_id,  # VK chat_id неуникален между сообществами!
    )
    if not written:
        return
    await remember_known_chat(
        platform="vk", chat_id=chat_id, title=None,
        bot_id=str(ctx.group_id), client_id=ctx.client_id, can_read=True,
    )

    # ── Контроль заданий: ловим кодовые фразы критериев.
    from app.services.chat_archive import process_task_submissions
    try:
        submissions = await process_task_submissions(
            platform="vk",
            chat_id=chat_id,
            platform_user_id=str(from_id),
            username=None,
            author_name=None,
            text=text or None,
            attachments=_vk_attachment_urls(message),
            message_ref=str(message.get("conversation_message_id") or message.get("id") or ""),
            sent_at=None,
            owner_client_id=ctx.client_id,  # VK chat_id неуникален между сообществами!
        )
        if submissions:
            await _reply_submission_vk(peer_id, submissions[0], ctx)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"VK task submissions failed: {e}")

    # ── Приветствие в чатах: кодовое слово → ОТВЕТ случайной фразой (reply),
    # через случайную задержку 30..180 сек (естественнее). Фоном — не держим
    # обработку апдейта.
    from app.services.chat_archive import process_chat_greeting, pick_greeting_delay_sec
    try:
        greeting = await process_chat_greeting(
            platform="vk",
            chat_id=chat_id,
            author_name=None,
            username=None,
            text=text or None,
            owner_client_id=ctx.client_id,  # VK chat_id неуникален между сообществами!
        )
        if greeting:
            delay = pick_greeting_delay_sec()

            async def _send_greeting_later(pid=peer_id, msg=message, txt=greeting, c=ctx, d=delay):
                try:
                    await asyncio.sleep(d)
                    await _reply_greeting_vk(pid, msg, txt, c)
                except Exception as ex:  # noqa: BLE001
                    logger.warning(f"VK delayed greeting failed: {ex}")

            asyncio.create_task(_send_greeting_later())
    except Exception as e:  # noqa: BLE001
        logger.warning(f"VK greeting failed: {e}")


def _vk_attachment_urls(message: dict) -> list[dict]:
    """VK-вложения → [{kind, url}]. У VK медиа сразу с URL."""
    out: list[dict] = []
    for a in (message.get("attachments") or []):
        t = a.get("type")
        obj = a.get(t) or {}
        url = None
        if t == "photo":
            sizes = obj.get("sizes") or []
            if sizes:
                url = sizes[-1].get("url")
        elif t == "video":
            url = obj.get("player") or f"https://vk.com/video{obj.get('owner_id')}_{obj.get('id')}"
        elif t == "doc":
            url = obj.get("url")
        elif t == "audio_message":
            url = obj.get("link_mp3") or obj.get("link_ogg")
        out.append({"kind": {"doc": "document", "audio_message": "voice"}.get(t, t), "url": url})
    return out


async def _reply_greeting_vk(peer_id: int, message: dict, text: str, ctx: "GroupCtx") -> None:
    """Ответ-приветствие в беседе именно ОТВЕТОМ (reply) на сообщение автора.

    VK reply = forward с is_reply=1 и conversation_message_ids исходного
    сообщения. Если cmid нет — обычный messages.send в беседу.
    """
    import json as _json
    import random as _rnd
    try:
        params = {
            "peer_id": peer_id,
            "message": text,
            "random_id": _rnd.randint(1, 2**31 - 1),
        }
        cmid = message.get("conversation_message_id")
        if cmid:
            params["forward"] = _json.dumps({
                "peer_id": peer_id,
                "conversation_message_ids": [int(cmid)],
                "is_reply": 1,
            })
        await vk_call("messages.send", params, token=ctx.token)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"VK reply greeting failed: {e}")


async def _reply_submission_vk(peer_id: int, info: dict, ctx: "GroupCtx") -> None:
    """Авто-ответ автору в беседе после сдачи задания — «✅ Принято: …» (plain)."""
    from app.services.chat_archive import build_submission_reply_text
    msg = build_submission_reply_text(info, html=False)
    if not msg:
        return
    try:
        import random as _rnd
        await vk_call("messages.send", {
            "peer_id": peer_id, "message": msg,
            "random_id": _rnd.randint(1, 2**31 - 1),
        }, token=ctx.token)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"VK reply submission failed: {e}")


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

    # Сообщения из беседы/мультичата сообщества (peer_id ≥ 2000000001):
    # НЕ запускаем логику лички (воронки/уведомления), но СЛУШАЕМ для архива
    # заданий (отдельная слушалка чатов). chat_id беседы = ПОЛНЫЙ peer_id.
    peer_id = message.get("peer_id")
    if peer_id is not None and int(peer_id) != int(from_id):
        try:
            await _archive_vk_chat_message(message, int(peer_id), int(from_id), ctx)
        except Exception as e:  # noqa: BLE001 — слушалка не должна ронять обработчик
            logger.warning(f"VK chat archive failed: {e}")
        return

    # ЧЁРНЫЙ СПИСОК (миграция 228) — до выдачи любого контента.
    # Ставится ниже веток чатов: в беседах блок не применяем, только в ЛС.
    try:
        from app.services.blacklist import is_identity_blacklisted, blocked_message
        if await is_identity_blacklisted(db, ctx.client_id, "vk", str(from_id)):
            from app.services.vk_api import send_message as _vk_send
            await _vk_send(int(from_id),
                           await blocked_message(db, ctx.client_id, platform="vk"),
                           token=ctx.token)
            return
    except Exception as e:  # noqa: BLE001 — fail-open, сбой проверки не блокирует
        logger.warning(f"VK blacklist check failed: {e}")

    # /start — приветствие из НАСТРОЕК клиента (как в TG): режим «конкретное
    # событие» / кастомный текст / дефолт + кнопки «Все события» и «Об основателе».
    # Системное сообщество — на Mini App (HubSelector по всем организаторам).
    if (message.get("text") or "").strip().lower().startswith("/start"):
        try:
            if not ctx.is_system:
                await _vk_direct_start_welcome(int(from_id), db, ctx)
            else:
                from app.services.vk_api import send_message as _vk_send, tg_inline_to_vk_keyboard
                txt = ("👋 Здравствуйте!\n\n"
                       "Откройте приложение, чтобы посмотреть свои события и партнёрские ссылки.")
                kb = tg_inline_to_vk_keyboard([[
                    {"text": "Открыть приложение", "url": f"https://vk.com/app{ctx.vk_app_id}"},
                ]])
                await _vk_send(int(from_id), txt, keyboard=kb, token=ctx.token)
        except Exception as e:
            logger.warning(f"VK /start failed: {e}")
        return

    # /support — единое сообщение службы поддержки клиента (каналы связи).
    if (message.get("text") or "").strip().lower().startswith("/support"):
        try:
            from app.services.support_message import build_support_message_plain
            from app.services.vk_api import send_message as _vk_send
            row = await db.fetchrow(
                "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
                ctx.client_id,
            )
            wtg = row["work_tg_username"] if row else ""
            wvk = row["work_vk"] if row else ""
            wmax = row["work_max"] if row else ""
            await _vk_send(
                int(from_id),
                build_support_message_plain(work_tg=wtg, work_vk=wvk, work_max=wmax),
                token=ctx.token,
            )
        except Exception as e:
            logger.warning(f"VK /support failed: {e}")
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

    # /pluson_connect — связать свой ПЛЮСОН-аккаунт (ссылка на форму pluson.ru).
    if (message.get("text") or "").strip().lower().startswith("/pluson_connect"):
        try:
            from app.services.vk_api import send_message as _vk_send, tg_inline_to_vk_keyboard
            from app.services.pluson_connect_token import make_pluson_connect_token
            from app.config import settings as _s
            if ctx.is_system:
                await _vk_send(int(from_id), "Эта команда доступна только в сообществе организатора.", token=ctx.token)
                return
            token = make_pluson_connect_token(
                client_id=int(ctx.client_id), platform="vk", user_id=str(from_id))
            url = f"{_s.frontend_url.rstrip('/')}/link-pluson?token={token}"
            kb = tg_inline_to_vk_keyboard([[{"text": "Связать ПЛЮСОН-аккаунт", "url": url}]])
            await _vk_send(
                int(from_id),
                "Свяжите свой аккаунт ПЛЮСОН — тогда все, кто зарегистрируются "
                "на событие и заберут в подарок доступ к ПЛЮСОН, закрепятся за "
                "вами. Откройте форму на pluson.ru (ссылка на 1 час).",
                keyboard=kb, token=ctx.token,
            )
        except Exception as e:
            logger.warning(f"VK /pluson_connect failed: {e}")
        return

    # /merge <платформа> <id> — объединить аккаунты с другой площадки.
    if (message.get("text") or "").strip().lower().startswith("/merge"):
        await _handle_vk_merge(message.get("text") or "", int(from_id), db, ctx)
        return

    # /vip_link{event_id} — прислать VIP-ссылку события (как кнопка меню).
    _vtext = (message.get("text") or "").strip()
    if _vtext.lower().lstrip("/").startswith("vip_link"):
        import re as _re
        mvip = _re.match(r"(?i)^\s*/?vip_link\s*(\d+)", _vtext)
        if not mvip:
            await vk_send_message(int(from_id), "Укажите событие: /vip_link24", token=ctx.token)
            return
        event_id = int(mvip.group(1))
        # VIP-сообщество клиента видит только свои события; системное — любые.
        if not ctx.is_system:
            owns = await db.fetchval(
                """SELECT 1 FROM event_owners
                    WHERE event_id = $1 AND client_id = $2 AND status='accepted' LIMIT 1""",
                event_id, ctx.client_id)
            if not owns:
                await vk_send_message(int(from_id), "Неизвестное событие — возможно, вы ошиблись с идентификатором события.", token=ctx.token)
                return
        contact_id = await db.fetchval(
            """SELECT ep.contact_id FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id
                  AND pu.platform_slug='vk' AND pu.platform_user_id = $2
                WHERE ep.event_id = $1 LIMIT 1""",
            event_id, str(from_id))
        from app.services.external_landing import build_event_vip_target
        vip = await build_event_vip_target(db, event_id, contact_id)
        if not vip:
            ev_exists = await db.fetchval("SELECT 1 FROM events WHERE id=$1 LIMIT 1", event_id)
            if not ev_exists:
                await vk_send_message(int(from_id), "Неизвестное событие — возможно, вы ошиблись с идентификатором события.", token=ctx.token)
            else:
                await vk_send_message(int(from_id), "У этого события не настроен формат участия (VIP).", token=ctx.token)
            return
        msg_text = (
            f"Выберите формат участия в событии {vip['title']}\n\n"
            "👇👇👇\n"
        )
        kb = tg_inline_to_vk_keyboard([[{"text": vip["vip_label"], "url": vip["vip_target"]}]])
        await vk_send_message(int(from_id), msg_text, keyboard=kb, token=ctx.token)
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

    # Прямая ссылка в чат vk.me/{group}?ref=m_<slug> / p_<slug> — лид-магнит по slug.
    # Альтернатива Mini App (теряет payload при холодном запуске «Запустить»).
    lm_ref = _extract_lead_magnet_ref(event_obj)
    if lm_ref and await _start_vk_lead_magnet_by_slug(lm_ref[0], lm_ref[1], int(from_id), db, ctx):
        return

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

    # ПЛЮСОН-реф-код: ref=ref<8симв> (если ЛС уже разрешены, ref приходит сюда).
    # Первым среди ref-веток — формат строгий, с `ref_pg{slug}` не пересекается.
    _pl_code_new, _pl_src_new = _extract_plusson_ref(event_obj)
    if _pl_code_new:
        try:
            await _vk_handle_plusson_ref(
                _pl_code_new, int(from_id), None, None, None, db, ctx,
                source=_pl_src_new)
            return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK plusson ref (message_new) failed: %s", e)

    # Ссылка на продукт: ref=pr_<slug> (решение № 24). Как и реф-код ПЛЮСОНа,
    # метка строковая — разбираем её до int-меток событий.
    _inv_new = _extract_partner_invite(event_obj)
    if _inv_new:
        try:
            if await _vk_handle_partner_invite(
                _inv_new, int(from_id), None, None, None, db, ctx):
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK bpr_ (message_new) failed: %s", e)

    _prod_new = _extract_product_payload(event_obj)
    if _prod_new:
        try:
            if await _vk_handle_product_link(
                _prod_new, int(from_id), None, None, None, db, ctx):
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK pr_ (message_new) failed: %s", e)

    # Текст, написанный на сайте: ref=txt_<токен> (если ЛС уже разрешены, метка
    # приходит сюда). Врезка нужна в ОБЕИХ точках — как и у остальных меток.
    _txt_new = _extract_text_token(event_obj)
    if _txt_new:
        try:
            if await _vk_handle_saved_text(_txt_new, int(from_id), db, ctx):
                return
        except Exception as e:  # noqa: BLE001
            logger.warning("VK txt_ (message_new) failed: %s", e)

    # Кнопка «Чат события» с веб-страницы /event/{slug}: ref=evchat_<event_id>
    # (если человек уже разрешил ЛС, ref приходит в message_new). Ведём сразу
    # на «вступить в чат» — проверка подписки + выдача чат-ссылок.
    evchat_event_id = _extract_event_chat_id(event_obj)
    if evchat_event_id and await _event_belongs_to_client(db, evchat_event_id, ctx.client_id):
        try:
            from bot.vk_event_menu import handle_vk_event_chat
            await handle_vk_event_chat(evchat_event_id, int(from_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK evchat (message_new) failed: %s", e)

    # Внешняя ссылка на эфир: ref=evlive_<event_id> (если ЛС уже разрешены).
    evlive_event_id = _extract_event_live_id(event_obj)
    if evlive_event_id and await _event_belongs_to_client(db, evlive_event_id, ctx.client_id):
        try:
            from bot.vk_event_menu import handle_vk_event_live
            await handle_vk_event_live(evlive_event_id, int(from_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK evlive (message_new) failed: %s", e)

    evsupport_event_id = _extract_event_support_id(event_obj)
    if evsupport_event_id and await _event_belongs_to_client(db, evsupport_event_id, ctx.client_id):
        try:
            from bot.vk_event_menu import handle_vk_event_support
            await handle_vk_event_support(evsupport_event_id, int(from_id), db, ctx)
            return
        except Exception as e:
            logger.warning("VK evsupport (message_new) failed: %s", e)

    _evreg_new = _extract_evreg_payload(event_obj)
    if _evreg_new:
        try:
            if await _vk_handle_evreg(_evreg_new, int(from_id), None, None, db, ctx):
                return
        except Exception as e:
            logger.warning("VK evreg (message_new) failed: %s", e)

    # Триггер «ИВЕНТ<id>» — человек написал в личку слово вроде «ИВЕНТ24».
    # Шлём воронку события №24 (незарег → 2 кнопки, зарег → меню кабинета).
    # ВАЖНО: этот блок ВЫШЕ «досыла evl_» ниже — явный номер от пользователя
    # имеет приоритет над «угадай по недавней активности» (иначе бот пришлёт
    # последнее открытое событие, а не запрошенное).
    # Событие обязано принадлежать ЭТОМУ клиенту (нельзя дёрнуть чужой ивент
    # из чужого сообщества). Нет такого события → честно говорим, что не нашли.
    trigger_text = (message.get("text") or "").strip()

    # Триггер «podarki<id>» / «/podarki<id>» — подарки за рекомендации:
    # личные реф-ссылки + лестница подарков + кнопка в кабинет.
    # ⚠️ Стоит ВЫШЕ «ИВЕНТ<id>»: тот ловит и слово `menu`, и если бы подарки
    # разбирались после, часть запросов ушла бы в меню события.
    # ⚠️ Кнопки «Отправить другу» в ВК НЕТ (решение владельца 22.09.2026):
    # механизма «выбери чат и отправь» у ВК-бота не существует — она только
    # в Telegram. Текст plain: ВК не понимает HTML, теги пришли бы как есть.
    _gm = re.match(r"(?i)^\s*/?podarki\s*(\d{1,9})\b", trigger_text)
    if _gm:
        try:
            from app.services.referral_gifts import (
                build_gifts_message, resolve_event_for_client, split_text_chunks,
            )
            _gev_id = int(_gm.group(1))
            # Событие обязано принадлежать клиенту ЭТОГО сообщества — иначе по
            # перебору номеров из чужого бота вытянули бы чужую лестницу подарков.
            _gev = await resolve_event_for_client(
                db, event_id=_gev_id, client_id=ctx.client_id)
            if not _gev:
                await vk_send_message(
                    int(from_id),
                    f"Не нашёл событие №{_gev_id} 🤔\n\n"
                    "Возможно, в номере опечатка — проверьте и напишите ещё раз.",
                    token=ctx.token,
                )
                return
            _gcontact_id = await db.fetchval(
                """SELECT contact_id FROM platform_users
                    WHERE platform_slug = 'vk' AND platform_user_id = $1
                    ORDER BY id LIMIT 1""",
                str(from_id))
            _gmsg = await build_gifts_message(
                db, event_id=_gev_id, client_id=ctx.client_id,
                contact_id=_gcontact_id, platform="vk",
            )
            if not _gmsg:
                await vk_send_message(
                    int(from_id), "Событие не найдено.", token=ctx.token)
                return
            _gkb = None
            if _gmsg["main_url"]:
                _gkb = tg_inline_to_vk_keyboard(
                    [[{"text": "Получить ссылку и материалы", "url": _gmsg["main_url"]}]])
            _gchunks = split_text_chunks(_gmsg["text"])
            for _gi, _gchunk in enumerate(_gchunks):
                await vk_send_message(
                    int(from_id), _gchunk, token=ctx.token,
                    keyboard=(_gkb if _gi == len(_gchunks) - 1 else None),
                )
            return
        except Exception as e:  # noqa: BLE001
            logger.warning(f"VK podarki{_gm.group(1)} упал: {e}")
            return

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
                          AND ep.contact_id = (SELECT pu.contact_id FROM platform_users pu
                                                JOIN contacts c_own ON c_own.id = pu.contact_id
                                                WHERE pu.platform_slug='vk' AND pu.platform_user_id=$3
                                                  AND c_own.client_id=$2 LIMIT 1)
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

    # Свободный текст / медиа. Игнорируем служебные старты (action: chat_invite_user и т.п.)
    text = (message.get("text") or "").strip()
    has_att, att_kind = _vk_attachment_info(message)
    if not text and not has_att:
        return

    # Архив личного сообщения для раздела «Диалоги» (только VIP — у системного
    # сообщества контекст клиента неизвестен). Голос не качаем.
    if not ctx.is_system:
        try:
            from app.services.dialog_archive import archive_incoming
            file_url = None
            if has_att and att_kind != "voice":
                urls = _vk_attachment_urls(message)
                file_url = urls[0]["url"] if urls else None
            await archive_incoming(
                client_id=ctx.client_id, platform="vk", channel_id=ctx.channel_id,
                platform_user_id=str(from_id), text=(text or None),
                media_kind=att_kind, file_url=file_url,
                platform_message_id=str(message.get("conversation_message_id")
                                        or message.get("id") or "") or None,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"VK dialog archive failed: {e}")

        # Голосовое без текста — просим написать текстом и выходим.
        if att_kind == "voice" and not text:
            try:
                from app.services.dialog_archive import VOICE_REPLY
                from app.services.vk_api import send_message as _vk_send
                await _vk_send(int(from_id), VOICE_REPLY, token=ctx.token)
            except Exception:  # noqa: BLE001
                pass
            return

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
                      c.notifications_max_chat_id, c.notifications_vk_peer_id,
                      COALESCE(NULLIF(c.brand_name,''), c.name) AS brand,
                      pu.contact_id, ct.name AS contact_name, ct.utm_source
                 FROM clients c
            LEFT JOIN platform_users pu
                   ON pu.platform_slug = 'vk' AND pu.platform_user_id = $2
                  AND EXISTS (SELECT 1 FROM contacts c_own
                               WHERE c_own.id = pu.contact_id AND c_own.client_id = c.id)
            LEFT JOIN contacts ct ON ct.id = pu.contact_id
                WHERE c.id = $1""",
            ctx.client_id, str(from_id),
        )
        if not row or not (
            row["notifications_telegram_chat_id"]
            or row["notifications_max_chat_id"]
            or row["notifications_vk_peer_id"]
        ):
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
        from app.services.profile_links import nick_html, link_html
        user_nick = nick_html("vk", user_id=from_id, username=vk_screen)
        prof_link = link_html("vk", user_id=from_id, username=vk_screen)
        card_url = (
            f"{_s.frontend_url}/dashboard/clients?contact={row['contact_id']}"
            if row['contact_id'] else "—"
        )
        parts = [
            "#user_message 💬",
            "",
            f"<b>Когда:</b> {when_str}",
            f"<b>Платформа:</b> ВКонтакте · {_html.escape(row['brand'] or '—')}",
            "",
            "<b>Кто написал</b>",
            f"<b>Никнейм:</b> {user_nick}",
            f"<b>Имя:</b> {_html.escape(display_name or row['contact_name'] or '—')}",
            f"<b>VK ID:</b> <code>{from_id}</code>",
        ]
        if prof_link:
            parts.append(f"<b>Ссылка:</b> {prof_link}")
        parts += [
            f"<b>ID контакта:</b> {('#' + str(row['contact_id'])) if row['contact_id'] else '—'}",
            f"<b>Источник (utm_source):</b> {_html.escape(row['utm_source']) if row['utm_source'] else '—'}",
            f"<b>Карточка:</b> {card_url}",
            "",
            "<b>Сообщение:</b>",
            _html.escape(text),
        ]
        notif_text = "\n".join(parts)

        # Дублируем во ВСЕ каналы уведомлений клиента (TG+MAX+VK).
        from app.services.channels import notify_organizer_all_channels
        await notify_organizer_all_channels(ctx.client_id, notif_text, db)
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
    else:
        # VIP-сообщество: приветствие + прямые контакты поддержки клиента.
        from app.services.support_message import build_user_reply_plain
        from app.database import get_pool as _gp
        wtg = wvk = wmax = ""
        try:
            _p = await _gp()
            async with _p.acquire() as _c:
                _r = await _c.fetchrow(
                    "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
                    ctx.client_id)
            if _r:
                wtg, wvk, wmax = (_r["work_tg_username"] or "", _r["work_vk"] or "", _r["work_max"] or "")
        except Exception:  # noqa: BLE001
            pass
        reply = build_user_reply_plain(work_tg=wtg, work_vk=wvk, work_max=wmax)
        button_url = None
        button_text = None
    kb = (tg_inline_to_vk_keyboard([[{"text": button_text, "url": button_url}]])
          if button_url else None)
    try:
        await vk_send_message(peer_id, reply, keyboard=kb, token=ctx.token)
        if not ctx.is_system:
            try:
                from app.services.dialog_archive import archive_outgoing_bot
                await archive_outgoing_bot(
                    client_id=ctx.client_id, platform="vk", channel_id=ctx.channel_id,
                    platform_user_id=str(peer_id), text=reply,
                )
            except Exception:  # noqa: BLE001
                pass
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
    # ⚠️⚠️ РАЗРЕШЕНИЕ ПИСАТЬ ЗДЕСЬ НЕ СТАВИМ (исправлено 04.09.2026).
    # Раньше вступление в сообщество помечалось как `is_unsubscribed=FALSE`,
    # то есть человек попадал в базу рассылки, ничего нам не разрешив. Это
    # РАЗНЫЕ права ВКонтакте: подписка на стену ≠ право писать в личку.
    # Отсюда база рассылки расходилась с реальностью, и сообщения уходили
    # тем, кому ВК их всё равно не доставит.
    #
    # Флаг ставит ТОЛЬКО `message_allow` (и снимает `message_deny`) — как
    # my_chat_member в Telegram. Контакт и идентичность выше по функции
    # заводятся как и раньше: человек нам известен, просто писать ему нельзя.
    logger.info("VK group_join: group=%s user=%s recorded (право писать НЕ выдаём)",
                ctx.group_id, user_id)


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
        elif t == "group_leave":
            await handle_group_leave(obj, db, ctx)
        # message_reply — не обрабатываем пока
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
    """Собирает список обслуживаемых VK-групп: ТОЛЬКО клиентские VIP-сообщества.

    Системное VK-сообщество ПЛЮСОНа больше НЕ обслуживает клиентские флоу
    (воронки, события, чаты) — каждый клиент работает только своим VK-сообществом.
    Системным остаётся только email. Поэтому системное сообщество в polling не грузим.
    """
    out: list[GroupCtx] = []

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
