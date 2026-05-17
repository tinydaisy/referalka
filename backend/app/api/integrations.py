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


async def _authorize(
    token: Optional[str],
    client_id: int,
    db: asyncpg.Connection,
) -> None:
    """
    Авторизация запросов от чат-ботов.

    Принимаются два варианта токена:
    1. Per-client `clients.integration_token` — выдаётся клиенту в Настройки → Интеграция.
       В этом случае токен ДОЛЖЕН принадлежать тому же `client_id`,
       что передан в запросе (защита от использования чужого токена).
    2. Глобальный `SALEBOT_SECRET` из окружения — fallback для старых клиентов.
       Постепенно выводим из эксплуатации.
    """
    if not token:
        raise HTTPException(status_code=401, detail="Не передан секретный токен")

    # 1) Per-client токен
    owner_id = await db.fetchval(
        "SELECT id FROM clients WHERE integration_token = $1 AND is_active = TRUE",
        token,
    )
    if owner_id is not None:
        if owner_id != client_id:
            raise HTTPException(
                status_code=403,
                detail="Токен принадлежит другому клиенту. Используйте свой client_id "
                       "из Настройки → Интеграция в кабинете ПЛЮСОН.",
            )
        return

    # 2) Глобальный legacy-токен
    if settings.salebot_secret and token == settings.salebot_secret:
        return

    raise HTTPException(status_code=401, detail="Неверный токен")


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
    await _authorize(token, data.client_id, db)

    # Проверяем что клиент существует (на случай legacy-токена с client_id чужого клиента)
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
    await _authorize(secret, client_id, db)

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


class SalebotSubscriptionRequest(BaseModel):
    """Подписка/отписка контакта на КОНКРЕТНЫЙ бот клиента."""
    client_id: int                          # зашит в настройках Salebot
    platform: str = "telegram"             # 'telegram' | 'vk' | 'max'
    platform_user_id: str                  # tg_id / vk_id / max_id — строкой
    is_subscribed: Union[str, int, bool]   # true = подписался, false = отписался

    # Идентификация канала — один из двух обязателен
    channel_id: Optional[int] = None       # channels.id
    bot_username: Optional[str] = None     # @handle бота — для удобства

    # Опционально — обновить/создать контакт (автомердж по email/phone)
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    salebot_id: Optional[str] = None

    secret: Optional[str] = None           # токен можно передать в теле

    @validator('is_subscribed', pre=True)
    def parse_bool(cls, v):
        if isinstance(v, str):
            return v.strip() in ('1', 'true', 'True')
        return bool(v)


class SalebotSubscriptionResponse(BaseModel):
    ok: bool
    pluson_id: int                          # platform_users.id
    contact_id: int                         # contacts.id
    channel_id: int                         # channels.id (резолвленный)
    is_unsubscribed: bool                   # итоговое состояние


@router.post(
    "/salebot/subscription",
    response_model=SalebotSubscriptionResponse,
    summary="Подписка/отписка контакта на конкретный бот клиента"
)
async def salebot_subscription(
    data: SalebotSubscriptionRequest,
    x_salebot_secret: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db)
):
    # 1. Авторизация
    token = x_salebot_secret or data.secret
    await _authorize(token, data.client_id, db)

    # 2. Резолв канала + проверка что он привязан к этому клиенту
    if not data.channel_id and not data.bot_username:
        raise HTTPException(
            status_code=400,
            detail="Нужно передать channel_id или bot_username"
        )

    if data.channel_id:
        cc_id = await db.fetchval(
            "SELECT id FROM client_channels WHERE client_id = $1 AND channel_id = $2",
            data.client_id, data.channel_id
        )
        if not cc_id:
            raise HTTPException(
                status_code=404,
                detail=f"Канал {data.channel_id} не привязан к клиенту {data.client_id}"
            )
        channel_id = data.channel_id
    else:
        handle = (data.bot_username or "").strip()
        if not handle:
            raise HTTPException(status_code=400, detail="Пустой bot_username")
        if not handle.startswith('@'):
            handle = '@' + handle
        row = await db.fetchrow(
            """SELECT ch.id AS ch_id, cc.id AS cc_id
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1
                  AND ch.platform_slug = $2
                  AND lower(ch.handle) = lower($3)
                ORDER BY cc.is_active DESC, ch.id ASC
                LIMIT 1""",
            data.client_id, data.platform, handle
        )
        if not row:
            raise HTTPException(
                status_code=404,
                detail=f"Бот {handle} не привязан к клиенту {data.client_id} "
                       f"на платформе {data.platform}"
            )
        channel_id = row['ch_id']
        cc_id = row['cc_id']

    # 3. Upsert контакт + идентичность (автомердж по email/phone, как в /register)
    contact_id, pluson_id, _is_new = await upsert_contact_with_identity(
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

    # 4. UPSERT подписки на конкретный канал
    is_unsub = not bool(data.is_subscribed)
    await db.execute(
        """INSERT INTO platform_user_channels
             (platform_user_id, client_channel_id, is_unsubscribed,
              subscribed_at, unsubscribed_at)
           VALUES ($1, $2, $3,
                   CASE WHEN $3 = FALSE THEN NOW() ELSE NULL END,
                   CASE WHEN $3 = TRUE  THEN NOW() ELSE NULL END)
           ON CONFLICT (platform_user_id, client_channel_id) DO UPDATE
             SET is_unsubscribed = EXCLUDED.is_unsubscribed,
                 subscribed_at = CASE
                     WHEN EXCLUDED.is_unsubscribed = FALSE
                     THEN COALESCE(platform_user_channels.subscribed_at, NOW())
                     ELSE platform_user_channels.subscribed_at
                 END,
                 unsubscribed_at = CASE
                     WHEN EXCLUDED.is_unsubscribed = TRUE
                     THEN COALESCE(platform_user_channels.unsubscribed_at, NOW())
                     ELSE NULL
                 END""",
        pluson_id, cc_id, is_unsub
    )

    return {
        "ok": True,
        "pluson_id": pluson_id,
        "contact_id": contact_id,
        "channel_id": channel_id,
        "is_unsubscribed": is_unsub,
    }


@router.get(
    "/salebot/subscription",
    summary="Подписка/отписка через GET (для Salebot без заголовков)"
)
async def salebot_subscription_get(
    client_id: int,
    platform_user_id: str,
    is_subscribed: bool,
    secret: str,
    channel_id: Optional[int] = None,
    bot_username: Optional[str] = None,
    platform: str = "telegram",
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    salebot_id: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db)
):
    request = SalebotSubscriptionRequest(
        client_id=client_id,
        platform=platform,
        platform_user_id=platform_user_id,
        is_subscribed=is_subscribed,
        channel_id=channel_id,
        bot_username=bot_username,
        username=username,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        salebot_id=salebot_id,
        secret=secret,
    )
    return await salebot_subscription(request, secret, db)


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
    await _authorize(x_salebot_secret, client_id, db)

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
