from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from typing import Optional
from app.auth import get_current_admin, hash_password
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/admin", tags=["Администратор"])


# ─── Статистика ───────────────────────────────────────────────────────────────

@router.get("/stats", summary="Общая статистика платформы")
async def platform_stats(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    stats = await db.fetchrow(
        """
        SELECT
          (SELECT COUNT(*) FROM clients WHERE is_active = TRUE) as clients_total,
          (SELECT COUNT(*) FROM events) as events_total,
          (SELECT COUNT(*) FROM events WHERE status = 'published') as events_active,
          (SELECT COUNT(*) FROM event_participants) as participants_total,
          (SELECT COUNT(*) FROM referral_events WHERE type IN ('free','paid')) as conversions_total
        """
    )
    return dict(stats)


# ─── Клиенты ──────────────────────────────────────────────────────────────────

@router.get("/clients", summary="Список клиентов")
async def list_clients(
    search: Optional[str] = None,
    tariff: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    conditions = ["1=1"]
    params = []

    if search:
        params.append(f"%{search}%")
        conditions.append(f"(c.name ILIKE ${len(params)} OR c.email ILIKE ${len(params)})")

    if tariff:
        params.append(tariff)
        conditions.append(f"c.tariff_slug = ${len(params)}")

    where = " AND ".join(conditions)
    params.extend([limit, offset])

    # Расширенные колонки: тариф, флаг allow_custom_bot, число событий,
    # число своих не-системных каналов, число подписчиков (через client_channels),
    # число отписавшихся, число коллабораторов.
    clients = await db.fetch(
        f"""
        SELECT
          c.id, c.name, c.email, c.phone, c.telegram_username,
          c.tariff_slug, c.trial_ends_at, c.is_active, c.created_at,
          t.name AS tariff_name,
          COALESCE(t.allow_custom_bot, FALSE) AS allow_custom_bot,
          (SELECT COUNT(*) FROM events e WHERE e.client_id = c.id) AS events_count,
          (SELECT COUNT(*) FROM contacts ct WHERE ct.client_id = c.id AND ct.is_active = TRUE) AS contacts_count,
          (SELECT COUNT(*) FROM client_channels cc
            JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = c.id AND ch.is_system = FALSE) AS own_channels_count,
          (SELECT COUNT(*) FROM platform_user_channels puc
             JOIN client_channels cc ON cc.id = puc.client_channel_id
            WHERE cc.client_id = c.id AND puc.is_unsubscribed = FALSE) AS subscribers_count,
          (SELECT COUNT(*) FROM platform_user_channels puc
             JOIN client_channels cc ON cc.id = puc.client_channel_id
            WHERE cc.client_id = c.id AND puc.is_unsubscribed = TRUE) AS unsubscribed_count,
          (SELECT COUNT(*) FROM collaborators co
            JOIN contacts ct ON ct.id = co.contact_id
            WHERE ct.client_id = c.id) AS collaborators_count
        FROM clients c
        LEFT JOIN tariffs t ON t.slug = c.tariff_slug
        WHERE {where}
        ORDER BY c.created_at DESC
        LIMIT ${len(params)-1} OFFSET ${len(params)}
        """,
        *params
    )
    total = await db.fetchval(f"SELECT COUNT(*) FROM clients c WHERE {where}", *params[:-2])
    return {"clients": [dict(c) for c in clients], "total": total}


@router.get("/clients/{client_id}", summary="Клиент по ID")
async def get_client(
    client_id: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    client = await db.fetchrow(
        """
        SELECT c.*, COUNT(DISTINCT e.id) as events_count
        FROM clients c
        LEFT JOIN events e ON e.client_id = c.id
        WHERE c.id = $1
        GROUP BY c.id
        """,
        client_id
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return {"client": dict(client)}


@router.patch("/clients/{client_id}", summary="Обновить клиента")
async def update_client(
    client_id: int,
    is_active: Optional[bool] = None,
    tariff_slug: Optional[str] = None,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    if is_active is not None:
        await db.execute("UPDATE clients SET is_active = $1 WHERE id = $2", is_active, client_id)
    if tariff_slug:
        await db.execute("UPDATE clients SET tariff_slug = $1 WHERE id = $2", tariff_slug, client_id)
    return {"message": "Обновлено"}


# ─── Партнёры ─────────────────────────────────────────────────────────────────

class PartnerCreate(BaseModel):
    name: str
    partner_code: str
    percent: float = 0
    contact: Optional[str] = None
    notes: Optional[str] = None


@router.get("/partners", summary="Список партнёров")
async def list_partners(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    partners = await db.fetch(
        """
        SELECT p.*, COUNT(c.id) as clients_count
        FROM partners p
        LEFT JOIN clients c ON c.partner_code = p.partner_code
        GROUP BY p.id
        ORDER BY p.created_at DESC
        """
    )
    return {"partners": [dict(p) for p in partners]}


@router.post("/partners", summary="Создать партнёра")
async def create_partner(
    data: PartnerCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    existing = await db.fetchrow("SELECT id FROM partners WHERE partner_code = $1", data.partner_code)
    if existing:
        raise HTTPException(status_code=409, detail="Такой код уже существует")

    partner = await db.fetchrow(
        """
        INSERT INTO partners (name, partner_code, percent, contact, notes)
        VALUES ($1,$2,$3,$4,$5) RETURNING *
        """,
        data.name, data.partner_code.upper(), data.percent, data.contact, data.notes
    )
    return {"partner": dict(partner)}


# ─── Тарифы ───────────────────────────────────────────────────────────────────

class TariffCreate(BaseModel):
    slug: str
    name: str
    price: float = 0
    trial_months: int = 0
    max_events: int = -1
    max_participants: int = -1


@router.get("/tariffs", summary="Список тарифов")
async def list_tariffs(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    tariffs = await db.fetch("SELECT * FROM tariffs ORDER BY price")
    return {"tariffs": [dict(t) for t in tariffs]}


@router.post("/tariffs", summary="Создать тариф")
async def create_tariff(
    data: TariffCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    tariff = await db.fetchrow(
        """
        INSERT INTO tariffs (slug, name, price, trial_months, max_events, max_participants)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
        """,
        data.slug, data.name, data.price, data.trial_months, data.max_events, data.max_participants
    )
    return {"tariff": dict(tariff)}


# ─── Создание администратора (только суперадмин) ──────────────────────────────

class AdminCreate(BaseModel):
    name: str
    email: EmailStr
    password: str
    is_superadmin: bool = False


@router.post("/admins", summary="Создать администратора")
async def create_admin(
    data: AdminCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    if not admin.get("is_superadmin"):
        raise HTTPException(status_code=403, detail="Только суперадмин может создавать администраторов")
    pw_hash = hash_password(data.password)
    new_admin = await db.fetchrow(
        "INSERT INTO admins (name, email, password_hash, is_superadmin) VALUES ($1,$2,$3,$4) RETURNING id, name, email",
        data.name, data.email, pw_hash, data.is_superadmin
    )
    return {"admin": dict(new_admin)}



# ═════════════════════════════════════════════════════════════════════════
# Системные каналы — общие @pluson_bot, MAX, VK для всех клиентов сервиса
# Архитектура G: channels.is_system=TRUE, доступ через client_channels.
# ═════════════════════════════════════════════════════════════════════════

class SystemChannelCreate(BaseModel):
    platform_slug: str          # 'telegram' | 'vk' | 'max'
    display_name: str
    handle: Optional[str] = None
    bot_token: Optional[str] = None  # для telegram


class SystemChannelUpdate(BaseModel):
    display_name: Optional[str] = None
    handle: Optional[str] = None
    bot_token: Optional[str] = None  # менять только в is_test и без подписчиков
    is_test: Optional[bool] = None   # FALSE = выпустить в бой → backfill всем клиентам


@router.get("/system-channels", summary="Список системных каналов с метриками")
async def list_system_channels(
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Системные каналы (общие для всех клиентов).

    Для каждого: общее число подписок (по всем клиентам), отписавшихся,
    и кол-во клиентов которым он подключён через client_channels.
    """
    rows = await db.fetch("""
        SELECT ch.id, ch.platform_slug, ch.display_name, ch.handle,
               ch.is_system, ch.is_test, ch.created_at, ch.updated_at,
               (SELECT COUNT(DISTINCT cc.client_id) FROM client_channels cc
                 WHERE cc.channel_id = ch.id) AS clients_attached,
               (SELECT COUNT(*) FROM platform_user_channels puc
                  JOIN client_channels cc ON cc.id = puc.client_channel_id
                 WHERE cc.channel_id = ch.id AND puc.is_unsubscribed = FALSE) AS subscribers,
               (SELECT COUNT(*) FROM platform_user_channels puc
                  JOIN client_channels cc ON cc.id = puc.client_channel_id
                 WHERE cc.channel_id = ch.id AND puc.is_unsubscribed = TRUE) AS unsubscribed
          FROM channels ch
         WHERE ch.is_system = TRUE
         ORDER BY ch.platform_slug, ch.id
    """)
    return {"items": [dict(r) for r in rows]}


@router.post("/system-channels", summary="Создать системный канал (в тестовом режиме)")
async def create_system_channel(
    data: SystemChannelCreate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Создаёт is_system=TRUE, is_test=TRUE канал. Клиенты его пока НЕ видят
    (записи в client_channels не создаются). Для выпуска в бой — PATCH с is_test=FALSE."""
    platform_exists = await db.fetchval(
        "SELECT 1 FROM platforms WHERE slug = $1 AND is_active = TRUE", data.platform_slug
    )
    if not platform_exists:
        raise HTTPException(status_code=400, detail="Неизвестная платформа")
    new_id = await db.fetchval(
        """INSERT INTO channels (platform_slug, display_name, handle, bot_token, is_system, is_test)
           VALUES ($1, $2, $3, $4, TRUE, TRUE) RETURNING id""",
        data.platform_slug, data.display_name, data.handle, data.bot_token
    )
    return {"id": new_id, "ok": True}


@router.patch("/system-channels/{channel_id}", summary="Обновить системный канал / выпустить в бой")
async def update_system_channel(
    channel_id: int,
    data: SystemChannelUpdate,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Логика:
      - is_test=FALSE (выпуск в бой): backfill client_channels для всех клиентов.
        Обратно (FALSE→TRUE) — только если 0 подписок (иначе 409).
      - bot_token: менять только в is_test=TRUE без подписок (иначе 409).
      - display_name/handle: можно менять всегда.
    """
    current = await db.fetchrow(
        "SELECT id, is_system, is_test, bot_token FROM channels WHERE id = $1",
        channel_id
    )
    if not current or not current["is_system"]:
        raise HTTPException(status_code=404, detail="Системный канал не найден")

    has_subs = await db.fetchval(
        """SELECT COUNT(*) FROM platform_user_channels puc
           JOIN client_channels cc ON cc.id = puc.client_channel_id
          WHERE cc.channel_id = $1""",
        channel_id
    )

    # Запрет смены токена при наличии подписок
    if data.bot_token is not None and data.bot_token != (current["bot_token"] or ""):
        if has_subs and has_subs > 0:
            raise HTTPException(
                status_code=409,
                detail=f"У канала {has_subs} подписок — токен менять нельзя (потеряете базу)."
            )

    # Запрет возврата в тест при наличии подписок
    if data.is_test is True and current["is_test"] is False:
        if has_subs and has_subs > 0:
            raise HTTPException(
                status_code=409,
                detail=f"Канал в бою с {has_subs} подписками — вернуть в тест нельзя."
            )

    upd, params = [], []
    if data.display_name is not None:
        params.append(data.display_name); upd.append(f"display_name=${len(params)}")
    if data.handle is not None:
        params.append(data.handle); upd.append(f"handle=${len(params)}")
    if data.bot_token is not None:
        params.append(data.bot_token); upd.append(f"bot_token=${len(params)}")
    if data.is_test is not None:
        params.append(data.is_test); upd.append(f"is_test=${len(params)}")

    async with db.transaction():
        if upd:
            params.append(channel_id)
            await db.execute(
                f"UPDATE channels SET {', '.join(upd)}, updated_at=NOW() WHERE id=${len(params)}",
                *params
            )
        # Если выпустили в бой → backfill client_channels всем клиентам (кроме тех у кого уже есть)
        if data.is_test is False and current["is_test"] is True:
            await db.execute(
                """INSERT INTO client_channels (client_id, channel_id, is_active)
                   SELECT c.id, $1,
                     -- активным делаем если у клиента нет других активных каналов на этой платформе
                     NOT EXISTS (
                       SELECT 1 FROM client_channels cc2
                         JOIN channels ch2 ON ch2.id = cc2.channel_id
                        WHERE cc2.client_id = c.id
                          AND ch2.platform_slug = (SELECT platform_slug FROM channels WHERE id = $1)
                          AND cc2.is_active = TRUE
                     )
                     FROM clients c WHERE c.is_active = TRUE
                   ON CONFLICT (client_id, channel_id) DO NOTHING""",
                channel_id
            )
    return {"ok": True}


@router.delete("/system-channels/{channel_id}", summary="Удалить системный канал (только без подписок)")
async def delete_system_channel(
    channel_id: int,
    admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db)
):
    """Удалить можно только канал без подписок (даже отписавшихся)."""
    current = await db.fetchrow(
        "SELECT id, is_system FROM channels WHERE id = $1",
        channel_id
    )
    if not current or not current["is_system"]:
        raise HTTPException(status_code=404, detail="Системный канал не найден")
    has_subs = await db.fetchval(
        """SELECT COUNT(*) FROM platform_user_channels puc
           JOIN client_channels cc ON cc.id = puc.client_channel_id
          WHERE cc.channel_id = $1""",
        channel_id
    )
    if has_subs and has_subs > 0:
        raise HTTPException(
            status_code=409,
            detail=f"У канала {has_subs} подписок — удалять нельзя. Сначала миграция/чистка."
        )
    async with db.transaction():
        await db.execute("DELETE FROM client_channels WHERE channel_id = $1", channel_id)
        await db.execute("DELETE FROM channels WHERE id = $1", channel_id)
    return {"ok": True}
