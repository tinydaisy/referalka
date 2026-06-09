"""
Callback-handlers воронки лид-магнита.

Кнопка «ГОТОВО» из Текста 1 шлёт callback с data `fnl_check_<run_id>`.
Обработчик проверяет подписку через funnel_service.run_check_subscription.
"""
from aiogram import Router, F
from aiogram.types import (
    CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup,
)
from app.database import get_pool
import html as _html
import logging

router = Router()
log = logging.getLogger(__name__)


# Группы ролей для вывода каналов при проверке подписки на чат события.
# (заголовок, набор ролей). Порядок = порядок вывода.
_ROLE_GROUPS: list[tuple[str, set[str]]] = [
    ("Организаторы", {"organizer"}),
    ("Жюри", {"jury"}),
    ("Спикеры", {"speaker", "headliner"}),
    ("Партнёры", {"partner", "general_partner"}),
]


async def _gather_event_chat_channels(event_id: int, mode: str, db):
    """Возвращает список каналов события (для проверки подписки на чат),
    с ролью/именем/каналом/личным tg спикера. Учитывает mode:
      • organizer    → только role='organizer'
      • all_speakers → все роли
    Исключает exclude_channel_from_subscription=TRUE и пустые tg_channel_id.
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
               {role_filter}
             ORDER BY COALESCE(cse.priority, 60), cse.sort_order, cse.id""",
        event_id,
    )
    return [dict(r) for r in rows]


def _build_chat_links_message(ev) -> tuple[str, list[list[InlineKeyboardButton]]]:
    """Сообщение со ссылками на чаты события + кнопки. Главный чат
    (primary_chat_platform) выводится первым с пометкой «(главный чат)»."""
    tg = (ev["chat_url_tg"] or "").strip()
    vk = (ev["chat_url_vk"] or "").strip()
    mx = (ev["chat_url_max"] or "").strip()
    primary = (ev["primary_chat_platform"] or "telegram").strip()

    # (platform_key, подпись_строки, текст_кнопки, url)
    items = [
        ("telegram", "Телеграм", "Чат в Телеграм", tg),
        ("vk", "ВК", "Чат в ВК", vk),
        ("max", "Мах", "Чат в МАХ", mx),
    ]
    items = [it for it in items if it[3]]
    # Главный — первым.
    items.sort(key=lambda it: 0 if it[0] == primary else 1)

    lines = [
        "Это чаты события:",
        'Добавьтесь во все и НАПИШИТЕ в чаты "Я С ВАМИ" и о себе, чтобы не потеряться!',
        "",
    ]
    rows: list[list[InlineKeyboardButton]] = []
    for idx, (pkey, label, btn, url) in enumerate(items):
        main_mark = " (главный чат)" if idx == 0 else ""
        lines.append(f"{label}: {_html.escape(url)}{main_mark}")
        rows.append([InlineKeyboardButton(text=btn, url=url)])
    return "\n".join(lines), rows


@router.callback_query(F.data.startswith("evchat_"))
async def handle_event_chat_join(callback: CallbackQuery):
    """«Вступить в Чат» — проверка подписки на каналы спикеров/организаторов
    события, затем выдача ссылок на чаты."""
    try:
        event_id = int((callback.data or "").removeprefix("evchat_"))
    except ValueError:
        await callback.answer("Ошибка кнопки")
        return

    user_tg_id = callback.from_user.id
    pool = await get_pool()
    async with pool.acquire() as db:
        ev = await db.fetchrow(
            """SELECT id, client_id, require_subscription,
                      chat_url_tg, chat_url_vk, chat_url_max, primary_chat_platform
                 FROM events WHERE id = $1 LIMIT 1""",
            event_id,
        )
        if not ev:
            await callback.answer("Событие не найдено", show_alert=True)
            return

        # Режим проверки: конференция → conf_conferences.subscription_mode,
        # мероприятие → events.require_subscription (true=organizer, false=none).
        conf = await db.fetchrow(
            "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id
        )
        if conf:
            mode = (dict(conf).get("subscription_mode") or "all_speakers")
        else:
            mode = "organizer" if ev["require_subscription"] else "none"

        # Каналы для проверки (если mode != none).
        channels = [] if mode == "none" else await _gather_event_chat_channels(event_id, mode, db)

        # Проверяем подписку по каждому каналу.
        not_all_subscribed = False
        verdicts: dict[int, str] = {}  # speaker_id → 'subscribed'|'not_subscribed'|'fake_pass'
        if channels:
            import httpx
            from app.api.subscription_check import _check_one_channel
            from app.services.channels import get_client_telegram_token
            from app.config import settings as _settings
            token = await get_client_telegram_token(ev["client_id"], db) or _settings.telegram_bot_token
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
            lines = ["Чтобы попасть в чат — подпишитесь на каналы:", ""]
            for header, roles in _ROLE_GROUPS:
                grp = [c for c in channels if c["role"] in roles]
                if not grp:
                    continue
                lines.append(f"<b>{header}:</b>")
                for c in grp:
                    name = _html.escape(c["name"] or "Канал")
                    url = (c["tg_channel_url"] or "").strip()
                    mark = "✅ " if verdicts.get(c["speaker_id"]) in ("subscribed", "fake_pass") else ""
                    if url:
                        lines.append(f"{mark}- <a href=\"{_html.escape(url)}\">{name}</a>")
                    else:
                        lines.append(f"{mark}- {name}")
                lines.append("")
            kb = InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="✅ Готово / Проверить снова",
                                     callback_data=f"evchat_{event_id}")
            ]])
            await callback.message.answer(
                "\n".join(lines).strip(), reply_markup=kb,
                parse_mode="HTML", disable_web_page_preview=True,
            )
            await callback.answer()
            return

        # ── Подписан (или mode=none) — выдаём ссылки на чаты ──────────────────
        text, rows = _build_chat_links_message(ev)
        kb = InlineKeyboardMarkup(inline_keyboard=rows) if rows else None
        await callback.message.answer(
            text, reply_markup=kb, parse_mode="HTML",
            disable_web_page_preview=True,
        )
        await callback.answer()


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
    spkinv_url = f"https://t.me/{bot_handle}?start=spkinv_{access_code}"

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
