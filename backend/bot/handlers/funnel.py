"""
Callback-handlers воронки лид-магнита.

Кнопка «ГОТОВО» из Текста 1 шлёт callback с data `fnl_check_<run_id>`.
Обработчик проверяет подписку через funnel_service.run_check_subscription.
"""
from aiogram import Router, F
from aiogram.types import (
    CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message,
)
from app.database import get_pool
from app.services.client_domains import client_public_link
import html as _html
import logging

router = Router()
log = logging.getLogger(__name__)


async def _send_survey_gate_tg(callback, run_id: int, db) -> None:
    """Человек упёрся в анкету по дороге за подарком — шлём ссылку кнопкой.

    ⚠️ Никакого «спасибо и вернитесь сами»: в ссылке зашиты contact_id, номер
    подарка и площадка, поэтому после отправки анкеты подарок выдаётся сразу —
    и на странице, и сообщением сюда же, в бот.
    """
    from app.services.survey_gate import (
        required_survey_for_run, survey_link_for_run, survey_prompt_text,
        survey_text_for_client,
    )
    run = await db.fetchrow(
        """SELECT id, client_id, contact_id, lead_magnet_id, package_id, platform_slug
             FROM funnel_runs WHERE id = $1""", run_id)
    if not run:
        return
    survey = await required_survey_for_run(db, dict(run))
    if not survey:
        return
    url = await survey_link_for_run(db, survey, dict(run))
    # Свой текст клиента (funnel_templates.text_survey); пусто → дефолт.
    custom = await survey_text_for_client(db, run["client_id"])
    try:
        await callback.message.answer(
            survey_prompt_text(survey, custom),
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="📝 Заполнить анкету", url=url),
            ]]),
        )
    except Exception:
        log.exception("survey gate: не удалось отправить анкету в TG (run=%s)", run_id)


# Группы ролей для вывода каналов при проверке подписки на чат события.
# (заголовок, набор ролей). Порядок = порядок вывода.
_ROLE_GROUPS: list[tuple[str, set[str]]] = [
    ("Организаторы", {"organizer"}),
    ("Жюри", {"jury"}),
    ("Спикеры", {"speaker", "headliner"}),
    ("Партнёры", {"partner", "general_partner"}),
]


async def _gather_event_chat_channels(event_id: int, mode: str, db, client_id: int | None = None):
    """Возвращает список каналов события (для проверки подписки на чат),
    с ролью/именем/каналом/личным tg спикера. Учитывает mode:
      • organizer    → только role='organizer'
      • all_speakers → все роли
    Исключает exclude_channel_from_subscription=TRUE и пустые tg_channel_id.
    Дедуп: исключает self-коллаба клиента (clients.self_collaborator_id) — его
    каналы добавляются отдельно как «каналы основателя».
    """
    role_filter = "AND cse.role = 'organizer'" if mode == "organizer" else ""
    rows = await db.fetch(
        f"""SELECT sp.id AS speaker_id, sp.name, sp.tg_channel_id, sp.tg_channel_url,
                   cse.role,
                   pu_tg.platform_user_id AS personal_tg_id
              FROM event_collaborators cse
              JOIN collaborators sp ON sp.id = cse.speaker_id
              LEFT JOIN platform_users pu_tg
                ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
             WHERE cse.event_id = $1
               AND cse.exclude_channel_from_subscription = FALSE
               AND sp.tg_channel_id IS NOT NULL
               AND sp.tg_channel_id <> ''
               AND sp.id <> COALESCE((SELECT self_collaborator_id FROM clients WHERE id = $2), 0)
               {role_filter}
             ORDER BY COALESCE(cse.priority, 60), cse.sort_order, cse.id""",
        event_id, client_id or 0,
    )
    return [dict(r) for r in rows]


async def _gather_founder_tg_channels(client_id: int | None, db):
    """Каналы ОСНОВАТЕЛЯ клиента (clients.social_links.telegram_channels) как
    псевдо-«каналы» в формате _gather_event_chat_channels: role='organizer',
    отрицательный speaker_id (чтобы не пересекаться с реальными коллабами).
    Берёт только каналы с числовым chat_id (без него getChatMember не вызвать)."""
    if not client_id:
        return []
    from app.services.social_links import get_founder_tg_channels
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
    channels = get_founder_tg_channels(social or {})
    out = []
    for idx, ch in enumerate(channels):
        cid = (ch.get("chat_id") or "").strip()
        if not cid:
            continue  # без числового chat_id getChatMember не вызвать
        out.append({
            "speaker_id": -(idx + 1),
            "name": ch.get("name") or "Канал основателя",
            "tg_channel_id": cid,
            "tg_channel_url": ch.get("url") or "",
            "role": "organizer",
            "personal_tg_id": None,
        })
    return out


def _build_chat_links_message(
    ev, event_id: int, work_tg: str | None = None,
) -> tuple[str, list[list[InlineKeyboardButton]]]:
    """Сообщение со ссылками на чаты события + кнопки. Главный чат
    (primary_chat_platform) выводится первым с пометкой «(главный чат)».
    Ссылка вшита HTML-якорем за название площадки. В конце — футер со
    Службой поддержки (work_tg), если задана. Внизу кнопок — «Меню события»."""
    tg = (ev["chat_url_tg"] or "").strip()
    vk = (ev["chat_url_vk"] or "").strip()
    mx = (ev["chat_url_max"] or "").strip()
    primary = (ev["primary_chat_platform"] or "telegram").strip()

    # (platform_key, подпись_площадки, текст_кнопки, url)
    items = [
        ("telegram", "Телеграм", "Чат в Телеграм", tg),
        ("vk", "ВКонтакте", "Чат в ВК", vk),
        ("max", "МАХ", "Чат в МАХ", mx),
    ]
    items = [it for it in items if it[3]]
    # Главный — первым.
    items.sort(key=lambda it: 0 if it[0] == primary else 1)

    text = (
        "Это чаты события:\n\n"
        'Добавьтесь во все и <b>НАПИШИТЕ "Я с вами"</b>, чтобы не потеряться!\n\n'
    )
    rows: list[list[InlineKeyboardButton]] = []
    for idx, (pkey, label, btn, url) in enumerate(items):
        main_mark = " (главный чат)" if idx == 0 else ""
        text += f'➤ <a href="{_html.escape(url)}">{label}{main_mark}</a>\n\n'
        rows.append([InlineKeyboardButton(text=btn, url=url)])

    work_tg = (work_tg or "").strip().lstrip("@")
    if work_tg:
        wt = _html.escape(work_tg)
        text += (
            "\n\n\n\n--- По всем техническим вопросам обращайтесь в "
            f'<a href="https://telegram.me/{wt}">@{wt}</a>'
        )

    rows.append([InlineKeyboardButton(
        text="⬅️ Меню события", callback_data=f"evmenu_{event_id}"
    )])
    return text, rows


@router.callback_query(F.data.startswith("evchat_"))
async def handle_event_chat_join(callback: CallbackQuery):
    """«Вступить в Чат» — проверка подписки на каналы спикеров/организаторов
    события, затем выдача ссылок на чаты."""
    try:
        event_id = int((callback.data or "").removeprefix("evchat_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return
    await run_event_chat_gate(callback.message, event_id, callback.from_user.id)
    await callback.answer()


async def run_event_chat_gate(message, event_id: int, user_tg_id: int):
    """Общая логика «вступить в чат события»: проверка подписки на каналы
    спикеров/организаторов → если не подписан, шлём список каналов; если
    подписан (или проверка не нужна), сразу выдаём ссылки на чаты.

    Переиспользуется и из callback `evchat_<id>` (меню бота), и из deeplink
    `/start evchat_<id>` (кнопка чата на веб-странице события /event/{slug}).
    `message` — aiogram Message, в который шлём ответ."""
    pool = await get_pool()
    async with pool.acquire() as db:
        ev = await db.fetchrow(
            """SELECT id, require_subscription,
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
            await message.answer("Событие не найдено. Проверьте ссылку.")
            return

        work_tg = await db.fetchval(
            "SELECT work_tg_username FROM clients WHERE id = $1", ev["client_id"]
        )

        # Режим проверки: конференция → conf_conferences.subscription_mode,
        # мероприятие → events.require_subscription (true=organizer, false=none).
        conf = await db.fetchrow(
            "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id
        )
        if conf:
            mode = (dict(conf).get("subscription_mode") or "all_speakers")
        else:
            mode = "organizer" if ev["require_subscription"] else "none"

        # Каналы для проверки (если mode != none): объединение каналов
        # ОСНОВАТЕЛЯ клиента + каналов организаторов/спикеров события (с дедупом
        # self-коллаба внутри _gather_event_chat_channels).
        channels = []
        if mode != "none":
            founder = await _gather_founder_tg_channels(ev["client_id"], db)
            speakers = await _gather_event_chat_channels(event_id, mode, db, ev["client_id"])
            channels = founder + speakers

        # Проверяем подписку по каждому каналу.
        not_all_subscribed = False
        verdicts: dict[int, str] = {}  # speaker_id → 'subscribed'|'not_subscribed'|'fake_pass'
        if channels:
            import httpx
            from app.api.subscription_check import _check_one_channel
            from app.services.channels import get_client_telegram_token
            from app.config import settings as _settings
            # Только свой TG-бот клиента. Системный @pluson_bot как fallback убран —
            # нет своего бота → проверку подписки пропускаем (не блокируем, см. ниже).
            token = await get_client_telegram_token(ev["client_id"], db)
            if token:
                async with httpx.AsyncClient() as http:
                    for ch in channels:
                        try:
                            v = await _check_one_channel(
                                http, token, ch["tg_channel_id"],
                                int(ch["personal_tg_id"]) if ch.get("personal_tg_id") else None,
                                user_tg_id,
                            )
                        except Exception as e:
                            log.warning("evchat check_one_channel failed (%s): %s",
                                        ch.get("tg_channel_id"), e)
                            v = "fake_pass"
                        verdicts[ch["speaker_id"]] = v
                        if v == "not_subscribed":
                            not_all_subscribed = True
            # нет токена → пропускаем проверку (не блокируем)

        # ── НЕ подписан на все нужные каналы — показываем список каналов ──────
        if channels and not_all_subscribed:
            def _is_done(c):
                return verdicts.get(c["speaker_id"]) in ("subscribed", "fake_pass")

            def _channel_title(url: str) -> str:
                """Название канала из url: последний сегмент после t.me/ или @."""
                u = (url or "").strip().rstrip("/")
                if not u:
                    return "канал"
                seg = u.split("/")[-1].lstrip("@")
                return seg or "канал"

            lines = ["Чтобы попасть в чат — подпишитесь на каналы:", ""]

            # ── Неподписанные — сквозная нумерация по всем группам ──
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
                    lines.append(f"<b>{header}:</b>")
                for c in grp:
                    counter += 1
                    name = _html.escape(c["name"] or "Канал")
                    url = (c["tg_channel_url"] or "").strip()
                    if url:
                        lines.append(f'{counter}. <a href="{_html.escape(url)}">{name}</a>')
                    else:
                        lines.append(f"{counter}. {name}")
                if multi_group:
                    lines.append("")

            # ── Уже подписанные ──
            done = [c for c in channels if _is_done(c)]
            if done:
                lines.append("\n\n")
                lines.append("Вы уже подписаны:")
                for c in done:
                    name = _html.escape(c["name"] or "Канал")
                    url = (c["tg_channel_url"] or "").strip()
                    title = _html.escape(_channel_title(url))
                    if url:
                        lines.append(f'✅ <a href="{_html.escape(url)}">{name}</a> ({title})')
                    else:
                        lines.append(f"✅ {name} ({title})")

            kb = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="✅ Готово / Проверить снова",
                                      callback_data=f"evchat_{event_id}")],
                [InlineKeyboardButton(text="⬅️ Меню события",
                                      callback_data=f"evmenu_{event_id}")],
            ])
            await message.answer(
                "\n".join(lines).strip(), reply_markup=kb,
                parse_mode="HTML", disable_web_page_preview=True,
            )
            return

        # ── Подписан (или mode=none) — выдаём ссылки на чаты ──────────────────
        text, rows = _build_chat_links_message(ev, event_id, work_tg)
        kb = InlineKeyboardMarkup(inline_keyboard=rows) if rows else None
        await message.answer(
            text, reply_markup=kb, parse_mode="HTML",
            disable_web_page_preview=True,
        )


@router.callback_query(F.data.startswith("evsignup_"))
async def handle_event_signup(callback: CallbackQuery):
    """«ЗАРЕГИСТРИРОВАТЬСЯ» у события со `skip_contact_form` — регистрируем прямо
    в боте по нажатию кнопки и присылаем меню события. Формы нет: человек уже в
    боте, контактные данные не спрашиваем."""
    try:
        event_id = int((callback.data or "").removeprefix("evsignup_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return

    user_tg_id = callback.from_user.id
    pool = await get_pool()
    async with pool.acquire() as db:
        client_id = await db.fetchval(
            """SELECT eo.client_id FROM event_owners eo
                WHERE eo.event_id = $1 AND eo.status = 'accepted'
                ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1""",
            event_id,
        )
        # contact_id — строго в базе клиента-владельца события (у человека может
        # быть несколько tg-идентичностей на разных клиентов).
        contact_id = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE platform_slug = 'telegram' AND platform_user_id = $1
                  AND client_id = $2
                ORDER BY id DESC LIMIT 1""",
            str(user_tg_id), client_id,
        )
        if not contact_id:
            await callback.answer("Не нашли ваш профиль — напишите в поддержку",
                                  show_alert=True)
            return

        from app.services.event_signup import signup_participant_in_bot
        ok = await signup_participant_in_bot(
            db, event_id=event_id, contact_id=contact_id)
        if not ok:
            await callback.answer("Не удалось зарегистрировать — попробуйте ещё раз",
                                  show_alert=True)
            return

        from bot.handlers.start import send_event_menu
        await send_event_menu(callback.message, event_id, contact_id, db)
    await callback.answer("Вы зарегистрированы 🎉")


@router.callback_query(F.data.startswith("evmenu_"))
async def handle_event_menu_back(callback: CallbackQuery):
    """«⬅️ Меню события» — возврат в меню кабинета зарегистрированного участника."""
    try:
        event_id = int((callback.data or "").removeprefix("evmenu_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return

    user_tg_id = callback.from_user.id
    pool = await get_pool()
    async with pool.acquire() as db:
        # Резолв contact_id по telegram-идентичности.
        contact_id = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE platform_slug = 'telegram'
                  AND platform_user_id = $1
                ORDER BY id DESC LIMIT 1""",
            str(user_tg_id),
        )
        # Отложенный импорт во избежание циклической зависимости.
        from bot.handlers.start import send_event_menu
        await send_event_menu(callback.message, event_id, contact_id, db)
    await callback.answer()


@router.callback_query(F.data.startswith("evsupport_"))
async def handle_event_support(callback: CallbackQuery):
    """«🆘 Тех. поддержка» — тонкая обёртка над `run_event_support`.

    Та же логика доступна по внешней ссылке `?start=evsupport_<event_id>`
    (ветка в handlers/start.py) — используется кнопкой «Тех.поддержка» в рассылках."""
    try:
        event_id = int((callback.data or "").removeprefix("evsupport_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return
    if callback.message:
        await run_event_support(callback.message, event_id)
    await callback.answer()


async def run_event_support(message: Message, event_id: int) -> None:
    """Единое сообщение с каналами связи клиента-владельца события (ВК / ТГ / MAX).
    Вызывается из callback-кнопки меню (`evsupport_<id>`) и из внешней ссылки
    `?start=evsupport_<id>` (кнопка «Тех.поддержка» в рассылках)."""
    # ⚠️ У КОЛЛАБЫ — контакты ВСЕХ организаторов (см. support_text_for_event).
    from app.services.support_message import support_text_for_event
    pool = await get_pool()
    async with pool.acquire() as db:
        text = await support_text_for_event(db, event_id, html=True)
    await message.answer(text, parse_mode="HTML", disable_web_page_preview=True)


_RU_MONTHS = ["", "января", "февраля", "марта", "апреля", "мая", "июня",
              "июля", "августа", "сентября", "октября", "ноября", "декабря"]


@router.callback_query(F.data.startswith("evlive_"))
async def handle_event_live(callback: CallbackQuery):
    """«📺 Ссылка на эфир» — тонкая обёртка над `run_event_live`.

    Та же логика доступна по внешней ссылке `?start=evlive_<event_id>`
    (ветка в handlers/start.py) — поэтому тело вынесено в отдельную функцию."""
    try:
        event_id = int((callback.data or "").removeprefix("evlive_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return
    if callback.message:
        await run_event_live(callback.message, event_id, callback.from_user.id)
    await callback.answer()


async def run_event_live(message: Message, event_id: int, user_tg_id: int) -> None:
    """Сообщение «Ближайший эфир» — ближайшая будущая сессия / старт события +
    кнопка «ВОЙТИ В ЭФИР» (если есть stream_url и не скрыт). Внизу — кнопки
    «Программа» и «⬅️ Вернуться в меню».

    Вызывается из callback-кнопки меню (`evlive_<id>`) и из внешней ссылки
    `telegram.me/{бот}?start=evlive_<id>` — одна логика на обе точки входа."""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    pool = await get_pool()
    async with pool.acquire() as db:
        ev = await db.fetchrow(
            """SELECT id, slug, title, module_slug, start_at,
                      hide_stream_button,
                      (SELECT eo.client_id FROM event_owners eo
                        WHERE eo.event_id = e.id AND eo.status='accepted'
                        ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id,
                      (SELECT c.default_link_mode FROM event_owners eo
                         JOIN clients c ON c.id = eo.client_id
                        WHERE eo.event_id = e.id AND eo.status='accepted'
                        ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS default_link_mode
                 FROM events e WHERE e.id = $1 LIMIT 1""",
            event_id,
        )
        if not ev:
            await message.answer("Событие не найдено.")
            return

        # contact_id — строго в базе клиента-владельца события (единый хелпер).
        from app.services.webinar_service import resolve_event_contact_id
        contact_id = await resolve_event_contact_id(db, ev["id"], "telegram", user_tg_id)

        now_msk = datetime.now(ZoneInfo("Europe/Moscow"))
        live_when = ""   # «3 мая 12:00 МСК»
        live_what = ""   # название сессии / события

        # Ближайшая будущая сессия программы (conf_days.day_date + start_time).
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
                dt = datetime(r["day_date"].year, r["day_date"].month,
                              r["day_date"].day, int(hh), int(mm),
                              tzinfo=ZoneInfo("Europe/Moscow"))
            except Exception:
                continue
            if dt >= now_msk - timedelta(minutes=90):  # текущий/будущий эфир
                chosen = (dt, r["title"])
                break
        if chosen is None and sessions:
            # все прошли — берём последнюю
            r = sessions[-1]
            try:
                hh, mm = str(r["start_time"])[:5].split(":")
                dt = datetime(r["day_date"].year, r["day_date"].month,
                              r["day_date"].day, int(hh), int(mm),
                              tzinfo=ZoneInfo("Europe/Moscow"))
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

        # Текст
        title = _html.escape(ev["title"] or "")
        if live_when:
            text = f"<b>Ближайший эфир</b> — {_html.escape(live_when)}"
            if live_what:
                text += f"\n{_html.escape(live_what)}"
        else:
            text = "<b>Ближайший эфир</b>"

        # Кнопка/заглушка стрима — ссылка эфира = комната АКТУАЛЬНОГО дня (+ contact_id).
        from app.services.webinar_service import day_stream_url as _day_stream_url, current_event_day
        _sd = await current_event_day(db, ev["id"])
        stream_url = await _day_stream_url(db, ev["id"], _sd, contact_id) if _sd else ""
        hide = bool(ev["hide_stream_button"])
        rows = []
        if stream_url and not hide:
            rows.append([InlineKeyboardButton(text="ВОЙТИ В ЭФИР", url=stream_url)])
        else:
            text += "\n\nКнопка на стрим появится тут перед эфиром."

        text += "\n\nЧтобы посмотреть всю программу — нажмите на кнопку 👇"

        cid_q = f"?c={contact_id}" if contact_id else ""
        # Кнопка «Программа» — Mini App или веб по глобальной настройке клиента.
        # Веб-страница программы — публичная страница клиента (Mini App-ветка
        # ниже её перебивает: адрес Mini App на домен клиента не переезжает).
        prog_url = await client_public_link(
            db, ev["client_id"], f"event/{ev['slug']}{cid_q}#program"
        )
        if (ev["default_link_mode"] or "miniapp") == "miniapp" and ev["client_id"]:
            from app.services.share_links import get_client_bot_handles, telegram_link
            handles = await get_client_bot_handles(db, ev["client_id"])
            tg_handle = handles.get("telegram")
            if tg_handle:
                ma = telegram_link(ev["slug"], bot_handle=tg_handle, tab="program",
                                   contact_id=contact_id, link_mode="miniapp")
                if ma:
                    prog_url = ma
        rows.append([InlineKeyboardButton(text="Программа", url=prog_url)])
        rows.append([InlineKeyboardButton(
            text="⬅️ Вернуться в меню", callback_data=f"evmenu_{event_id}")])

        kb = InlineKeyboardMarkup(inline_keyboard=rows)
        await message.answer(text, reply_markup=kb, parse_mode="HTML",
                             disable_web_page_preview=True)


@router.callback_query(F.data.startswith("fnl_check_"))
async def handle_check_subscription(callback: CallbackQuery):
    try:
        run_id = int((callback.data or "").removeprefix("fnl_check_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return
    pool = await get_pool()
    from app.services.funnel_service import (
        run_check_subscription,
        check_telegram_channels_subscription,
    )
    async with pool.acquire() as db:
        result = await run_check_subscription(run_id, str(callback.from_user.id), db)
        if result == "subscribed":
            await callback.answer("Готово! Проверяйте сообщения 🎁", show_alert=False)
        elif result == "survey_required":
            # Перед подарком нужно заполнить анкету. Кидаем ссылку кнопкой —
            # в ней зашиты человек, номер подарка и площадка, поэтому файл
            # выдастся сразу после отправки, возвращать сюда не нужно.
            await callback.answer()
            await _send_survey_gate_tg(callback, run_id, db)
        elif result == "not_subscribed":
            client_id = await db.fetchval("SELECT client_id FROM funnel_runs WHERE id=$1", run_id)
            # Перепроверяем, чтобы перечислить КАКИЕ именно каналы не подписаны
            # (Telegram callback.answer лимит ~200 символов — обрезаем до 3 каналов).
            missing_text = ""
            if client_id:
                sub = await check_telegram_channels_subscription(
                    client_id, str(callback.from_user.id), db
                )
                missing = sub.get("missing") or []
                if missing:
                    shown = missing[:3]
                    parts = [(ch.get("name") or ch.get("url") or "") for ch in shown]
                    parts = [p for p in parts if p]
                    rest = len(missing) - len(shown)
                    suffix = f" и ещё {rest}" if rest > 0 else ""
                    missing_text = ", ".join(parts) + suffix
            alert = (
                f"Не вижу подписки на канал(ы): {missing_text}. Подпишитесь и нажмите снова."
                if missing_text
                else "Не вижу подписки на канал основателя. Подпишитесь и нажмите снова."
            )
            await callback.answer(alert, show_alert=True)
        elif result == "no_token":
            await callback.answer(
                "Технические неполадки. Попробуйте позже или свяжитесь с организатором.",
                show_alert=True,
            )
        else:
            await callback.answer("Что-то пошло не так. Попробуйте позже.", show_alert=True)


@router.callback_query(F.data.startswith("spkreg_confirm_"))
async def handle_speaker_self_register(callback: CallbackQuery):
    """Саморегистрация спикером (2026-05-29). На клик кнопки «Включить в
    спикеры» из сообщения по `/start spkreg_<event_id>`: создаём коллаба +
    привязку к событию, шлём ссылку на кабинет."""
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
    try:
        event_id = int((callback.data or "").removeprefix("spkreg_confirm_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return
    pool = await get_pool()
    user = callback.from_user
    async with pool.acquire() as db:
        from app.services.speaker_self_register import (
            get_event_for_self_register, complete_speaker_self_register,
        )
        ev = await get_event_for_self_register(db, event_id)
        if not ev:
            await callback.answer("Событие не найдено", show_alert=True)
            return
        # Узнаём contact + его имя (upsert уже был при /start spkreg_).
        contact = await db.fetchrow(
            """SELECT c.id, c.name
                 FROM contacts c
                 JOIN platform_users pu ON pu.contact_id = c.id
                WHERE c.client_id = $1 AND pu.platform_slug = 'telegram'
                  AND pu.platform_user_id = $2
                LIMIT 1""",
            ev["client_id"], str(user.id),
        )
        if not contact:
            await callback.answer("Сначала перейдите по ссылке организатора.", show_alert=True)
            return
        try:
            coll_id, access_code, slug, already = await complete_speaker_self_register(
                db,
                event_id=event_id,
                client_id=ev["client_id"],
                contact_id=contact["id"],
                contact_name=contact["name"] or (user.full_name or "Спикер"),
            )
        except Exception as e:
            log.exception("speaker self-register failed: %s", e)
            await callback.answer("Что-то пошло не так. Попробуйте позже.", show_alert=True)
            return

    # Берём username бота для построения ссылки spkinv_<code>.
    try:
        me = await callback.bot.get_me()
        bot_handle = me.username or "pluson_bot"
    except Exception:
        bot_handle = "pluson_bot"
    spkinv_url = f"https://telegram.me/{bot_handle}?start=spkinv_{access_code}"

    assistant_hint = (
        "\n\nЕсли хотите, чтобы ваш профиль вёл ассистент — войдите в кабинет "
        "и впишите его Telegram-ник в своей карточке (поле «Telegram-ник ассистента» "
        "сразу под именем). После этого он сможет открыть кабинет по ссылке от организатора."
    )
    if already:
        head = f"Вы уже спикер «{ev['title']}».\n\nОткройте свой кабинет для заполнения данных:{assistant_hint}"
    else:
        head = (
            f"Готово! Вы включены в спикеры «{ev['title']}».\n\n"
            f"Войдите в кабинет спикера и заполните данные о себе.{assistant_hint}"
        )
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="📝 Открыть кабинет спикера", url=spkinv_url)
    ]])
    try:
        await callback.message.answer(head, reply_markup=kb)
    except Exception as e:
        log.exception("send spkreg confirm reply failed: %s", e)
    await callback.answer("Готово!", show_alert=False)
