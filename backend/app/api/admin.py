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

    clients = await db.fetch(
        f"""
        SELECT c.id, c.name, c.email, c.phone, c.telegram_username,
               c.tariff_slug, c.trial_ends_at, c.is_active, c.created_at,
               COUNT(DISTINCT e.id) as events_count
        FROM clients c
        LEFT JOIN events e ON e.client_id = c.id
        WHERE {where}
        GROUP BY c.id
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
