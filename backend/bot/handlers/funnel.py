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
    from app.services.funnel_service import run_check_subscription, _get_brand_context
    async with pool.acquire() as db:
        result = await run_check_subscription(run_id, str(callback.from_user.id), db)
        if result == "subscribed":
            await callback.answer("Готово! Проверяйте сообщения 🎁", show_alert=False)
        elif result == "not_subscribed":
            client_id = await db.fetchval("SELECT client_id FROM funnel_runs WHERE id=$1", run_id)
            ctx = await _get_brand_context(client_id, db) if client_id else {}
            chan = ctx.get("subscription_channel", "")
            await callback.answer(
                f"Не вижу подписки на канал {chan}. Подпишитесь и нажмите снова.",
                show_alert=True,
            )
        elif result == "no_token":
            await callback.answer(
                "Технические неполадки. Попробуйте позже или свяжитесь с организатором.",
                show_alert=True,
            )
        else:
            await callback.answer("Что-то пошло не так. Попробуйте позже.", show_alert=True)
