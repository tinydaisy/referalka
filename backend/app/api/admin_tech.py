"""Управление тех-специалистами — админская часть (миграция 391).

Заведение людей, ставки, распределение клиентов, отметка выплат.

⚠️ Всё под `get_current_admin`: это деньги и чужие клиенты. Сам специалист сюда
не ходит — у него свой кабинет (`tech_cabinet.py`).
"""

from __future__ import annotations

import secrets
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_current_admin, hash_password
from app.database import get_db
from app.services.tech_accruals import assign_client

router = APIRouter(prefix="/admin/tech", tags=["Админ: тех-специалисты"])

# Алфавит без 0/O/o/1/l/I — те же правила, что у паролей помощников: пароль
# диктуют голосом, и похожие символы читаются неверно.
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"


def _password(length: int = 12) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


class SpecIn(BaseModel):
    email: str
    name: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    can_edit_materials: Optional[bool] = None
    is_active: Optional[bool] = None


class AssignIn(BaseModel):
    client_id: int
    # None = снять закрепление (клиент становится ничьим).
    spec_id: Optional[int] = None
    reason: Optional[str] = None


@router.get("/specialists", summary="Список тех-специалистов")
async def list_specs(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Кто есть и сколько на ком висит.

    ⚠️ Считаем и клиентов, и НЕВЫПЛАЧЕННОЕ: это две цифры, ради которых сюда
    заходят. Без второй пришлось бы открывать каждого по очереди.
    """
    rows = await db.fetch(
        """SELECT ts.id, ts.email, ts.name, ts.phone, ts.telegram_username,
                  ts.can_edit_materials, ts.is_active, ts.last_login_at, ts.created_at,
                  (SELECT COUNT(*) FROM clients c
                    WHERE c.tech_specialist_id = ts.id) AS clients_count,
                  (SELECT COUNT(*) FROM clients c
                    WHERE c.tech_specialist_id = ts.id
                      AND EXISTS (SELECT 1 FROM client_subscriptions cs
                                   WHERE cs.id = c.current_subscription_id
                                     AND cs.status='active' AND cs.expires_at > NOW()
                                     AND cs.source='paid')) AS paying_count,
                  (SELECT COALESCE(SUM(a.amount_kopecks),0) FROM tech_accruals a
                    WHERE a.spec_id = ts.id AND a.paid_at IS NULL) AS unpaid_kopecks
             FROM tech_specialists ts
            ORDER BY ts.is_active DESC, ts.name, ts.id"""
    )
    return {"specialists": [dict(r) for r in rows]}


@router.post("/specialists", summary="Завести тех-специалиста")
async def create_spec(
    data: SpecIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Создаёт человека и отдаёт пароль ОДИН РАЗ.

    ⚠️ Пароль показывается admin'у, а не уходит письмом: у специалиста может не
    быть почты на нашем домене, а завести его надо сейчас. Забыли — сбросить.
    """
    email = (data.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Укажите почту")
    if await db.fetchval("SELECT 1 FROM tech_specialists WHERE LOWER(email)=$1", email):
        raise HTTPException(409, "Такой тех-специалист уже есть")

    pwd = _password()
    row = await db.fetchrow(
        """INSERT INTO tech_specialists
             (email, password_hash, name, phone, telegram_username, can_edit_materials)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6, FALSE))
           RETURNING id, email, name""",
        email, hash_password(pwd), data.name, data.phone,
        data.telegram_username, data.can_edit_materials,
    )
    return {**dict(row), "password": pwd}


@router.patch("/specialists/{spec_id}", summary="Изменить тех-специалиста")
async def update_spec(
    spec_id: int,
    data: SpecIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    # ⚠️ Пишем только присланное: форма может слать часть полей, и не
    # присланное должно остаться прежним, а не обнулиться.
    fs = data.model_fields_set
    sets, args = [], []
    for col in ("name", "phone", "telegram_username", "can_edit_materials", "is_active"):
        if col in fs:
            args.append(getattr(data, col))
            sets.append(f"{col} = ${len(args)}")
    if not sets:
        raise HTTPException(400, "Нечего менять")
    args.append(spec_id)
    row = await db.fetchrow(
        f"UPDATE tech_specialists SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING *",
        *args,
    )
    if not row:
        raise HTTPException(404, "Не найден")
    return dict(row)


@router.post("/specialists/{spec_id}/reset-password", summary="Новый пароль")
async def reset_password(
    spec_id: int,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    pwd = _password()
    row = await db.fetchrow(
        "UPDATE tech_specialists SET password_hash=$2, updated_at=NOW() "
        "WHERE id=$1 RETURNING email",
        spec_id, hash_password(pwd),
    )
    if not row:
        raise HTTPException(404, "Не найден")
    return {"email": row["email"], "password": pwd}


@router.post("/assign", summary="Закрепить клиента за специалистом")
async def assign(
    data: AssignIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Передача клиента. ⚠️ Начисления с этого момента идут НОВОМУ (решение
    владельца), уже начисленное прежнему остаётся — оно за сделанную работу."""
    if data.spec_id is not None:
        if not await db.fetchval(
                "SELECT 1 FROM tech_specialists WHERE id=$1 AND is_active", data.spec_id):
            raise HTTPException(400, "Такого тех-специалиста нет или он отключён")
    await assign_client(db, client_id=data.client_id,
                        spec_id=data.spec_id, reason=data.reason or "")
    return {"ok": True}


@router.get("/unassigned", summary="Клиенты без ответственного")
async def unassigned(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Кого ещё не распределили.

    ⚠️ Показываем ВСЕХ без ответственного, включая остывших: среди них как раз и
    ищут, кого можно оживить, а спрятанные они не попадутся никому на глаза.
    """
    rows = await db.fetch(
        """SELECT c.id, c.name, c.email, c.telegram_username, c.created_at,
                  t.slug AS tariff_slug, cs.expires_at, cs.source AS sub_source,
                  (SELECT COUNT(*) FROM subscription_orders so
                    WHERE so.client_id = c.id AND so.status='paid'
                      AND so.amount_paid_card_kopecks > 0) AS payments_count
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             LEFT JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.tech_specialist_id IS NULL
              AND c.is_active
              AND NOT c.is_system_service
            ORDER BY c.created_at DESC LIMIT 500"""
    )
    return {"clients": [dict(r) for r in rows]}


@router.get("/rates", summary="Ставки начислений")
async def get_rates(
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch("SELECT * FROM tech_rates ORDER BY id")
    return {"rates": [dict(r) for r in rows]}


class RateIn(BaseModel):
    amount_kopecks: Optional[int] = None
    percent: Optional[float] = None
    is_active: Optional[bool] = None


@router.patch("/rates/{kind}", summary="Изменить ставку")
async def set_rate(
    kind: str,
    data: RateIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Новая ставка действует ВПЕРЁД: уже начисленное не пересчитывается.
    Пересчёт задним числом менял бы суммы, о которых с человеком договорились."""
    fs = data.model_fields_set
    sets, args = [], []
    for col in ("amount_kopecks", "percent", "is_active"):
        if col in fs:
            args.append(getattr(data, col))
            sets.append(f"{col} = ${len(args)}")
    if not sets:
        raise HTTPException(400, "Нечего менять")
    args.append(kind)
    row = await db.fetchrow(
        f"UPDATE tech_rates SET {', '.join(sets)}, updated_at=NOW() "
        f"WHERE kind = ${len(args)} RETURNING *",
        *args,
    )
    if not row:
        raise HTTPException(404, "Нет такой ставки")
    return dict(row)


@router.get("/accruals", summary="Начисления всех специалистов")
async def all_accruals(
    spec_id: Optional[int] = Query(None),
    period: Optional[str] = Query(None),
    unpaid: Optional[bool] = Query(None),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    args: list = []
    where = ["TRUE"]
    if spec_id:
        args.append(spec_id); where.append(f"a.spec_id = ${len(args)}")
    if period:
        args.append(period); where.append(f"a.period = ${len(args)}")
    if unpaid:
        where.append("a.paid_at IS NULL")

    rows = await db.fetch(
        f"""SELECT a.*, ts.name AS spec_name, c.name AS client_name
              FROM tech_accruals a
              JOIN tech_specialists ts ON ts.id = a.spec_id
              LEFT JOIN clients c ON c.id = a.client_id
             WHERE {' AND '.join(where)}
             ORDER BY a.created_at DESC LIMIT 1000""",
        *args,
    )
    return {"accruals": [dict(r) for r in rows]}


class PayIn(BaseModel):
    ids: list[int]


@router.post("/accruals/mark-paid", summary="Отметить выплаченными")
async def mark_paid(
    data: PayIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Отметка, а не перевод денег: платит владелец сам, платформа только
    ведёт учёт. Повторная отметка уже выплаченного ничего не меняет."""
    if not data.ids:
        return {"updated": 0}
    n = await db.fetchval(
        """WITH upd AS (
             UPDATE tech_accruals SET paid_at = NOW()
              WHERE id = ANY($1::int[]) AND paid_at IS NULL RETURNING 1)
           SELECT COUNT(*) FROM upd""",
        data.ids,
    )
    return {"updated": int(n or 0)}


class ManualIn(BaseModel):
    spec_id: int
    amount_kopecks: int
    note: Optional[str] = None
    client_id: Optional[int] = None
    period: Optional[str] = None


@router.post("/accruals/manual", summary="Начислить вручную")
async def manual_accrual(
    data: ManualIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """Разовая премия или доплата. ⚠️ Вид `bonus` — он единственный не имеет
    уникального индекса: одному человеку можно начислить премию дважды."""
    if data.amount_kopecks <= 0:
        raise HTTPException(400, "Сумма должна быть больше нуля")
    row = await db.fetchrow(
        """INSERT INTO tech_accruals
             (spec_id, client_id, kind, amount_kopecks, period, note)
           VALUES ($1,$2,'bonus',$3,$4,$5) RETURNING *""",
        data.spec_id, data.client_id, data.amount_kopecks,
        data.period, data.note,
    )
    return dict(row)


# ── Диалоги из @pluson_bot ───────────────────────────────────────────────
# ⚠️ Распределяются ОТДЕЛЬНО от клиентов: в бот пишут и те, кто клиентом ещё не
# стал, — их в списке клиентов платформы попросту нет.

@router.get("/dialogs", summary="Диалоги бота и кому назначены")
async def bot_dialogs(
    unassigned_only: bool = Query(False),
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = await db.fetchval(
        "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1")
    if not client_id:
        raise HTTPException(404, "Системный кабинет не найден")

    where = "dm.client_id = $1 AND dm.contact_id IS NOT NULL"
    rows = await db.fetch(
        f"""WITH agg AS (
              SELECT dm.contact_id,
                     MAX(dm.sent_at) AS last_at,
                     COUNT(*) FILTER (WHERE dm.direction='in' AND NOT dm.is_read) AS unread
                FROM direct_messages dm
               WHERE {where}
               GROUP BY dm.contact_id
            )
            SELECT c.id AS contact_id, c.name, a.last_at, a.unread,
                   da.spec_id, ts.name AS spec_name
              FROM agg a
              JOIN contacts c ON c.id = a.contact_id
              LEFT JOIN dialog_assignments da
                     ON da.client_id = $1 AND da.contact_id = c.id
              LEFT JOIN tech_specialists ts ON ts.id = da.spec_id
             {"WHERE da.spec_id IS NULL" if unassigned_only else ""}
             ORDER BY a.last_at DESC LIMIT 300""",
        client_id,
    )
    return {"dialogs": [dict(r) for r in rows]}


class AssignDialogIn(BaseModel):
    contact_id: int
    spec_id: Optional[int] = None


@router.post("/dialogs/assign", summary="Назначить диалог внедренцу")
async def assign_dialog(
    data: AssignDialogIn,
    _admin=Depends(get_current_admin),
    db: asyncpg.Connection = Depends(get_db),
):
    """⚠️ Назначение на КОНТАКТ, а не на сообщение: разговор ведёт один человек.
    Пометка на каждом сообщении означала бы, что половину переписки разбирает
    один внедренец, половину другой."""
    client_id = await db.fetchval(
        "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1")
    if not client_id:
        raise HTTPException(404, "Системный кабинет не найден")

    if data.spec_id is None:
        await db.execute(
            "DELETE FROM dialog_assignments WHERE client_id=$1 AND contact_id=$2",
            client_id, data.contact_id)
        return {"ok": True, "assigned": False}

    if not await db.fetchval(
            "SELECT 1 FROM tech_specialists WHERE id=$1 AND is_active", data.spec_id):
        raise HTTPException(400, "Такого внедренца нет или он отключён")

    await db.execute(
        """INSERT INTO dialog_assignments (client_id, contact_id, spec_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (client_id, contact_id)
           DO UPDATE SET spec_id = EXCLUDED.spec_id, assigned_at = NOW()""",
        client_id, data.contact_id, data.spec_id)
    return {"ok": True, "assigned": True}
