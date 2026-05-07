"""
Telegram-утилиты — общие endpoint'ы для разрешения @username канала в chat_id.

Используются на фронте кнопкой «Получить ID автоматически» в:
  - визитке основателя (`/dashboard/mini-app`)
  - карточке коллаборатора (`/dashboard/collaborators/{id}`)
  - блоке «Чат события» в карточках мероприятия и конференции

Endpoint только резолвит — не сохраняет. Сохранение делает соответствующий
PATCH ресурса (профиль клиента / коллаборатор / событие).
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.config import settings
from app.services.social_links import telegram_api_id, normalize_telegram_link

router = APIRouter(prefix="/utils", tags=["TG-утилиты"])


class ResolveIn(BaseModel):
    username: Optional[str] = None  # @foo / foo / https://t.me/foo
    url: Optional[str] = None       # альтернативно — полный URL канала


@router.post("/resolve-tg-chat-id", summary="Резолвит @username канала в числовой chat_id через Bot API")
async def resolve_tg_chat_id(
    payload: ResolveIn,
    client=Depends(get_current_client),
):
    """Возвращает `{chat_id, username}`. Сохранение — на стороне клиента
    через PATCH соответствующего ресурса. Для **закрытых** каналов с
    инвайт-ссылкой (без публичного @username) Bot API не умеет резолвить —
    отдаём 400 с понятным сообщением.
    """
    api_id = ""
    if payload.username and payload.username.strip():
        u = payload.username.strip().lstrip("@")
        u = u.split("/")[-1]
        if u:
            api_id = f"@{u}"
    elif payload.url and payload.url.strip():
        api_id = telegram_api_id(payload.url)
    if not api_id:
        raise HTTPException(
            status_code=400,
            detail=("У канала нет публичного @username (закрытый по инвайт-ссылке). "
                    "Введите ID руками — инструкция в Тех.поддержке."),
        )
    token = settings.telegram_bot_token
    if not token:
        raise HTTPException(status_code=500, detail="Bot token не настроен")
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": api_id},
            )
            data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Не дозвонились до Telegram: {e}")
    if not data.get("ok"):
        desc = data.get("description", "unknown")
        raise HTTPException(status_code=400, detail=f"Telegram отказал: {desc}")
    chat_id = data["result"].get("id")
    if not chat_id:
        raise HTTPException(status_code=502, detail="getChat не вернул id")
    return {"chat_id": chat_id, "username": api_id}
