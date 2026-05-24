"""
/start handler для @pluson_bot.

Сценарии:
  /start fnl_<run_id>  — landing воронки лид-магнита (см. funnel_service.run_started)
  /start ref_pg<...>   — переход с реф-ссылки события (открываем Mini App)
  /start ref_<old>     — старый формат ref-кода (compat)
  /start               — приветствие + ссылка на свои события
"""
from aiogram import Router, F
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.filters import CommandStart, CommandObject, Command
from app.config import settings
from app.database import get_pool
import html as _html
import json
import logging
from datetime import datetime
from zoneinfo import ZoneInfo
import httpx

router = Router()
log = logging.getLogger(__name__)


async def _record_subscription(message: Message) -> None:
    """Регистрирует подписку пользователя на этот конкретный TG-канал.

    Архитектура G — определяем client_id:
      - Системный канал (@pluson_bot, is_system=TRUE) → системный клиент «ПЛЮСОН Сервис».
      - VIP-канал клиента → client_id из client_channels.

    Если потом пользователь сделает /start с реф/событием — запись в контексте того
    клиента создастся отдельно (через ref-handler / event_start). Это не баг, а фича:
    один tg_id может быть в нескольких контекстах одновременно.
    """
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return
    try:
        from app.services.channels import find_channel_by_bot_id, register_telegram_subscription
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                return
            # Определяем client_id для записи подписки
            if ch["is_system"]:
                client_id = await db.fetchval(
                    "SELECT id FROM clients WHERE email='system@pluson.ru' AND is_active=TRUE LIMIT 1"
                )
            else:
                client_id = await db.fetchval(
                    """SELECT client_id FROM client_channels
                        WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
                    ch["id"]
                )
            if not client_id:
                return
            await register_telegram_subscription(
                client_id, ch["id"], str(user.id),
                username=user.username or "",
                first_name=user.first_name or "",
                last_name=user.last_name or "",
                db=db,
            )
    except Exception as e:
        log.warning("record_subscription failed: %s", e)


@router.message(CommandStart())
async def handle_start(message: Message, command: CommandObject):
    args = (command.args or "").strip()
    user = message.from_user

    # Регистрируем подписку — для счётчика подписчиков канала и базы контактов
    await _record_subscription(message)

    # Воронка лид-магнита: прямой формат `/start m_<slug>` (для лид-магнита) или
    # `/start p_<slug>` (для пакета). Опционально с UTM/pid: `m_<slug>_pid<ref>_src<utm>`.
    # Бот сам создаёт funnel_run и запускает run_started. Это заменяет старый
    # путь через pluson.ru/m/{slug}?to=tg.
    if args.startswith("m_") or args.startswith("p_"):
        kind = "m" if args.startswith("m_") else "p"
        # Разбираем `{slug}_pid{X}_src{Y}` — slug = до первого `_pid`/`_src` или весь хвост
        rest = args[2:]
        parts = rest.split("_") if rest else []
        slug = parts[0] if parts else ""
        pid: str | None = None
        utm_source: str | None = None
        for chunk in parts[1:]:
            if chunk.startswith("pid"):
                pid = chunk[3:] or None
            elif chunk.startswith("src"):
                utm_source = chunk[3:] or None
        if slug:
            try:
                pool = await get_pool()
                bot_id = message.bot.id if message.bot else None
                async with pool.acquire() as db:
                    if kind == "m":
                        row = await db.fetchrow(
                            "SELECT id, client_id FROM lead_magnets WHERE slug = $1", slug
                        )
                        client_id = row["client_id"] if row else None
                        lm_id = row["id"] if row else None
                        pkg_id = None
                    else:
                        row = await db.fetchrow(
                            "SELECT id, client_id FROM lead_magnet_packages WHERE slug = $1", slug
                        )
                        client_id = row["client_id"] if row else None
                        lm_id = None
                        pkg_id = row["id"] if row else None
                    if client_id:
                        referrer_id = None
                        if pid:
                            referrer_id = await db.fetchval(
                                "SELECT id FROM contacts WHERE client_id = $1 AND ref_code = $2",
                                client_id, pid,
                            )
                        utm_json = {"utm_source": utm_source} if utm_source else {}
                        run_id = await db.fetchval(
                            """INSERT INTO funnel_runs
                                  (client_id, type, lead_magnet_id, package_id,
                                   contact_id, referrer_contact_id, utm, stage, landed_at,
                                   platform_slug)
                               VALUES ($1, 'lead_magnet', $2, $3, NULL, $4, $5::jsonb, 'landed', NOW(), 'telegram')
                               RETURNING id""",
                            client_id, lm_id, pkg_id, referrer_id, json.dumps(utm_json),
                        )
                        from app.services.funnel_service import run_started
                        await run_started(
                            run_id,
                            str(user.id),
                            user.username or "",
                            user.first_name or "",
                            user.last_name or "",
                            db,
                            bot_id=bot_id,
                        )
                        return
                # Не нашли воронку — молча падаем дальше на приветствие
            except Exception as e:
                log.exception("funnel m_/p_ handler failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # Регистрация партнёра — прямые ссылки (миграция 105, рефакторинг 24.05.2026):
    #   prtc_<client_id>   — корневая ссылка клиента (без рефовода)
    #   prtp_<contact_id>  — личная ссылка партнёра (рефовод = этот контакт)
    # Старый prt_<run_id> (через /partner/{cid}-прокси) сохранён для совместимости.
    if args.startswith("prtc_") or args.startswith("prtp_"):
        pool = await get_pool()
        from app.services.partner_service import start_partner_flow
        try:
            bot_id = message.bot.id if message.bot else None
            async with pool.acquire() as db:
                handled = await start_partner_flow(
                    args,
                    str(user.id),
                    user.username or "",
                    user.first_name or "",
                    user.last_name or "",
                    db,
                    bot_id=bot_id,
                )
                if handled:
                    return
        except Exception as e:
            log.exception("start_partner_flow failed: %s", e)
            await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
            return

    # Старый формат через прокси (deprecated, оставлено для уже разосланных ссылок)
    if args.startswith("prt_"):
        try:
            run_id = int(args.removeprefix("prt_"))
        except ValueError:
            run_id = None
        if run_id:
            pool = await get_pool()
            from app.services.partner_service import run_started_partner
            try:
                bot_id = message.bot.id if message.bot else None
                async with pool.acquire() as db:
                    await run_started_partner(
                        run_id,
                        str(user.id),
                        user.username or "",
                        user.first_name or "",
                        user.last_name or "",
                        db,
                        bot_id=bot_id,
                    )
                return
            except Exception as e:
                log.exception("run_started_partner failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # Возврат после сабмита формы партнёрского лендинга (миграция 105).
    # Партнёрский сервис в редирект-после-формы ставит t.me/{bot}?start=partner_done_<client_id>.
    # Мы по tg_id ищем contact у клиента и шлём сообщение «вы зарегистрированы / упс».
    if args.startswith("partner_done_"):
        try:
            client_id = int(args.removeprefix("partner_done_"))
        except ValueError:
            client_id = None
        if client_id:
            pool = await get_pool()
            from app.services.partner_service import send_partner_done_tg
            try:
                bot_id = message.bot.id if message.bot else None
                async with pool.acquire() as db:
                    await send_partner_done_tg(client_id, str(user.id), db, bot_id=bot_id)
                return
            except Exception as e:
                log.exception("send_partner_done_tg failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # Самообслуживание спикера (миграция 108): /start spkinv_<access_code>.
    # Спикер кликнул invite-ссылку из сообщения, которое организатор скопировал
    # и отправил ему в личку. Опознаём коллаба по access_code → шлём в чат
    # код доступа и ссылку на лендинг pluson.ru/speaker/<event_slug>.
    if args.startswith("spkinv_"):
        access_code = args.removeprefix("spkinv_").strip()
        if access_code:
            pool = await get_pool()
            try:
                async with pool.acquire() as db:
                    coll = await db.fetchrow(
                        """SELECT c.id AS collaborator_id, c.name, c.contact_id,
                                  c.created_by_client_id
                             FROM collaborators c
                            WHERE LOWER(c.access_code) = LOWER($1)""",
                        access_code,
                    )
                    if not coll:
                        await message.answer(
                            "😕 Ссылка устарела или код доступа изменился. Попросите организатора прислать актуальное сообщение."
                        )
                        return

                    # Привязываем личный TG спикера к contact (если ещё не привязан).
                    from app.api.collaborators import _upsert_personal_identity
                    if coll["contact_id"] and coll["created_by_client_id"]:
                        await _upsert_personal_identity(
                            db,
                            coll["created_by_client_id"],
                            coll["contact_id"],
                            'telegram',
                            str(user.id),
                            user.username or None,
                        )

                    # Берём первое event_collaborators этого коллаба, чтобы знать slug.
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
                    text_lines = [
                        f"Здравствуйте, {name}!",
                        "",
                        f"Вы — спикер «{event_title}». Чтобы заполнить свои данные для участников события, откройте свой кабинет:",
                        f"<b>{cabinet_url}</b>",
                        "",
                        f"Код доступа: <code>{access_code}</code>",
                        "",
                        "На странице выберите свою фамилию из списка и введите этот код. Сессия живёт 24 часа. Можно передать ссылку и код ассистенту — он заполнит за вас.",
                    ]
                    await message.answer(
                        "\n".join(text_lines),
                        parse_mode="HTML",
                        disable_web_page_preview=True,
                    )
                return
            except Exception as e:
                log.exception("spkinv_ handler failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # Воронка лид-магнита (старый формат, через pluson.ru/m/{slug}?to=tg → 302 → /start fnl_<id>)
    if args.startswith("fnl_"):
        try:
            run_id = int(args.removeprefix("fnl_"))
        except ValueError:
            run_id = None
        if run_id:
            pool = await get_pool()
            from app.services.funnel_service import run_started
            try:
                bot_id = message.bot.id if message.bot else None
                async with pool.acquire() as db:
                    await run_started(
                        run_id,
                        str(user.id),
                        user.username or "",
                        user.first_name or "",
                        user.last_name or "",
                        db,
                        bot_id=bot_id,
                    )
                return
            except Exception as e:
                log.exception("run_started failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # /start reg_<event_slug> — пользователь только что оплатил на стороннем
    # лендинге и был отправлен в бота через t.me-ссылку (страница /r/{slug}
    # в браузере без Telegram.WebApp → universal link → этот бот).
    # Дозарегистрируем участника по tg_id и пришлём приветствие + Mini App.
    if args.startswith("reg_"):
        event_slug = args.removeprefix("reg_").strip()
        if event_slug:
            try:
                pool = await get_pool()
                async with pool.acquire() as db:
                    from app.services.contact_merge import upsert_contact_with_identity
                    event = await db.fetchrow(
                        "SELECT id, client_id, title, slug FROM events WHERE slug=$1 AND status='published'",
                        event_slug,
                    )
                    if event:
                        contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                            db,
                            client_id=event["client_id"],
                            platform_slug='telegram',
                            platform_user_id=str(user.id),
                            username=user.username or "",
                            first_name=user.first_name or "",
                            last_name=user.last_name or "",
                        )
                        existing = await db.fetchval(
                            "SELECT id FROM event_participants WHERE event_id=$1 AND contact_id=$2",
                            event["id"], contact_id,
                        )
                        if existing:
                            await db.execute(
                                "UPDATE event_participants SET is_registered=TRUE WHERE id=$1",
                                existing,
                            )
                        else:
                            await db.execute(
                                """INSERT INTO event_participants (event_id, contact_id, is_registered)
                                   VALUES ($1, $2, TRUE)""",
                                event["id"], contact_id,
                            )
                        # Mini App открывается прямо в контексте этого события.
                        # Для VIP-бота клиента — /c/{client_id}/tg/event/{slug},
                        # для общего @pluson_bot — /tg/event/{slug}.
                        # Бот VIP — это бот, у которого `is_system=FALSE` среди
                        # активных каналов клиента.
                        is_vip_bot = await db.fetchval(
                            """SELECT COALESCE(BOOL_OR(NOT ch.is_system), FALSE)
                                 FROM channels ch
                                 JOIN client_channels cc ON cc.channel_id = ch.id
                                WHERE cc.client_id = $1
                                  AND ch.platform_slug = 'telegram'
                                  AND cc.is_active = TRUE
                                  AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''""",
                            event["client_id"],
                        )
                        base = "https://pluson.ru"
                        path = f"/c/{event['client_id']}/tg/event/{event_slug}" if is_vip_bot else f"/tg/event/{event_slug}"
                        mini_app_url = f"{base}{path}?_reg=1"
                        kb = InlineKeyboardMarkup(inline_keyboard=[[
                            InlineKeyboardButton(text="🎉 Открыть кабинет события",
                                                 web_app=WebAppInfo(url=mini_app_url))
                        ]])
                        await message.answer(
                            f"Поздравляем с регистрацией на «{event['title']}»! 🎉\n\n"
                            f"Откройте кабинет события, чтобы попасть в чат участников и забрать партнёрскую ссылку.",
                            reply_markup=kb,
                        )
                        return
            except Exception as e:
                log.exception("reg_ handler failed: %s", e)

    # Старый сценарий: реф-ссылка события → Mini App
    if args.startswith("ref_") or args.startswith("ref"):
        mini_app_url = f"{settings.mini_app_url}?ref={args}"
        keyboard = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(
                text="🎮 Открыть",
                web_app=WebAppInfo(url=mini_app_url)
            )
        ]])
        await message.answer(
            f"Привет, {user.first_name or ''}! 👋\n\nНажмите кнопку, чтобы открыть приложение.",
            reply_markup=keyboard,
        )
        return

    # Прямой /start на VIP-боте клиента — приветствие с фото и списком ближайших событий
    bot_id = message.bot.id if message.bot else None
    if bot_id and await _handle_vip_direct_start(message, bot_id):
        return

    # Прямой /start (системный @pluson_bot или ошибка определения клиента)
    await message.answer(
        f"Привет, {user.first_name or ''}! 👋\n\n"
        f"Я бот <b>iViSiON: ПЛЮСОН</b> — платформа для организаторов и экспертов.\n\n"
        f"Откройте Mini App или перейдите по ссылке организатора.",
        parse_mode="HTML",
    )


async def _handle_vip_direct_start(message: Message, bot_id: int) -> bool:
    """Прямой /start на VIP-боте клиента — приветствие с фото основателя
    и списком ближайших событий клиента.

    Возвращает True если сообщение отправлено (нужно остановить дальнейшую обработку),
    False — если это системный @pluson_bot или возникла ошибка (тогда сработает общий fallback).
    """
    user = message.from_user
    if not user:
        return False
    if message.chat and message.chat.type != 'private':
        return False
    try:
        from app.services.channels import find_channel_by_bot_id
        from app.services.event_welcome import _fmt_event_period

        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch or ch["is_system"]:
                return False  # системный бот — общий fallback

            client_id = await db.fetchval(
                """SELECT client_id FROM client_channels
                    WHERE channel_id = $1
                    ORDER BY is_active DESC, id ASC LIMIT 1""",
                ch["id"],
            )
            if not client_id:
                return False

            client = await db.fetchrow(
                """SELECT id, name, brand_name,
                          profile_photo_url, owner_photo_url
                     FROM clients WHERE id = $1""",
                client_id,
            )
            if not client:
                return False

            events = await db.fetch(
                """
                SELECT * FROM (
                    SELECT e.id, e.slug, e.title, e.module_slug,
                           COALESCE(
                             CASE WHEN e.module_slug IN ('conference','turnir') THEN
                               (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                        AT TIME ZONE 'Europe/Moscow'
                                  FROM conf_days d WHERE d.event_id = e.id
                                  ORDER BY d.day_number ASC LIMIT 1)
                             END,
                             e.start_at
                           ) AS effective_start_at,
                           COALESCE(
                             CASE WHEN e.module_slug IN ('conference','turnir') THEN
                               (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                        AT TIME ZONE 'Europe/Moscow'
                                  FROM conf_days d WHERE d.event_id = e.id
                                  ORDER BY d.day_number DESC LIMIT 1)
                             END,
                             e.end_at
                           ) AS effective_end_at
                      FROM events e
                     WHERE e.client_id = $1
                       AND e.status = 'published'
                ) t
                WHERE t.effective_start_at IS NOT NULL
                  AND (t.effective_end_at IS NULL OR t.effective_end_at > NOW())
                ORDER BY t.effective_start_at ASC
                LIMIT 4
                """,
                client_id,
            )

        # Текст приветствия
        brand_name = (client["brand_name"] or client["name"] or "").strip()
        greet_name = (user.first_name or "").strip()
        greeting = f"Привет, {_html.escape(greet_name)}! 👋" if greet_name else "Привет! 👋"

        intro_lines = [greeting, ""]
        if brand_name:
            intro_lines.append(f"Добро пожаловать в бот <b>{_html.escape(brand_name)}</b>.")
        else:
            intro_lines.append("Добро пожаловать!")
        intro_lines.append("")
        intro_lines.append("🌐 По кнопке <b>«ЭКОСИСТЕМА»</b> — полезные материалы и продукты организатора.")

        if events:
            intro_lines.append("")
            intro_lines.append("📅 А ещё вы можете попасть на ближайшие события:")
            intro_lines.append("")
            for idx, ev in enumerate(events, start=1):
                is_conf = ev["module_slug"] == "conference"
                date_str = _fmt_event_period(
                    ev["effective_start_at"], ev["effective_end_at"], is_conf
                )
                title = _html.escape(ev["title"] or "Без названия")
                intro_lines.append(f"<b>{idx}.</b> {title}")
                if date_str:
                    intro_lines.append(f"🗓 {date_str}")
                intro_lines.append("")
            # убираем последний пустой
            while intro_lines and intro_lines[-1] == "":
                intro_lines.pop()

        text = "\n".join(intro_lines)

        # Клавиатура: «Открыть N» (по 2 в ряд) + «ВСЕ СОБЫТИЯ» + «ЭКОСИСТЕМА»
        rows: list[list[InlineKeyboardButton]] = []
        buf: list[InlineKeyboardButton] = []
        for idx, ev in enumerate(events, start=1):
            url = f"https://pluson.ru/c/{client_id}/tg/event/{ev['slug']}"
            buf.append(InlineKeyboardButton(
                text=f"Открыть {idx}",
                web_app=WebAppInfo(url=url),
            ))
            if len(buf) == 2:
                rows.append(buf)
                buf = []
        if buf:
            rows.append(buf)

        rows.append([InlineKeyboardButton(
            text="📅 ВСЕ СОБЫТИЯ",
            web_app=WebAppInfo(url=f"https://pluson.ru/c/{client_id}/tg/"),
        )])
        rows.append([InlineKeyboardButton(
            text="🌐 ЭКОСИСТЕМА",
            web_app=WebAppInfo(url=f"https://pluson.ru/c/{client_id}/tg/?_tab=ecosystem"),
        )])
        keyboard = InlineKeyboardMarkup(inline_keyboard=rows)

        # Фото клиента — приоритет фото основателя, fallback на фото бренда
        photo_url = client["owner_photo_url"] or client["profile_photo_url"]

        TG_CAPTION_LIMIT = 1024
        if photo_url:
            if len(text) <= TG_CAPTION_LIMIT:
                try:
                    await message.answer_photo(
                        photo=photo_url,
                        caption=text,
                        parse_mode="HTML",
                        reply_markup=keyboard,
                    )
                    return True
                except Exception as e:
                    log.warning("vip_start answer_photo failed: %s — fallback to text", e)
            else:
                # Текст не влезает в caption — фото отдельно, потом текст с кнопкой
                try:
                    await message.answer_photo(photo=photo_url)
                except Exception as e:
                    log.warning("vip_start answer_photo (separate) failed: %s", e)
                await message.answer(
                    text, parse_mode="HTML",
                    reply_markup=keyboard,
                    disable_web_page_preview=True,
                )
                return True

        # Без фото
        await message.answer(
            text, parse_mode="HTML",
            reply_markup=keyboard,
            disable_web_page_preview=True,
        )
        return True
    except Exception as e:
        log.exception("_handle_vip_direct_start failed: %s", e)
        return False


@router.message(Command(commands=["getchatid"]))
async def handle_getchatid(message: Message):
    """Подсказка для клиента: как получить chat_id канала уведомлений.
    Если бот добавлен админом в канал и клиент пересылает сюда сообщение из канала —
    бот отвечает chat_id канала (forward_from_chat.id)."""
    fwd = message.forward_from_chat
    if fwd:
        await message.answer(
            f"<b>ID канала:</b> <code>{fwd.id}</code>\n\n"
            f"Скопируйте это число и вставьте в поле «Канал уведомлений» в Настройках → Технические.",
            parse_mode="HTML",
        )
        return
    await message.answer(
        "Чтобы узнать ID канала:\n\n"
        "1. Создайте Telegram-канал (или используйте существующий).\n"
        "2. Добавьте меня (@pluson_bot) в этот канал админом — права не нужны.\n"
        "3. Перешлите мне сюда любое сообщение из канала.\n\n"
        "Я отвечу с ID канала, который надо вставить в Настройки → Технические.",
    )


@router.message(
    (F.chat.type == 'private')
    & F.text
    & ~F.text.startswith('/')
    & F.forward_from_chat.is_(None)
    & F.forward_from.is_(None)
)
async def handle_user_message(message: Message):
    """Свободное сообщение пользователя в бот клиента (VIP или системный @pluson_bot).

    Развилка по типу бота:

    1) Системный @pluson_bot — мы НЕ знаем, какому организатору пользователь
       хочет написать (бот общий, в нём могут быть подписки на десятки клиентов).
       Никаких уведомлений никому НЕ шлём, никого не угадываем. Просто отвечаем
       пользователю текстом «откройте Лидеры» + web_app-кнопкой на эту вкладку.

    2) VIP-бот клиента — клиент за этим ботом ровно один (client_channels).
       Шлём уведомление #user_message в `clients.notifications_telegram_chat_id`,
       пользователю отвечаем «напишите лично @{work_tg}» + URL-кнопка
       «НАПИСАТЬ ЛИЧНО» → `t.me/{work_tg}?text=Есть вопрос`. Если у клиента
       work_tg_username пуст — fallback на кнопку «Открыть Экосистему».
    """
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return
    try:
        from app.services.channels import find_channel_by_bot_id
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                return

            # === Ветка 1: системный @pluson_bot ===
            if ch["is_system"]:
                # Ничего не лукапим, никому не уведомляем — просто отвечаем.
                reply = (
                    "Спасибо за сообщение 💛\n\n"
                    "Чтобы связаться с конкретным организатором — откройте приложение, "
                    "перейдите на вкладку «Лидеры», выберите нужного лидера и в разделе "
                    "«Экосистема» найдите его контакты для вопросов."
                )
                kb = InlineKeyboardMarkup(inline_keyboard=[[
                    InlineKeyboardButton(
                        text="Открыть «Лидеры»",
                        web_app=WebAppInfo(url="https://pluson.ru/tg/?_tab=leaders"),
                    ),
                ]])
                await message.answer(reply, reply_markup=kb)
                return

            # === Ветка 2: VIP-бот клиента ===
            client_id = await db.fetchval(
                """SELECT client_id FROM client_channels
                    WHERE channel_id = $1
                    ORDER BY is_active DESC, id ASC LIMIT 1""",
                ch["id"],
            )
            if not client_id:
                return

            client_row = await db.fetchrow(
                """SELECT notifications_telegram_chat_id, work_tg_username
                     FROM clients WHERE id = $1""",
                client_id,
            )
            if not client_row:
                return
            notif_chat_id = client_row["notifications_telegram_chat_id"]
            work_tg = (client_row["work_tg_username"] or "").lstrip("@")

            contact_row = await db.fetchrow(
                """SELECT pu.contact_id, c.name, c.utm_source
                     FROM platform_users pu
                LEFT JOIN contacts c ON c.id = pu.contact_id
                    WHERE pu.client_id = $1
                      AND pu.platform_slug = 'telegram'
                      AND pu.platform_user_id = $2""",
                client_id, str(user.id),
            )
            contact_id = contact_row["contact_id"] if contact_row else None
            contact_name = (contact_row["name"] if contact_row else "") or ""
            utm_source = (contact_row["utm_source"] if contact_row else None)

            bot_handle = await db.fetchval(
                "SELECT handle FROM channels WHERE id = $1", ch["id"],
            )

        # Уведомление в канал клиента (от @pluson_bot)
        if notif_chat_id:
            when_str = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
            display_name = (
                ((user.first_name or "") + " " + (user.last_name or "")).strip()
                or contact_name or "—"
            )
            user_nick = f"@{user.username}" if user.username else "—"
            card_url = (
                f"{settings.frontend_url}/dashboard/clients?contact={contact_id}"
                if contact_id else "—"
            )
            parts = [
                "#user_message 💬",
                "",
                f"<b>Когда:</b> {when_str}",
                f"<b>Бот:</b> {bot_handle or '—'}",
                "",
                "<b>Кто написал</b>",
                f"<b>Никнейм:</b> {user_nick}",
                f"<b>Имя:</b> {_html.escape(display_name)}",
                f"<b>TG ID:</b> <code>{user.id}</code>",
                f"<b>ID контакта:</b> {('#' + str(contact_id)) if contact_id else '—'}",
                f"<b>Источник (utm_source):</b> {_html.escape(utm_source) if utm_source else '—'}",
                f"<b>Карточка:</b> {card_url}",
                "",
                "<b>Сообщение:</b>",
                _html.escape(message.text or ""),
            ]
            notif_text = "\n".join(parts)
            token = settings.telegram_bot_token
            if token:
                try:
                    async with httpx.AsyncClient(timeout=10) as http:
                        await http.post(
                            f"https://api.telegram.org/bot{token}/sendMessage",
                            json={
                                "chat_id": notif_chat_id,
                                "text": notif_text,
                                "parse_mode": "HTML",
                                "disable_web_page_preview": True,
                            },
                        )
                except Exception as e:
                    log.warning("user_message notify failed: %s", e)

        # Ответ пользователю VIP-бота
        if work_tg:
            reply = (
                "Спасибо, видим ваше сообщение 💛\n\n"
                f"Для оперативного ответа напишите лично — @{work_tg}."
            )
            from urllib.parse import quote
            prefill = quote("Есть вопрос")
            personal_url = f"https://t.me/{work_tg}?text={prefill}"
            kb = InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="НАПИСАТЬ ЛИЧНО", url=personal_url),
            ]])
        else:
            reply = (
                "Спасибо за сообщение 💛\n\n"
                "Если нужно связаться с организатором — откройте приложение, "
                "вкладка «Экосистема». Там вся информация и контакты."
            )
            kb = InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(
                    text="Открыть «Экосистему»",
                    web_app=WebAppInfo(url=f"https://pluson.ru/c/{client_id}/tg/?_tab=ecosystem"),
                ),
            ]])
        await message.answer(reply, reply_markup=kb)
    except Exception as e:
        log.exception("handle_user_message failed: %s", e)


@router.message(F.chat.type == 'private')
async def handle_forwarded(message: Message):
    """Любая пересланная сюда из канала запись — отвечаем chat_id (для /getchatid).

    Только в личке с ботом. В групповых чатах/каналах Telegram сам форвардит
    посты канала в привязанный чат, и без этого фильтра бот сыпал ответами
    «ID канала: …» в чат, что не нужно.
    """
    fwd = message.forward_from_chat
    if fwd:
        await message.answer(
            f"<b>ID канала:</b> <code>{fwd.id}</code>",
            parse_mode="HTML",
        )
