from fastapi import APIRouter, Depends
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
