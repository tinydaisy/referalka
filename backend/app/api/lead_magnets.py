"""
Лид-магниты — общая база Клиента (per-client).

Один лид-магнит = один материал (чек-лист, гайд, статья, видео).
Используется в реф-программе любого события клиента (через event_referral_thresholds)
и в воронках выдачи (через funnel_runs.lead_magnet_id).

У каждого лид-магнита есть короткий уникальный slug — публичная ссылка вида
`pluson.ru/m/{slug}` ведёт на воронку выдачи.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
import asyncpg
import secrets

router = APIRouter(prefix="/lead-magnets", tags=["Лид-магниты"])

_SLUG_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'


def _short_code(n: int = 5) -> str:
    return ''.join(secrets.choice(_SLUG_ALPHABET) for _ in range(n))


async def _make_unique_lead_magnet_slug(db: asyncpg.Connection) -> str:
    """5-символьный slug, уникальный среди lead_magnets и lead_magnet_packages.
    Маленькая вероятность коллизии (~1/33M), но проверяем до уникальности."""
    while True:
        candidate = _short_code(5)
        exists = await db.fetchval(
            "SELECT 1 FROM lead_magnets WHERE slug = $1 "
            "UNION SELECT 1 FROM lead_magnet_packages WHERE slug = $1 LIMIT 1",
            candidate
        )
        if not exists:
            return candidate


class LeadMagnetIn(BaseModel):
    name: str
    description: Optional[str] = None
    url: str


@router.get("", summary="Список лид-магнитов клиента")
async def list_lead_magnets(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    rows = await db.fetch(
        """SELECT id, name, description, url, slug, created_at, updated_at
           FROM lead_magnets WHERE client_id = $1
           ORDER BY name""",
        int(client["sub"])
    )
    return {"items": [dict(r) for r in rows]}


@router.post("", summary="Создать лид-магнит")
async def create_lead_magnet(
    data: LeadMagnetIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    slug = await _make_unique_lead_magnet_slug(db)
    row = await db.fetchrow(
        """INSERT INTO lead_magnets (client_id, name, description, url, slug)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, description, url, slug, created_at, updated_at""",
        int(client["sub"]), data.name.strip(), data.description, data.url.strip(), slug
    )
    return dict(row)


@router.get("/counts", summary="Батч-счётчики воронки по всем лид-магнитам клиента")
async def list_counts(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Возвращает [{id, landed, started, delivered}] — для отображения цифр
    рядом со строкой в дашборде. Один запрос на всех."""
    rows = await db.fetch(
        """SELECT
              lm.id,
              COALESCE(COUNT(fr.id) FILTER (WHERE fr.stage IN ('landed','started','subscribed','delivered')), 0) AS landed,
              COALESCE(COUNT(fr.id) FILTER (WHERE fr.stage IN ('started','subscribed','delivered')), 0) AS started,
              COALESCE(COUNT(fr.id) FILTER (WHERE fr.stage = 'delivered'), 0) AS delivered
             FROM lead_magnets lm
        LEFT JOIN funnel_runs fr ON fr.lead_magnet_id = lm.id
            WHERE lm.client_id = $1
         GROUP BY lm.id""",
        int(client["sub"])
    )
    return {"items": [
        {"id": r["id"], "landed": int(r["landed"]), "started": int(r["started"]), "delivered": int(r["delivered"])}
        for r in rows
    ]}


@router.get("/{lead_magnet_id}", summary="Получить лид-магнит")
async def get_lead_magnet(
    lead_magnet_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """SELECT id, name, description, url, slug, created_at, updated_at
           FROM lead_magnets WHERE id = $1 AND client_id = $2""",
        lead_magnet_id, int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    return dict(row)


@router.patch("/{lead_magnet_id}", summary="Обновить лид-магнит")
async def update_lead_magnet(
    lead_magnet_id: int,
    data: LeadMagnetIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """UPDATE lead_magnets
              SET name = $1, description = $2, url = $3, updated_at = NOW()
            WHERE id = $4 AND client_id = $5
            RETURNING id, name, description, url, slug, created_at, updated_at""",
        data.name.strip(), data.description, data.url.strip(),
        lead_magnet_id, int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    return dict(row)


@router.delete("/{lead_magnet_id}", summary="Удалить лид-магнит")
async def delete_lead_magnet(
    lead_magnet_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    result = await db.execute(
        "DELETE FROM lead_magnets WHERE id = $1 AND client_id = $2",
        lead_magnet_id, int(client["sub"])
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    return {"ok": True}


@router.get("/{lead_magnet_id}/analytics", summary="Аналитика воронки лид-магнита")
async def lead_magnet_analytics(
    lead_magnet_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Три счётчика по `funnel_runs` + список интересантов с этапами."""
    cid = int(client["sub"])
    own = await db.fetchval(
        "SELECT 1 FROM lead_magnets WHERE id = $1 AND client_id = $2",
        lead_magnet_id, cid
    )
    if not own:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")

    counts = await db.fetchrow(
        """SELECT
              COUNT(*) FILTER (WHERE stage IN ('landed','started','subscribed','delivered')) AS landed,
              COUNT(*) FILTER (WHERE stage IN ('started','subscribed','delivered'))         AS started,
              COUNT(*) FILTER (WHERE stage = 'delivered')                                    AS delivered
             FROM funnel_runs
            WHERE lead_magnet_id = $1""",
        lead_magnet_id
    )

    runs = await db.fetch(
        """SELECT
              fr.id, fr.stage, fr.utm, fr.landed_at, fr.started_at,
              fr.subscribed_at, fr.delivered_at,
              fr.contact_id, c.name AS contact_name,
              fr.platform_slug, fr.platform_user_id,
              pu.username AS contact_username,
              fr.referrer_contact_id, rc.name AS referrer_name,
              rpu.username AS referrer_username
             FROM funnel_runs fr
        LEFT JOIN contacts c ON c.id = fr.contact_id
        LEFT JOIN platform_users pu
               ON pu.contact_id = fr.contact_id
              AND pu.platform_slug = fr.platform_slug
        LEFT JOIN contacts rc ON rc.id = fr.referrer_contact_id
        LEFT JOIN platform_users rpu
               ON rpu.contact_id = fr.referrer_contact_id
              AND rpu.platform_slug = fr.platform_slug
            WHERE fr.lead_magnet_id = $1
         ORDER BY fr.landed_at DESC
            LIMIT 500""",
        lead_magnet_id
    )

    return {
        "counts": {
            "landed": int(counts["landed"] or 0),
            "started": int(counts["started"] or 0),
            "delivered": int(counts["delivered"] or 0),
        },
        "runs": [dict(r) for r in runs],
    }
