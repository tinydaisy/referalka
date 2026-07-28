"""
Оферты клиента — свои тексты договоров (миграция 249).

Зачем отдельной базой, а не полем у события: у клиента обычно несколько
продуктов (конференция, курс, клуб), и оферта у каждого своя. Раньше был один
`events.offer_url` — ссылка на чужой сайт, и переиспользовать её было нельзя.

Текст хранится у нас, публичная страница — `pluson.ru/o/{slug}`. Если оферта
уже лежит снаружи, клиент вписывает `external_url` — тогда ведём туда.

Гейт — фича `offers` (никогда по tariff_slug).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import re
import secrets
import asyncpg

from app.database import get_db
from app.auth import get_current_client
from app.services.features import client_has_feature

router = APIRouter(prefix="/clients/me/offers", tags=["Оферты"])

# Алфавит без визуально похожих символов (0/o, 1/l/i) — как у slug событий.
_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"


async def _assert_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "offers"):
        raise HTTPException(status_code=403, detail="Раздел «Оферты» недоступен на вашем тарифе.")


def _slugify(title: str) -> str:
    """Латиница из заголовка; пусто → случайный код (кириллица в URL запрещена)."""
    t = (title or "").strip().lower()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t[:40] if t else "".join(secrets.choice(_ALPHABET) for _ in range(6))


class OfferIn(BaseModel):
    title: str
    slug: Optional[str] = None
    body: Optional[str] = None
    external_url: Optional[str] = None
    is_active: bool = True


class OfferPatch(BaseModel):
    title: Optional[str] = None
    slug: Optional[str] = None
    body: Optional[str] = None
    external_url: Optional[str] = None
    is_active: Optional[bool] = None


@router.get("", summary="Список оферт")
async def list_offers(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    rows = await db.fetch(
        """SELECT id, title, slug, external_url, is_active, updated_at,
                  (body IS NOT NULL AND body <> '') AS has_body,
                  (SELECT COUNT(*) FROM events e WHERE e.offer_id = o.id) AS events_count,
                  (SELECT COUNT(*) FROM event_tariffs t WHERE t.offer_id = o.id) AS tariffs_count
             FROM client_offers o
            WHERE client_id = $1
            ORDER BY is_active DESC, updated_at DESC""",
        client_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.get("/{offer_id}", summary="Оферта целиком (с текстом)")
async def get_offer(
    offer_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    row = await db.fetchrow(
        "SELECT * FROM client_offers WHERE id = $1 AND client_id = $2", offer_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Оферта не найдена")
    return dict(row)


@router.post("", summary="Создать оферту")
async def create_offer(
    data: OfferIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    title = (data.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Название оферты обязательно")

    slug = _slugify(data.slug or title)
    # Занятый slug дополняем суффиксом, а не отказываем: клиент не обязан
    # держать в голове, какие адреса уже использованы.
    for _ in range(20):
        busy = await db.fetchval(
            "SELECT 1 FROM client_offers WHERE client_id = $1 AND slug = $2", client_id, slug
        )
        if not busy:
            break
        slug = f"{_slugify(data.slug or title)}-{secrets.choice(_ALPHABET)}{secrets.choice(_ALPHABET)}"

    row = await db.fetchrow(
        """INSERT INTO client_offers (client_id, title, slug, body, external_url, is_active)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *""",
        client_id, title, slug, data.body, data.external_url, data.is_active,
    )
    return dict(row)


@router.patch("/{offer_id}", summary="Изменить оферту")
async def patch_offer(
    offer_id: int,
    data: OfferPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    owns = await db.fetchval(
        "SELECT 1 FROM client_offers WHERE id = $1 AND client_id = $2", offer_id, client_id
    )
    if not owns:
        raise HTTPException(status_code=404, detail="Оферта не найдена")

    fs = data.model_fields_set
    sets, vals = [], []
    for field in ("title", "body", "external_url", "is_active"):
        if field not in fs:
            continue
        vals.append(getattr(data, field))
        sets.append(f"{field} = ${len(vals)}")

    if "slug" in fs:
        slug = _slugify(data.slug or "")
        busy = await db.fetchval(
            "SELECT 1 FROM client_offers WHERE client_id = $1 AND slug = $2 AND id <> $3",
            client_id, slug, offer_id,
        )
        if busy:
            raise HTTPException(status_code=409, detail=f"Адрес «{slug}» уже занят")
        vals.append(slug)
        sets.append(f"slug = ${len(vals)}")

    if not sets:
        return {"ok": True}

    vals.append(offer_id)
    row = await db.fetchrow(
        f"UPDATE client_offers SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(vals)} RETURNING *",
        *vals,
    )
    return dict(row)


@router.delete("/{offer_id}", summary="Удалить оферту")
async def delete_offer(
    offer_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    deleted = await db.fetchval(
        "DELETE FROM client_offers WHERE id = $1 AND client_id = $2 RETURNING id",
        offer_id, client_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Оферта не найдена")
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Публичная страница оферты — pluson.ru/o/{slug}
# ─────────────────────────────────────────────────────────────────────────────
public_router = APIRouter(prefix="/api/v1/public/offers", tags=["Оферты (публично)"])


@public_router.get("/{slug}", summary="Текст оферты по адресу")
async def public_offer(slug: str, db: asyncpg.Connection = Depends(get_db)):
    """Slug уникален в пределах клиента, но на публичной странице клиента нет.
    Берём активную оферту с таким адресом — коллизия между клиентами
    маловероятна, а адрес можно сменить в кабинете."""
    row = await db.fetchrow(
        "SELECT title, body, external_url FROM client_offers "
        "WHERE slug = $1 AND is_active ORDER BY id LIMIT 1",
        slug,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Документ не найден")
    return dict(row)
