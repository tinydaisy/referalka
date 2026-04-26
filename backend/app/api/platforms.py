"""
API справочника платформ (миграция 036).

Read-only — список доступных платформ с метаданными для UI и валидации.
"""
from fastapi import APIRouter, Depends
from app.database import get_db

router = APIRouter(prefix="/platforms", tags=["Платформы"])


@router.get("")
async def list_platforms(db=Depends(get_db)):
    rows = await db.fetch(
        """SELECT slug, display_name, icon_url, color_hex, id_format,
                  max_message_length, supports_buttons, supports_photo, supports_video,
                  api_base_url, is_active, sort_order
             FROM platforms
            WHERE is_active = TRUE
            ORDER BY sort_order, slug"""
    )
    return {"items": [dict(r) for r in rows]}
