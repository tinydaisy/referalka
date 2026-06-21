"""
API-выгрузка ВСЕЙ базы контактов клиента для интеграции со сторонними
сервисами (мейлеры, CRM). Авторизация — `clients.integration_token`
(тот же токен, что и для выгрузки участников события).

  GET /api/v1/integrations/contacts?client_id=...
      — вся база контактов клиента (только активные, не смерженные).
        Пагинация: ?limit=1000&offset=0 (по умолчанию 1000, максимум 5000).

В каждой записи — те же поля, что и в выгрузке участников:
name/email/phone/ref_code/utm_source/tags + `messengers` (на каких
платформах есть аккаунт) + развёрнутые telegram/vk/max.
"""
from fastapi import APIRouter, Depends, HTTPException, Header, Query
from typing import Optional
import asyncpg

from app.database import get_db


router = APIRouter(prefix="/integrations", tags=["Интеграции"])

_MESSENGERS = ("telegram", "vk", "max")
_PLATFORM_ALIASES = {"tg": "telegram", "telegram": "telegram", "vk": "vk", "max": "max"}


def _normalize_platform(value: Optional[str]) -> Optional[str]:
    """`?platform=tg|vk|max|all` → slug | None (None/all = все платформы)."""
    if not value:
        return None
    v = value.strip().lower()
    if v == "all":
        return None
    slug = _PLATFORM_ALIASES.get(v)
    if slug is None:
        raise HTTPException(status_code=400, detail="platform должен быть одним из: tg, vk, max, all")
    return slug


async def _authorize(token: Optional[str], client_id: int, db: asyncpg.Connection) -> None:
    if not token:
        raise HTTPException(status_code=401, detail="Не передан секретный токен")
    owner_id = await db.fetchval(
        "SELECT id FROM clients WHERE integration_token = $1 AND is_active = TRUE",
        token,
    )
    if owner_id is None:
        raise HTTPException(status_code=401, detail="Неверный токен")
    if owner_id != client_id:
        raise HTTPException(status_code=403, detail="Токен принадлежит другому клиенту.")


def _fmt_dt(v) -> Optional[str]:
    if not v:
        return None
    return v.strftime("%Y-%m-%d %H:%M") if hasattr(v, "strftime") else str(v)[:16]


def _identity(identities: list, slug: str) -> Optional[dict]:
    for ident in identities or []:
        if ident.get("platform_slug") == slug:
            return {"id": ident.get("platform_user_id"), "username": ident.get("username")}
    return None


@router.get(
    "/contacts",
    summary="Вся база контактов клиента (для мейлера/CRM)",
)
async def list_all_contacts(
    client_id: int,
    limit: int = Query(1000, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    platform: Optional[str] = Query(None, description="tg|vk|max — только контакты с этой платформой; не задан=все"),
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    await _authorize(x_integration_token, client_id, db)
    plat = _normalize_platform(platform)

    # При фильтре по платформе считаем total и выбираем только контакты,
    # у которых есть идентичность на этой платформе.
    plat_clause = ""
    base_params: list = [client_id]
    if plat is not None:
        base_params.append(plat)
        plat_clause = (
            " AND EXISTS (SELECT 1 FROM platform_users pu2 "
            "WHERE pu2.contact_id = c.id AND pu2.platform_slug = $2)"
        )

    total = await db.fetchval(
        f"SELECT COUNT(*) FROM contacts c WHERE c.client_id = $1 AND c.merged_into IS NULL{plat_clause}",
        *base_params,
    )

    limit_idx = len(base_params) + 1
    offset_idx = len(base_params) + 2
    rows = await db.fetch(
        f"""
        SELECT
          c.id              AS contact_id,
          c.name,
          (SELECT pe.platform_user_id FROM platform_users pe
             WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
             ORDER BY pe.id LIMIT 1)            AS email,
          c.phone,
          c.ref_code,
          c.utm_source,
          c.tags,
          c.created_at,
          c.last_contact_at,
          (SELECT json_agg(json_build_object(
              'platform_slug',    pu.platform_slug,
              'platform_user_id', pu.platform_user_id,
              'username',         pu.username
            ) ORDER BY pu.platform_slug)
            FROM platform_users pu WHERE pu.contact_id = c.id) AS identities
        FROM contacts c
        WHERE c.client_id = $1 AND c.merged_into IS NULL{plat_clause}
        ORDER BY c.id
        LIMIT ${limit_idx} OFFSET ${offset_idx}
        """,
        *base_params, limit, offset,
    )

    import json
    out = []
    for r in rows:
        identities = r["identities"]
        if isinstance(identities, str):
            identities = json.loads(identities)
        identities = identities or []

        tags = r["tags"]
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except Exception:
                tags = [t.strip() for t in tags.split(",") if t.strip()]

        messengers = [
            slug for slug in _MESSENGERS
            if any(i.get("platform_slug") == slug for i in identities)
        ]

        tg = _identity(identities, "telegram")
        vk = _identity(identities, "vk")
        mx = _identity(identities, "max")
        if plat is not None:
            messengers = [plat]
            tg = tg if plat == "telegram" else None
            vk = vk if plat == "vk" else None
            mx = mx if plat == "max" else None

        out.append({
            "contact_id": r["contact_id"],
            "name": r["name"],
            "email": r["email"],
            "phone": r["phone"],
            "ref_code": r["ref_code"],
            "utm_source": r["utm_source"],
            "tags": tags or [],
            "messengers": messengers,
            "telegram": tg,
            "vk": vk,
            "max": mx,
            "created_at": _fmt_dt(r["created_at"]),
            "last_contact_at": _fmt_dt(r["last_contact_at"]),
        })

    return {
        "client_id": client_id,
        "total": total,
        "platform": plat,
        "limit": limit,
        "offset": offset,
        "count": len(out),
        "contacts": out,
    }
