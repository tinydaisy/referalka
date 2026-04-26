"""
API интеграции с Salebot (миграция 036+).

Использует helper `upsert_contact_with_identity` — автомердж по email/phone
при импорте Salebot.
"""
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, validator
from typing import Optional, Union
import asyncpg

from app.database import get_db
from app.config import settings
from app.services.contact_merge import upsert_contact_with_identity

router = APIRouter(prefix="/integrations", tags=["Интеграции"])


class SalebotRegisterRequest(BaseModel):
    client_id: int                          # зашит в настройках Salebot
    platform: str = "telegram"             # 'telegram' | 'vk' | 'max'
    platform_user_id: str                  # tg_id / vk_id / max_id — строкой
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    salebot_id: Optional[str] = None
    event_id: Optional[str] = None         # зашит в настройках Salebot (опционально, строка или число)
    is_registered: Union[str, int, bool] = False
    is_in_chat: Union[str, int, bool] = False
    partner_tg_id: Optional[str] = None    # tg_id рефовода (спикер или участник) — ищем его ref_code

    @validator('is_registered', 'is_in_chat', pre=True)
    def parse_bool(cls, v):
        if isinstance(v, str):
            return v.strip() in ('1', 'true', 'True')
        return bool(v)
    secret: Optional[str] = None           # токен можно передать в теле (альтернатива заголовку)


class SalebotRegisterResponse(BaseModel):
    ok: bool
    pluson_id: int                          # platform_users.id
    participant_id: Optional[int] = None   # event_participants.id (если event_id передан)
    ref_code: Optional[str] = None
    is_new_user: bool
    is_new_participant: bool


@router.post(
    "/salebot/register",
    response_model=SalebotRegisterResponse,
    summary="Регистрация/обновление участника из Salebot"
)
async def salebot_register(
    data: SalebotRegisterRequest,
    x_salebot_secret: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db)
):
    # Проверка секретного токена (заголовок или тело)
    token = x_salebot_secret or data.secret
    if settings.salebot_secret and token != settings.salebot_secret:
        raise HTTPException(status_code=401, detail="Неверный токен")

    # Проверяем что клиент существует
    client = await db.fetchrow(
        "SELECT id FROM clients WHERE id = $1 AND is_active = TRUE", data.client_id
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")

    # Создаём/находим контакт + идентичность (автомердж по email/phone)
    contact_id, pluson_id, is_new_user = await upsert_contact_with_identity(
        db,
        client_id=data.client_id,
        platform_slug=data.platform,
        platform_user_id=data.platform_user_id,
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
        email=data.email,
        phone=data.phone,
        salebot_id=data.salebot_id,
    )

    # Если event_id передан — upsert event_participants
    participant_id = None
    ref_code = None
    is_new_participant = False

    if data.event_id:
        event_id_int = int(data.event_id)
        # Проверяем событие принадлежит этому клиенту
        event = await db.fetchrow(
            "SELECT id FROM events WHERE id = $1 AND client_id = $2",
            event_id_int, data.client_id
        )
        if not event:
            raise HTTPException(status_code=404, detail="Событие не найдено у этого клиента")

        existing_participant = await db.fetchrow(
            "SELECT id FROM event_participants WHERE event_id = $1 AND contact_id = $2",
            event_id_int, contact_id
        )

        # Реф-код берём из contacts — единственный источник
        ref_code = await db.fetchval(
            "SELECT ref_code FROM contacts WHERE id = $1", contact_id
        )

        if existing_participant:
            participant_id = existing_participant["id"]
            # Обновляем булевы поля (только в сторону TRUE, назад не откатываем)
            if data.is_registered or data.is_in_chat:
                await db.execute(
                    """
                    UPDATE event_participants SET
                      is_registered = is_registered OR $1,
                      is_in_chat    = is_in_chat    OR $2
                    WHERE id = $3
                    """,
                    data.is_registered, data.is_in_chat, participant_id
                )
        else:
            is_new_participant = True

            # Ищем ref_code рефовода по partner_tg_id (через platform_users → contacts)
            referrer_ref_code = None
            if data.partner_tg_id:
                referrer_ref_code = await db.fetchval(
                    """
                    SELECT c.ref_code FROM platform_users pu
                    JOIN contacts c ON c.id = pu.contact_id
                    WHERE pu.client_id = $1 AND pu.platform_slug = 'telegram'
                      AND pu.platform_user_id = $2
                    """,
                    data.client_id, str(data.partner_tg_id)
                )

            participant_id = await db.fetchval(
                """
                INSERT INTO event_participants
                  (event_id, contact_id, is_registered, is_in_chat, registered_at, referrer_ref_code)
                VALUES ($1, $2, $3, $4, NOW(), $5)
                RETURNING id
                """,
                event_id_int, contact_id, data.is_registered, data.is_in_chat, referrer_ref_code
            )

    return {
        "ok": 1,
        "pluson_id": str(pluson_id),
        "participant_id": str(participant_id or 0),
        "ref_code": ref_code or "",
        "is_new_user": 1 if is_new_user else 0,
        "is_new_participant": 1 if is_new_participant else 0
    }


@router.get(
    "/salebot/register",
    summary="Регистрация через GET (для Salebot без заголовков)"
)
async def salebot_register_get(
    client_id: int,
    platform_user_id: str,
    event_id: int,
    secret: str,
    salebot_id: Optional[str] = None,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    is_registered: bool = False,
    is_in_chat: bool = False,
    platform: str = "telegram",
    db: asyncpg.Connection = Depends(get_db)
):
    if settings.salebot_secret and secret != settings.salebot_secret:
        raise HTTPException(status_code=401, detail="Неверный токен")

    request = SalebotRegisterRequest(
        client_id=client_id,
        platform=platform,
        platform_user_id=platform_user_id,
        username=username,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        salebot_id=salebot_id,
        event_id=str(event_id),
        is_registered=is_registered,
        is_in_chat=is_in_chat,
        secret=secret
    )
    return await salebot_register(request, secret, db)


@router.get(
    "/salebot/user",
    summary="Получить данные участника по platform_user_id"
)
async def salebot_get_user(
    client_id: int,
    platform_user_id: str,
    platform: str = "telegram",
    x_salebot_secret: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db)
):
    if settings.salebot_secret and x_salebot_secret != settings.salebot_secret:
        raise HTTPException(status_code=401, detail="Неверный токен")

    user = await db.fetchrow(
        """
        SELECT pu.id as pluson_id, pu.username, pu.first_name, pu.last_name,
               c.salebot_id, pu.created_at, c.ref_code,
               ep.id as participant_id, ep.event_id, ep.is_registered, ep.is_in_chat
        FROM platform_users pu
        JOIN contacts c ON c.id = pu.contact_id
        LEFT JOIN event_participants ep ON ep.contact_id = c.id
        WHERE pu.client_id = $1 AND pu.platform_slug = $2 AND pu.platform_user_id = $3
        """,
        client_id, platform, platform_user_id
    )
    if not user:
        raise HTTPException(status_code=404, detail="Участник не найден")

    return dict(user)
