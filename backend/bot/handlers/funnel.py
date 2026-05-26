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
