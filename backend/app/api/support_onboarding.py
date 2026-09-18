"""
«Шаг ноль»: подтверждение почты + вход хотя бы в одного бота поддержки.

ЗАЧЕМ ЭТОТ ШАГ ВООБЩЕ ЕСТЬ. Автонастройка в нескольких местах упирается в
действие клиента — зайти в бота, открыть настройку приватности, вступить в
группу. Если к этому моменту с человеком нет ни одного рабочего канала связи,
услуга встаёт намертво, и сказать ему об этом НЕЧЕМ. Именно так вышло с
заказами 8 и 13 (сентябрь 2026): письма не доходили, в боте человек ни разу не
был, и после оплаты он просто сидел в тишине.

⚠️ Поэтому шаг ноль идёт ДО настройки, а не после.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_current_client
from app.database import get_db
from app.services.support_link import PLATFORMS, support_url

logger = logging.getLogger(__name__)

# ⚠️ Префикс БЕЗ `/api/v1` — его добавляет main.py при include_router, как всем
# остальным роутерам. С полным путём здесь вышло бы `/api/v1/api/v1/...`.
router = APIRouter(prefix="/clients/me/support-onboarding",
                   tags=["support-onboarding"])


@router.get("", summary="Состояние шага ноль: почта и подписки на ботов")
async def get_state(user=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(user["sub"])

    row = await db.fetchrow(
        "SELECT email, email_verified FROM clients WHERE id = $1", client_id
    )
    if not row:
        raise HTTPException(404, "Клиент не найден")

    subs = await db.fetch(
        "SELECT platform_slug, subscribed_at FROM client_support_subscriptions "
        " WHERE client_id = $1", client_id,
    )
    done = {s["platform_slug"] for s in subs}

    # ⚠️ Ссылку собирает БЭКЕНД, а не фронт: подпись параметра считается по
    # серверному секрету, и на фронт он не попадает никогда.
    platforms = []
    for slug, cfg in PLATFORMS.items():
        platforms.append({
            "slug": slug,
            "label": cfg["label"],
            "enabled": bool(cfg.get("base")) and cfg.get("enabled") is not False,
            "subscribed": slug in done,
            "url": support_url(slug, reason="zero", client_id=client_id),
        })

    return {
        "email": row["email"],
        "email_verified": bool(row["email_verified"]),
        "platforms": platforms,
        # ⚠️ ХВАТАЕТ ОДНОЙ ПЛОЩАДКИ (решение владельца). Зовём в обе — человеку
        # так удобнее, и мы не теряем с ним связь, если он ушёл из одной, — но
        # упираться в того, у кого нет Telegram, нельзя.
        "any_subscribed": bool(done),
        "can_continue": bool(row["email_verified"]) and bool(done),
    }


@router.post("/resend-email", summary="Выслать письмо подтверждения ещё раз")
async def resend_email(user=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(user["sub"])

    row = await db.fetchrow(
        "SELECT email_verified FROM clients WHERE id = $1", client_id
    )
    if not row:
        raise HTTPException(404, "Клиент не найден")
    if row["email_verified"]:
        return {"ok": True, "already_verified": True}

    # ⚠️ Письмо шлёт ТА ЖЕ функция, что и при регистрации — второй реализации
    # подтверждения почты быть не должно, они разойдутся в текстах и сроках.
    from app.services.email_verification import send_verification_email
    sent = await send_verification_email(db, client_id)
    return {"ok": True, "sent": sent}
