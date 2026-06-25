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


async def _upgrade_pseudo_identities(user) -> None:
    """Дорастить ВСЕ псевдо-записи `platform_user_id='@<username>'` этого человека
    до реального числового tg_id — глобально, по всем клиентам.

    Зачем. Организатор может завести коллаба/контакт по @нику без числового id —
    тогда создаётся псевдо-запись platform_users (см.
    project_collaborator_pseudo_platform_users). Она должна сама превращаться в
    реальную при ЛЮБОМ касании ботом (любой /start: спикер, партнёр, лид-магнит,
    или вообще без аргументов). Раньше это делалось только внутри
    upsert_contact_with_identity и зависело от точки входа — отсюда баг «спикер
    есть в списке, а войти не может» (Юлия Фрейм, 2026-06-04).

    Идемпотентно. Срабатывает только если у юзера сейчас виден username (без него
    Telegram не присылает ник — сопоставить не с чем, это ограничение Telegram).
    """
    if not user or not user.username:
        return
    uname = user.username.lstrip("@").strip()
    if not uname:
        return
    real_id = str(user.id)
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            # ВСЕ псевдо-записи `@<username>` этого ника (по всем клиентам).
            # Контакт псевдо-записи — это, как правило, контакт коллаба, его
            # ОБЯЗАТЕЛЬНО сохраняем (на нём висит access_code кабинета).
            pseudos = await db.fetch(
                """SELECT p.id, p.client_id, p.contact_id
                     FROM platform_users p
                    WHERE p.platform_slug = 'telegram'
                      AND p.platform_user_id = $1""",
                f"@{uname}",
            )
            for ps in pseudos:
                async with db.transaction():
                    # Уже есть реальная TG-запись с этим tg_id у того же клиента?
                    real = await db.fetchrow(
                        """SELECT id, contact_id FROM platform_users
                            WHERE client_id = $1 AND platform_slug = 'telegram'
                              AND platform_user_id = $2 AND id <> $3
                            LIMIT 1""",
                        ps["client_id"], real_id, ps["id"],
                    )
                    if real is None:
                        # Ветка A: конфликта нет — просто дорастить заглушку.
                        await db.execute(
                            """UPDATE platform_users
                                  SET platform_user_id = $1, username = $2, updated_at = NOW()
                                WHERE id = $3""",
                            real_id, uname, ps["id"],
                        )
                        await db.execute(
                            """UPDATE platform_user_channels
                                  SET is_unsubscribed = FALSE,
                                      subscribed_at   = COALESCE(subscribed_at, NOW()),
                                      unsubscribed_at = NULL
                                WHERE platform_user_id = $1 AND is_unsubscribed = TRUE""",
                            ps["id"],
                        )
                        continue
                    # Ветка B: реальный tg_id уже создан ОТДЕЛЬНЫМ контактом
                    # (человек зашёл в бот раньше, чем коллаба завели по нику,
                    #  ИЛИ наоборот — заглушка не доросла). Сливаем реальный
                    #  контакт В контакт коллаба (ps.contact_id), сохраняя его.
                    keep_cid = ps["contact_id"]      # контакт коллаба — оставляем
                    dup_cid = real["contact_id"]     # реальный дубль — поглощаем
                    if dup_cid == keep_cid:
                        # Обе записи уже на одном контакте — просто убираем заглушку.
                        await db.execute("DELETE FROM platform_users WHERE id = $1", ps["id"])
                        continue
                    # Перенести зависимые сущности дубля на контакт коллаба.
                    await db.execute(
                        "UPDATE event_participants SET contact_id = $1 WHERE contact_id = $2",
                        keep_cid, dup_cid,
                    )
                    await db.execute(
                        "UPDATE collaborators SET contact_id = $1 WHERE contact_id = $2",
                        keep_cid, dup_cid,
                    )
                    await db.execute(
                        "UPDATE contacts SET first_referrer_contact_id = $1 WHERE first_referrer_contact_id = $2",
                        keep_cid, dup_cid,
                    )
                    # Убрать заглушку и перевесить реальную TG-запись на контакт коллаба
                    # (заглушка занимает UNIQUE (contact_id, platform_slug) — удаляем её первой).
                    await db.execute("DELETE FROM platform_users WHERE id = $1", ps["id"])
                    await db.execute(
                        """UPDATE platform_users
                              SET contact_id = $1, username = $2, updated_at = NOW()
                            WHERE id = $3""",
                        keep_cid, uname, real["id"],
                    )
                    await db.execute(
                        """UPDATE platform_user_channels
                              SET is_unsubscribed = FALSE,
                                  subscribed_at   = COALESCE(subscribed_at, NOW()),
                                  unsubscribed_at = NULL
                            WHERE platform_user_id = $1 AND is_unsubscribed = TRUE""",
                        real["id"],
                    )
                    # Пометить дубль слитым.
                    await db.execute(
                        "UPDATE contacts SET merged_into = $1, is_active = FALSE WHERE id = $2",
                        keep_cid, dup_cid,
                    )
                    log.info(
                        "merged dup contact %s -> collaborator contact %s on @%s (%s)",
                        dup_cid, keep_cid, uname, real_id,
                    )
            if pseudos:
                log.info(
                    "processed %d pseudo TG identities for @%s -> %s",
                    len(pseudos), uname, real_id,
                )
    except Exception as e:
        log.warning("upgrade_pseudo_identities failed: %s", e)


@router.message(CommandStart())
async def handle_start(message: Message, command: CommandObject):
    # В группах/беседах бот МОЛЧИТ — не отвечает на /start@bot и т.п.,
    # чтобы не засорять чаты событий. Команды бота работают только в личке.
    if message.chat and message.chat.type != "private":
        return
    args = (command.args or "").strip()
    user = message.from_user

    # ЛОГ ССЫЛКИ ПЕРЕХОДА — сырой /start-аргумент ПЕРВЫМ делом, до любой обработки.
    if args:
        try:
            from app.services.entry_link_log import log_entry_link
            _pool = await get_pool()
            if _pool:
                async with _pool.acquire() as _logc:
                    await log_entry_link(
                        _logc,
                        platform="telegram",
                        platform_user_id=(user.id if user else None),
                        raw_param=args,
                    )
        except Exception:
            pass

    # Регистрируем подписку — для счётчика подписчиков канала и базы контактов
    await _record_subscription(message)

    # Дорастить пустышки `@username` -> реальный tg_id (любой вход в бот, до ветвления)
    await _upgrade_pseudo_identities(user)

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

    # Саморедактирование (вход в кабинет без создания коллаба):
    # /start spkedit_<event_id>. Для УЖЕ добавленных спикеров и их ассистентов.
    # Бот по TG зашедшего ищет спикера события: личный TG или
    # assistant_tg_username. Нашёл → отдаёт код доступа. Новый коллаб НЕ создаём.
    if args.startswith("spkedit_"):
        try:
            event_id = int(args.removeprefix("spkedit_"))
        except ValueError:
            event_id = None
        if event_id:
            pool = await get_pool()
            try:
                async with pool.acquire() as db:
                    ev = await db.fetchrow(
                        "SELECT slug, title FROM events WHERE id = $1", event_id
                    )
                    if not ev:
                        await message.answer("😕 Событие не найдено.")
                        return
                    uname = (user.username or "").lstrip("@").strip().lower()
                    # 1) Спикер по личному TG (числовой id).
                    sp = await db.fetchrow(
                        """SELECT c.name, c.access_code
                             FROM event_collaborators ec
                             JOIN collaborators c ON c.id = ec.speaker_id
                             JOIN platform_users pu ON pu.contact_id = c.contact_id
                                  AND pu.platform_slug = 'telegram'
                            WHERE ec.event_id = $1 AND pu.platform_user_id = $2
                            LIMIT 1""",
                        event_id, str(user.id),
                    )
                    role_label = "speaker"
                    # 2) Если не нашли — пробуем как ассистента по нику.
                    if not sp and uname:
                        sp = await db.fetchrow(
                            """SELECT c.name, c.access_code
                                 FROM event_collaborators ec
                                 JOIN collaborators c ON c.id = ec.speaker_id
                                WHERE ec.event_id = $1
                                  AND LOWER(c.assistant_tg_username) = $2
                                LIMIT 1""",
                            event_id, uname,
                        )
                        if sp:
                            role_label = "assistant"
                    if not sp:
                        await message.answer(
                            "😕 Этот Telegram-аккаунт не привязан ни к одному спикеру события.\n\n"
                            "Если вы спикер и ещё не в списке — используйте ссылку регистрации спикером.\n"
                            "Если вы ассистент — попросите спикера вписать ваш Telegram-ник в его карточке "
                            "(поле «Telegram-ник ассистента» в кабинете спикера)."
                        )
                        return
                    sp_name = (sp["name"] or "").strip() or "спикер"
                    access_code = sp["access_code"]
                    cabinet_url = f"https://pluson.ru/speaker/{ev['slug']}"
                    if role_label == "assistant":
                        text_lines = [
                            f"Здравствуйте! Вы менеджер спикера <b>{sp_name}</b> («{ev['title']}»).",
                            "",
                            f"Ваш код доступа для редактирования карточки спикера: <code>{access_code}</code>",
                            "",
                            f"Откройте кабинет: <b>{cabinet_url}</b>",
                            "",
                            f"На странице выберите фамилию «{sp_name}» и введите этот код. Сессия живёт 24 часа.",
                        ]
                    else:
                        text_lines = [
                            f"Здравствуйте, {sp_name}!",
                            "",
                            f"Вы — спикер «{ev['title']}». Откройте свой кабинет, чтобы обновить данные:",
                            f"<b>{cabinet_url}</b>",
                            "",
                            f"Код доступа: <code>{access_code}</code>",
                            "",
                            "На странице выберите свою фамилию и введите этот код. Сессия живёт 24 часа.",
                        ]
                    kb = InlineKeyboardMarkup(inline_keyboard=[[
                        InlineKeyboardButton(text="📝 Открыть кабинет спикера", url=cabinet_url)
                    ]])
                    await message.answer(
                        "\n".join(text_lines),
                        parse_mode="HTML",
                        disable_web_page_preview=True,
                        reply_markup=kb,
                    )
                return
            except Exception as e:
                log.exception("spkedit_ handler failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # Саморегистрация спикером (2026-05-29): /start spkreg_<event_id>.
    # Клиент шарит прямую ссылку из вкладки «Спикеры» события. Человек
    # переходит — бот апсертит contact для client_id события и шлёт
    # текст + inline-кнопку «Включить в спикеры» (callback
    # `spkreg_confirm_<event_id>`).
    if args.startswith("spkreg_"):
        try:
            event_id = int(args.removeprefix("spkreg_"))
        except ValueError:
            event_id = None
        if event_id:
            pool = await get_pool()
            try:
                async with pool.acquire() as db:
                    from app.services.speaker_self_register import (
                        get_event_for_self_register, find_existing_speaker,
                        SELF_REG_TEXT, SELF_REG_BUTTON,
                    )
                    from app.services.contact_merge import upsert_contact_with_identity
                    ev = await get_event_for_self_register(db, event_id)
                    if not ev:
                        await message.answer("😕 Событие не найдено или удалено.")
                        return
                    # Upsert контакта для client_id этого события.
                    contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                        db,
                        client_id=ev["client_id"],
                        platform_slug='telegram',
                        platform_user_id=str(user.id),
                        username=user.username or "",
                        first_name=user.first_name or "",
                        last_name=user.last_name or "",
                    )
                    # Уже в списке спикеров этого события? → впускаем в кабинет
                    # (универсальная ссылка работает и для уже-добавленных).
                    existing = await find_existing_speaker(
                        db, event_id=event_id,
                        client_id=ev["client_id"], contact_id=contact_id,
                    )
                    if existing:
                        name = (existing["name"] or "").strip() or "спикер"
                        slug = existing["event_slug"]
                        access_code = existing["access_code"]
                        cabinet_url = f"https://pluson.ru/speaker/{slug}"
                        text_lines = [
                            f"Здравствуйте, {name}!",
                            "",
                            f"Вы — спикер «{ev['title']}». Откройте свой кабинет, чтобы заполнить или обновить данные:",
                            f"<b>{cabinet_url}</b>",
                            "",
                            f"Код доступа: <code>{access_code}</code>",
                            "",
                            "На странице выберите свою фамилию из списка и введите этот код. "
                            "Сессия живёт 24 часа. Код можно передать ассистенту — он заполнит за вас.",
                        ]
                        kb = InlineKeyboardMarkup(inline_keyboard=[[
                            InlineKeyboardButton(text="📝 Открыть мой кабинет", url=cabinet_url),
                        ]])
                        await message.answer(
                            "\n".join(text_lines),
                            parse_mode="HTML",
                            disable_web_page_preview=True,
                            reply_markup=kb,
                        )
                        return

                    # Не в списке → предлагаем зарегистрироваться.
                    kb = InlineKeyboardMarkup(inline_keyboard=[[
                        InlineKeyboardButton(
                            text=f"➕ {SELF_REG_BUTTON}",
                            callback_data=f"spkreg_confirm_{event_id}",
                        )
                    ]])
                    await message.answer(SELF_REG_TEXT, reply_markup=kb)
                return
            except Exception as e:
                log.exception("spkreg_ handler failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # Deeplink VIP: /start vip_link24 (id) или vip_link_cygum (slug) — сразу шлём
    # сообщение с VIP-ссылкой события (как команда /vip_link).
    if args.lower().startswith("vip_link"):
        rest = args[len("vip_link"):].lstrip("_").strip()
        pool = await get_pool()
        async with pool.acquire() as db:
            if rest.isdigit():
                event_id = int(rest)
            else:
                event_id = await db.fetchval("SELECT id FROM events WHERE slug = $1 LIMIT 1", rest)
            if not event_id:
                await message.answer("Неизвестное событие — возможно, вы ошиблись с идентификатором события.")
                return
            contact_id = await db.fetchval(
                """SELECT ep.contact_id FROM event_participants ep
                     JOIN platform_users pu ON pu.contact_id = ep.contact_id
                      AND pu.platform_slug='telegram' AND pu.platform_user_id = $2
                    WHERE ep.event_id = $1 LIMIT 1""",
                event_id, str(message.from_user.id))
            from app.services.external_landing import build_event_vip_target
            vip = await build_event_vip_target(db, event_id, contact_id)
            if not vip:
                await message.answer("У этого события не настроен формат участия (VIP).")
                return
            kb = InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text=vip["vip_label"], url=vip["vip_target"])]])
            await message.answer(
                f"Выберите формат участия в событии {vip['title']}\n\n👇👇👇\n",
                reply_markup=kb)
        return

    # Самообслуживание спикера (миграция 108): /start spkinv_<access_code>.
    # Спикер кликнул invite-ссылку из сообщения, которое организатор скопировал
    # и отправил ему в личку. Опознаём коллаба по access_code → шлём в чат
    # код доступа и ссылку на лендинг pluson.ru/speaker/<event_slug>.
    if args.startswith("spkinv_"):
        access_code = args.removeprefix("spkinv_").strip()
        # Опциональный суффикс `_e<event_id>` — жёсткая привязка к событию,
        # чтобы ссылка не «уехала» на последнее по ec.id (например, копию-черновик).
        invite_event_id: int | None = None
        if "_e" in access_code:
            base, _, ev_part = access_code.rpartition("_e")
            if ev_part.isdigit():
                access_code = base.strip()
                invite_event_id = int(ev_part)
        if access_code:
            pool = await get_pool()
            try:
                async with pool.acquire() as db:
                    coll = await db.fetchrow(
                        """SELECT c.id AS collaborator_id, c.name, c.contact_id,
                                  c.created_by_client_id, c.assistant_tg_username
                             FROM collaborators c
                            WHERE LOWER(c.access_code) = LOWER($1)""",
                        access_code,
                    )
                    if not coll:
                        await message.answer(
                            "😕 Ссылка устарела или код доступа изменился. Попросите организатора прислать актуальное сообщение."
                        )
                        return

                    # Ассистент спикера: если у коллаба указан assistant_tg_username
                    # и зашедший TG-ник совпадает с ним — это законный помощник,
                    # который заполняет кабинет за спикера. Не привязываем его TG к
                    # контакту спикера (это чужой аккаунт) и НЕ считаем foreign_owner —
                    # просто отдаём код доступа спикера.
                    assistant_uname = (coll["assistant_tg_username"] or "").lstrip("@").strip().lower()
                    is_assistant = bool(
                        assistant_uname and (user.username or "").strip().lower() == assistant_uname
                    )

                    # Привязываем личный TG спикера к contact (если ещё не привязан).
                    from app.api.collaborators import _upsert_personal_identity
                    foreign_owner = False
                    if not is_assistant and coll["contact_id"] and coll["created_by_client_id"]:
                        res = await _upsert_personal_identity(
                            db,
                            coll["created_by_client_id"],
                            coll["contact_id"],
                            'telegram',
                            str(user.id),
                            user.username or None,
                        )
                        if isinstance(res, dict) and res.get("status") == "foreign_owner":
                            foreign_owner = True

                    if foreign_owner:
                        sp_name = (coll["name"] or "").strip() or "спикер"
                        await message.answer(
                            f"⚠️ Вы зашли не с того аккаунта.\n\n"
                            f"Эта ссылка выдана спикеру «{sp_name}». Ваш Telegram-аккаунт уже привязан к другому контакту у этого клиента, "
                            f"поэтому я не могу записать вас как спикера.\n\n"
                            f"Попросите самого спикера открыть ссылку со своего личного Telegram, "
                            f"либо передайте ссылку его ассистенту."
                        )
                        return

                    # Какое событие открыть в кабинете спикера:
                    # 1) если ссылка несёт `_e<event_id>` — строго это событие
                    #    (он привязан к нему как коллаб);
                    # 2) иначе — НЕ «последнее по ec.id» (так ссылка уезжала на
                    #    копию-черновик), а опубликованное/завершённое с приоритетом:
                    #    published → ended → draft, внутри — позже добавленное.
                    if invite_event_id:
                        ev = await db.fetchrow(
                            """SELECT e.slug, e.title
                                 FROM event_collaborators ec
                                 JOIN events e ON e.id = ec.event_id
                                WHERE ec.speaker_id = $1 AND ec.event_id = $2
                                LIMIT 1""",
                            coll["collaborator_id"], invite_event_id,
                        )
                    else:
                        ev = None
                    if not ev:
                        ev = await db.fetchrow(
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

                    name = (coll["name"] or "").strip() or "спикер"
                    cabinet_url = f"https://pluson.ru/speaker/{event_slug}" if event_slug else "https://pluson.ru/speaker/"
                    if is_assistant:
                        text_lines = [
                            f"Здравствуйте! Вы менеджер спикера <b>{name}</b> («{event_title}»).",
                            "",
                            f"Ваш код доступа для редактирования карточки спикера: <code>{access_code}</code>",
                            "",
                            f"Откройте кабинет: <b>{cabinet_url}</b>",
                            "",
                            f"На странице выберите фамилию «{name}» из списка и введите этот код. Сессия живёт 24 часа.",
                        ]
                    else:
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
                    kb = InlineKeyboardMarkup(inline_keyboard=[[
                        InlineKeyboardButton(
                            text="📝 Открыть кабинет спикера" if is_assistant else "📝 Открыть мой кабинет",
                            url=cabinet_url,
                        )
                    ]]) if event_slug else None
                    await message.answer(
                        "\n".join(text_lines),
                        parse_mode="HTML",
                        disable_web_page_preview=True,
                        reply_markup=kb,
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
                        """SELECT id, title, slug,
                                  (SELECT eo.client_id FROM event_owners eo
                                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
                             FROM events WHERE slug=$1 AND status='published'""",
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

    # Партнёрский ref-код клиента ПЛЮСОНа: /start ref{8симв} (миграция 125).
    # Формат строго `ref` + 8 символов алфавита `23456789abcdefghjkmnpqrstuvwxyz`.
    # Обрабатываем ДО общего ref_-обработчика событий, иначе уйдёт в Mini App.
    import re as _re
    m = _re.fullmatch(r"ref([23456789abcdefghjkmnpqrstuvwxyz]{8})", args)
    if m:
        referral_code = m.group(1)
        try:
            from app.database import get_pool as _get_pool
            pool = await _get_pool()
            async with pool.acquire() as conn:
                referrer = await conn.fetchrow(
                    "SELECT id, name FROM clients WHERE referral_code = $1",
                    referral_code,
                )
            if referrer:
                register_url = f"https://pluson.ru/register?pid={referral_code}"
                kb = InlineKeyboardMarkup(inline_keyboard=[[
                    InlineKeyboardButton(text="📝 Зарегистрироваться", url=register_url)
                ]])
                await message.answer(
                    f"Привет, {user.first_name or ''}! 👋\n\n"
                    f"Вас пригласил(а) <b>{referrer['name']}</b> в <b>iViSiON: ПЛЮСОН</b> — "
                    f"платформу для организаторов и экспертов.\n\n"
                    f"Создайте аккаунт и попробуйте всё сами 👇",
                    reply_markup=kb,
                    parse_mode="HTML",
                )
                return
        except Exception as e:
            log.exception("partner ref handler failed: %s", e)

    # Реф-ссылка события через БОТ-флоу: `/start ref_pg<slug>[_land][_nolend][_pid..][_src..]`.
    # В отличие от `?startapp=...` (прямое открытие Mini App), `?start=...` открывает
    # СНАЧАЛА бот, который шлёт сообщение с кнопкой:
    #   • без `_land` → кнопка открывает Mini App (вариант 1);
    #   • с `_land`   → кнопка ведёт на сторонний лендинг события (вариант 2),
    #                   если лендинг пуст — фолбэк на Mini App;
    #   • `_nolend`   → передаём флаг дальше в Mini App, чтобы внутри не уводило
    #                   на сторонний лендинг (вариант 3 в бот-флоу).
    # Deeplink-слово в start-параметре: `?start=menu24` / `?start=event24` /
    # `?start=ивент24` — то же, что напечатать слово в чат. Резолвим slug по id
    # события и делегируем общему бот-флоу (он сам: не зареган → приглашение,
    # зареган → меню кабинета).
    import re as _re_start
    _ev_word = _re_start.match(r"(?i)^(?:ивент|event|menu)\s*(\d+)$", args)
    if _ev_word:
        try:
            event_id = int(_ev_word.group(1))
            pool = await get_pool()
            async with pool.acquire() as db:
                slug = await db.fetchval(
                    "SELECT slug FROM events WHERE id = $1 LIMIT 1", event_id
                )
            if slug:
                if await _handle_ref_event_bot_flow(message, f"ref_pg{slug}"):
                    return
            else:
                await message.answer("Событие не найдено. Проверьте номер.")
                return
        except Exception as e:
            log.exception("menu<id> deeplink handler failed: %s", e)

    # Кнопка «Чат события» с веб-страницы /event/{slug}: `/start evchat_<event_id>`.
    # Ведёт сразу на «вступить в чат» — проверка подписки на каналы спикеров/
    # организаторов, затем выдача ссылок на чаты (та же логика, что callback в меню).
    if args.startswith("evchat_"):
        try:
            event_id = int(args.removeprefix("evchat_"))
            from bot.handlers.funnel import run_event_chat_gate
            await run_event_chat_gate(message, event_id, user.id)
            return
        except (ValueError, AttributeError):
            pass
        except Exception as e:
            log.exception("evchat deeplink handler failed: %s", e)

    if args.startswith("ref_pg"):
        try:
            if await _handle_ref_event_bot_flow(message, args):
                return
        except Exception as e:
            log.exception("ref_pg bot-flow handler failed: %s", e)

    # Старый сценарий (compat): любой иной `ref…` → Mini App.
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


async def _handle_ref_event_bot_flow(message: Message, args: str) -> bool:
    """Бот-флоу для `/start ref_pg<slug>[_land][_nolend][_pid..][_src..]`.

    Возвращает True, если сообщение отправлено (дальнейшую обработку прервать).

    Варианты:
      • без `_land`  → web_app/url-кнопка открывает Mini App (вариант 1);
      • с `_land`    → url-кнопка на сторонний лендинг события (вариант 2);
                       если у события нет landing_url — фолбэк на Mini App;
      • `_nolend`    → флаг передаётся в Mini App через startapp (внутри Mini App
                       сторонний лендинг не открывается).
    """
    user = message.from_user
    if not user:
        return False

    # Разбираем payload: после `ref_pg` идёт slug, дальше — флаги/параметры через `_`.
    rest = args[len("ref_pg"):]
    parts = rest.split("_") if rest else []
    slug = parts[0] if parts else ""
    if not slug:
        return False
    want_landing = False   # флаг `_land` — кнопка на сторонний лендинг
    no_landing = False     # флаг `_nolend` — не открывать сторонний лендинг в Mini App
    pid: str | None = None
    utm_source: str | None = None
    known_contact_id: int | None = None  # `_ct<N>` — сквозной contact_id против дублей
    landing_flags: list[str] = []  # `_q<key>` — произвольные маркеры тарифа для лендинга
    for chunk in parts[1:]:
        if chunk == "land":
            want_landing = True
        elif chunk == "nolend":
            no_landing = True
        elif chunk.startswith("pid"):
            pid = chunk[3:] or None
        elif chunk.startswith("src"):
            utm_source = chunk[3:] or None
        elif chunk.startswith("ct"):
            ct_raw = chunk[2:]
            known_contact_id = int(ct_raw) if ct_raw.isdigit() else None
        elif chunk.startswith("q") and len(chunk) > 1:
            # произвольный флаг `_q<key>` или `_q<key>=<value>` — на лендинг
            # уходит РОВНО как задан: `shwt` (голый) или `shwt=1` (со значением).
            landing_flags.append(chunk[1:])

    # username бота (для t.me-ссылки на Mini App). Системный @pluson_bot открывает
    # Mini App по short-name `/pluson`, VIP-бот — напрямую `t.me/{handle}?startapp=`.
    try:
        me = await message.bot.get_me()
        bot_username = (me.username or "").lstrip("@")
    except Exception:
        bot_username = ""
    if not bot_username:
        return False

    from app.services.share_links import PLUSON_TG_HANDLE, PLUSON_TG_APP

    # Собираем startapp-payload для Mini App: ref_pg<slug> + флаги/параметры
    # (всё, КРОМЕ `_land` — это маркер только для бот-флоу).
    sa_parts = [f"ref_pg{slug}"]
    if pid:
        sa_parts.append(f"pid{pid}")
    if utm_source:
        sa_parts.append(f"src{utm_source}")
    if no_landing:
        sa_parts.append("nolend")
    for fk in landing_flags:
        sa_parts.append(f"q{fk}")
    startapp = "_".join(sa_parts)
    app_part = f"/{PLUSON_TG_APP}" if bot_username == PLUSON_TG_HANDLE else ""
    mini_app_link = f"https://t.me/{bot_username}{app_part}?startapp={startapp}"

    from app.services.external_landing import (
        resolve_or_create_participant,
        get_contact_landing_params,
        resolve_referrer_external_ref_param,
        build_external_landing_url,
    )

    pool = await get_pool()
    async with pool.acquire() as db:
        ev = await db.fetchrow(
            """SELECT id, title, landing_url, status,
                      (SELECT eo.client_id FROM event_owners eo
                         WHERE eo.event_id = e.id AND eo.status = 'accepted'
                         ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id,
                      (SELECT url FROM event_posters
                         WHERE event_id = e.id
                         ORDER BY CASE orientation
                                    WHEN 'horizontal' THEN 1
                                    WHEN 'square'     THEN 2
                                    WHEN 'vertical'   THEN 3
                                    ELSE 4
                                  END, sort, id
                         LIMIT 1) AS poster_url
                 FROM events e WHERE e.slug = $1 LIMIT 1""",
            slug,
        )
        if not ev:
            return False
        work_tg = await db.fetchval(
            "SELECT work_tg_username FROM clients WHERE id = $1", ev["client_id"]
        ) or ""

        title = _html.escape(ev["title"] or "")
        poster_url = (ev["poster_url"] or "").strip()

        # Резолвим contact_id + статус регистрации участника по tg_id.
        is_registered = False
        contact_id: int | None = None
        reg_row = await db.fetchrow(
            """SELECT ep.is_registered, ep.contact_id
                 FROM event_participants ep
                 JOIN platform_users pu
                   ON pu.contact_id = ep.contact_id
                  AND pu.platform_slug = 'telegram'
                  AND pu.platform_user_id = $2
                WHERE ep.event_id = $1
                LIMIT 1""",
            ev["id"], str(user.id),
        )
        if reg_row:
            is_registered = bool(reg_row["is_registered"])
            contact_id = reg_row["contact_id"]

        # Если записи нет (или contact_id не достали) — создаём participant, чтобы
        # получить contact_id для ссылок pluson.ru/event/{slug}?c={contact_id}.
        if contact_id is None:
            _pid_part, contact_id = await resolve_or_create_participant(
                db, client_id=ev["client_id"], event_id=ev["id"],
                platform_slug="telegram", platform_user_id=str(user.id),
                known_contact_id=known_contact_id, partner_id=pid,
            )

        # ── Зарегистрированный участник → меню кабинета ───────────────────────
        if is_registered:
            await send_event_menu(message, ev["id"], contact_id, db)
            return True

        # ── НЕ зарегистрирован → три кнопки (Mini App / Веб / Регистрация) ────
        text = (
            "Добрейшего-богатейшего! 🤝\n\n"
            "Здесь вы можете зарегистрироваться на наше событие:\n"
            f"<b>{title}</b>\n\n"
            "Нажмите на кнопку ниже.\n\n"
            "Если проблемы с регистрацией — нажмите кнопку «🆘 Тех. поддержка»."
        )

        # Веб-ссылка/ссылка регистрации: сторонний лендинг (если задан и опубликован),
        # иначе ВНУТРЕННИЙ ЛЕНДИНГ РЕГИСТРАЦИИ pluson.ru/event/{slug}/register?c={cid}
        # (страница сама решает: зареган → кабинет, не зареган → форма).
        landing_url = (ev["landing_url"] or "").strip()
        internal_web = f"https://pluson.ru/event/{slug}/register?c={contact_id}" if contact_id else f"https://pluson.ru/event/{slug}/register"
        if landing_url and ev["status"] == "published":
            contact_params = await get_contact_landing_params(db, contact_id) if contact_id else {}
            erp = await resolve_referrer_external_ref_param(
                db, ev["client_id"], pid=pid, contact_id=contact_id,
            )
            # participant_id ОБЯЗАТЕЛЕН в URL: GetCourse/Tilda присылают его обратно
            # в webhook (getcourse/register по participant_id). Без него регистрация
            # на лендинге не привязывается к участию — is_registered не проставляется.
            participant_id = await db.fetchval(
                "SELECT id FROM event_participants WHERE event_id = $1 AND contact_id = $2 LIMIT 1",
                ev["id"], contact_id,
            ) if contact_id else None
            landing_target = build_external_landing_url(
                landing_url,
                event_slug=slug,
                contact_id=contact_id,
                participant_id=participant_id,
                pid=pid,
                utm_source=utm_source,
                external_ref_param=erp,
                flags=landing_flags,
                **contact_params,
            )
            web_url = landing_target
            reg_url = landing_target
        else:
            web_url = internal_web
            reg_url = internal_web

    # Одна кнопка «Зарегистрироваться» → сторонний лендинг (если задан и
    # опубликован) ЛИБО встроенный веб pluson.ru/event/{slug} — с передачей
    # contact_id, pid, utm, external_ref_param рефовода и полей контакта.
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="ЗАРЕГИСТРИРОВАТЬСЯ", url=web_url)],
        [InlineKeyboardButton(text="🆘 Тех. поддержка", callback_data=f"evsupport_{ev['id']}")],
    ])

    # Если у события есть афиша — шлём фото с подписью; иначе обычный текст.
    # Подпись Telegram ограничена 1024 символами — длинный текст без афиши.
    if poster_url and len(text) <= 1024:
        try:
            await message.answer_photo(poster_url, caption=text, reply_markup=kb,
                                       parse_mode="HTML")
            return True
        except Exception as e:
            log.warning("ref_pg poster send failed (%s), fallback to text: %s", poster_url, e)
    await message.answer(text, reply_markup=kb, parse_mode="HTML",
                         disable_web_page_preview=True)
    return True


async def send_event_menu(message: Message, event_id: int, contact_id: int | None, db) -> None:
    """Меню кабинета зарегистрированного участника события.

    Вызывается из ветки «зареган» в `_handle_ref_event_bot_flow` и из команды
    `/menu{event_id}`. Кнопки строятся в зависимости от настроек события:
      • «Выбрать формат участия» — только если задан events.vip_url (VIP-ссылка
        обогащается параметрами контакта через enrich_external_url);
      • «Вступить в Чат» — callback evchat_{event_id}, только если есть хоть один
        chat_url_tg/vk/max;
      • «Программа и Спикеры» / «Программа» — внутренний веб с якорем #program;
      • «Кабинет и подарки» — внутренний веб события.
    """
    ev = await db.fetchrow(
        """SELECT id, slug, title, module_slug,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = e.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id,
                  vip_url, vip_button_label,
                  chat_url_tg, chat_url_vk, chat_url_max,
                  (SELECT url FROM event_posters
                     WHERE event_id = e.id
                     ORDER BY CASE orientation
                                WHEN 'horizontal' THEN 1
                                WHEN 'square'     THEN 2
                                WHEN 'vertical'   THEN 3
                                ELSE 4
                              END, sort, id
                     LIMIT 1) AS poster_url
             FROM events e WHERE e.id = $1 LIMIT 1""",
        event_id,
    )
    if not ev:
        return

    slug = ev["slug"]
    title = _html.escape(ev["title"] or "")
    cid_q = f"?c={contact_id}" if contact_id else ""

    text = (
        "Вы зарегистрированы на событие:\n"
        f"<b>{title}</b>\n\n"
        "Это ваше меню — вы всегда можете вызвать его командой\n"
        f"/menu{event_id}"
    )

    rows: list[list[InlineKeyboardButton]] = []

    # 1. Выбрать формат участия (VIP) — только если задан vip_url.
    vip_url = (ev["vip_url"] or "").strip()
    if vip_url:
        from app.services.external_landing import (
            get_contact_landing_params,
            resolve_referrer_external_ref_param,
            enrich_external_url,
        )
        contact_params = await get_contact_landing_params(db, contact_id) if contact_id else {}
        erp = await resolve_referrer_external_ref_param(
            db, ev["client_id"], contact_id=contact_id,
        )
        vip_target = enrich_external_url(
            vip_url,
            pluson_contact_id=contact_id,
            event_slug=slug,
            external_ref_param=erp,
            **contact_params,
        )
        vip_label = (ev["vip_button_label"] or "").strip() or "Выбрать формат участия"
        rows.append([InlineKeyboardButton(text=vip_label, url=vip_target)])

    # 2. Вступить в Чат — только если есть хоть одна chat-ссылка.
    has_chat = bool((ev["chat_url_tg"] or "").strip()
                    or (ev["chat_url_vk"] or "").strip()
                    or (ev["chat_url_max"] or "").strip())
    if has_chat:
        rows.append([InlineKeyboardButton(
            text="📝 Вступить в Чат", callback_data=f"evchat_{event_id}"
        )])

    # 3. Кабинет и подарки → вкладка кабинета (#cabinet).
    rows.append([InlineKeyboardButton(
        text="🎁 Кабинет и подарки",
        url=f"https://pluson.ru/event/{slug}{cid_q}#cabinet"
    )])

    # 3. Ссылка на эфир (над Программой) — ближайший эфир + кнопка войти в стрим.
    rows.append([InlineKeyboardButton(
        text="📺 Ссылка на эфир", callback_data=f"evlive_{event_id}"
    )])

    # 4. Программа (и спикеры для конференций/турниров).
    prog_label = ("Программа и Спикеры"
                  if ev["module_slug"] in ("conference", "turnir")
                  else "Программа")
    rows.append([InlineKeyboardButton(
        text=prog_label, url=f"https://pluson.ru/event/{slug}{cid_q}#program"
    )])

    # 5. Тех. поддержка — единое сообщение с каналами связи клиента.
    rows.append([InlineKeyboardButton(
        text="🆘 Тех. поддержка", callback_data=f"evsupport_{event_id}"
    )])

    kb = InlineKeyboardMarkup(inline_keyboard=rows)
    poster_url = (ev["poster_url"] or "").strip()
    if poster_url and len(text) <= 1024:
        try:
            await message.answer_photo(poster_url, caption=text, reply_markup=kb,
                                       parse_mode="HTML")
            return
        except Exception as e:
            log.warning("send_event_menu poster send failed (%s), fallback to text: %s",
                        poster_url, e)
    await message.answer(text, reply_markup=kb, parse_mode="HTML",
                         disable_web_page_preview=True)


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
                     WHERE e.id IN (SELECT event_id FROM event_owners WHERE client_id = $1 AND status = 'accepted')
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
            intro_lines.append("📅 Выберите событие, которое вас интересует:")
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
            text="📋 ВЫБРАТЬ СОБЫТИЕ",
            url=f"https://pluson.ru/o/{client_id}",
        )])
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


@router.message(F.text.regexp(r"(?i)^\s*(?:ивент|event|menu)\s*\d+\s*$"))
async def handle_event_word_command(message: Message):
    """Слово-открыватель события (как в ВК, без зависимости от регистра):
    русское `ивент<id>` и английские `event<id>` / `menu<id>` — `ивент24`,
    `Event24`, `MENU 24`. Открывает событие в чат-боте: не зареган → приглашение
    на регистрацию, зареган → меню кабинета. Переиспользует общий бот-флоу
    `_handle_ref_event_bot_flow` (он сам решает регистрация/меню по tg_id).
    Команда `/menu<id>` (со слешем) — отдельный обработчик ниже, сюда не попадает."""
    user = message.from_user
    if not user:
        return
    import re as _re
    m = _re.match(r"(?i)^\s*(?:ивент|event|menu)\s*(\d+)\s*$", (message.text or "").strip())
    if not m:
        return
    event_id = int(m.group(1))
    pool = await get_pool()
    async with pool.acquire() as db:
        slug = await db.fetchval(
            "SELECT slug FROM events WHERE id = $1 LIMIT 1", event_id
        )
    if not slug:
        await message.answer("Событие не найдено. Проверьте номер.")
        return
    # Делегируем общему флоу — он сам отправит приглашение или меню.
    await _handle_ref_event_bot_flow(message, f"ref_pg{slug}")


@router.message(F.text.regexp(r"^/menu\d+"))
async def handle_event_menu_command(message: Message):
    """Команда `/menu{event_id}` — открыть событие в чат-боте.

    Делегирует общему флоу `_handle_ref_event_bot_flow`: он сам решает по
    регистрации tg_id — зарегистрирован → меню кабинета, не зарегистрирован →
    приглашение на регистрацию (как при `ивент<id>`). Раньше меню показывалось
    безусловно — незарегистрированный получал кабинет минуя регистрацию."""
    user = message.from_user
    if not user:
        return
    import re as _re
    m = _re.match(r"^/menu(\d+)", (message.text or "").strip())
    if not m:
        return
    event_id = int(m.group(1))
    pool = await get_pool()
    async with pool.acquire() as db:
        slug = await db.fetchval(
            "SELECT slug FROM events WHERE id = $1 LIMIT 1", event_id
        )
    if not slug:
        await message.answer("Событие не найдено.")
        return
    # Делегируем общему флоу — он сам отправит приглашение или меню.
    await _handle_ref_event_bot_flow(message, f"ref_pg{slug}")


@router.message(F.text.regexp(r"(?i)^\s*/?vip_link\s*\d+"))
async def handle_vip_link_command(message: Message):
    """Команда `/vip_link{event_id}` — прислать VIP-ссылку события с кнопкой.

    Ссылка обогащается теми же GET-параметрами и внешним партнёрским кодом, что
    и кнопка «Выбрать формат участия» в меню. Если событие не принадлежит этому
    боту/клиенту — «Неизвестное событие …»."""
    user = message.from_user
    if not user:
        return
    import re as _re
    m = _re.match(r"(?i)^\s*/?vip_link\s*(\d+)", (message.text or "").strip())
    if not m:
        return
    event_id = int(m.group(1))
    bot_id = message.bot.id if message.bot else None
    pool = await get_pool()
    async with pool.acquire() as db:
        # client_id этого бота (системный @pluson_bot или VIP-бот клиента).
        client_id = None
        if bot_id:
            from app.services.channels import find_channel_by_bot_id
            ch = await find_channel_by_bot_id(bot_id, db)
            if ch:
                if ch["is_system"]:
                    client_id = await db.fetchval(
                        "SELECT id FROM clients WHERE email='system@pluson.ru' AND is_active=TRUE LIMIT 1")
                else:
                    client_id = await db.fetchval(
                        """SELECT client_id FROM client_channels
                            WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
                        ch["id"])
        # Событие должно принадлежать этому клиенту (для системного @pluson_bot —
        # любому, т.к. он обслуживает всех; для VIP-бота — только своему).
        if client_id is not None:
            owns = await db.fetchval(
                """SELECT 1 FROM event_owners
                    WHERE event_id = $1 AND client_id = $2 AND status = 'accepted' LIMIT 1""",
                event_id, client_id)
            # Для системного бота владение не ограничиваем (он общий).
            is_system = bool(ch and ch["is_system"]) if bot_id else False
            if not owns and not is_system:
                await message.answer("Неизвестное событие — возможно, вы ошиблись с идентификатором события.")
                return
        # contact_id по tg_id.
        contact_id = await db.fetchval(
            """SELECT ep.contact_id FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id
                  AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $2
                WHERE ep.event_id = $1 LIMIT 1""",
            event_id, str(user.id))
        from app.services.external_landing import build_event_vip_target
        vip = await build_event_vip_target(db, event_id, contact_id)
        if not vip:
            # событие либо не найдено, либо у него нет vip_url
            ev_exists = await db.fetchval("SELECT 1 FROM events WHERE id = $1 LIMIT 1", event_id)
            if not ev_exists:
                await message.answer("Неизвестное событие — возможно, вы ошиблись с идентификатором события.")
            else:
                await message.answer("У этого события не настроен формат участия (VIP).")
            return
        text = (
            f"Выберите формат участия в событии {vip['title']}\n\n"
            "👇👇👇\n"
        )
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=vip["vip_label"], url=vip["vip_target"]),
        ]])
        await message.answer(text, reply_markup=kb)


@router.message(Command(commands=["app"]))
async def handle_app(message: Message):
    """Команда `/app` — кнопка открыть Mini App (команда сама URL открыть не
    может, поэтому шлём сообщение с кнопкой web_app/url)."""
    user = message.from_user
    if not user:
        return
    try:
        me = await message.bot.get_me()
        bot_username = (me.username or "").lstrip("@")
    except Exception:
        bot_username = ""
    if not bot_username:
        return
    from app.services.share_links import PLUSON_TG_HANDLE, PLUSON_TG_APP
    # Системный бот открывает Mini App по short-name (t.me/pluson_bot/pluson).
    # VIP-бот: Main Mini App открывается по `?startapp=...` (без него t.me-ссылка
    # просто ведёт в чат с ботом и приложение не открывается).
    if bot_username == PLUSON_TG_HANDLE:
        app_url = f"https://t.me/{bot_username}/{PLUSON_TG_APP}?startapp=hub"
    else:
        app_url = f"https://t.me/{bot_username}?startapp=hub"
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Открыть приложение", url=app_url)
    ]])
    await message.answer("Нажмите кнопку, чтобы открыть приложение 👇",
                         reply_markup=kb)


@router.message(Command(commands=["support"]))
async def handle_support(message: Message):
    """Команда `/support` — единое сообщение службы поддержки клиента со всеми
    заполненными каналами (ВК / Телеграм / MAX). Резолвит каналы по боту.

    Резолв инлайн (без отдельной функции) — самодостаточный хендлер. Обёрнут
    в try/except: даже при сбое БД отвечает нейтральным текстом, не молчит."""
    user = message.from_user
    if not user:
        return
    from app.services.support_message import build_support_message_html
    work_tg = work_vk = work_max = ""
    try:
        bot_id = message.bot.id if message.bot else None
        if bot_id:
            pool = await get_pool()
            async with pool.acquire() as db:
                from app.services.channels import find_channel_by_bot_id
                ch = await find_channel_by_bot_id(bot_id, db)
                if ch and not ch["is_system"]:
                    cid = await db.fetchval(
                        """SELECT client_id FROM client_channels
                            WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
                        ch["id"],
                    )
                    if cid:
                        row = await db.fetchrow(
                            "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1",
                            cid,
                        )
                        if row:
                            work_tg = row["work_tg_username"] or ""
                            work_vk = row["work_vk"] or ""
                            work_max = row["work_max"] or ""
    except Exception as e:
        log.warning("handle_support resolve failed: %s", e)
    text = build_support_message_html(work_tg=work_tg, work_vk=work_vk, work_max=work_max)
    try:
        await message.answer(text, parse_mode="HTML", disable_web_page_preview=True)
    except Exception as e:
        log.warning("handle_support answer failed: %s", e)
        await message.answer("Возникли вопросы? Напишите организатору события.")


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


@router.message(Command(commands=["getmyid"]))
async def handle_getmyid(message: Message):
    """Узнать свой Telegram ID — для поля тестовых ID в Настройках → Технические."""
    uid = message.from_user.id if message.from_user else "?"
    await message.answer(
        f"<b>Ваш Telegram ID:</b> <code>{uid}</code>\n\n"
        "Вставьте это число в поле тестовых Telegram-ID в Настройках → Технические, "
        "чтобы получать тестовые рассылки.",
        parse_mode="HTML",
    )


_MERGE_USAGE_TG = (
    "<b>Объединение аккаунтов</b>\n\n"
    "Если вы заходили к этому организатору и в Telegram, и в ВКонтакте, и в MAX — "
    "можно слить всё в один профиль (рефералы, регистрации и подарки сложатся вместе).\n\n"
    "1. Узнайте свой ID на другой площадке командой <code>/getmyid</code> в её боте/сообществе.\n"
    "2. Пришлите сюда:\n"
    "<code>/merge vk ВАШ_VK_ID</code>\n"
    "<code>/merge max ВАШ_MAX_ID</code>\n"
    "<code>/merge tg ВАШ_TG_ID</code>\n\n"
    "Например: <code>/merge vk 12345678</code>"
)


@router.message(Command(commands=["merge"]))
async def handle_merge(message: Message, command: CommandObject):
    """Объединить аккаунты с другой площадки в рамках клиента (главный — самый ранний)."""
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return

    args = (command.args or "").strip().split()
    if len(args) < 2:
        await message.answer(_MERGE_USAGE_TG, parse_mode="HTML")
        return

    other_platform = args[0].lower()
    aliases = {"telegram": "telegram", "tg": "telegram", "vk": "vk",
               "вк": "vk", "max": "max", "макс": "max", "мах": "max"}
    other_platform = aliases.get(other_platform)
    other_id_raw = args[1].lstrip("@").strip()
    if other_platform not in ("telegram", "vk", "max") or not other_id_raw.isdigit():
        await message.answer(_MERGE_USAGE_TG, parse_mode="HTML")
        return

    from app.services.channels import find_channel_by_bot_id
    from app.services.contact_merge import (
        merge_my_account_with_identity, find_contact_by_identity,
    )

    pool = get_pool()
    async with pool.acquire() as db:
        ch = await find_channel_by_bot_id(bot_id, db)
        if not ch:
            await message.answer("😕 Не удалось определить организатора.")
            return
        if ch["is_system"]:
            client_id = await db.fetchval(
                "SELECT id FROM clients WHERE email = 'system@pluson.ru' LIMIT 1"
            )
        else:
            client_id = await db.fetchval(
                """SELECT client_id FROM client_channels
                    WHERE channel_id = $1 AND is_active = TRUE LIMIT 1""",
                ch["id"],
            )
        if not client_id:
            await message.answer("😕 Не удалось определить организатора.")
            return

        if other_platform == "telegram" and other_id_raw == str(user.id):
            await message.answer("Это ваш текущий Telegram-аккаунт — объединять не с чем.")
            return

        current_contact_id = await find_contact_by_identity(
            db, client_id=client_id, platform_slug="telegram",
            platform_user_id=str(user.id),
        )
        if not current_contact_id:
            await message.answer(
                "Сначала зайдите в любое событие этого организатора, "
                "чтобы создать профиль, потом повторите объединение."
            )
            return

        res = await merge_my_account_with_identity(
            db, client_id=client_id, current_contact_id=current_contact_id,
            other_platform_slug=other_platform, other_platform_user_id=other_id_raw,
        )

    if res["status"] == "not_found":
        plat_name = {"telegram": "Telegram", "vk": "ВКонтакте", "max": "MAX"}[other_platform]
        await message.answer(
            f"😕 Не нашёл аккаунт {plat_name} с ID <code>{other_id_raw}</code> у этого организатора.\n\n"
            "Проверьте ID (узнайте его командой /getmyid в нужном боте) "
            "и заходили ли вы к этому организатору с той площадки.",
            parse_mode="HTML",
        )
    elif res["status"] == "already":
        await message.answer("✅ Эти аккаунты уже объединены — ничего делать не нужно.")
    else:
        await message.answer(
            "✅ Готово! Аккаунты объединены в один профиль. "
            "Рефералы, регистрации и подарки теперь общие."
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
                """SELECT notifications_telegram_chat_id, work_tg_username, work_vk, work_max
                     FROM clients WHERE id = $1""",
                client_id,
            )
            if not client_row:
                return
            notif_chat_id = client_row["notifications_telegram_chat_id"]
            work_tg = (client_row["work_tg_username"] or "").lstrip("@")
            work_vk = client_row["work_vk"]
            work_max = client_row["work_max"]

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

        # Архив входящего личного сообщения (для раздела «Диалоги» в карточке контакта).
        try:
            from app.services.dialog_archive import archive_incoming, archive_outgoing_bot
            await archive_incoming(
                client_id=client_id, platform="telegram", channel_id=ch["id"],
                platform_user_id=str(user.id), text=message.text,
                platform_message_id=str(message.message_id), contact_id=contact_id,
            )
        except Exception as e:  # noqa: BLE001 — архив не должен ронять обработчик
            log.warning("dialog archive (tg in) failed: %s", e)

        # Ответ пользователю VIP-бота — приветствие + прямые контакты поддержки.
        from app.services.support_message import build_user_reply_html, build_user_reply_plain
        reply = build_user_reply_html(work_tg=work_tg, work_vk=work_vk, work_max=work_max)
        await message.answer(reply, parse_mode="HTML", disable_web_page_preview=True)
        try:
            await archive_outgoing_bot(
                client_id=client_id, platform="telegram", channel_id=ch["id"],
                platform_user_id=str(user.id),
                text=build_user_reply_plain(work_tg=work_tg, work_vk=work_vk, work_max=work_max),
                contact_id=contact_id,
            )
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:
        log.exception("handle_user_message failed: %s", e)


@router.message(
    (F.chat.type == 'private')
    & (F.voice | F.photo | F.video | F.video_note | F.document | F.audio | F.animation | F.sticker)
    & F.forward_from_chat.is_(None)
    & F.forward_from.is_(None)
)
async def handle_user_media(message: Message):
    """Медиа-сообщение пользователя в личке VIP-бота клиента.

    Архивируем в «Диалоги» (текст caption + ссылка на файл в R2, кроме голоса).
    На голосовое — отвечаем «пишите текстом» (хранить не будем).
    Системный @pluson_bot — игнорируем (как и текст).
    """
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return
    try:
        from app.services.channels import find_channel_by_bot_id
        from app.services.dialog_archive import archive_incoming, VOICE_REPLY
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch or ch["is_system"]:
                return
            client_id = await db.fetchval(
                """SELECT client_id FROM client_channels
                    WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
                ch["id"],
            )
            if not client_id:
                return

        # Определяем тип вложения + file_id для скачивания.
        media_kind = None
        file_id = None
        if message.voice:        media_kind, file_id = "voice", message.voice.file_id
        elif message.photo:      media_kind, file_id = "photo", message.photo[-1].file_id
        elif message.video:      media_kind, file_id = "video", message.video.file_id
        elif message.video_note: media_kind, file_id = "video", message.video_note.file_id
        elif message.animation:  media_kind, file_id = "video", message.animation.file_id
        elif message.audio:      media_kind, file_id = "audio", message.audio.file_id
        elif message.document:   media_kind, file_id = "document", message.document.file_id
        elif message.sticker:    media_kind, file_id = "sticker", None

        file_url = None
        if file_id and media_kind != "voice":
            try:
                f = await message.bot.get_file(file_id)
                file_url = f"https://api.telegram.org/file/bot{message.bot.token}/{f.file_path}"
            except Exception:  # noqa: BLE001
                file_url = None

        await archive_incoming(
            client_id=client_id, platform="telegram", channel_id=ch["id"],
            platform_user_id=str(user.id), text=(message.caption or None),
            media_kind=media_kind, file_url=file_url,
            platform_message_id=str(message.message_id),
        )

        if media_kind == "voice":
            try:
                await message.answer(VOICE_REPLY)
            except Exception:  # noqa: BLE001
                pass
    except Exception as e:  # noqa: BLE001
        log.warning("handle_user_media failed: %s", e)


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
