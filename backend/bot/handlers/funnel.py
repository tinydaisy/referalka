"""
Callback-handlers воронки лид-магнита.

Кнопка «ГОТОВО» из Текста 1 шлёт callback с data `fnl_check_<run_id>`.
Обработчик проверяет подписку через funnel_service.run_check_subscription.
"""
from aiogram import Router, F
from aiogram.types import CallbackQuery
from app.database import get_pool
import logging

router = Router()
log = logging.getLogger(__name__)


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

    if already:
        head = f"Вы уже спикер «{ev['title']}».\n\nОткройте свой кабинет:"
    else:
        head = f"Готово! Вы включены в спикеры «{ev['title']}».\n\nОткройте свой кабинет и заполните данные о себе:"
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="📝 Открыть кабинет спикера", url=spkinv_url)
    ]])
    try:
        await callback.message.answer(head, reply_markup=kb)
    except Exception as e:
        log.exception("send spkreg confirm reply failed: %s", e)
    await callback.answer("Готово!", show_alert=False)
