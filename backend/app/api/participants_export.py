"""
API-выгрузка участников события для интеграции со сторонними сервисами
(мейлеры, CRM, конструкторы). Авторизация — `clients.integration_token`
(тот же токен, что и для чат-ботов, см. [integrations.py](integrations.py)).

Эндпоинты (все GET, токен в заголовке `X-Integration-Token`):

  GET /api/v1/integrations/events/{event_id}/participants
      — ВСЕ участники события (зарегистрированные + нет).
        Опциональный фильтр ?registered=true|false.

  GET /api/v1/integrations/events/{event_id}/participants/registered
      — только ЗАРЕГИСТРИРОВАННЫЕ (is_registered = TRUE).

  GET /api/v1/integrations/events/{event_id}/participants/not-registered
      — только НЕзарегистрированные (is_registered = FALSE).

  GET /api/v1/integrations/events/{event_id}/participants/in-chat
      — кто реально состоит в Telegram-чате события (is_in_chat = TRUE).

  GET /api/v1/integrations/events/{event_id}/participants/paid
      — кто оплатил хотя бы один тариф события
        (есть запись в event_participant_tariffs). У каждого — список
        оплаченных тарифов (paid_tariffs).

Из всех списков ВЫЧИТАЮТСЯ коллабораторы события (организаторы, жюри,
спикеры, хедлайнеры, партнёры) — отдаётся чистая аудитория зрителей.

В каждой записи участника есть поле `messengers` — массив платформ, на
которых у человека есть аккаунт (любая комбинация 'telegram'/'vk'/'max'),
плюс развёрнутые объекты `telegram`/`vk`/`max` с id и username.
"""
from fastapi import APIRouter, Depends, HTTPException, Header, Query
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


# Какие платформы считаем «мессенджерами» для пометки messengers[]
_MESSENGERS = ("telegram", "vk", "max")


async def _fetch_participants(
    db: asyncpg.Connection,
    event_id: int,
    client_id: int,
    is_registered: Optional[bool] = None,
    only_in_chat: bool = False,
    only_paid: bool = False,
) -> list[dict]:
    """Список участников события (за вычетом коллабораторов).

    is_registered=None  — все; True/False — фильтр по регистрации.
    only_in_chat=True   — только те, кто в Telegram-чате события.
    only_paid=True       — только те, кто оплатил хотя бы один тариф.
    """
    where = ["ep.event_id = $1"]
    params: list = [event_id]

    if is_registered is not None:
        params.append(is_registered)
        where.append(f"ep.is_registered = ${len(params)}")
    if only_in_chat:
        where.append("ep.is_in_chat = TRUE")
    if only_paid:
        where.append(
            "EXISTS (SELECT 1 FROM event_participant_tariffs ept "
            "WHERE ept.participant_id = ep.id)"
        )

    where_sql = " AND ".join(where)

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
          ep.is_in_chat,
          ep.chat_check_at,
          ep.registered_at    AS participated_at,
          c.created_at        AS contact_created_at,
          c.last_contact_at,
          (SELECT json_agg(json_build_object(
              'platform_slug',    pu.platform_slug,
              'platform_user_id', pu.platform_user_id,
              'username',         pu.username
            ) ORDER BY pu.platform_slug)
            FROM platform_users pu WHERE pu.contact_id = c.id) AS identities,
          (SELECT json_agg(json_build_object(
              'code',    et.code,
              'title',   et.title,
              'price',   et.price,
              'amount',  ept.amount,
              'paid_at', to_char(ept.paid_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI'),
              'source',  ept.source
            ) ORDER BY ept.paid_at)
            FROM event_participant_tariffs ept
            JOIN event_tariffs et ON et.id = ept.tariff_id
            WHERE ept.participant_id = ep.id)     AS paid_tariffs
        FROM event_participants ep
        JOIN contacts c ON c.id = ep.contact_id
        WHERE {where_sql}
          AND NOT EXISTS (
            SELECT 1
              FROM event_collaborators ec
              JOIN collaborators co ON co.id = ec.speaker_id
             WHERE ec.event_id = $1
               AND co.contact_id = c.id
          )
        ORDER BY c.name NULLS LAST, c.id
        """,
        *params,
    )

    import json
    out = []
    for r in rows:
        identities = r["identities"]
        if isinstance(identities, str):
            identities = json.loads(identities)
        identities = identities or []

        paid = r["paid_tariffs"]
        if isinstance(paid, str):
            paid = json.loads(paid)
        paid = paid or []

        tags = r["tags"]
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except Exception:
                tags = [t.strip() for t in tags.split(",") if t.strip()]

        tg = _identity(identities, "telegram")
        vk = _identity(identities, "vk")
        mx = _identity(identities, "max")
        # Пометка мессенджеров: на каких платформах у человека есть аккаунт
        messengers = [
            slug for slug in _MESSENGERS
            if any(i.get("platform_slug") == slug for i in identities)
        ]

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
            "is_in_chat": r["is_in_chat"],
            "chat_check_at": _fmt_dt(r["chat_check_at"]),
            "is_paid": bool(paid),
            "paid_tariffs": paid,
            "messengers": messengers,
            "telegram": tg,
            "vk": vk,
            "max": mx,
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
    "/events/{event_id}/participants",
    summary="Все участники события (опц. фильтр ?registered=true|false)",
)
async def list_all_participants(
    event_id: int,
    client_id: int,
    registered: Optional[bool] = Query(None, description="true=только зарег., false=только незарег., не задан=все"),
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    await _authorize(x_integration_token, client_id, db)
    await _assert_event_belongs(db, event_id, client_id)
    participants = await _fetch_participants(db, event_id, client_id, registered)
    return {
        "event_id": event_id,
        "filter": "all" if registered is None else ("registered" if registered else "not_registered"),
        "count": len(participants),
        "participants": participants,
    }


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


@router.get(
    "/events/{event_id}/participants/in-chat",
    summary="Участники, которые состоят в Telegram-чате события (is_in_chat=TRUE)",
)
async def list_in_chat_participants(
    event_id: int,
    client_id: int,
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    await _authorize(x_integration_token, client_id, db)
    await _assert_event_belongs(db, event_id, client_id)
    participants = await _fetch_participants(db, event_id, client_id, only_in_chat=True)
    return {
        "event_id": event_id,
        "filter": "in_chat",
        "count": len(participants),
        "participants": participants,
    }


@router.get(
    "/events/{event_id}/participants/paid",
    summary="Участники, которые оплатили хотя бы один тариф события",
)
async def list_paid_participants(
    event_id: int,
    client_id: int,
    x_integration_token: Optional[str] = Header(None),
    db: asyncpg.Connection = Depends(get_db),
):
    await _authorize(x_integration_token, client_id, db)
    await _assert_event_belongs(db, event_id, client_id)
    participants = await _fetch_participants(db, event_id, client_id, only_paid=True)
    return {
        "event_id": event_id,
        "filter": "paid",
        "count": len(participants),
        "participants": participants,
    }
