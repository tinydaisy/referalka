"""
Тарифы мероприятия — настройка платных тарифов события (VIP и др.) и
просмотр «кто оплатил».

Раздел доступен только клиентам тарифа `vip` (write-операции — 403 для
остальных). Само наличие тарифов у события — это то, что позволяет вебхуку
оплаты (`/integrations/payment/paid`) засчитать покупку.

API (требуют JWT владельца кабинета):
  GET    /api/v1/events/{event_id}/tariffs
  POST   /api/v1/events/{event_id}/tariffs
  PATCH  /api/v1/events/{event_id}/tariffs/{tariff_id}
  DELETE /api/v1/events/{event_id}/tariffs/{tariff_id}
  GET    /api/v1/events/{event_id}/tariffs/{tariff_id}/buyers

Создано миграцией 157 (event_tariffs, event_participant_tariffs, events.offer_url).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.subscriptions import get_subscription

router = APIRouter(prefix="/events/{event_id}/tariffs", tags=["Тарифы мероприятия"])


async def _check_event_access(db, client_id: int, event_id: int):
    row = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND id IN "
        "(SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
        event_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


async def _assert_vip(db, client_id: int):
    """Раздел тарифов мероприятия — только для клиентов тарифа vip."""
    sub = await get_subscription(db, client_id)
    if not sub or sub.get("tariff_slug") != "vip":
        raise HTTPException(
            status_code=403,
            detail="Тарифы мероприятия доступны только на тарифе VIP.",
        )


class TariffIn(BaseModel):
    code: str
    title: str
    description: Optional[str] = None
    price: Optional[int] = None
    pay_url: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True


class TariffPatch(BaseModel):
    code: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    price: Optional[int] = None
    pay_url: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


def _norm_code(code: str) -> str:
    return (code or "").strip().lower()


@router.get("", summary="Тарифы мероприятия + счётчик оплативших")
async def list_tariffs(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """SELECT t.id, t.code, t.title, t.description, t.price, t.pay_url,
                  t.sort_order, t.is_active,
                  (SELECT COUNT(*) FROM event_participant_tariffs ept
                     WHERE ept.tariff_id = t.id) AS buyers_count
             FROM event_tariffs t
            WHERE t.event_id = $1
            ORDER BY t.sort_order, t.id""",
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.post("", summary="Создать тариф")
async def create_tariff(
    event_id: int,
    data: TariffIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)
    code = _norm_code(data.code)
    if not code:
        raise HTTPException(status_code=400, detail="Код тарифа обязателен")
    if not (data.title or "").strip():
        raise HTTPException(status_code=400, detail="Название тарифа обязательно")
    exists = await db.fetchval(
        "SELECT 1 FROM event_tariffs WHERE event_id = $1 AND code = $2", event_id, code
    )
    if exists:
        raise HTTPException(status_code=409, detail=f"Тариф с кодом «{code}» уже есть у события")
    row = await db.fetchrow(
        """INSERT INTO event_tariffs (event_id, code, title, description, price, pay_url, sort_order, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, code, title, description, price, pay_url, sort_order, is_active""",
        event_id, code, data.title.strip(), data.description, data.price,
        data.pay_url, data.sort_order, data.is_active,
    )
    return dict(row)


@router.patch("/{tariff_id}", summary="Изменить тариф")
async def update_tariff(
    event_id: int,
    tariff_id: int,
    data: TariffPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)
    cur = await db.fetchrow(
        "SELECT id FROM event_tariffs WHERE id = $1 AND event_id = $2", tariff_id, event_id
    )
    if not cur:
        raise HTTPException(status_code=404, detail="Тариф не найден")

    fields = data.model_dump(exclude_unset=True)
    if "code" in fields:
        code = _norm_code(fields["code"])
        if not code:
            raise HTTPException(status_code=400, detail="Код тарифа не может быть пустым")
        clash = await db.fetchval(
            "SELECT 1 FROM event_tariffs WHERE event_id = $1 AND code = $2 AND id <> $3",
            event_id, code, tariff_id,
        )
        if clash:
            raise HTTPException(status_code=409, detail=f"Тариф с кодом «{code}» уже есть у события")
        fields["code"] = code
    if "title" in fields:
        fields["title"] = (fields["title"] or "").strip()
        if not fields["title"]:
            raise HTTPException(status_code=400, detail="Название тарифа не может быть пустым")

    if not fields:
        return {"ok": True}

    sets = ", ".join(f"{k} = ${i+3}" for i, k in enumerate(fields.keys()))
    row = await db.fetchrow(
        f"""UPDATE event_tariffs SET {sets}, updated_at = NOW()
             WHERE id = $1 AND event_id = $2
         RETURNING id, code, title, description, price, pay_url, sort_order, is_active""",
        tariff_id, event_id, *fields.values(),
    )
    return dict(row)


@router.delete("/{tariff_id}", summary="Удалить тариф")
async def delete_tariff(
    event_id: int,
    tariff_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _check_event_access(db, client_id, event_id)
    await _assert_vip(db, client_id)
    await db.execute(
        "DELETE FROM event_tariffs WHERE id = $1 AND event_id = $2", tariff_id, event_id
    )
    return {"ok": True}


@router.get("/{tariff_id}/buyers", summary="Кто оплатил тариф")
async def list_buyers(
    event_id: int,
    tariff_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    tariff = await db.fetchrow(
        "SELECT id, code, title FROM event_tariffs WHERE id = $1 AND event_id = $2",
        tariff_id, event_id,
    )
    if not tariff:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    rows = await db.fetch(
        """SELECT ept.id, ept.participant_id, ept.paid_at, ept.source, ept.amount,
                  ept.external_payment_id,
                  c.id AS contact_id, c.name AS contact_name, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS tg_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS vk_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_id,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS max_username
             FROM event_participant_tariffs ept
             JOIN event_participants ep ON ep.id = ept.participant_id
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ept.tariff_id = $1
            ORDER BY ept.paid_at DESC, ept.id DESC""",
        tariff_id,
    )
    return {
        "tariff": dict(tariff),
        "count": len(rows),
        "buyers": [dict(r) for r in rows],
    }
