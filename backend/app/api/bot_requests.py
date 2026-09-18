"""
Заявка с сайта: человек описывает, что ему нужно, и уходит в наш бот.

⚠️⚠️ ЭТО ОБЩИЙ МЕХАНИЗМ, а не часть услуг. Тот же сценарий нужен в
автонастройке и в техподдержке: человек пишет текст на сайте → текст оказывается
в боте у нас перед глазами. Отличаются только `kind` и встречающая фраза.
Появится следующее место — добавится значение `kind`, а не второй эндпоинт.

Почему текст не едет прямо в ссылке — разобрано в services/bot_text_request.py:
в `?start=` у Telegram 64 символа и только латиница.
"""
import logging
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.services import bot_text_request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/public/bot-requests", tags=["Заявка в бот"])

# Откуда пришла заявка. ⚠️ Список закрытый: `kind` попадает в базу и в тексты
# бота, произвольные значения оттуда потом не выкорчевать.
KINDS = ("service", "autosetup", "support")


class RequestIn(BaseModel):
    text: str
    kind: str = "service"
    name: Optional[str] = None
    contact: Optional[str] = None      # телефон или почта, если оставил


@router.post("", summary="Сохранить текст заявки и получить ссылки в боты")
async def create_request(
    data: RequestIn,
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает ссылки во все наши боты. Человек выбирает площадку, бот
    встречает его уже с его текстом.

    ⚠️ Ссылки собирает БЭКЕНД, а не фронт: имена параметров у площадок разные
    (`start` у TG и MAX, `ref` у ВК), и знать об этом должно одно место.
    """
    text = (data.text or "").strip()
    if len(text) < 5:
        raise HTTPException(400, "Опишите, что нужно — хотя бы пару слов")

    kind = data.kind if data.kind in KINDS else "service"

    try:
        token = await bot_text_request.save_text(
            db, text=text, kind=kind,
            name=(data.name or "").strip() or None,
            contact_hint=(data.contact or "").strip() or None,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))

    logger.info("bot request saved: kind=%s len=%s", kind, len(text))
    return {"ok": True, "token": token, "platforms": bot_text_request.bot_links(token)}
