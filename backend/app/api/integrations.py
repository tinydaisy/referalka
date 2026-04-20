from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from typing import Optional
import asyncpg
import secrets
import string

from app.database import get_db
from app.config import settings

router = APIRouter(prefix="/integrations", tags=["Интеграции"])


def generate_ref_code() -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


async def get_unique_ref_code(db: asyncpg.Connection) -> str:
    for _ in range(10):
        code = generate_ref_code()
        exists = await db.fetchval(
            "SELECT 1 FROM event_participants WHERE ref_code = $1", code
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
    status: str = "interested"             # 'interested' | 'registered' | 'in_chat'
    partner_tg_id: Optional[str] = None    # tg_id рефовода (спикер или участник) — ищем его ref_code
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
        pluson_id = await db.fetchval(
            """
            INSERT INTO platform_users
              (client_id, platform, platform_user_id, username, first_name, last_name, salebot_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            """,
            data.client_id, data.platform, data.platform_user_id,
            data.username, data.first_name, data.last_name, data.salebot_id
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
            data.username, data.first_name, data.last_name, data.salebot_id, pluson_id
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
            # Обновляем статус только если он "выше" текущего
            status_order = {"interested": 1, "registered": 2, "in_chat": 3}
            current_status = await db.fetchval(
                "SELECT status FROM event_participants WHERE id = $1", participant_id
            )
            if status_order.get(data.status, 0) > status_order.get(current_status, 0):
                await db.execute(
                    "UPDATE event_participants SET status = $1 WHERE id = $2",
                    data.status, participant_id
                )
        else:
            is_new_participant = True
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
                  (event_id, platform_user_id, ref_code, status, registered_at, referrer_ref_code)
                VALUES ($1, $2, $3, $4, NOW(), $5)
                RETURNING id
                """,
                event_id_int, pluson_id, ref_code, data.status, referrer_ref_code
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
    status: str = "interested",
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
        status=status,
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
               ep.id as participant_id, ep.event_id, ep.ref_code, ep.status
        FROM platform_users pu
        LEFT JOIN event_participants ep ON ep.platform_user_id = pu.id
        WHERE pu.client_id = $1 AND pu.platform = $2 AND pu.platform_user_id = $3
        """,
        client_id, platform, platform_user_id
    )
    if not user:
        raise HTTPException(status_code=404, detail="Участник не найден")

    return dict(user)
