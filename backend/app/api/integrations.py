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
from app.services.contact_merge import (
    upsert_contact_with_identity,
    find_or_create_contact,
    name_from_parts,
    resolve_ref_code,
    normalize_phone,
)


def _normalize_phone_for_update(phone: Optional[str]) -> Optional[str]:
    """Возвращает нормализованный phone или None для пустых значений."""
    return normalize_phone(phone)

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
    platform: str = "telegram"             # 'telegram' | 'vk' | 'max' (legacy, для Salebot)
    platform_user_id: Optional[str] = None # tg_id / vk_id / max_id (legacy, для Salebot). Опционально.
    contact_id: Optional[int] = None       # ID контакта в ПЛЮСОНе. Приоритетный способ идентификации для GetCourse/Tilda — Mini App подсовывает в URL стороннего лендинга, форма возвращает через скрытое поле.
    username: Optional[str] = None
    telegram_username: Optional[str] = None # TG-ник из формы (fallback-поиск контакта когда нет ни contact_id, ни platform_user_id)
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    salebot_id: Optional[str] = None
    event_id: Optional[str] = None
    is_registered: Union[str, int, bool] = False
    is_in_chat: Union[str, int, bool] = False
    partner_tg_id: Optional[str] = None    # tg_id рефовода — fallback (старая логика)
    pid: Optional[str] = None              # ref_code партнёра (приоритетнее partner_tg_id)
    external_ref_param: Optional[str] = None # партнёрский код внешней платформы клиента (например "gcpc=fdd97") — обновляет contacts.external_ref_param

    @validator('is_registered', 'is_in_chat', pre=True)
    def parse_bool(cls, v):
        if isinstance(v, str):
            return v.strip() in ('1', 'true', 'True')
        return bool(v)
    secret: Optional[str] = None           # токен можно передать в теле (альтернатива заголовку)


class SalebotRegisterResponse(BaseModel):
    ok: bool
    pluson_id: Optional[int] = None        # platform_users.id (None для web-интеграций без platform_user_id)
    contact_id: Optional[int] = None       # contacts.id
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

    # Создаём/находим контакт. Приоритет идентификации:
    # 1) contact_id (GetCourse/Tilda — Mini App подсунул ID в URL → скрытое поле формы)
    # 2) platform_user_id + platform (Salebot — старая логика)
    # 3) email / phone / telegram_username (fallback — find_or_create)
    pluson_id: Optional[int] = None
    is_new_user = False
    if data.contact_id is not None:
        # Прямой путь: контакт уже известен. Проверяем что он принадлежит этому
        # клиенту, разруливаем merged_into (если контакт мержнут — берём главного).
        row = await db.fetchrow(
            "SELECT id, client_id, merged_into FROM contacts WHERE id = $1",
            data.contact_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail=f"Контакт {data.contact_id} не найден")
        if row["client_id"] != data.client_id:
            raise HTTPException(
                status_code=403,
                detail=f"Контакт {data.contact_id} принадлежит другому клиенту",
            )
        contact_id = row["merged_into"] or row["id"]
        # Обновляем поля контакта (только заполняем пустое + email/phone могут
        # быть обновлены, остальное — COALESCE).
        await db.execute(
            """UPDATE contacts SET
                 name             = COALESCE(name, $2),
                 email            = COALESCE($3, email),
                 email_normalized = COALESCE($4, email_normalized),
                 phone            = COALESCE($5, phone),
                 phone_normalized = COALESCE($6, phone_normalized),
                 salebot_id       = COALESCE(salebot_id, $7),
                 last_contact_at  = NOW(),
                 updated_at       = NOW()
               WHERE id = $1""",
            contact_id,
            name_from_parts(data.first_name, data.last_name),
            data.email, (data.email or '').strip().lower() or None,
            data.phone, _normalize_phone_for_update(data.phone),
            data.salebot_id,
        )
    elif data.platform_user_id:
        # Полный путь: с привязкой к платформенной идентичности
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
            lookup_telegram_username=data.telegram_username,
        )
    else:
        # Веб-интеграция без идентификатора платформы (например, GetCourse-форма
        # в обычном браузере): только find_or_create по email/phone/tg_username.
        contact_id, is_new_user = await find_or_create_contact(
            db,
            client_id=data.client_id,
            name=name_from_parts(data.first_name, data.last_name),
            email=data.email,
            phone=data.phone,
            salebot_id=data.salebot_id,
            lookup_telegram_username=data.telegram_username,
        )

    # UPSERT contacts.external_ref_param — партнёрский параметр внешней
    # платформы клиента типа "gcpc=fdd97". Пишем ТОЛЬКО непустое валидное
    # значение (с ключом и непустым значением справа от `=`). Пустое
    # значение (`""`, `gcpc=`) пропускаем — НЕ обнуляем существующее в БД,
    # чтобы клиент не терял уже сохранённый код при повторной отправке формы
    # без партнёрского хвоста.
    erp = (data.external_ref_param or "").strip()
    if erp and '=' in erp and erp.split('=', 1)[1].strip():
        await db.execute(
            "UPDATE contacts SET external_ref_param = $1, updated_at = NOW() WHERE id = $2",
            erp, contact_id,
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

            # Ищем ref_code рефовода. Приоритет:
            #   1. pid — прямой ref_code (с учётом merged_ref_codes для слитых контактов)
            #   2. partner_tg_id — fallback через TG-идентичность партнёра
            referrer_ref_code = None
            if data.pid:
                referrer_ref_code, _ = await resolve_ref_code(
                    db, data.pid, client_id=data.client_id
                )
            if not referrer_ref_code and data.partner_tg_id:
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

    # Если event_id не передавался — берём ref_code контакта (для веб-интеграций
    # без события — сразу отдаём свежесозданный ref_code партнёра).
    if not ref_code:
        ref_code = await db.fetchval(
            "SELECT ref_code FROM contacts WHERE id = $1", contact_id
        )

    return {
        "ok": 1,
        "pluson_id": pluson_id,
        "contact_id": contact_id,
        "participant_id": str(participant_id or 0),
        "ref_code": ref_code or "",
        "is_new_user": 1 if is_new_user else 0,
        "is_new_participant": 1 if is_new_participant else 0
    }


@router.get(
    "/salebot/register",
    summary="Регистрация через GET (для Salebot/конструкторов без заголовков)"
)
async def salebot_register_get(
    client_id: int,
    secret: str,
    contact_id: Optional[int] = None,
    event_id: Optional[int] = None,
    platform_user_id: Optional[str] = None,
    salebot_id: Optional[str] = None,
    username: Optional[str] = None,
    telegram_username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    is_registered: bool = False,
    is_in_chat: bool = False,
    platform: str = "telegram",
    partner_tg_id: Optional[str] = None,
    pid: Optional[str] = None,
    external_ref_param: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db)
):
    await _authorize(secret, client_id, db)

    request = SalebotRegisterRequest(
        client_id=client_id,
        platform=platform,
        platform_user_id=platform_user_id,
        contact_id=contact_id,
        username=username,
        telegram_username=telegram_username,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        salebot_id=salebot_id,
        event_id=str(event_id) if event_id is not None else None,
        is_registered=is_registered,
        is_in_chat=is_in_chat,
        partner_tg_id=partner_tg_id,
        pid=pid,
        external_ref_param=external_ref_param,
        secret=secret,
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
