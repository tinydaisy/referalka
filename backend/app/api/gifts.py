from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
from app.services.client_domains import client_public_link
import asyncpg

router = APIRouter(prefix="/events/{event_id}/gifts", tags=["Подарки"])

# Совместимый роутер для старого URL /api/v1/events/slug/{slug}/gifts/
# НЕ УДАЛЯТЬ — на этот маршрут завязан Mini App
router_compat = APIRouter(prefix="/events/slug", tags=["Подарки"])


class GiftCreate(BaseModel):
    title: str
    description: Optional[str] = None
    points_cost: int
    link_url: Optional[str] = None
    stock: int = -1
    sort_order: int = 0


async def check_event_owner(event_id: int, client_id: int, db: asyncpg.Connection):
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return event


@router.get("/", summary="Подарки события")
async def list_gifts(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    gifts = await db.fetch(
        "SELECT * FROM gifts WHERE event_id = $1 ORDER BY sort_order, points_cost",
        event_id
    )
    return {"gifts": [dict(g) for g in gifts]}


@router.post("/", summary="Добавить подарок")
async def create_gift(
    event_id: int,
    data: GiftCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    gift = await db.fetchrow(
        """
        INSERT INTO gifts (event_id, title, description, points_cost, link_url, stock, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
        """,
        event_id, data.title, data.description, data.points_cost,
        data.link_url, data.stock, data.sort_order
    )
    return {"gift": dict(gift)}


@router.patch("/{gift_id}", summary="Обновить подарок")
async def update_gift(
    event_id: int,
    gift_id: int,
    data: GiftCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    gift = await db.fetchrow(
        """
        UPDATE gifts SET title=$2, description=$3, points_cost=$4, link_url=$5, stock=$6, sort_order=$7
        WHERE id=$1 AND event_id=$8 RETURNING *
        """,
        gift_id, data.title, data.description, data.points_cost,
        data.link_url, data.stock, data.sort_order, event_id
    )
    if not gift:
        raise HTTPException(status_code=404, detail="Подарок не найден")
    return {"gift": dict(gift)}


@router.delete("/{gift_id}", summary="Удалить подарок")
async def delete_gift(
    event_id: int,
    gift_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM gifts WHERE id = $1 AND event_id = $2", gift_id, event_id)
    return {"message": "Подарок удалён"}


async def _referrer_link_params(
    event_id: int, tg_id: Optional[int], db: asyncpg.Connection
) -> dict:
    """Значения плейсхолдеров реф-кодов рефовода запрашивающего участника:

      {plsn_ref} — плюсоновский реф-код рефовода (contacts.ref_code). Для ссылки
                   регистрации в ПЛЮСОН: pluson.ru/register?pid={plsn_ref}.
                   /register сам резолвит код-контакт спикера в его клиентский
                   аккаунт (services/plusson_referral.py).
      {ext_ref}  — сторонний партнёрский код рефовода (contacts.external_ref_param,
                   напр. gcpc=fdd97). Для внешних систем: landing.ru/?{ext_ref}.

    Рефовод берётся из event_participants.referrer_ref_code участника (по tg_id).
    Нет tg_id / нет рефовода → пустые строки (плейсхолдеры исчезают)."""
    empty = {"plsn_ref": "", "ext_ref": ""}
    if not tg_id:
        return empty
    row = await db.fetchrow(
        """
        SELECT rc.ref_code, rc.external_ref_param
          FROM event_participants ep
          JOIN contacts c ON c.id = ep.contact_id
          JOIN platform_users pu ON pu.contact_id = c.id
          JOIN contacts rc ON (rc.ref_code = ep.referrer_ref_code
                               OR rc.merged_ref_codes ? ep.referrer_ref_code)
         WHERE ep.event_id = $1
           AND pu.platform_slug = 'telegram'
           AND pu.platform_user_id = $2
           AND ep.referrer_ref_code IS NOT NULL
         LIMIT 1
        """,
        event_id, str(tg_id),
    )
    if not row:
        return empty
    return {
        "plsn_ref": row["ref_code"] or "",
        "ext_ref": row["external_ref_param"] or "",
    }


async def _fetch_gifts_for_event(
    event_id: int, db: asyncpg.Connection, tg_id: Optional[int] = None
):
    """
    Подарки реф-программы из event_referral_thresholds + JOIN lead_magnets.
    Возвращает список в формате, который ждёт Mini App (id, title, description,
    points_cost, link_url, sort_order).

    В link_url/certificate_url раскрываются плейсхолдеры {plsn_ref}/{ext_ref} —
    реф-коды рефовода участника (по tg_id). Единый синтаксис с воронками
    лид-магнитов (funnel_service). Клиент сам решает, в какой подарок вписать.
    """
    rows = await db.fetch(
        """
        SELECT t.id,
               COALESCE(NULLIF(lm.name, ''), 'Подарок') AS title,
               lm.description                          AS description,
               t.threshold_count                       AS points_cost,
               lm.url                                  AS link_url,
               lm.slug                                 AS lm_slug,
               lm.client_id                            AS lm_client_id,
               t.certificate_url                       AS certificate_url,
               t.sort                                  AS sort_order
          FROM event_referral_thresholds t
          LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
         WHERE t.event_id = $1
         ORDER BY t.sort, t.threshold_count
        """,
        event_id,
    )
    gifts = [dict(r) for r in rows]

    # Галочка «выдавать подарки через воронку» (event_referral_settings.
    # gift_via_funnel). Вкл → link_url подарка ведёт на воронку /m/{slug}
    # (проверка подписки + follow-up), а не сразу на файл. Плейсхолдеры {plsn_ref}/
    # {ext_ref} тогда раскрывает сама воронка (funnel_service).
    # ⚠️ Домен — у ВЛАДЕЛЬЦА магнита: воронку обслуживает его кабинет и его бот.
    via_funnel = await db.fetchval(
        "SELECT gift_via_funnel FROM event_referral_settings WHERE event_id = $1",
        event_id,
    )
    if via_funnel:
        for g in gifts:
            if g.get("lm_slug"):
                g["link_url"] = await client_public_link(
                    db, g.get("lm_client_id"), f"m/{g['lm_slug']}")

    # Подставляем плейсхолдеры только если они реально встречаются — иначе не
    # трогаем БД лишним запросом рефовода. (При via_funnel прямые url заменены на
    # воронку, где плейсхолдеров нет — подстановка тут просто не сработает.)
    def _has_ph(s):
        return "{plsn_ref}" in (s or "") or "{ext_ref}" in (s or "")

    if any(_has_ph(g.get("link_url")) or _has_ph(g.get("certificate_url")) for g in gifts):
        params = await _referrer_link_params(event_id, tg_id, db)
        for g in gifts:
            for field in ("link_url", "certificate_url"):
                if g.get(field):
                    for k, v in params.items():
                        g[field] = g[field].replace("{" + k + "}", v or "")

    for g in gifts:
        g.pop("lm_slug", None)
        g.pop("lm_client_id", None)   # служебное поле резолва домена
    return gifts


@router.get("/public/{event_slug}", summary="Подарки для Mini App (публично)")
async def list_gifts_public(
    event_slug: str,
    tg_id: Optional[int] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    event = await db.fetchrow("SELECT id FROM events WHERE slug = $1", event_slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"gifts": await _fetch_gifts_for_event(event["id"], db, tg_id)}


@router_compat.get("/{event_slug}/gifts/", summary="Подарки для Mini App — совместимый URL")
async def list_gifts_by_slug(
    event_slug: str,
    tg_id: Optional[int] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    event = await db.fetchrow("SELECT id FROM events WHERE slug = $1", event_slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"gifts": await _fetch_gifts_for_event(event["id"], db, tg_id)}
