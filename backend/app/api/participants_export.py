"""
API-выгрузка участников события для интеграции со сторонними сервисами.

Два эндпоинта (авторизация — тем же `clients.integration_token`, что и
интеграции с чат-ботами, см. [integrations.py](integrations.py)):

  GET /api/v1/integrations/events/{event_id}/participants/registered
      — все ЗАРЕГИСТРИРОВАННЫЕ участники события
        (event_participants.is_registered = TRUE)

  GET /api/v1/integrations/events/{event_id}/participants/not-registered
      — все НЕзарегистрированные участники события
        (event_participants.is_registered = FALSE)

Из обоих списков ВЫЧИТАЮТСЯ коллабораторы этого события — организаторы,
жюри, спикеры, хедлайнеры, генеральные партнёры, партнёры (любая запись в
`event_collaborators` этого события через `collaborators.contact_id`).
Так клиент получает «чистую» аудиторию — только реальные участники-зрители,
без членов команды события.

Возвращается JSON с богатым набором полей контакта: имя, email, телефон,
реф-код, UTM, теги, идентичности на платформах (TG/VK/MAX), даты.
"""
from fastapi import APIRouter, Depends, HTTPException, Header
from typing import Optional
import asyncpg

from app.database import get_db


router = APIRouter(prefix="/integrations", tags=["Интеграции"])


async def _authorize(
    token: Optional[str],
    client_id: int,
    db: asyncpg.Connection,
) -> None:
    """Проверяет `clients.integration_token`. Токен обязан принадлежать
    тому же клиенту, к которому относится событие."""
    if not token:
        raise HTTPException(status_code=401, detail="Не передан секретный токен")
    owner_id = await db.fetchval(
        "SELECT id FROM clients WHERE integration_token = $1 AND is_active = TRUE",
        token,
    )
    if owner_id is None:
        raise HTTPException(status_code=401, detail="Неверный токен")
    if owner_id != client_id:
        raise HTTPException(
            status_code=403,
            detail="Токен принадлежит другому клиенту.",
        )


def _fmt_dt(v) -> Optional[str]:
    if not v:
        return None
    return v.strftime("%Y-%m-%d %H:%M") if hasattr(v, "strftime") else str(v)[:16]


def _identity(identities: list, slug: str) -> Optional[dict]:
    """Первая идентичность контакта на платформе slug → {id, username} | None."""
    for ident in identities or []:
        if ident.get("platform_slug") == slug:
            return {
                "id": ident.get("platform_user_id"),
                "username": ident.get("username"),
            }
    return None


async def _fetch_participants(
    db: asyncpg.Connection,
    event_id: int,
    client_id: int,
    is_registered: bool,
) -> list[dict]:
    """Список участников события с заданным is_registered, за вычетом
    коллабораторов события (организаторы/жюри/спикеры/партнёры)."""
    rows = await db.fetch(
        f"""
        SELECT
          c.id                AS contact_id,
          ep.id               AS participant_id,
          c.name,
          (SELECT pe.platform_user_id FROM platform_users pe
             WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
             ORDER BY pe.id LIMIT 1)              AS email,
          c.phone,
          c.ref_code,
          c.utm_source,
          c.tags,
          ep.referrer_ref_code,
          ep.is_registered,
          ep.registered_at    AS participated_at,
          c.created_at        AS contact_created_at,
          c.last_contact_at,
          (SELECT json_agg(json_build_object(
              'platform_slug',    pu.platform_slug,
              'platform_user_id', pu.platform_user_id,
              'username',         pu.username
            ) ORDER BY pu.platform_slug)
            FROM platform_users pu WHERE pu.contact_id = c.id) AS identities
        FROM event_participants ep
        JOIN contacts c ON c.id = ep.contact_id
        WHERE ep.event_id = $1
          AND ep.is_registered = $2
          AND NOT EXISTS (
            SELECT 1
              FROM event_collaborators ec
              JOIN collaborators co ON co.id = ec.speaker_id
             WHERE ec.event_id = $1
               AND co.contact_id = c.id
          )
        ORDER BY c.name NULLS LAST, c.id
        """,
        event_id, is_registered,
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
        out.append({
            "contact_id": r["contact_id"],
            "participant_id": r["participant_id"],
            "name": r["name"],
            "email": r["email"],
            "phone": r["phone"],
            "ref_code": r["ref_code"],
            "utm_source": r["utm_source"],
            "tags": tags or [],
            "referrer_ref_code": r["referrer_ref_code"],
            "is_registered": r["is_registered"],
            "telegram": _identity(identities, "telegram"),
            "vk": _identity(identities, "vk"),
            "max": _identity(identities, "max"),
            "participated_at": _fmt_dt(r["participated_at"]),
            "contact_created_at": _fmt_dt(r["contact_created_at"]),
            "last_contact_at": _fmt_dt(r["last_contact_at"]),
        })
    return out


async def _assert_event_belongs(db, event_id: int, client_id: int) -> None:
    owner = await db.fetchval("SELECT client_id FROM event_owners WHERE event_id = $1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1", event_id)
    if owner is None:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    if owner != client_id:
        raise HTTPException(status_code=403, detail="Событие принадлежит другому клиенту")


@router.get(
    "/events/{event_id}/participants/registered",
    summary="Зарегистрированные участники события (без организаторов/жюри/спикеров/партнёров)",
)
async def list_registered_participants(
    event_id: int,
    client_id: int,
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    await _authorize(x_integration_token, client_id, db)
    await _assert_event_belongs(db, event_id, client_id)
    participants = await _fetch_participants(db, event_id, client_id, True)
    return {
        "event_id": event_id,
        "is_registered": True,
        "count": len(participants),
        "participants": participants,
    }


@router.get(
    "/events/{event_id}/participants/not-registered",
    summary="Незарегистрированные участники события (без организаторов/жюри/спикеров/партнёров)",
)
async def list_not_registered_participants(
    event_id: int,
    client_id: int,
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    await _authorize(x_integration_token, client_id, db)
    await _assert_event_belongs(db, event_id, client_id)
    participants = await _fetch_participants(db, event_id, client_id, False)
    return {
        "event_id": event_id,
        "is_registered": False,
        "count": len(participants),
        "participants": participants,
    }
