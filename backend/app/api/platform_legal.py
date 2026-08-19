"""Правовые документы платформы: оферта, политика ПД, партнёрская оферта.

Публично отдаются на /offer, /privacy, /partner-offer — на них ссылаются
чекбоксы при регистрации (миграция 315). Редактируются в админке.

⚠️ Не путать с документами КЛИЕНТА: его политика ПД живёт в
`clients.privacy_policy_text` (legal.py), его оферты — в `client_offers`.
Здесь документы Оферента для его Клиентов.

⚠️ Версия (`version`) — дата редакции. При правке текста её меняют осознанно:
она фиксируется клиенту при акцепте, и по ней видно, с какой именно редакцией
он согласился. Менять версию при исправлении опечатки не нужно.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.auth import get_current_admin

SLUGS = ("offer", "privacy", "partner_offer")

router = APIRouter(prefix="/api/v1/admin/legal-docs", tags=["Правовые документы"])
public_router = APIRouter(prefix="/api/v1/public/legal-docs", tags=["Правовые документы"])


class DocUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    version: Optional[str] = None


@router.get("")
async def list_docs(admin=Depends(get_current_admin), db=Depends(get_db)):
    rows = await db.fetch(
        "SELECT slug, title, body, version, updated_at FROM platform_legal_docs ORDER BY slug")
    return [dict(r) for r in rows]


@router.patch("/{slug}")
async def update_doc(slug: str, data: DocUpdate,
                     admin=Depends(get_current_admin), db=Depends(get_db)):
    if slug not in SLUGS:
        raise HTTPException(404, detail="Документ не найден")

    fields, values = [], []
    for name in ("title", "body", "version"):
        if name in data.model_fields_set:          # различаем «не прислали» и «прислали пусто»
            fields.append(f"{name} = ${len(values) + 2}")
            values.append(getattr(data, name))
    if not fields:
        raise HTTPException(400, detail="Нечего сохранять")

    row = await db.fetchrow(
        f"""UPDATE platform_legal_docs SET {', '.join(fields)}, updated_at = NOW()
             WHERE slug = $1
         RETURNING slug, title, body, version, updated_at""",
        slug, *values,
    )
    if not row:
        raise HTTPException(404, detail="Документ не найден")
    return dict(row)


@public_router.get("/{slug}")
async def get_public_doc(slug: str, db=Depends(get_db)):
    """Публичное чтение. Пустой документ отдаём как 404 — страница покажет
    «документ пока не опубликован», а не пустой белый экран."""
    if slug not in SLUGS:
        raise HTTPException(404, detail="Документ не найден")
    row = await db.fetchrow(
        "SELECT slug, title, body, version, updated_at FROM platform_legal_docs WHERE slug = $1",
        slug,
    )
    if not row or not (row["body"] or "").strip():
        raise HTTPException(404, detail="Документ не опубликован")
    return dict(row)
