"""
VK callback-обработчики меню события (порт TG handlers/funnel.py: evchat_/evmenu_/evlive_).

Открываются по клику callback-кнопок VK keyboard, которые шлёт send_vk_event_funnel
(backend/app/api/vk_event.py) в меню зарегистрированного участника:
  • evchat_<id>  — «Вступить в Чат»: проверка подписки на VK-сообщества спикеров
                   (groups.isMember) + выдача чат-ссылок события.
  • evmenu_<id>  — «⬅️ Меню события»: возврат в меню кабинета.
  • evlive_<id>  — «📺 Ссылка на эфир»: ближайший эфир + кнопка стрима.

Логика 1:1 с TG-версией; различия только в платформе:
  • отправка через vk_send_message/tg_inline_to_vk_keyboard, а не aiogram;
  • проверка подписки VK-шная (groups.isMember по collaborators.vk_url спикеров),
    а не Telegram getChatMember.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.services.vk_api import (
    send_message as vk_send_message,
    tg_inline_to_vk_keyboard,
    is_user_member_of_group,
    vk_call,
)
from app.services.client_domains import client_public_link

logger = logging.getLogger(__name__)

_RU_MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
              "июля", "августа", "сентября", "октября", "ноября", "декабря"]

# Группы ролей для вывода каналов (зеркало funnel.py:_ROLE_GROUPS).
_ROLE_GROUPS: list[tuple[str, set[str]]] = [
    ("Организаторы", {"organizer"}),
    ("Жюри", {"jury"}),
    ("Спикеры", {"speaker", "headliner"}),
    ("Партнёры", {"partner", "general_partner"}),
]


async def _resolve_vk_group_id(vk_url: str, token: str | None) -> int | None:
    """VK screen_name из vk_url → числовой group_id через utils.resolveScreenName.
    Нужен для groups.isMember (он требует числовой id). None если не VK / не резолвится."""
    from app.services.social_links import vk_screen_name_from_link
    screen = vk_screen_name_from_link(vk_url)
    if not screen:
        return None
    try:
        resp = await vk_call("utils.resolveScreenName", {"screen_name": screen}, token=token)
        if isinstance(resp, dict) and resp.get("type") in ("group", "page") and resp.get("object_id"):
            return int(resp["object_id"])
    except Exception as e:
        logger.warning(f"VK resolveScreenName failed for {vk_url!r}: {e}")
    return None


async def _gather_event_vk_channels(event_id: int, mode: str, db, client_id: int | None = None):
    """Каналы спикеров события для VK-проверки подписки. Источник — collaborators.vk_url
    (публичное VK-сообщество спикера) + кешированный vk_channel_id. mode: 'organizer'
    → только орги, иначе все. Исключает exclude_channel_from_subscription=TRUE и
    пустые vk_url. Дедуп: исключает self-коллаба (clients.self_collaborator_id) —
    его каналы добавляются отдельно как «каналы основателя»."""
    role_filter = "AND cse.role = 'organizer'" if mode == "organizer" else ""
    rows = await db.fetch(
        f"""SELECT sp.id AS speaker_id, sp.name, sp.vk_url, sp.vk_channel_id, cse.role
              FROM event_collaborators cse
              JOIN collaborators sp ON sp.id = cse.speaker_id
             WHERE cse.event_id = $1
               AND cse.exclude_channel_from_subscription = FALSE
               AND sp.vk_url IS NOT NULL
               AND sp.vk_url <> ''
               AND sp.id <> COALESCE((SELECT self_collaborator_id FROM clients WHERE id = $2), 0)
               {role_filter}
             ORDER BY COALESCE(cse.priority, 60), cse.sort_order, cse.id""",
        event_id, client_id or 0,
    )
    return [dict(r) for r in rows]


async def _gather_founder_vk_channels(client_id: int | None, db):
    """VK-сообщества ОСНОВАТЕЛЯ клиента (clients.social_links.vk_channels) как
    псевдо-«каналы» в формате _gather_event_vk_channels: role='organizer',
    отрицательный speaker_id. group_id (если уже резолвлен) кладём в vk_channel_id."""
    if not client_id:
        return []
    from app.services.social_links import get_founder_vk_channels
    row = await db.fetchrow("SELECT social_links FROM clients WHERE id = $1", client_id)
    if not row:
        return []
    social = row["social_links"]
    if isinstance(social, str):
        import json as _json
        try:
            social = _json.loads(social)
        except Exception:
            social = {}
    channels = get_founder_vk_channels(social or {})
    out = []
    for idx, ch in enumerate(channels):
        url = (ch.get("url") or "").strip()
        if not url:
            continue
        out.append({
            "speaker_id": -(idx + 1),
            "name": ch.get("name") or "Сообщество основателя",
            "vk_url": url,
            "vk_channel_id": (ch.get("group_id") or "").strip() or None,
            "role": "organizer",
        })
    return out


def _build_chat_links_message_vk(ev, event_id: int, work_tg: str | None = None):
    """Сообщение со ссылками на чаты события (порт funnel.py:_build_chat_links_message).
    Главный чат (primary_chat_platform) — первым. Возвращает (text, keyboard_dict|None)."""
    tg = (ev["chat_url_tg"] or "").strip()
    vk = (ev["chat_url_vk"] or "").strip()
    mx = (ev["chat_url_max"] or "").strip()
    primary = (ev["primary_chat_platform"] or "telegram").strip()

    items = [
        ("telegram", "Телеграм", "Чат в Телеграм", tg),
        ("vk", "ВКонтакте", "Чат в ВК", vk),
        ("max", "МАХ", "Чат в МАХ", mx),
    ]
    items = [it for it in items if it[3]]
    # ⚠️ Только ВКЛЮЧЁННЫЕ площадки (галочки события, миграция 263) — как в
    # TG-боте и на веб-странице. Организаторы сами решают, куда вести зрителей.
    from app.services.event_platforms import enabled_from_row
    _enabled = enabled_from_row(ev)
    items = [it for it in items if it[0] in _enabled]
    items.sort(key=lambda it: 0 if it[0] == primary else 1)

    text = (
        "Это чаты события:\n\n"
        'Добавьтесь во все и НАПИШИТЕ "Я с вами", чтобы не потеряться!\n\n'
    )
    rows: list[list[dict]] = []
    for idx, (pkey, label, btn, url) in enumerate(items):
        main_mark = " (главный чат)" if idx == 0 else ""
        text += f"➤ {label}{main_mark}: {url}\n\n"
        rows.append([{"text": btn, "url": url}])

    text += "\n\nПо всем техническим вопросам напишите команду /support."

    rows.append([{"text": "⬅️ Меню события", "callback_data": f"evmenu_{event_id}"}])
    keyboard = tg_inline_to_vk_keyboard(rows) if rows else None
    return text, keyboard


async def handle_vk_event_chat(event_id: int, vk_user_id: int, db, ctx) -> None:
    """«Вступить в Чат» (VK) — проверка подписки на VK-сообщества спикеров, затем
    выдача чат-ссылок. Порт funnel.py:handle_event_chat_join с VK groups.isMember."""
    ev = await db.fetchrow(
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
        await vk_send_message(vk_user_id, "😕 Событие не найдено.", token=ctx.token)
        return

    # ⚠️ КОЛЛАБА: человек пришёл к КОНКРЕТНОМУ организатору — через его
    # сообщество. Поддержку и каналы основателя для проверки подписки берём у
    # него, а не у «первого владельца» события.
    from app.services.event_client import resolve_event_client
    client_id = await resolve_event_client(
        db, event_id=event_id, client_id=ev["client_id"],
        source_client_id=getattr(ctx, "client_id", None),
    )

    work_tg = await db.fetchval(
        "SELECT work_tg_username FROM clients WHERE id = $1", client_id
    )

    # Режим проверки: конференция → subscription_mode, мероприятие → require_subscription.
    conf = await db.fetchrow(
        "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id
    )
    if conf:
        mode = (dict(conf).get("subscription_mode") or "all_speakers")
    else:
        mode = "organizer" if ev["require_subscription"] else "none"

    # Объединение каналов ОСНОВАТЕЛЯ клиента + каналов организаторов/спикеров
    # события (с дедупом self-коллаба внутри _gather_event_vk_channels).
    channels = []
    if mode != "none":
        founder = await _gather_founder_vk_channels(client_id, db)
        speakers = await _gather_event_vk_channels(event_id, mode, db, client_id)
        channels = founder + speakers

    # Проверяем подписку на каждое VK-сообщество спикера.
    not_all_subscribed = False
    verdicts: dict[int, str] = {}  # speaker_id → 'subscribed'|'not_subscribed'|'fake_pass'
    for ch in channels:
        # Кешированный group_id (vk_channel_id) — без лишнего resolveScreenName.
        cached = (ch.get("vk_channel_id") or "")
        gid = int(cached) if str(cached).isdigit() else await _resolve_vk_group_id(ch["vk_url"], ctx.token)
        if not gid:
            # Не смогли резолвить group_id → fail-open (не блокируем).
            verdicts[ch["speaker_id"]] = "fake_pass"
            continue
        member = await is_user_member_of_group(gid, vk_user_id, token=ctx.token)
        if member is True:
            verdicts[ch["speaker_id"]] = "subscribed"
        elif member is False:
            verdicts[ch["speaker_id"]] = "not_subscribed"
            not_all_subscribed = True
        else:
            # None = ошибка API → fail-open.
            verdicts[ch["speaker_id"]] = "fake_pass"

    # ── НЕ подписан на всё нужное — список сообществ для подписки ──────────────
    if channels and not_all_subscribed:
        def _is_done(c):
            return verdicts.get(c["speaker_id"]) in ("subscribed", "fake_pass")

        lines = ["Чтобы попасть в чат — подпишитесь на сообщества:", ""]
        multi_group = sum(
            1 for _, roles in _ROLE_GROUPS
            if any(c["role"] in roles and not _is_done(c) for c in channels)
        ) > 1
        counter = 0
        for header, roles in _ROLE_GROUPS:
            grp = [c for c in channels if c["role"] in roles and not _is_done(c)]
            if not grp:
                continue
            if multi_group:
                lines.append(f"{header}:")
            for c in grp:
                counter += 1
                name = c["name"] or "Сообщество"
                url = (c["vk_url"] or "").strip()
                lines.append(f"{counter}. {name}: {url}" if url else f"{counter}. {name}")
            if multi_group:
                lines.append("")

        done = [c for c in channels if _is_done(c)]
        if done:
            lines.append("")
            lines.append("Вы уже подписаны:")
            for c in done:
                lines.append(f"✅ {c['name'] or 'Сообщество'}")

        keyboard = tg_inline_to_vk_keyboard([
            [{"text": "✅ Готово / Проверить снова", "callback_data": f"evchat_{event_id}"}],
            [{"text": "⬅️ Меню события", "callback_data": f"evmenu_{event_id}"}],
        ])
        await vk_send_message(vk_user_id, "\n".join(lines).strip(), keyboard=keyboard, token=ctx.token)
        return

    # ── Подписан (или mode=none) — выдаём чат-ссылки ──────────────────────────
    text, keyboard = _build_chat_links_message_vk(ev, event_id, work_tg)
    await vk_send_message(vk_user_id, text, keyboard=keyboard, token=ctx.token)


async def handle_vk_event_signup(event_id: int, vk_user_id: int, db, ctx) -> None:
    """«ЗАРЕГИСТРИРОВАТЬСЯ» (VK) у события со `skip_contact_form` — регистрируем
    прямо в боте по нажатию кнопки и присылаем меню события. Зеркало TG
    `handle_event_signup` и MAX-ветки `evsignup_`."""
    client_id = await db.fetchval(
        """SELECT eo.client_id FROM event_owners eo
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1""",
        event_id,
    )
    # ⚠️ КОЛЛАБА: база — того организатора, через чьё сообщество зашёл человек
    # (`ctx.client_id`), а не «первый владелец» (services/event_client.py).
    from app.services.event_client import resolve_event_client
    client_id = await resolve_event_client(
        db, event_id=event_id, client_id=client_id,
        source_client_id=getattr(ctx, "client_id", None),
    )
    # contact_id — строго в базе клиента-владельца события (см. пояснение ниже,
    # в handle_vk_event_menu_back: у человека может быть несколько vk-идентичностей).
    contact_id = await db.fetchval(
        """SELECT contact_id FROM platform_users
            WHERE platform_slug = 'vk' AND platform_user_id = $1 AND client_id = $2
            ORDER BY id DESC LIMIT 1""",
        str(vk_user_id), client_id,
    )
    if contact_id:
        from app.services.event_signup import signup_participant_in_bot
        await signup_participant_in_bot(
            db, event_id=event_id, contact_id=contact_id)
    # Меню собираем той же функцией, что и «⬅️ Меню события» — она перечитает
    # is_registered из БД (уже TRUE) и отдаст меню кабинета.
    await handle_vk_event_menu_back(event_id, vk_user_id, db, ctx)


async def handle_vk_event_menu_back(event_id: int, vk_user_id: int, db, ctx) -> None:
    """«⬅️ Меню события» (VK) — пересобрать меню кабинета зарегистрированного.
    Порт funnel.py:handle_event_menu_back."""
    # Поля события + клиентский vk_app_id для кнопки Мини-Апп (на случай незарег.).
    from app.api.vk_event import send_vk_event_funnel, _EVENT_FUNNEL_FIELDS
    ev = await db.fetchrow(
        f"SELECT {_EVENT_FUNNEL_FIELDS} FROM events e WHERE e.id = $1 LIMIT 1",
        event_id,
    )
    if not ev:
        await vk_send_message(vk_user_id, "😕 Событие не найдено.", token=ctx.token)
        return
    # contact_id ищем В КОНТЕКСТЕ КЛИЕНТА события (у человека может быть несколько
    # vk-идентичностей на разных клиентов; без фильтра по client_id брался чужой
    # contact_id → is_registered=False → меню как для незарега = баг «ведёт на
    # регистрацию у зарегистрированного»).
    contact_id = await db.fetchval(
        """SELECT contact_id FROM platform_users
            WHERE platform_slug = 'vk' AND platform_user_id = $1 AND client_id = $2
            ORDER BY id DESC LIMIT 1""",
        str(vk_user_id), ev["client_id"],
    )
    if not contact_id:
        contact_id = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE platform_slug = 'vk' AND platform_user_id = $1
                ORDER BY id DESC LIMIT 1""",
            str(vk_user_id),
        )
    client_vk_app_id = await db.fetchval(
        """SELECT (ch.platform_meta->>'vk_app_id')::int
             FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk' AND ch.is_system = FALSE
            LIMIT 1""",
        ev["client_id"],
    )
    is_registered = bool(await db.fetchval(
        "SELECT is_registered FROM event_participants WHERE event_id=$1 AND contact_id=$2",
        event_id, contact_id,
    )) if contact_id else False
    await send_vk_event_funnel(
        db,
        vk_user_id=vk_user_id,
        token=ctx.token,
        client_vk_app_id=client_vk_app_id,
        event_row=ev,
        contact_id=contact_id or 0,
        is_registered=is_registered,
    )


async def handle_vk_event_live(event_id: int, vk_user_id: int, db, ctx) -> None:
    """«📺 Ссылка на эфир» (VK) — ближайший эфир + кнопка стрима. Порт
    funnel.py:handle_event_live."""
    from app.services.webinar_service import day_stream_url
    # client_id владельца нужен, чтобы страница программы открылась на домене
    # клиента, если он подключён.
    ev = await db.fetchrow(
        """SELECT id, slug, title, module_slug, start_at, hide_stream_button,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
             FROM events WHERE id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        await vk_send_message(vk_user_id, "😕 Событие не найдено.", token=ctx.token)
        return

    # contact_id — строго в базе клиента-владельца события (единый хелпер).
    from app.services.webinar_service import resolve_event_contact_id
    contact_id = await resolve_event_contact_id(db, ev["id"], "vk", vk_user_id)

    now_msk = datetime.now(ZoneInfo("Europe/Moscow"))
    live_when = ""
    live_what = ""

    sessions = await db.fetch(
        """SELECT cd.day_date, s.start_time, s.title
             FROM conf_sessions s
             JOIN conf_days cd ON cd.event_id = s.event_id AND cd.day_number = s.day
            WHERE s.event_id = $1 AND s.start_time IS NOT NULL
              AND cd.day_date IS NOT NULL
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
            chosen = (dt, r["title"])
            break
    if chosen is None and sessions:
        r = sessions[-1]
        try:
            hh, mm = str(r["start_time"])[:5].split(":")
            dt = datetime(r["day_date"].year, r["day_date"].month, r["day_date"].day,
                          int(hh), int(mm), tzinfo=ZoneInfo("Europe/Moscow"))
            chosen = (dt, r["title"])
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

    if live_when:
        text = f"Ближайший эфир — {live_when}"
        if live_what:
            text += f"\n{live_what}"
    else:
        text = "Ближайший эфир"

    from app.services.webinar_service import current_event_day
    _sd = await current_event_day(db, ev["id"])
    stream_url = (await day_stream_url(db, ev["id"], _sd, contact_id)) if _sd else ""
    hide = bool(ev["hide_stream_button"])
    rows: list[list[dict]] = []
    if stream_url and not hide:
        rows.append([{"text": "ВОЙТИ В ЭФИР", "url": stream_url}])
    else:
        text += "\n\nКнопка на стрим появится тут перед эфиром."

    text += "\n\nЧтобы посмотреть всю программу — нажмите на кнопку 👇"
    cid_q = f"?c={contact_id}" if contact_id else ""
    # Страница программы — публичная страница события: домен клиента.
    # ⚠️ КОЛЛАБА: домен ТОГО организатора, в чьей базе контакт человека, —
    # «первый владелец» отправил бы его на чужую страницу.
    from app.services.event_client import resolve_event_client
    prog_url = await client_public_link(
        db,
        await resolve_event_client(
            db, event_id=ev["id"], client_id=ev["client_id"], contact_id=contact_id),
        f"event/{ev['slug']}{cid_q}#program",
    )
    rows.append([{"text": "Программа", "url": prog_url}])
    rows.append([{"text": "⬅️ Вернуться в меню", "callback_data": f"evmenu_{event_id}"}])

    keyboard = tg_inline_to_vk_keyboard(rows)
    await vk_send_message(vk_user_id, text, keyboard=keyboard, token=ctx.token)


async def handle_vk_event_support(event_id: int, vk_user_id: int, db, ctx) -> None:
    """«🆘 Тех. поддержка» (VK) — единое сообщение с каналами связи клиента-
    владельца события (ВК / Телеграм / MAX)."""
    # ⚠️ У КОЛЛАБЫ отвечает ТОТ организатор, в чьём сообществе человек написал:
    # `ctx.client_id` — владелец бота, обрабатывающего этот запрос. Контакты всех
    # организаторов остаются запасным вариантом, если клиент не определился.
    from app.services.support_message import support_text_for_event
    await vk_send_message(
        vk_user_id,
        await support_text_for_event(
            db, event_id, html=False, client_id=getattr(ctx, "client_id", None)),
        token=ctx.token,
    )
