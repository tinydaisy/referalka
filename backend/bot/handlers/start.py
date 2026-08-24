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
from app.services.client_domains import client_public_link, platform_base_url
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

    Архитектура G — определяем client_id единообразно для ЛЮБОГО бота:
    канал → client_channels → его клиент. @pluson_bot больше не «общий»:
    он принадлежит сервисному клиенту (clients.is_system_service=TRUE),
    поэтому особых веток по channels.is_system в боте нет.

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
            # Определяем client_id для записи подписки: любой бот (в т.ч.
            # @pluson_bot сервисного клиента) резолвится через client_channels.
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


async def _reply_if_blacklisted(message) -> bool:
    """
    Если человек в чёрном списке клиента ЭТОГО бота — ответить заглушкой
    с каналами поддержки и вернуть True (контент не выдавать).

    Клиент определяется по боту: один и тот же человек может быть заблокирован
    у одного клиента и свободно работать в ботах остальных.
    Ошибка проверки = не блокируем (fail-open) — лучше пропустить, чем
    оставить человека без ответа из-за сбоя.
    """
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return False
    try:
        from app.services.channels import find_channel_by_bot_id
        from app.services.blacklist import is_identity_blacklisted, blocked_message
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                return False
            client_id = await db.fetchval(
                """SELECT client_id FROM client_channels
                    WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
                ch["id"]
            )
            if not client_id:
                return False
            if not await is_identity_blacklisted(db, client_id, "telegram", str(user.id)):
                return False
            text = await blocked_message(db, client_id, platform="telegram")
        await message.answer(text, parse_mode="HTML", disable_web_page_preview=True)
        return True
    except Exception as e:
        log.warning("blacklist check failed: %s", e)
        return False


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
                """SELECT p.id, c_own.client_id, p.contact_id
                     FROM platform_users p
                     JOIN contacts c_own ON c_own.id = p.contact_id
                    WHERE p.platform_slug = 'telegram'
                      AND p.platform_user_id = $1""",
                f"@{uname}",
            )
            for ps in pseudos:
                async with db.transaction():
                    # Уже есть реальная TG-запись с этим tg_id у того же клиента?
                    real = await db.fetchrow(
                        """SELECT pu.id, pu.contact_id FROM platform_users pu
                            JOIN contacts c_own ON c_own.id = pu.contact_id
                            WHERE c_own.client_id = $1 AND pu.platform_slug = 'telegram'
                              AND pu.platform_user_id = $2 AND pu.id <> $3
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


async def _persist_plusson_referrer_code(conn, *, bot_id, tg_id, referral_code: str) -> None:
    """Закрепить ПЛЮСОН-реф-код за TG-контактом человека в базе клиента ЭТОГО бота.

    Резолвит клиента по боту (bot_id → channels → client_channels) и передаёт
    работу общей `persist_plusson_referrer_code` — она одна на все площадки.
    """
    if not bot_id or not tg_id or not referral_code:
        return
    try:
        from app.services.channels import find_channel_by_bot_id
        from app.services.plusson_referral import persist_plusson_referrer_code
        ch = await find_channel_by_bot_id(bot_id, conn)
        if not ch:
            return
        client_id = await conn.fetchval(
            """SELECT client_id FROM client_channels
                WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
            ch["id"],
        )
        await persist_plusson_referrer_code(
            conn, client_id=client_id, platform="telegram",
            platform_user_id=str(tg_id), referral_code=referral_code,
        )
    except Exception as e:
        log.warning("persist_plusson_referrer_code failed: %s", e)


async def _client_id_by_bot(conn, bot_id: int | None) -> int | None:
    """Владелец бота, в который человек написал (bot_id → channels → client_channels).

    Нужен коллабе: человек должен попасть в базу того организатора, через чьего
    бота зашёл, а не «первого владельца события» (см. `_collab_base_client`).
    Ошибки глушим — это уточнение, а не обязательный шаг.
    """
    if not bot_id:
        return None
    try:
        from app.services.channels import find_channel_by_bot_id
        ch = await find_channel_by_bot_id(bot_id, conn)
        if not ch:
            return None
        return await conn.fetchval(
            """SELECT client_id FROM client_channels
                WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
            ch["id"],
        )
    except Exception as e:
        log.warning("_client_id_by_bot failed: %s", e)
        return None


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

    # ЧЁРНЫЙ СПИСОК — до выдачи любого контента (миграция 228).
    # Лог перехода выше уже записан: видно, что человек пытался войти.
    if await _reply_if_blacklisted(message):
        return

    # Регистрируем подписку — для счётчика подписчиков канала и базы контактов
    await _record_subscription(message)

    # Дорастить пустышки `@username` -> реальный tg_id (любой вход в бот, до ветвления)
    await _upgrade_pseudo_identities(user)

    # Возврат с формы связки ПЛЮСОН (/pluson_connect → форма → сюда). Просто
    # подтверждаем — привязка уже записана на форме по подписанному токену.
    if args == "pluson_connected":
        await message.answer("✅ Ваш аккаунт ПЛЮСОН привязан. Приведённые вами люди будут закрепляться за вами.")
        return

    # Вопрос в поддержку ПЛЮСОНа — вход из кабинета (кнопка «Написать
    # разработчику» в сайдбаре ведёт на ?start=question). Приглашение написать
    # вопрос; дальше свободное сообщение ловит handle_user_message и уводит его
    # в Диалоги сервисного клиента + уведомление организатору.
    if args == "question":
        if await _send_question_prompt(message):
            return

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
                started = await _start_lead_magnet_funnel(message, kind, slug, pid, utm_source)
                if started:
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
                    # client_id владельца нужен, чтобы кабинет спикера открылся
                    # на домене клиента, а не на pluson.ru.
                    ev = await db.fetchrow(
                        """SELECT slug, title,
                                  (SELECT eo.client_id FROM event_owners eo
                                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
                             FROM events WHERE id = $1""",
                        event_id,
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
                    # Кабинет спикера — публичная страница клиента: открываем на
                    # его домене, если он подключён.
                    cabinet_url = await client_public_link(
                        db, ev["client_id"], f"speaker/{ev['slug']}"
                    )
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
                        # Кабинет спикера — на домене клиента-владельца события.
                        cabinet_url = await client_public_link(
                            db, ev["client_id"], f"speaker/{slug}"
                        )
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
                    # Кабинет спикера — на домене клиента, который завёл коллаба
                    # (событие могло ещё не найтись, поэтому берём владельца карточки).
                    cabinet_url = await client_public_link(
                        db, coll["created_by_client_id"],
                        f"speaker/{event_slug}" if event_slug else "speaker/",
                    )
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
                        # ⚠️ КОЛЛАБА: база — по рефоводу/боту, а не «первый
                        # владелец» (services/event_client.py).
                        from app.services.event_client import resolve_event_client
                        _cid = await resolve_event_client(
                            db, event_id=event["id"], client_id=event["client_id"],
                            source_client_id=await _client_id_by_bot(db, message.bot.id),
                        )
                        contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                            db,
                            client_id=_cid,
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
                        # Mini App открывается прямо в контексте этого события:
                        # у клиента со своим TG-ботом — /c/{client_id}/tg/event/{slug}.
                        # (@pluson_bot тоже «свой» — он принадлежит сервисному клиенту.)
                        is_vip_bot = await db.fetchval(
                            """SELECT COALESCE(BOOL_OR(TRUE), FALSE)
                                 FROM channels ch
                                 JOIN client_channels cc ON cc.channel_id = ch.id
                                WHERE cc.client_id = $1
                                  AND ch.platform_slug = 'telegram'
                                  AND cc.is_active = TRUE
                                  AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''""",
                            event["client_id"],
                        )
                        # Mini App НЕ переезжает на домен клиента: его адрес вбит
                        # в @BotFather и на лету не меняется — всегда pluson.ru.
                        base = platform_base_url()
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
    #
    # Работает в ЛЮБОМ боте (и @pluson_bot, и VIP-бот клиента) — обработчик один на
    # всю polling-службу. Раньше матчился только по clients.referral_code и ничего
    # не сохранял; теперь:
    #   1) резолвим код через resolve_plusson_referrer — понимает и клиентский код,
    #      и код-контакт спикера с привязанным ПЛЮСОНом (миграция 206);
    #   2) закрепляем СЫРОЙ код за контактом этого человека в базе клиента бота
    #      (contacts.plusson_referrer_code), чтобы привязка не терялась, даже если
    #      кнопку нажмут не сразу. При регистрации /register возьмёт код отсюда,
    #      если в URL нет pid.
    import re as _re
    m = _re.fullmatch(r"ref([23456789abcdefghjkmnpqrstuvwxyz]{8})", args)
    if m:
        referral_code = m.group(1)
        try:
            from app.database import get_pool as _get_pool
            from app.services.plusson_referral import resolve_plusson_referrer
            pool = await _get_pool()
            async with pool.acquire() as conn:
                referrer_client_id = await resolve_plusson_referrer(conn, referral_code)
                referrer_name = None
                if referrer_client_id:
                    referrer_name = await conn.fetchval(
                        "SELECT name FROM clients WHERE id = $1", referrer_client_id
                    )
                    # Закрепляем реф-код за контактом человека в базе клиента ЭТОГО
                    # бота. Первый рефовод выигрывает — не перезатираем непустое.
                    await _persist_plusson_referrer_code(
                        conn,
                        bot_id=(message.bot.id if message.bot else None),
                        tg_id=user.id if user else None,
                        referral_code=referral_code,
                    )
                    # «Новый интерес» — РЕФОВОДУ, а не владельцу бота: партнёрская
                    # программа принадлежит тому, чей код в ссылке.
                    from app.services.plusson_referral_notify import (
                        notify_referrer_new_interest,
                    )
                    await notify_referrer_new_interest(
                        conn,
                        referrer_client_id=referrer_client_id,
                        platform="telegram",
                        user_id=user.id if user else None,
                        username=user.username if user else None,
                        first_name=user.first_name if user else None,
                        last_name=user.last_name if user else None,
                    )
            if referrer_client_id:
                # Регистрация в САМОЙ платформе — всегда основной домен,
                # доменом клиента тут не пахнет.
                register_url = f"{platform_base_url()}/register?pid={referral_code}"
                kb = InlineKeyboardMarkup(inline_keyboard=[[
                    InlineKeyboardButton(text="📝 Зарегистрироваться", url=register_url)
                ]])
                await message.answer(
                    f"Привет, {user.first_name or ''}! 👋\n\n"
                    f"Вас пригласил(а) <b>{referrer_name or 'партнёр'}</b> в <b>iViSiON: ПЛЮСОН</b> — "
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

    # Внешняя ссылка на эфир: `/start evlive_<event_id>`. Даёт то же сообщение,
    # что кнопка «📺 Ссылка на эфир» в меню события (ближайший эфир + кнопка
    # «ВОЙТИ В ЭФИР»), но открывается сразу — без прохода через меню.
    if args.startswith("evlive_"):
        try:
            event_id = int(args.removeprefix("evlive_"))
            from bot.handlers.funnel import run_event_live
            await run_event_live(message, event_id, user.id)
            return
        except (ValueError, AttributeError):
            pass
        except Exception as e:
            log.exception("evlive deeplink handler failed: %s", e)

    # Регистрация на событие из вебинара: `/start evreg_<event_id>_ct<contact_id>`.
    # Кнопка «Регистрация на событие» в вебинаре для тех, кого ещё нет в боте.
    # Привязываем реальную TG-идентичность к контакту + регистрируем + подтверждаем.
    if args.startswith("evreg_"):
        try:
            from app.services import webinar_service as _ws
            parsed = _ws.parse_evreg_payload(args)
            if parsed:
                _eid, _ct_hint = parsed
                pool = await get_pool()
                async with pool.acquire() as _c:
                    # client_id владельца события
                    _clid = await _c.fetchval(
                        "SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=$1 "
                        "AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1", _eid)
                    if _clid:
                        res = await _ws.register_event_from_deeplink(
                            _c, client_id=_clid, event_id=_eid, contact_id_hint=_ct_hint,
                            platform="telegram", platform_user_id=user.id,
                            username=user.username, first_name=user.first_name)
                        await send_event_menu(message, _eid, res["contact_id"], _c)
                return
        except Exception as e:
            log.exception("evreg deeplink handler failed: %s", e)

    # Тех.поддержка: `/start evsupport_<event_id>` — то же сообщение, что кнопка
    # «🆘 Тех. поддержка» в меню события. Используется кнопкой «Тех.поддержка» в
    # рассылках (URL-кнопка-deeplink), чтобы вызвать команду support одним тапом.
    if args.startswith("evsupport_"):
        try:
            event_id = int(args.removeprefix("evsupport_"))
            from bot.handlers.funnel import run_event_support
            await run_event_support(message, event_id)
            return
        except (ValueError, AttributeError):
            pass
        except Exception as e:
            log.exception("evsupport deeplink handler failed: %s", e)

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
    app_part = f"/{PLUSON_TG_APP}" if bot_username == PLUSON_TG_HANDLE else ""

    def _mini_app_link(_contact_id: int | None = None) -> str:
        """Ссылка в Mini App. ⚠️ С `_ct{id}` — контактом человека В БАЗЕ ЭТОГО
        БОТА. Бот его знает, а Mini App — нет: Telegram не сообщает странице,
        чьему боту она принадлежит. Без контакта у КОЛЛАБЫ приложение теряло
        контекст, и человек уезжал к «первому владельцу» события: писал чужой
        бот, заводился второй контакт (прод, 2026-08-18).
        Контакт универсальнее номера клиента — он один на все площадки, и по
        нему сразу известна база (`contacts.client_id`)."""
        parts = list(sa_parts)
        if _contact_id:
            parts.append(f"ct{_contact_id}")
        return f"https://telegram.me/{bot_username}{app_part}?startapp={'_'.join(parts)}"

    # Пока контакт не резолвлен (он определяется ниже) — ссылка без него.
    mini_app_link = _mini_app_link()

    from app.services.external_landing import (
        resolve_or_create_participant,
        get_contact_landing_params,
        resolve_referrer_external_ref_param,
        build_external_landing_url,
    )

    pool = await get_pool()
    async with pool.acquire() as db:
        ev = await db.fetchrow(
            """SELECT id, title, landing_url, status, module_slug,
                      skip_contact_form, registration_mode,
                      (SELECT eo.client_id FROM event_owners eo
                         WHERE eo.event_id = e.id AND eo.status = 'accepted'
                         ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id,
                      (SELECT url FROM event_posters
                         WHERE event_id = e.id AND day IS NULL
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
        # ⚠️ `source_client_id` — владелец ЭТОГО бота: в коллабе человек должен
        # попасть в базу того организатора, через чьего бота зашёл, а не
        # «первого владельца» из ev["client_id"] (см. _collab_base_client).
        # Клиент ЭТОГО бота — нужен и здесь, и ниже для ссылки регистрации.
        _bot_cid = await _client_id_by_bot(db, message.bot.id)
        if contact_id is None:
            _pid_part, contact_id = await resolve_or_create_participant(
                db, client_id=ev["client_id"], event_id=ev["id"],
                platform_slug="telegram", platform_user_id=str(user.id),
                known_contact_id=known_contact_id, partner_id=pid,
                source_client_id=_bot_cid,
            )

        # Контакт известен → пересобираем ссылку Mini App вместе с ним.
        # ⚠️ Без этого приложение открывается «ничьим» и у коллабы уводит
        # человека к «первому владельцу» события (см. _mini_app_link).
        if contact_id:
            mini_app_link = _mini_app_link(contact_id)

        # ── МедиаЛифт: своя многоуровневая воронка ПРЯМО В БОТЕ ──────────────
        # Не зависит от Mini App (у @pluson_bot он может быть не подключён):
        # карточки ветки → подписка на 3 → регистрация → «добавь свой канал».
        if ev["module_slug"] == "medialift":
            from bot.handlers.medialift_flow import start_medialift_flow, prompt_add_channel
            if is_registered:
                await prompt_add_channel(message, ev["id"], db)
            else:
                await start_medialift_flow(message, ev["id"], contact_id, db)
            return True

        # ── Зарегистрированный участник → меню кабинета ───────────────────────
        if is_registered:
            await send_event_menu(message, ev["id"], contact_id, db)
            return True

        # ── «Регистрировать без ввода контактных данных»: кнопка
        # «ЗАРЕГИСТРИРОВАТЬСЯ» ОСТАЁТСЯ (человек должен её нажать), но ведёт не на
        # веб-форму, а на callback `evsignup_<id>` — по нажатию регистрируем прямо в
        # боте и присылаем меню события. Спрашивать нечего: человек уже в боте.
        # ⚠️ Меню НЕ шлём само, без нажатия — это осознанное действие пользователя.
        # ⚠️ Уступаем дорогу лендингу, только если он ВЫБРАН способом регистрации
        # ('landing' или 'external'): там своя форма и свой заказ, иначе человек
        # не увидел бы тарифы. Просто заполненное поле landing_url выбором НЕ
        # считается — у многих там ссылка на бота или на чужое событие.
        reg_in_bot = bool(
            ev["skip_contact_form"] and contact_id
            and ev["registration_mode"] not in ("landing", "external")
        )

        # ── НЕ зарегистрирован → три кнопки (Mini App / Веб / Регистрация) ────
        text = (
            "Добрейшего-богатейшего! 🤝\n\n"
            "Здесь вы можете зарегистрироваться на наше событие:\n"
            f"<b>{title}</b>\n\n"
            "Нажмите на кнопку ниже.\n\n"
            "Если проблемы с регистрацией — нажмите кнопку «🆘 Тех. поддержка»."
        )

        # Куда ведёт кнопка «Зарегистрироваться» — решает СПОСОБ РЕГИСТРАЦИИ
        # события (events.registration_mode). ⚠️ Общая функция resolve_landing_url,
        # та же, что раскрывает {landing_url} в рассылках: раньше бот про наш
        # лендинг-конструктор не знал вовсе и при выбранном «Плюсоновском лендинге»
        # всё равно вёл на простую форму.
        from app.services.message_builder import resolve_landing_url
        landing_url = (ev["landing_url"] or "").strip()
        # ⚠️ КОЛЛАБА: ссылка регистрации — на домене ТОГО организатора, в чьём
        # боте человек (`_bot_cid`), а не «первого владельца» события.
        _reg_page = await resolve_landing_url(db, ev["id"], client_id=_bot_cid)
        _sep = "&" if "?" in _reg_page else "?"
        internal_web = f"{_reg_page}{_sep}c={contact_id}" if contact_id else _reg_page
        # Сторонний сайт ведём прежним путём (там свои параметры и webhook),
        # но ТОЛЬКО когда он выбран способом регистрации.
        if landing_url and ev["status"] == "published" and ev["registration_mode"] == "external":
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

    # Одна кнопка «Зарегистрироваться»:
    #  • skip_contact_form (без лендинга) → CALLBACK `evsignup_<id>`: по нажатию
    #    регистрируем прямо в боте и присылаем меню (форма не нужна — человек уже
    #    в боте). Кнопка остаётся: меню приходит по НАЖАТИЮ, а не само собой;
    #  • иначе → URL: сторонний лендинг (если задан и опубликован) ЛИБО встроенный
    #    веб pluson.ru/event/{slug} — с передачей contact_id, pid, utm,
    #    external_ref_param рефовода и полей контакта.
    if reg_in_bot:
        reg_btn = InlineKeyboardButton(
            text="ЗАРЕГИСТРИРОВАТЬСЯ", callback_data=f"evsignup_{ev['id']}")
    else:
        reg_btn = InlineKeyboardButton(text="ЗАРЕГИСТРИРОВАТЬСЯ", url=web_url)
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [reg_btn],
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


async def _send_finished_event_menu(message: Message, ev, contact_id: int | None, db) -> bool:
    """Если событие завершилось — вместо меню кабинета шлёт «событие прошло».

    Вернёт True, если сообщение отправлено (вызывающий должен выйти), и False,
    если событие ещё идёт/впереди (нужно обычное меню).

    Признак завершения и ближайшее предстоящее событие организатора берутся из
    общего хелпера `resolve_event_finish_state` — того же, на котором работает
    приветствие при открытии события (kind `next_event_cta`/`ecosystem_thanks`).
    Есть предстоящее событие → кнопка-ссылка прямо на него (Mini App или
    бот-флоу — по `clients.default_link_mode`, как у «Кабинет·Подарки»).
    Нет предстоящих → только текст, без кнопок.
    """
    from app.services.event_welcome import resolve_event_finish_state, _fmt_event_period

    try:
        state = await resolve_event_finish_state(db, ev["id"])
    except Exception as e:
        log.warning("resolve_event_finish_state failed for event=%s: %s", ev["id"], e)
        return False

    if not state["is_ended"]:
        return False

    title = _html.escape(ev["title"] or "")
    text = (f"Событие <b>{title}</b> завершилось — спасибо за ваш интерес!")

    succ = state["successor"]
    rows: list[list[InlineKeyboardButton]] = []

    if succ:
        succ_title = _html.escape(succ["title"] or "следующее событие")
        succ_date = _fmt_event_period(
            succ["effective_start_at"], succ["effective_end_at"],
            succ["module_slug"] in ("conference", "turnir"),
        )
        text += f"\n\nСледующее событие: <b>{succ_title}</b>"
        if succ_date:
            text += f"\n🗓 {succ_date}"

        # Ссылка на следующее событие — тем же способом, что «Кабинет·Подарки»:
        # Mini App клиента, если default_link_mode='miniapp' и есть свой бот,
        # иначе веб-страница события.
        # Веб-страница события — публичная страница клиента: домен клиента,
        # если подключён (Mini App-ветка ниже её перебивает).
        # ⚠️ КОЛЛАБА: ведём в Mini App/на домен ТОГО организатора, в чьей базе
        # контакт человека, — иначе он попадёт в чужой кабинет незарегистрированным.
        from app.services.event_client import resolve_event_client
        succ_client_id = await resolve_event_client(
            db, event_id=ev["id"], client_id=ev["client_id"], contact_id=contact_id)
        succ_mode = (await db.fetchval(
            "SELECT default_link_mode FROM clients WHERE id = $1", succ_client_id
        ) if succ_client_id != ev["client_id"] else ev["default_link_mode"]) or "miniapp"
        succ_url = await client_public_link(db, succ_client_id, f"event/{succ['slug']}")
        if succ_mode == "miniapp" and succ_client_id:
            from app.services.share_links import get_client_bot_handles, telegram_link
            handles = await get_client_bot_handles(db, succ_client_id)
            tg_handle = handles.get("telegram")
            if tg_handle:
                ma = telegram_link(succ["slug"], bot_handle=tg_handle,
                                   contact_id=contact_id, link_mode="miniapp")
                if ma:
                    succ_url = ma
        rows.append([InlineKeyboardButton(text="Записаться на следующее", url=succ_url)])
    else:
        text += "\n\nСледите за анонсами — скоро расскажем о новых событиях."

    kb = InlineKeyboardMarkup(inline_keyboard=rows) if rows else None
    await message.answer(text, reply_markup=kb, parse_mode="HTML",
                         disable_web_page_preview=True)
    return True


async def send_event_menu(
    message: Message | None, event_id: int, contact_id: int | None, db,
    *, tg_id: int | str | None = None, bot_token: str | None = None,
) -> None:
    """Меню кабинета зарегистрированного участника события.

    ⚠️ Если событие уже завершилось — меню не показывается вовсе: уходит
    сообщение «событие завершилось» + кнопка на ближайшее предстоящее событие
    организатора (см. `_send_finished_event_menu`).

    Два режима отправки:
      • `message` — ответом на входящее сообщение (заход в бота, `/menu{id}`);
      • `tg_id` + `bot_token` — БЕЗ входящего сообщения. Нужен, когда человек
        зарегистрировался не в боте (Mini App, веб-форма, оплата): раньше меню
        в этом случае не приходило вовсе, и человек не получал ни чата, ни
        эфира — при том что воронка догрева зовёт его «закрепить этот бот».

    Вызывается из ветки «зареган» в `_handle_ref_event_bot_flow`, из команды
    `/menu{event_id}` и из `send_event_menu_after_signup`. Кнопки строятся в
    зависимости от настроек события:
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
                  (SELECT c.default_link_mode FROM event_owners eo
                     JOIN clients c ON c.id = eo.client_id
                    WHERE eo.event_id = e.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS default_link_mode,
                  vip_url, vip_button_label, hide_stream_button,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS chat_url_tg,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS chat_url_vk,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS chat_url_max,
                  (SELECT url FROM event_posters
                     WHERE event_id = e.id AND day IS NULL
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

    # Событие уже прошло → меню кабинета не нужно (эфиров/чата/подарков там
    # больше нет). Вместо него — «событие завершилось» + приглашение на
    # ближайшее предстоящее событие организатора кнопкой-ссылкой. Если
    # предстоящих событий нет — только текст благодарности, без кнопок.
    # ⚠️ Отвечает только на входящее сообщение; при отправке после регистрации
    # (message=None) ветка не нужна — на завершённое событие не регистрируются.
    if message is not None and await _send_finished_event_menu(message, ev, contact_id, db):
        return

    # ⚠️ КОЛЛАБА: меню открывает КОНКРЕТНЫЙ человек — кабинет, Mini App и домен
    # должны быть ТОГО организатора, в чьей базе его контакт. «Первый владелец»
    # из event_owners увёл бы его в чужой Mini App, где он не зарегистрирован.
    from app.services.event_client import resolve_event_client
    link_client_id = await resolve_event_client(
        db, event_id=ev["id"], client_id=ev["client_id"], contact_id=contact_id)

    # Куда ведёт «Кабинет и подарки»: по глобальной настройке клиента
    # (clients.default_link_mode). miniapp → Mini App клиента; иначе → веб события.
    # Настройка берётся у ТОГО ЖЕ клиента, иначе режим одного организатора
    # применился бы к ссылкам другого.
    link_mode = (await db.fetchval(
        "SELECT default_link_mode FROM clients WHERE id = $1", link_client_id
    ) if link_client_id != ev["client_id"] else ev["default_link_mode"]) or "miniapp"
    # Веб-страница события — публичная страница клиента: домен клиента,
    # если подключён. Mini App-ветка ниже её перебивает (адрес Mini App
    # на домен клиента не переезжает).
    cabinet_url = await client_public_link(
        db, link_client_id, f"event/{slug}{cid_q}#cabinet"
    )
    if link_mode == "miniapp" and link_client_id:
        from app.services.share_links import get_client_bot_handles, telegram_link
        handles = await get_client_bot_handles(db, link_client_id)
        tg_handle = handles.get("telegram")
        if tg_handle:
            ma = telegram_link(slug, bot_handle=tg_handle, tab="game",
                               contact_id=contact_id, link_mode="miniapp")
            if ma:
                cabinet_url = ma

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
        # Реф-код приведшего ищется В БАЗЕ человека: у коллабы в чужой базе
        # его нет, и партнёрский параметр молча терялся бы.
        erp = await resolve_referrer_external_ref_param(
            db, link_client_id, contact_id=contact_id,
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

    # Порядок кнопок: Оплатить орг-взнос (VIP) → Кабинет и подарки →
    # Вступить в чат → Ссылка на эфир → Тех. поддержка.

    # 2. Кабинет → веб (#cabinet) или Mini App — по настройке клиента.
    #    Название: для конференций/турниров «Кабинет·Подарки·Спикеры»,
    #    для обычных событий «Кабинет·Подарки».
    cabinet_label = ("🎁 Кабинет·Подарки·Спикеры"
                     if ev["module_slug"] in ("conference", "turnir")
                     else "🎁 Кабинет·Подарки")
    rows.append([InlineKeyboardButton(text=cabinet_label, url=cabinet_url)])

    # 3. Вступить в Чат — только если есть хоть одна chat-ссылка.
    has_chat = bool((ev["chat_url_tg"] or "").strip()
                    or (ev["chat_url_vk"] or "").strip()
                    or (ev["chat_url_max"] or "").strip())
    if has_chat:
        rows.append([InlineKeyboardButton(
            text="📝 Вступить в Чат", callback_data=f"evchat_{event_id}"
        )])

    # 4. Ссылка на эфир — ближайший эфир + кнопка войти в стрим.
    #    Скрывается, если у события стоит галочка «Скрыть кнопку стрима»
    #    (hide_stream_button) — она прячет кнопку и в Mini App/вебе, и тут.
    if not ev["hide_stream_button"]:
        rows.append([InlineKeyboardButton(
            text="📺 Ссылка на эфир", callback_data=f"evlive_{event_id}"
        )])

    # (Кнопка «Программа и Спикеры» убрана — программа и спикеры доступны
    #  внутри «🎁 Кабинет и подарки» на странице события.)

    # 5. Тех. поддержка — единое сообщение с каналами связи клиента.
    rows.append([InlineKeyboardButton(
        text="🆘 Тех. поддержка", callback_data=f"evsupport_{event_id}"
    )])

    kb = InlineKeyboardMarkup(inline_keyboard=rows)
    poster_url = (ev["poster_url"] or "").strip()

    # Режим «без входящего сообщения»: шлём напрямую по tg_id токеном бота
    # клиента. Кнопки меню — callback (чат/эфир/поддержка), поэтому общая
    # send_telegram_message не годится: она умеет только url-кнопки.
    if message is None:
        if not (tg_id and bot_token):
            return
        payload_kb = kb.model_dump(exclude_none=True)
        async with httpx.AsyncClient(timeout=20) as cl:
            if poster_url and len(text) <= 1024:
                try:
                    r = await cl.post(
                        f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                        json={"chat_id": str(tg_id), "photo": poster_url,
                              "caption": text, "parse_mode": "HTML",
                              "reply_markup": payload_kb},
                    )
                    if r.json().get("ok"):
                        return
                except Exception as e:
                    log.warning("send_event_menu(direct) photo failed: %s", e)
            try:
                await cl.post(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    json={"chat_id": str(tg_id), "text": text,
                          "parse_mode": "HTML", "disable_web_page_preview": True,
                          "reply_markup": payload_kb},
                )
            except Exception as e:
                log.warning("send_event_menu(direct) text failed: %s", e)
        return

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


async def send_event_menu_after_signup(db, *, event_id: int, contact_id: int) -> None:
    """Прислать меню события человеку, который зарегистрировался НЕ в боте.

    Зачем: меню (чат, эфир, кабинет, поддержка) отправлялось только когда
    человек сам заходил в бота по ссылке события. Зарегистрировавшийся из
    Mini App или с веб-формы не получал его вовсе — и не получил бы никогда,
    пока не догадается перейти по ссылке повторно. При этом воронка догрева
    сразу пишет ему «запомните и закрепите этот бот», а бот пустой.

    ⚠️ Бот берём у ВЛАДЕЛЬЦА КОНТАКТА (`contacts.client_id`), а не у события:
    в коллабе человек лежит в базе того организатора, через кого пришёл, и
    писать ему должен ЕГО бот. Токен чужого бота отправит сообщение от имени
    постороннего организатора — человек не поймёт, кто ему пишет.

    ⚠️ Только Telegram: MAX и VK своих меню событий не имеют.
    Все ошибки глушим — это дополнение к регистрации, а не её часть.
    """
    try:
        row = await db.fetchrow(
            """SELECT c.client_id,
                      (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
                        LIMIT 1) AS tg_id
                 FROM contacts c WHERE c.id = $1""",
            contact_id,
        )
        if not row or not row["client_id"]:
            return
        tg_id = (row["tg_id"] or "").strip()
        # Псевдо-запись `@ник` (идентичность известна только по нику) для
        # отправки не годится — нужен числовой id.
        if not tg_id.isdigit():
            return

        from app.services.channels import get_client_telegram_token
        token = await get_client_telegram_token(row["client_id"], db)
        if not token:
            return

        await send_event_menu(
            None, event_id, contact_id, db, tg_id=tg_id, bot_token=token,
        )
    except Exception as e:
        log.warning("send_event_menu_after_signup failed (event=%s contact=%s): %s",
                    event_id, contact_id, e)


async def _start_lead_magnet_funnel(message: Message, kind: str, slug: str,
                                    pid: str | None = None,
                                    utm_source: str | None = None) -> bool:
    """Запускает воронку лид-магнита (kind='m') или пакета (kind='p') по slug.

    Создаёт funnel_run + вызывает run_started (Текст 1 с кнопкой «ГОТОВО»).
    Возвращает True если воронка запущена, False — если slug не найден.
    Переиспользуется из /start m_/p_ и из режима /start='lead_magnet'.
    """
    user = message.from_user
    if not user:
        return False
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
        if not client_id:
            return False
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
        return True


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

        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                return False

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
                          profile_photo_url, owner_photo_url,
                          default_link_mode, start_greeting_text,
                          start_btn_events_label, start_btn_owner_label,
                          start_buttons,
                          start_mode, start_event_id,
                          start_lead_magnet_id, start_package_id
                     FROM clients WHERE id = $1""",
                client_id,
            )
            if not client:
                return False

            # Режим «открывать конкретное событие при /start»: если клиент
            # выбрал событие — отдаём приветствие/вход именно этого события
            # (его лендинг/рега/меню по статусу), а не общее приветствие.
            start_event = None
            if client["start_mode"] == "event" and client["start_event_id"]:
                start_event = await db.fetchrow(
                    """SELECT e.id, e.slug, e.title FROM events e
                        WHERE e.id = $1 AND e.status = 'published'
                          AND EXISTS (SELECT 1 FROM event_owners eo
                                       WHERE eo.event_id = e.id AND eo.client_id = $2
                                         AND eo.status = 'accepted')""",
                    client["start_event_id"], client_id,
                )

            # Режим «открывать воронку лид-магнита при /start»: резолвим slug
            # выбранного лид-магнита/пакета — запустим штатную воронку ниже.
            lm_start_kind = None  # 'm' | 'p'
            lm_start_slug = None
            if client["start_mode"] == "lead_magnet":
                if client["start_lead_magnet_id"]:
                    lm_start_slug = await db.fetchval(
                        "SELECT slug FROM lead_magnets WHERE id=$1 AND client_id=$2",
                        client["start_lead_magnet_id"], client_id,
                    )
                    if lm_start_slug:
                        lm_start_kind = "m"
                if not lm_start_slug and client["start_package_id"]:
                    lm_start_slug = await db.fetchval(
                        "SELECT slug FROM lead_magnet_packages WHERE id=$1 AND client_id=$2",
                        client["start_package_id"], client_id,
                    )
                    if lm_start_slug:
                        lm_start_kind = "p"

        brand_name = (client["brand_name"] or client["name"] or "").strip()
        greet_name = (user.first_name or "").strip()
        web_mode = (client["default_link_mode"] or "miniapp") == "bot"
        # Адрес Mini App: всегда основной домен — он вбит в @BotFather и на
        # домен клиента не переезжает (web-ссылки кнопок резолвятся отдельно).
        base = f"{platform_base_url()}/c/{client_id}/tg"

        # ── Режим «конкретное событие»: запускаем СТАНДАРТНЫЙ флоу события,
        # ровно как по ссылке t.me/<bot>?start=ref_pg<slug> — афиша + кнопка
        # «Зарегистрироваться» (если не зарег.) или афиша + «Меню» (если зарег.),
        # с учётом link_mode (Mini App / веб). Никакого самописного текста. ──
        if start_event:
            try:
                if await _handle_ref_event_bot_flow(message, f"ref_pg{start_event['slug']}"):
                    return True
            except Exception as e:  # noqa: BLE001
                log.warning("vip_start(event) ref-flow failed: %s", e)
            # если стандартный флоу не отработал — падаем в общее приветствие ниже

        # ── Режим «лид-магнит»: запускаем штатную воронку выбранного
        # лид-магнита/пакета (Текст 1 с кнопкой «ГОТОВО»), как по ссылке m_/p_. ──
        if lm_start_kind and lm_start_slug:
            try:
                if await _start_lead_magnet_funnel(message, lm_start_kind, lm_start_slug):
                    return True
            except Exception as e:  # noqa: BLE001
                log.warning("vip_start(lead_magnet) funnel failed: %s", e)
            # если воронка не запустилась — падаем в общее приветствие ниже

        # Текст приветствия. Если клиент задал свой — используем его
        # (плейсхолдеры {имя} и {бренд}); иначе — дефолт.
        custom_greeting = (client["start_greeting_text"] or "").strip()

        if custom_greeting:
            text = (custom_greeting
                    .replace("{имя}", _html.escape(greet_name))
                    .replace("{бренд}", _html.escape(brand_name)))
        else:
            greeting = f"Привет, {_html.escape(greet_name)}! 👋" if greet_name else "Привет! 👋"
            intro_lines = [greeting, ""]
            if brand_name:
                intro_lines.append(f"Добро пожаловать в бот <b>{_html.escape(brand_name)}</b>.")
            else:
                intro_lines.append("Добро пожаловать!")
            intro_lines.append("")
            intro_lines.append("Загляните в события и узнайте об организаторе по кнопкам ниже 👇")
            text = "\n".join(intro_lines)

        # Куда ведут кнопки: общая настройка клиента (web_mode/base заданы выше).
        def _btn(label: str, *, miniapp_path: str, web_url: str) -> InlineKeyboardButton:
            if web_mode:
                return InlineKeyboardButton(text=label, url=web_url)
            return InlineKeyboardButton(text=label, web_app=WebAppInfo(url=f"{base}{miniapp_path}"))

        # Кнопки приветствия — из clients.start_buttons (до 5, типы events/owner/custom),
        # с фолбэком на 2 дефолтные кнопки из старых полей.
        from app.services.start_greeting import _resolve_buttons
        # Веб-ссылки кнопок («Все события», «Об основателе») — публичные
        # страницы клиента, поэтому резолвим его домен.
        from app.services.client_domains import client_public_url
        pool = await get_pool()
        async with pool.acquire() as _db:
            greet_base = await client_public_url(_db, client_id)
        btns = _resolve_buttons(
            client_id,
            client["start_buttons"],
            client["start_btn_events_label"],
            client["start_btn_owner_label"],
            greet_base,
        )
        rows: list[list[InlineKeyboardButton]] = []
        for b in btns:
            if b["kind"] == "events":
                rows.append([_btn(b["label"], miniapp_path="/", web_url=b["url"])])
            elif b["kind"] == "owner":
                rows.append([_btn(b["label"], miniapp_path="/?_tab=ecosystem", web_url=b["url"])])
            else:  # custom — всегда обычная url-кнопка (произвольная ссылка)
                rows.append([InlineKeyboardButton(text=b["label"], url=b["url"])])
        keyboard = InlineKeyboardMarkup(inline_keyboard=rows)

        # Фото клиента — приоритет фото основателя, fallback на фото бренда
        photo_url = client["owner_photo_url"] or client["profile_photo_url"]

        async def _send_text_safe() -> None:
            """Приветствие клиента важнее кнопок. Если Telegram отверг клавиатуру
            (кривой URL кастомной кнопки → «Wrong HTTP URL») — отправляем тот же
            текст без кнопок. Ни при каких условиях не показываем системный
            фолбэк «Я бот ПЛЮСОН» в боте клиента."""
            try:
                await message.answer(text, parse_mode="HTML", reply_markup=keyboard,
                                     disable_web_page_preview=True)
            except Exception as e:  # noqa: BLE001
                log.warning("vip_start keyboard rejected (%s) — sending without buttons", e)
                await message.answer(text, parse_mode="HTML",
                                     disable_web_page_preview=True)

        TG_CAPTION_LIMIT = 1024
        if photo_url and len(text) <= TG_CAPTION_LIMIT:
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
        elif photo_url:
            # Текст не влезает в caption — фото отдельно, потом текст с кнопками
            try:
                await message.answer_photo(photo=photo_url)
            except Exception as e:
                log.warning("vip_start answer_photo (separate) failed: %s", e)

        await _send_text_safe()
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


@router.message(Command("pluson_connect"))
async def handle_pluson_connect_command(message: Message):
    """Команда /pluson_connect — связать свой ПЛЮСОН-аккаунт с контактом.

    Бот генерит подписанный токен (telegram + user.id из апдейта + client_id
    владельца бота) и отдаёт ссылку на форму pluson.ru/link-pluson?token=…, где
    человек безопасно (на РФ-сервере, с согласием ПД) вводит email/пароль ПЛЮСОНа.
    Ввод в самом боте/мессенджере НЕ делаем. Личность гарантирует токен."""
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return
    try:
        from app.services.channels import find_channel_by_bot_id
        from app.services.pluson_connect_token import make_pluson_connect_token
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                # Бот не привязан ни к одному клиенту — связку сделать не к чему.
                await message.answer("Эта команда доступна только в боте организатора.")
                return
            client_id = await db.fetchval(
                """SELECT client_id FROM client_channels
                    WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
                ch["id"],
            )
            if not client_id:
                return
        token = make_pluson_connect_token(
            client_id=int(client_id), platform="telegram", user_id=str(user.id))
        url = f"{settings.frontend_url.rstrip('/')}/link-pluson?token={token}"
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🔗 Связать ПЛЮСОН-аккаунт", url=url)
        ]])
        await message.answer(
            "Свяжите свой аккаунт ПЛЮСОН с этим профилем — тогда все, кто "
            "зарегистрируются на событие и заберут в подарок доступ к ПЛЮСОН, "
            "закрепятся за вами.\n\nНажмите кнопку ниже — откроется форма "
            "на pluson.ru (ссылка действует 1 час).",
            reply_markup=kb,
        )
    except Exception as e:
        logging.warning(f"/pluson_connect failed: {e!r}")


@router.message(F.text.regexp(r"(?i)^/menu\d+_orders\b"))
async def handle_event_orders_command(message: Message):
    """`/menu{event_id}_orders` — заказы события: НЕОПЛАЧЕННЫЕ и ОПЛАЧЕННЫЕ.

    ⚠️ Объявлен ДО `/menu\d+`: тот хендлер ловит любой /menu<цифры> и без этого
    перехватил бы команду, открыв меню события вместо списка заказов.

    Доступ — только владельцу события: команда приходит в бот КЛИЕНТА, поэтому
    сверяем, что бот принадлежит клиенту-владельцу (event_owners). Чужому —
    молчим, иначе по номеру события утекли бы контакты заказчиков.
    """
    import re as _re
    from app.services.channels import find_channel_by_bot_id
    from app.services.orders_export import (
        client_owns_event, can_see_orders, fetch_orders, build_orders_message,
    )

    user = message.from_user
    m = _re.match(r"(?i)^/menu(\d+)_orders\b", (message.text or "").strip())
    if not user or not m:
        return
    event_id = int(m.group(1))
    bot_id = message.bot.id if message.bot else None
    if not bot_id:
        return

    pool = await get_pool()
    async with pool.acquire() as db:
        ch = await find_channel_by_bot_id(bot_id, db)
        if not ch:
            return
        # Клиенты этого бота (у канала может быть несколько привязок).
        client_ids = [r["client_id"] for r in await db.fetch(
            "SELECT client_id FROM client_channels WHERE channel_id = $1", ch["id"])]
        # Два условия сразу: событие принадлежит клиенту этого бота И пишет
        # человек, которому можно (владелец / служба поддержки / помощник).
        # Бот общий для всех участников события — без второй проверки список
        # заказчиков с телефонами увидел бы любой из них.
        owner_ok = False
        for cid in client_ids:
            if await client_owns_event(db, cid, event_id) and \
                    await can_see_orders(db, cid, user.id, user.username):
                owner_ok = True
                break
        if not owner_ok:
            return
        ev_title = await db.fetchval("SELECT title FROM events WHERE id = $1", event_id) or f"#{event_id}"
        rows = await fetch_orders(db, event_id)

    for part in build_orders_message(rows, ev_title):
        await message.answer(part, parse_mode="HTML", disable_web_page_preview=True)


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
            # Каждый бот обслуживает события СВОЕГО клиента (включая @pluson_bot,
            # который принадлежит сервисному клиенту).
            if not owns:
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
        app_url = f"https://telegram.me/{bot_username}/{PLUSON_TG_APP}?startapp=hub"
    else:
        app_url = f"https://telegram.me/{bot_username}?startapp=hub"
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
                if ch:
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


QUESTION_PROMPT_HTML = (
    "💬 <b>Напишите ваш вопрос по ПЛЮСОН</b> — мы вам ответим.\n\n"
    "Просто отправьте его следующим сообщением: опишите, что не получается "
    "или что хотите настроить. Чем подробнее — тем быстрее разберёмся.\n\n"
    "Если вопрос про конкретное событие — укажите его название."
)


async def _send_question_prompt(message: Message) -> bool:
    """Приглашение «напишите ваш вопрос» — ТОЛЬКО в @pluson_bot.

    ⚠️ Проверка бота обязательна: polling-диспетчер один на все боты платформы.
    Без неё приглашение писать «вопрос по ПЛЮСОН» приходило бы и в ботах
    клиентов, где человек ждёт ответа организатора события, а не нас.

    Возвращает True, если приглашение отправлено (вызывающий прекращает
    обработку), иначе False — payload/команда обрабатывается дальше как обычно.
    """
    bot_id = message.bot.id if message.bot else None
    if not bot_id:
        return False
    try:
        from app.services.admin_export import is_export_bot
        pool = await get_pool()
        async with pool.acquire() as db:
            if not await is_export_bot(db, bot_id):
                return False
    except Exception as e:  # noqa: BLE001 — не знаем бота → молчим, не угадываем
        log.warning("question prompt bot check failed: %s", e)
        return False
    try:
        await message.answer(QUESTION_PROMPT_HTML, parse_mode="HTML",
                             disable_web_page_preview=True)
    except Exception as e:  # noqa: BLE001
        log.warning("question prompt answer failed: %s", e)
        return False
    return True


@router.message(Command(commands=["question"]))
async def handle_question(message: Message):
    """Команда `/question` — приглашение задать вопрос по ПЛЮСОНу.

    Работает только в @pluson_bot (см. `_send_question_prompt`). В боте клиента
    команда молчит — там за поддержку отвечает `/support` организатора.
    """
    if message.chat and message.chat.type != "private":
        return
    if not message.from_user:
        return
    await _send_question_prompt(message)


@router.message(Command(commands=["getmyid"]))
async def handle_getmyid(message: Message):
    """ОДНА команда /getmyid — работает в личке, группе и беседе.
    Возвращает chat_id текущего места + ваш Telegram ID.
    Для КАНАЛА (бот не ловит команды в канале) — перешлите сообщение из канала
    в личку боту, ответим id канала (forward_from_chat.id).
    """
    chat = message.chat
    fwd = message.forward_from_chat
    # Анонимная отправка «от имени группы»: настоящего отправителя нет —
    # Telegram кладёт его в sender_chat, а from_user либо пуст, либо это
    # служебный GroupAnonymousBot (id 1087968824). Личный ID в этом случае скрыт.
    anonymous = message.sender_chat is not None or (
        message.from_user is not None and message.from_user.id == 1087968824
    )
    uid = message.from_user.id if (message.from_user and not anonymous) else None

    lines = []
    if fwd:
        # Переслали сообщение из канала/чата — отдаём id источника.
        lines.append(f"<b>ID канала/чата:</b> <code>{fwd.id}</code>")
    lines.append(f"<b>ID этого чата:</b> <code>{chat.id}</code>")
    if uid is not None:
        lines.append(f"<b>Ваш ID:</b> <code>{uid}</code>")
    else:
        lines.append(
            "<b>Ваш ID:</b> не смог узнать — вы пишете от имени группы "
            "(анонимный админ). Ваш личный ID Telegram скрывает. "
            "Чтобы узнать его — снимите анонимность или напишите мне <code>/getmyid</code> в личку."
        )
    lines.append("")
    lines.append(
        "Вставьте нужный ID в Настройки → Технические "
        "(канал уведомлений / тестовые ID). Для канала — перешлите сюда сообщение из него."
    )
    await message.answer("\n".join(lines), parse_mode="HTML")


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


# ─────────────────────────────────────────────────────────────────────────────
# Выгрузки для владельца платформы: /clients и /collabs
# Доступ — только у аккаунтов из ALLOWED_USERNAMES (admin_export.py).
# ⚠️ Сборка списков и формат — в app/services/admin_export.py, здесь только
# проверка доступа и отправка: команды одинаковые по структуре.
# ─────────────────────────────────────────────────────────────────────────────

async def _send_admin_export(message: Message, kind: str) -> None:
    from app.services.admin_export import (
        is_allowed, is_export_bot, fetch_clients, fetch_collabs, build_message,
        build_grouped_message,
    )
    # Молча игнорируем чужих: подсказка «вам нельзя» только раскрыла бы, что
    # такая команда существует.
    username = message.from_user.username if message.from_user else None
    if not is_allowed(username):
        log.info("admin_export: отказ — ник @%s не в списке", username)
        return
    bot_id = message.bot.id if message.bot else None
    if not bot_id:
        return
    pool = await get_pool()
    async with pool.acquire() as db:
        # ⚠️ ТОЛЬКО @pluson_bot. Диспетчер в polling один на все боты клиентов,
        # без этой проверки команда отвечала бы и в боте клиента, отдавая ему
        # выгрузку по всей платформе.
        if not await is_export_bot(db, bot_id):
            log.info("admin_export: отказ — команда пришла не в @pluson_bot (bot_id=%s)", bot_id)
            return
        if kind == "clients":
            rows = await fetch_clients(db)
            parts = build_grouped_message(rows, "Действующие клиенты")
        else:
            rows = await fetch_collabs(db)
            parts = build_message(rows, "Коллабораторная", with_tariff=False)
    log.info("admin_export: /%s для @%s — %d записей, %d сообщений",
                kind, username, len(rows), len(parts))
    for part in parts:
        await message.answer(part, parse_mode="HTML", disable_web_page_preview=True)


@router.message(Command(commands=["clients"]))
async def handle_clients_export(message: Message):
    """Клиенты с активной подпиской Профи+ либо активным модулем
    (Конференции / Премии / Турниры)."""
    await _send_admin_export(message, "clients")


@router.message(Command(commands=["collabs"]))
async def handle_collabs_export(message: Message):
    """Реальные участники Коллабораторной (без демо-карточек и тестовых)."""
    await _send_admin_export(message, "collabs")


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
    # ЧЁРНЫЙ СПИСОК (миграция 228) — не отвечаем и не шлём уведомление организатору
    if await _reply_if_blacklisted(message):
        return
    try:
        from app.services.channels import find_channel_by_bot_id
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                return

            # Единый путь для ЛЮБОГО бота (в т.ч. @pluson_bot сервисного клиента):
            # бот → client_channels → его клиент. Сообщение сохраняется в базу
            # этого клиента, ему же уходит уведомление. Раньше системный бот
            # отвечал отпиской и ничего не сохранял — это отменено: @pluson_bot
            # принадлежит сервисному клиенту (clients.is_system_service).
            client_id = await db.fetchval(
                """SELECT client_id FROM client_channels
                    WHERE channel_id = $1
                    ORDER BY is_active DESC, id ASC LIMIT 1""",
                ch["id"],
            )
            if not client_id:
                return

            client_row = await db.fetchrow(
                """SELECT notifications_telegram_chat_id, work_tg_username, work_vk, work_max,
                          COALESCE(NULLIF(brand_name,''), name) AS brand
                     FROM clients WHERE id = $1""",
                client_id,
            )
            if not client_row:
                return
            notif_chat_id = client_row["notifications_telegram_chat_id"]
            client_brand = client_row["brand"] or ""
            work_tg = (client_row["work_tg_username"] or "").lstrip("@")
            work_vk = client_row["work_vk"]
            work_max = client_row["work_max"]

            contact_row = await db.fetchrow(
                """SELECT pu.contact_id, c.name, c.utm_source
                     FROM platform_users pu
                     JOIN contacts c ON c.id = pu.contact_id
                    WHERE c.client_id = $1
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

        # Уведомление в каналы клиента (TG+MAX+VK дублирование). Хелпер сам решит,
        # куда слать (по заполненным полям); строим текст всегда, если есть client_id.
        if client_id:
            when_str = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
            display_name = (
                ((user.first_name or "") + " " + (user.last_name or "")).strip()
                or contact_name or "—"
            )
            from app.services.profile_links import nick_html, link_html
            user_nick = nick_html("telegram", user_id=user.id, username=user.username)
            prof_link = link_html("telegram", user_id=user.id, username=user.username)
            card_url = (
                f"{settings.frontend_url}/dashboard/clients?contact={contact_id}"
                if contact_id else "—"
            )
            parts = [
                "#user_message 💬",
                "",
                f"<b>Когда:</b> {when_str}",
                # Бот + бренд кабинета: сразу видно, ЧЕРЕЗ КОГО пришло сообщение
                # (напр. через сервисный @pluson_bot, а не ваш бот).
                (f"<b>Бот:</b> {bot_handle} — {_html.escape(client_brand)}"
                 if bot_handle else f"<b>Бот:</b> {_html.escape(client_brand) or '—'}"),
                "",
                "<b>Кто написал</b>",
                f"<b>Никнейм:</b> {user_nick}",
                f"<b>Имя:</b> {_html.escape(display_name)}",
                f"<b>TG ID:</b> <code>{user.id}</code>",
            ]
            if prof_link:
                parts.append(f"<b>Ссылка:</b> {prof_link}")
            parts += [
                f"<b>ID контакта:</b> {('#' + str(contact_id)) if contact_id else '—'}",
                f"<b>Источник (utm_source):</b> {_html.escape(utm_source) if utm_source else '—'}",
                f"<b>Карточка:</b> {card_url}",
                "",
                "<b>Сообщение:</b>",
                _html.escape(message.text or ""),
            ]
            notif_text = "\n".join(parts)
            try:
                from app.services.channels import notify_organizer_all_channels
                # ⚠️ Соединение `db` выше уже вернулось в пул (блок `async with`
                # закрылся) — берём своё, иначе asyncpg бросает
                # «connection has been released back to the pool».
                pool = await get_pool()
                async with pool.acquire() as ndb:
                    await notify_organizer_all_channels(client_id, notif_text, ndb)
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
    # ЧЁРНЫЙ СПИСОК (миграция 228) — не архивируем и не уведомляем организатора
    if await _reply_if_blacklisted(message):
        return
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
            if not ch:
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
