from fastapi import APIRouter, Depends, Query
from app.auth import get_current_client
from app.database import get_db

router = APIRouter()

@router.get("/contacts")
async def get_contacts(
    search: str = Query(default="", alias="search"),
    limit: int = Query(default=50),
    offset: int = Query(default=0),
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    client_id = client["id"]

    where = "WHERE pu.client_id = $1"
    params = [client_id]

    if search:
        params.append(f"%{search}%")
        idx = len(params)
        where += f"""
          AND (
            pu.first_name ILIKE ${idx} OR pu.last_name ILIKE ${idx}
            OR pu.username ILIKE ${idx} OR pu.email ILIKE ${idx}
            OR pu.phone ILIKE ${idx}
          )
        """

    total = await db.fetchval(f"""
        SELECT COUNT(*) FROM platform_users pu {where}
    """, *params)

    rows = await db.fetch(f"""
        SELECT
          pu.id,
          pu.platform_user_id,
          pu.username,
          pu.first_name,
          pu.last_name,
          pu.email,
          pu.phone,
          pu.utm_source,
          pu.tags,
          pu.ref_code,
          pu.is_unsubscribed,
          pu.last_contact_at,
          pu.created_at,
          pu.salebot_id,
          -- партнёр: ищем по tg_id из ref_code
          CASE
            WHEN pu.ref_code LIKE 'tg_%%_r_%%' THEN
              (SELECT c2.name FROM collaborators c2
               WHERE c2.personal_tg_id = split_part(pu.ref_code, '_r_', 2)
               LIMIT 1)
            ELSE NULL
          END AS referrer_name,
          -- участник конфы?
          EXISTS (
            SELECT 1 FROM event_participants ep WHERE ep.platform_user_id = pu.id
          ) AS is_participant
        FROM platform_users pu
        {where}
        ORDER BY pu.first_name, pu.last_name
        LIMIT ${ len(params)+1 } OFFSET ${ len(params)+2 }
    """, *params, limit, offset)

    return {
        "total": total,
        "items": [dict(r) for r in rows]
    }


@router.get("/contacts/{contact_id}")
async def get_contact(
    contact_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    client_id = client["id"]

    row = await db.fetchrow("""
        SELECT
          pu.id,
          pu.platform_user_id,
          pu.username,
          pu.first_name,
          pu.last_name,
          pu.email,
          pu.phone,
          pu.utm_source,
          pu.tags,
          pu.ref_code,
          pu.is_unsubscribed,
          pu.last_contact_at,
          pu.created_at,
          pu.salebot_id,
          CASE
            WHEN pu.ref_code LIKE 'tg_%%_r_%%' THEN
              (SELECT c2.name FROM collaborators c2
               WHERE c2.personal_tg_id = split_part(pu.ref_code, '_r_', 2)
               LIMIT 1)
            ELSE NULL
          END AS referrer_name
        FROM platform_users pu
        WHERE pu.id = $1 AND pu.client_id = $2
    """, contact_id, client_id)

    if not row:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Not found")

    # События в которых участвует
    events = await db.fetch("""
        SELECT e.title, e.slug, ep.is_registered, ep.registered_at, ep.ref_code
        FROM event_participants ep
        JOIN events e ON e.id = ep.event_id
        WHERE ep.platform_user_id = $1
        ORDER BY ep.registered_at DESC
    """, contact_id)

    return {
        **dict(row),
        "events": [dict(e) for e in events]
    }
