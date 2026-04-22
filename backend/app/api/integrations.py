from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, validator
from typing import Optional, Union
import asyncpg
import secrets
import string

from app.database import get_db
from app.config import settings

router = APIRouter(prefix="/integrations", tags=["Интеграции"])


def clean_username(username: Optional[str]) -> Optional[str]:
    if username is None:
        return None
    return username.lstrip('@') or None


def generate_ref_code() -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


async def get_unique_ref_code(db: asyncpg.Connection) -> str:
    for _ in range(10):
        code = generate_ref_code()
        exists = await db.fetchval(
            "SELECT 1 FROM platform_users WHERE ref_code = $1 UNION SELECT 1 FROM event_participants WHERE ref_code = $1",
            code, code
        )
        if not exists:
            return code
    raise HTTPException(status_code=500, detail="Не удалось сгенерировать уникальный ref_code")


class SalebotRegisterRequest(BaseModel):
    client_id: int                          # зашит в настройках Salebot
    platform: str = "telegram"             # 'telegram' | 'max'
    platform_user_id: str                  # tg_id или max_id — строкой
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
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

    # Upsert platform_users
    # Ищем по (client_id, platform, platform_user_id) — уникальный ключ
    existing_user = await db.fetchrow(
        """
        SELECT id FROM platform_users
        WHERE client_id = $1 AND platform = $2 AND platform_user_id = $3
        """,
        data.client_id, data.platform, data.platform_user_id
    )

    is_new_user = existing_user is None

    if is_new_user:
        new_ref_code = await get_unique_ref_code(db)
        pluson_id = await db.fetchval(
            """
            INSERT INTO platform_users
              (client_id, platform, platform_user_id, username, first_name, last_name, salebot_id, ref_code)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id
            """,
            data.client_id, data.platform, data.platform_user_id,
            clean_username(data.username), data.first_name, data.last_name, data.salebot_id, new_ref_code
        )
    else:
        pluson_id = existing_user["id"]
        # Обновляем данные (имя могло поменяться, salebot_id мог появиться)
        await db.execute(
            """
            UPDATE platform_users SET
              username   = COALESCE($1, username),
              first_name = COALESCE($2, first_name),
              last_name  = COALESCE($3, last_name),
              salebot_id = COALESCE($4, salebot_id),
              updated_at = NOW()
            WHERE id = $5
            """,
            clean_username(data.username), data.first_name, data.last_name, data.salebot_id, pluson_id
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
            """
            SELECT id, ref_code FROM event_participants
            WHERE event_id = $1 AND platform_user_id = $2
            """,
            event_id_int, pluson_id
        )

        if existing_participant:
            participant_id = existing_participant["id"]
            ref_code = existing_participant["ref_code"]
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
            # Берём ref_code из platform_users — он уже сгенерирован там
            ref_code = await db.fetchval(
                "SELECT ref_code FROM platform_users WHERE id = $1", pluson_id
            )
            if not ref_code:
                ref_code = await get_unique_ref_code(db)

            # Ищем ref_code рефовода по partner_tg_id
            referrer_ref_code = None
            if data.partner_tg_id:
                # 1) Среди спикеров/коллабораторов этого события
                referrer_ref_code = await db.fetchval(
                    """
                    SELECT cse.ref_code FROM conf_speaker_events cse
                    JOIN collaborators c ON c.id = cse.speaker_id
                    WHERE c.personal_tg_id = $1 AND cse.event_id = $2
                    """,
                    str(data.partner_tg_id), event_id_int
                )
                # 2) Иначе среди участников события
                if not referrer_ref_code:
                    referrer_ref_code = await db.fetchval(
                        """
                        SELECT ep.ref_code FROM event_participants ep
                        JOIN platform_users pu ON pu.id = ep.platform_user_id
                        WHERE pu.platform_user_id = $1 AND ep.event_id = $2
                        """,
                        str(data.partner_tg_id), event_id_int
                    )

            participant_id = await db.fetchval(
                """
                INSERT INTO event_participants
                  (event_id, platform_user_id, ref_code, is_registered, is_in_chat, registered_at, referrer_ref_code)
                VALUES ($1, $2, $3, $4, $5, NOW(), $6)
                RETURNING id
                """,
                event_id_int, pluson_id, ref_code, data.is_registered, data.is_in_chat, referrer_ref_code
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
               pu.salebot_id, pu.created_at,
               ep.id as participant_id, ep.event_id, ep.ref_code, ep.is_registered, ep.is_in_chat
        FROM platform_users pu
        LEFT JOIN event_participants ep ON ep.platform_user_id = pu.id
        WHERE pu.client_id = $1 AND pu.platform = $2 AND pu.platform_user_id = $3
        """,
        client_id, platform, platform_user_id
    )
    if not user:
        raise HTTPException(status_code=404, detail="Участник не найден")

    return dict(user)
