from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from app.database import get_db
from app.services.referral_engine import process_conversion
import asyncpg

router = APIRouter(tags=["Реферальные ссылки"])


class ConversionRequest(BaseModel):
    event_slug: str
    ref_code: str
    type: str   # 'free' | 'paid'
    visitor_tg_id: int | None = None


@router.get("/r/{ref_code}", summary="Переход по реферальной ссылке")
async def referral_redirect(ref_code: str, db: asyncpg.Connection = Depends(get_db)):
    """
    1. Логирует click в referral_events
    2. Редиректит на landing_url события
    """
    # Ищем участника по ref_code (через platform_users — единственный источник)
    participant = await db.fetchrow(
        """
        SELECT ep.id, ep.event_id, e.landing_url, e.slug
        FROM platform_users pu
        JOIN event_participants ep ON ep.platform_user_id = pu.id
        JOIN events e ON e.id = ep.event_id
        WHERE pu.ref_code = $1
        ORDER BY ep.registered_at DESC
        LIMIT 1
        """,
        ref_code
    )

    if not participant:
        return RedirectResponse(url="https://plusson.app")

    # Логируем клик
    await db.execute(
        """
        INSERT INTO referral_events (event_id, ref_code, type, points_awarded)
        VALUES ($1, $2, 'click', 0)
        """,
        participant["event_id"], ref_code
    )

    landing = participant["landing_url"] or "https://plusson.app"
    return RedirectResponse(url=landing)


@router.post("/api/v1/referral/conversion", summary="Вебхук конверсии от внешнего лендинга")
async def register_conversion(
    data: ConversionRequest,
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Вызывается внешним лендингом (GetCourse, Tilda) после регистрации/оплаты.
    """
    result = await process_conversion(data.ref_code, data.type, data.visitor_tg_id, db)
    return result
