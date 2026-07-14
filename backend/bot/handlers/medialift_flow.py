"""МедиаЛифт — многоуровневая воронка автоподписки ПРЯМО В БОТЕ.

Полный флоу без Mini App (у @pluson_bot он может быть не подключён):

1. `/start ref_pg<slug>` события типа `medialift`
   → бот показывает до 7 карточек участников из ветки над зашедшим
     (рекурсия по referrer_ref_code; если в ветке <3 — добираем свежими),
     каждая карточка = отдельное сообщение с кнопкой «✓ Выбрать».
   → внизу счётчик «Выбрано N из 3» + кнопка «Я подписался — войти».

2. Кнопка «Войти» → getChatMember по выбранным каналам.
   Не подписан → список неподписанных, просим подписаться и нажать снова.
   Подписан на 3 → регистрируем участника → шаг 3.

3. «Добавьте свой канал» → человек присылает ссылку на свой TG-канал.
   → создаём ему карточку-коллаборатора (самозапись), название канала
     подтягиваем через getChat (не храним), автосвязка с ПЛЮСОН-аккаунтом по tg_id.

4. Апселл: «Триал 14 дней ПЛЮСОН» + «Коллабораторная».

Состояние диалога — в памяти процесса (dict), т.к. шаги короткие.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx
from aiogram import Bot, F, Router
from aiogram.types import (
    CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message,
)

from app.database import get_pool

log = logging.getLogger(__name__)
router = Router(name="medialift")

CHAIN_DEPTH = 7
MIN_SUBSCRIBE = 3
_SUBSCRIBED = ("member", "administrator", "creator", "restricted")

# tg_id → {"event_id": int, "selected": set[int], "await_channel": bool}
_state: dict[int, dict] = {}


# ─────────────────────────── выборка ветки ───────────────────────────

async def _chain_cards(db, event_id: int, contact_id: Optional[int], min_sub: int = MIN_SUBSCRIBE) -> list[dict]:
    """До 7 карточек из ветки над зашедшим. Меньше min_sub — добираем свежими (вариант C)."""
    chain_ids: list[int] = []
    if contact_id:
        rows = await db.fetch(
            """
            WITH RECURSIVE chain AS (
                SELECT ep.contact_id, ep.referrer_ref_code, 0 AS depth
                  FROM event_participants ep
                 WHERE ep.event_id = $1 AND ep.contact_id = $2
                UNION ALL
                SELECT rc.id, up.referrer_ref_code, ch.depth + 1
                  FROM chain ch
                  JOIN contacts rc ON rc.ref_code = ch.referrer_ref_code
                  LEFT JOIN event_participants up
                         ON up.event_id = $1 AND up.contact_id = rc.id
                 WHERE ch.referrer_ref_code IS NOT NULL AND ch.referrer_ref_code <> ''
                   AND ch.depth < $3
            )
            SELECT contact_id, MIN(depth) AS d FROM chain WHERE depth > 0
             GROUP BY contact_id ORDER BY d ASC LIMIT $3
            """,
            event_id, contact_id, CHAIN_DEPTH,
        )
        chain_ids = [r["contact_id"] for r in rows]

    cards: list[dict] = []
    if chain_ids:
        rows = await db.fetch(_CARD_SQL + " AND ct.id = ANY($2::int[])", event_id, chain_ids)
        by_c = {r["contact_id"]: dict(r) for r in rows}
        cards = [by_c[c] for c in chain_ids if c in by_c]

    if len(cards) < min_sub:
        shown = [c["contact_id"] for c in cards] + ([contact_id] if contact_id else [])
        need = min_sub - len(cards)
        extra = await db.fetch(
            _CARD_SQL + " AND NOT (ct.id = ANY($2::int[]))"
            " AND c.tg_channel_url IS NOT NULL AND c.tg_channel_url <> ''"
            " ORDER BY ec.id DESC LIMIT $3",
            event_id, shown or [0], need,
        )
        cards += [dict(r) for r in extra]
    return cards


_CARD_SQL = """
    SELECT ec.id AS ec_id, c.id AS collaborator_id, ct.id AS contact_id,
           ct.name AS name, c.hub_about AS description,
           c.tg_channel_url, c.tg_channel_id, c.photo_url,
           c.linked_client_id, ec.gift_lead_magnet_id
      FROM event_collaborators ec
      JOIN collaborators c ON c.id = ec.speaker_id
      JOIN contacts ct ON ct.id = c.contact_id
     WHERE ec.event_id = $1 AND COALESCE(ec.is_visible, TRUE) = TRUE
"""


# ─────────────────────────── рендер ───────────────────────────

def _card_text(i: int, c: dict) -> str:
    parts = [f"<b>{i}. {c['name']}</b>"]
    if c.get("description"):
        parts.append(c["description"])
    if c.get("linked_client_id") and c.get("gift_lead_magnet_id"):
        parts.append("🎁 Дарит подарок за подписку")
    url = c.get("tg_channel_url") or ""
    if url:
        parts.append(f'<a href="{url}">Открыть канал →</a>')
    return "\n".join(parts)


def _card_kb(c: dict, chosen: bool) -> InlineKeyboardMarkup:
    label = "✅ Выбрано" if chosen else "☐ Выбрать"
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=label, callback_data=f"ml_pick_{c['collaborator_id']}")
    ]])


def _footer_kb(n: int, need: int = MIN_SUBSCRIBE) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(
            text=f"Я подписался — войти ({n}/{need})",
            callback_data="ml_enter")
    ]])


async def start_medialift_flow(message: Message, event_id: int, contact_id: Optional[int], db) -> None:
    """Шаг 1: показываем карточки ветки + счётчик."""
    tg_id = message.from_user.id
    # Сколько подписок обязательно — свойство события (миграция 211), дефолт 3.
    min_sub = await db.fetchval(
        "SELECT medialift_required_subscriptions FROM events WHERE id = $1", event_id) or MIN_SUBSCRIBE
    cards = await _chain_cards(db, event_id, contact_id, min_sub)
    _state[tg_id] = {"event_id": event_id, "selected": set(), "await_channel": False,
                     "cards": {c["collaborator_id"]: c for c in cards}}

    if not cards:
        # Ветка пуста — сразу предлагаем добавить свой канал (человек первый).
        _state[tg_id]["await_channel"] = True
        await message.answer(
            "🚀 <b>МедиаЛифт</b>\n\nВы одним из первых! Пока никого нет в цепочке.\n\n"
            + _ADD_CHANNEL_INSTRUCTION,
            parse_mode="HTML")
        return

    need = min(min_sub, len(cards))
    await message.answer(
        f"🚀 <b>МедиаЛифт</b> — система автоподписки\n\n"
        f"Подпишитесь минимум на <b>{need}</b> из списка ниже, отметьте их и нажмите «Войти».\n"
        f"Потом добавите свой канал — и вас увидят все, кто зайдёт под вами.",
        parse_mode="HTML")

    for i, c in enumerate(cards, 1):
        await message.answer(_card_text(i, c), parse_mode="HTML",
                             reply_markup=_card_kb(c, False),
                             disable_web_page_preview=True)

    m = await message.answer(f"Выбрано: 0 из {need}", reply_markup=_footer_kb(0, need))
    _state[tg_id]["footer_id"] = m.message_id
    _state[tg_id]["need"] = need


_ADD_CHANNEL_INSTRUCTION = (
    "<b>Добавьте свой канал</b> — и вас увидят все, кто зайдёт под вами.\n\n"
    "⚠️ <b>Сначала добавьте этого бота администратором</b> вашего канала "
    "(иначе система не сможет проверять подписки на ваш канал).\n\n"
    "Затем пришлите канал одним из способов:\n"
    "• ссылкой: <code>https://telegram.me/ваш_канал</code>\n"
    "• или <b>перешлите сюда любой пост из канала</b> — так подхватим и закрытый канал."
)


async def prompt_add_channel(message: Message, event_id: int, db) -> None:
    """Уже зарегистрированный: показываем статус карточки и/или просим канал."""
    tg_id = message.from_user.id
    client_id = await db.fetchval(
        "SELECT client_id FROM event_owners WHERE event_id=$1 AND status='accepted' ORDER BY id LIMIT 1",
        event_id)
    row = await db.fetchrow(
        """SELECT c.id, c.tg_channel_url
             FROM platform_users pu
             JOIN contacts ct ON ct.id = pu.contact_id
             JOIN collaborators c ON c.contact_id = ct.id
             JOIN event_collaborators ec ON ec.speaker_id = c.id AND ec.event_id = $3
            WHERE pu.client_id=$1 AND pu.platform_slug='telegram'
              AND pu.platform_user_id=$2::text LIMIT 1""",
        client_id, str(tg_id), event_id)

    if row and (row["tg_channel_url"] or "").strip():
        # Канал уже добавлен — ведём в кабинет (ссылка, материалы, статистика).
        contact_row = await db.fetchval(
            """SELECT ct.id FROM platform_users pu JOIN contacts ct ON ct.id=pu.contact_id
                WHERE pu.client_id=$1 AND pu.platform_slug='telegram'
                  AND pu.platform_user_id=$2::text LIMIT 1""",
            client_id, str(tg_id))
        slug = await db.fetchval("SELECT slug FROM events WHERE id=$1", event_id)
        cab_url = f"https://pluson.ru/medialift/me?slug={slug}&c={contact_row}"
        await message.answer(
            "✅ <b>Вы уже в системе, канал добавлен.</b>\n\n"
            "Откройте кабинет — там ваша ссылка, готовые материалы и статистика.",
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="🔗 Мой кабинет и материалы", url=cab_url)],
                [InlineKeyboardButton(text="🎁 ПЛЮСОН с лид-магнитом", url="https://pluson.ru/register")],
                [InlineKeyboardButton(text="🤝 Коллабораторная", url="https://pluson.ru/dashboard/collab-hub")],
            ]))
        return

    _state[tg_id] = {"event_id": event_id, "selected": set(), "await_channel": True, "cards": {}}
    await message.answer(
        "Вы в системе ✅\n\n" + _ADD_CHANNEL_INSTRUCTION, parse_mode="HTML")


# ─────────────────────────── выбор карточек ───────────────────────────

@router.callback_query(F.data.startswith("ml_pick_"))
async def on_pick(cb: CallbackQuery):
    tg_id = cb.from_user.id
    st = _state.get(tg_id)
    if not st:
        await cb.answer("Начните заново: /start", show_alert=True)
        return
    cid = int(cb.data.rsplit("_", 1)[1])
    sel = st["selected"]
    sel.discard(cid) if cid in sel else sel.add(cid)

    card = st["cards"].get(cid)
    if card:
        try:
            await cb.message.edit_reply_markup(reply_markup=_card_kb(card, cid in sel))
        except Exception:  # noqa: BLE001
            pass
    # обновляем счётчик
    need = st.get("need", MIN_SUBSCRIBE)
    try:
        await cb.bot.edit_message_text(
            chat_id=cb.message.chat.id, message_id=st["footer_id"],
            text=f"Выбрано: {len(sel)} из {need}", reply_markup=_footer_kb(len(sel), need))
    except Exception:  # noqa: BLE001
        pass
    await cb.answer()


# ─────────────────────────── проверка подписки + регистрация ───────────────────────────

async def _get_chat_member(http: httpx.AsyncClient, token: str, chat: str, uid: int) -> tuple[bool, str]:
    try:
        r = await http.get(f"https://api.telegram.org/bot{token}/getChatMember",
                            params={"chat_id": chat, "user_id": uid}, timeout=5.0)
        d = r.json()
        if not d.get("ok"):
            return False, ""
        return True, (d.get("result") or {}).get("status") or ""
    except Exception:  # noqa: BLE001
        return False, ""


@router.callback_query(F.data == "ml_enter")
async def on_enter(cb: CallbackQuery, bot: Bot):
    tg_id = cb.from_user.id
    st = _state.get(tg_id)
    if not st:
        await cb.answer("Начните заново: /start", show_alert=True)
        return
    need = st.get("need", MIN_SUBSCRIBE)
    sel = st["selected"]
    if len(sel) < need:
        await cb.answer(f"Выберите минимум {need}", show_alert=True)
        return

    await cb.answer("Проверяю подписки…")
    not_subscribed: list[dict] = []
    async with httpx.AsyncClient() as http:
        for cid in sel:
            c = st["cards"].get(cid) or {}
            chan = c.get("tg_channel_id")
            if not chan:
                continue  # канал не резолвится — не блокируем (fail-open)
            ok, status = await _get_chat_member(http, bot.token, str(chan), tg_id)
            if not (ok and status in _SUBSCRIBED):
                not_subscribed.append(c)

    if not_subscribed:
        lines = ["❗️ Не вижу подписки на:"]
        for c in not_subscribed:
            u = c.get("tg_channel_url") or ""
            lines.append(f'• <a href="{u}">{c.get("name")}</a>' if u else f'• {c.get("name")}')
        lines.append("\nПодпишитесь и нажмите «Войти» ещё раз.")
        await cb.message.answer("\n".join(lines), parse_mode="HTML",
                                disable_web_page_preview=True)
        return

    # Регистрируем участника
    pool = await get_pool()
    async with pool.acquire() as db:
        ev_id = st["event_id"]
        client_id = await db.fetchval(
            "SELECT client_id FROM event_owners WHERE event_id=$1 AND status='accepted' ORDER BY id LIMIT 1",
            ev_id)
        contact_id = await db.fetchval(
            """SELECT ct.id FROM platform_users pu JOIN contacts ct ON ct.id=pu.contact_id
                WHERE pu.client_id=$1 AND pu.platform_slug='telegram' AND pu.platform_user_id=$2::text
                LIMIT 1""", client_id, str(tg_id))
        if contact_id:
            await db.execute(
                """UPDATE event_participants SET is_registered=TRUE
                    WHERE event_id=$1 AND contact_id=$2""", ev_id, contact_id)
            try:
                from app.services.participant_registration import finalize_participant_registration
                await finalize_participant_registration(db, event_id=ev_id, contact_id=contact_id)
            except Exception as e:  # noqa: BLE001
                log.warning("medialift finalize failed: %s", e)

    st["await_channel"] = True
    await cb.message.answer(
        "✅ <b>Готово! Вы в системе.</b>\n\n" + _ADD_CHANNEL_INSTRUCTION,
        parse_mode="HTML")


# ─────────────────────────── добавление своего канала ───────────────────────────

async def _bot_admin_of_channel(bot: Bot, chan_id: str) -> tuple[bool, Optional[str]]:
    """Бот админ канала? Возвращает (ok, title). getChat/getChatMember работают
    только если бот в канале админом → это и есть проверка."""
    try:
        async with httpx.AsyncClient() as http:
            me = await http.get(f"https://api.telegram.org/bot{bot.token}/getMe", timeout=5.0)
            bot_id = (me.json().get("result") or {}).get("id")
            cm = await http.get(f"https://api.telegram.org/bot{bot.token}/getChatMember",
                                params={"chat_id": chan_id, "user_id": bot_id}, timeout=5.0)
            d = cm.json()
            if d.get("ok") and (d["result"].get("status") in ("administrator", "creator")):
                ch = await http.get(f"https://api.telegram.org/bot{bot.token}/getChat",
                                    params={"chat_id": chan_id}, timeout=5.0)
                cd = ch.json()
                title = cd["result"].get("title") if cd.get("ok") else None
                return True, title
    except Exception:  # noqa: BLE001
        pass
    return False, None


async def _resolve_await_channel_event(tg_id: int) -> Optional[int]:
    """Определяет по БД, что человек СЕЙЧАС на шаге «добавь канал»: он участник
    события МедиаЛифт (зарегистрирован) и канала у его карточки ещё нет.

    ⚠️ Не полагаемся на память процесса (_state теряется при рестарте бота или
    со временем). Если человек прислал ссылку/форвард в любой момент — этого
    достаточно, чтобы добавить канал. Возвращает event_id или None."""
    pool = await get_pool()
    async with pool.acquire() as db:
        return await db.fetchval(
            """SELECT e.id
                 FROM events e
                 JOIN event_participants ep ON ep.event_id=e.id AND ep.is_registered
                 JOIN platform_users pu ON pu.contact_id=ep.contact_id
                                       AND pu.platform_slug='telegram'
                                       AND pu.platform_user_id=$1::text
                 -- у его карточки коллаба в этом событии канала ещё НЕТ
                 LEFT JOIN collaborators c ON c.contact_id=ep.contact_id
                 LEFT JOIN event_collaborators ec ON ec.speaker_id=c.id AND ec.event_id=e.id
                WHERE e.module_slug='medialift'
                  AND (c.id IS NULL OR c.tg_channel_url IS NULL OR c.tg_channel_url='')
                ORDER BY e.id LIMIT 1""",
            str(tg_id))


async def _handle_add_channel(message: Message, bot: Bot, *, chan_id: Optional[str], url: str, title_hint: Optional[str]) -> None:
    """Общий обработчик добавления канала — из ссылки или пересланного поста."""
    tg_id = message.from_user.id
    st = _state.get(tg_id)
    # Шаг «добавь канал»: из памяти ИЛИ восстановленный по БД (переживает рестарт).
    if not st or not st.get("await_channel"):
        ev_id = await _resolve_await_channel_event(tg_id)
        if not ev_id:
            return
        st = _state.setdefault(tg_id, {})
        st.update({"event_id": ev_id, "await_channel": True, "selected": st.get("selected", set()), "cards": st.get("cards", {})})

    # Резолвим ID канала, если пришла только ссылка на публичный @канал.
    if not chan_id and url:
        m = url.replace("https://telegram.me/", "").replace("http://telegram.me/", "").replace("https://t.me/", "").replace("http://t.me/", "").lstrip("@/").split("/")[0].split("?")[0]
        if m.startswith("+"):
            await message.answer(
                "Это закрытый канал по инвайт-ссылке — по ней ID не получить.\n"
                "<b>Перешлите сюда любой пост из канала</b> — так подхватим ID.",
                parse_mode="HTML")
            return
        try:
            async with httpx.AsyncClient() as http:
                r = await http.get(f"https://api.telegram.org/bot{bot.token}/getChat",
                                    params={"chat_id": f"@{m}"}, timeout=6.0)
            d = r.json()
            if d.get("ok"):
                chan_id = str(d["result"]["id"])
                title_hint = d["result"].get("title")
        except Exception:  # noqa: BLE001
            pass

    if not chan_id:
        await message.answer(
            "Не удалось определить канал. Проверьте, что бот <b>админ</b> канала, и "
            "пришлите ссылку ещё раз — или перешлите пост из канала.", parse_mode="HTML")
        return

    # ⚠️ Проверяем, что бот РЕАЛЬНО админ канала — иначе не сможем проверять
    # подписки следующих участников на этот канал.
    is_admin, title = await _bot_admin_of_channel(bot, chan_id)
    title = title or title_hint
    if not is_admin:
        me = ""
        try:
            async with httpx.AsyncClient() as http:
                g = await http.get(f"https://api.telegram.org/bot{bot.token}/getMe", timeout=5.0)
            me = (g.json().get("result") or {}).get("username", "")
        except Exception:  # noqa: BLE001
            pass
        bot_ref = f"@{me}" if me else "этого бота"
        await message.answer(
            f"❗️ <b>{bot_ref} ещё не админ вашего канала.</b>\n\n"
            "Добавьте бота администратором канала (достаточно базовых прав) и пришлите "
            "канал ещё раз. Без этого система не сможет проверять подписки на ваш канал.",
            parse_mode="HTML")
        return

    pool = await get_pool()
    async with pool.acquire() as db:
        ev_id = st["event_id"]
        client_id = await db.fetchval(
            "SELECT client_id FROM event_owners WHERE event_id=$1 AND status='accepted' ORDER BY id LIMIT 1",
            ev_id)
        row = await db.fetchrow(
            """SELECT ct.id, ct.name FROM platform_users pu JOIN contacts ct ON ct.id=pu.contact_id
                WHERE pu.client_id=$1 AND pu.platform_slug='telegram' AND pu.platform_user_id=$2::text
                LIMIT 1""", client_id, str(tg_id))
        if not row:
            await message.answer("Сначала войдите в систему: /start")
            return

        from app.services.speaker_self_register import complete_speaker_self_register
        coll_id, _code, ev_slug, _was = await complete_speaker_self_register(
            db, event_id=ev_id, client_id=client_id,
            contact_id=row["id"], contact_name=row["name"] or "Участник")
        contact_id = row["id"]

        chan_url = url or (f"https://telegram.me/{title}" if title else "")
        await db.execute(
            """UPDATE collaborators SET tg_channel_url=$1, tg_channel_id=$2, updated_at=NOW()
                WHERE id=$3""", chan_url, chan_id, coll_id)

        # Автосвязка с ПЛЮСОН-аккаунтом по числовому tg_id (если он уже клиент).
        linked = await db.fetchval(
            """SELECT pu.client_id FROM platform_users pu JOIN clients cl ON cl.id=pu.client_id
                WHERE pu.platform_slug='telegram' AND pu.platform_user_id=$1::text
                  AND cl.is_system_service = FALSE ORDER BY pu.client_id LIMIT 1""",
            str(tg_id))
        if linked:
            await db.execute(
                "UPDATE collaborators SET linked_client_id=$1 WHERE id=$2 AND linked_client_id IS NULL",
                linked, coll_id)

    st["await_channel"] = False
    ok_title = f' «{title}»' if title else ""
    reg_url = f"https://pluson.ru/register?ml_tg_id={tg_id}"
    # Кабинет участника — «страница рефералок»: его ссылка, материалы, статистика.
    cab_url = f"https://pluson.ru/medialift/me?slug={ev_slug}&c={contact_id}"
    await message.answer(
        f"✅ <b>Канал добавлен{ok_title}!</b>\n\n"
        "Теперь вы в цепочке — вас увидят все, кто зайдёт под вами.\n\n"
        "🔗 Откройте свой кабинет — там ваша ссылка и готовые материалы. "
        "Рассказывайте о системе, и ваш канал будет предлагаться всем, кто зайдёт под вами.",
        parse_mode="HTML",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🔗 Мой кабинет и материалы", url=cab_url)],
            [InlineKeyboardButton(text="🎁 ПЛЮСОН с лид-магнитом (14 дней бесплатно)", url=reg_url)],
            [InlineKeyboardButton(text="🤝 Коллабораторная — закрытый Хаб",
                                  url="https://pluson.ru/dashboard/collab-hub")],
        ]))


async def _is_await_channel(tg_id: int) -> bool:
    """Человек на шаге «добавь канал» — по памяти ИЛИ по БД (переживает рестарт)."""
    st = _state.get(tg_id)
    if st and st.get("await_channel"):
        return True
    return bool(await _resolve_await_channel_event(tg_id))


@router.message(F.forward_from_chat)
async def on_channel_forward(message: Message, bot: Bot):
    """Пересланный пост из канала → берём ID канала напрямую (работает и для закрытых)."""
    if not await _is_await_channel(message.from_user.id):
        return
    ch = message.forward_from_chat
    if not ch or ch.type != "channel":
        await message.answer("Это не пост из канала. Перешлите пост именно из вашего КАНАЛА.")
        return
    url = f"https://telegram.me/{ch.username}" if ch.username else ""
    await _handle_add_channel(message, bot, chan_id=str(ch.id), url=url, title_hint=ch.title)


@router.message(F.text.regexp(r"(?i)(t\.me/|telegram\.me/|^@)"))
async def on_channel_link(message: Message, bot: Bot):
    if not await _is_await_channel(message.from_user.id):
        return  # не наш шаг — пусть обрабатывают другие хендлеры
    await _handle_add_channel(message, bot, chan_id=None, url=(message.text or "").strip(), title_hint=None)
