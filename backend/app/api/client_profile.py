"""
Профиль клиента (Экосистема) — визитка + продукты.

Используется в Mini App в Хабе организатора во вкладке «🌐 Экосистема»,
а также для блока «А дальше» на завершённом событии и ленты Календаря.

Публичные эндпоинты (без авторизации, для Mini App):
  GET /api/v1/public/clients/{client_id}/profile
  GET /api/v1/public/clients/{client_id}/offerings
  GET /api/v1/public/clients/{client_id}/events?bucket=now|upcoming|past
  GET /api/v1/public/events/{slug}/landing

Приватные эндпоинты (авторизация клиента):
  GET   /api/v1/clients/me/profile      — получить свою визитку
  PATCH /api/v1/clients/me/profile      — обновить визитку
  GET   /api/v1/client-offerings        — список продуктов
  POST  /api/v1/client-offerings        — создать продукт
  PATCH /api/v1/client-offerings/{id}   — обновить продукт
  DELETE /api/v1/client-offerings/{id}  — удалить продукт
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Optional, Any
import asyncpg
import json

import httpx

from app.database import get_db, get_pool
from app.auth import get_current_client
from app.services.event_welcome import send_event_open_message
from app.services.social_links import normalize_social_links, normalize_telegram_link, telegram_api_id
from app.services.external_landing import (
    resolve_external_ref_param,
    resolve_referrer_external_ref_param,
    build_external_landing_url,
    resolve_or_create_participant,
)
from app.config import settings


# ═══════════════════════════════════════════
# ПУБЛИЧНЫЕ ЭНДПОИНТЫ (Mini App)
# ═══════════════════════════════════════════
public = APIRouter(prefix="/public", tags=["Публичный профиль клиента"])


# ─── Трекинг кликов по карточке спикера в Mini App (миграция 109) ──────────
class SpeakerClickIn(BaseModel):
    kind: str  # 'tg_channel' | 'vk' | 'max' | 'instagram' | 'website' | 'knowledge_base'
    tg_id: Optional[str] = None
    vk_user_id: Optional[str] = None
    max_user_id: Optional[str] = None


_ALLOWED_CLICK_KINDS = {'tg_channel', 'vk', 'max', 'instagram', 'website', 'knowledge_base'}


@public.post("/events/{event_id}/speakers/{ec_id}/click-track",
             summary="Записать клик участника по ссылке в карточке спикера в Mini App")
async def track_speaker_click(
    event_id: int,
    ec_id: int,
    body: SpeakerClickIn,
    db: asyncpg.Connection = Depends(get_db),
):
    """Mini App вызывает перед openLink. Резолвит contact_id по платформенной
    идентичности (если передана), пишет строку в event_collaborator_clicks.
    Анонимные клики (без tg_id/vk_id) тоже записываются — contact_id NULL."""
    kind = (body.kind or "").strip().lower()
    if kind not in _ALLOWED_CLICK_KINDS:
        raise HTTPException(status_code=400, detail=f"Неверный kind: {kind}")

    # Проверяем что коллаб реально привязан к этому событию
    coll = await db.fetchrow(
        """SELECT cse.id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id
             FROM event_collaborators cse
             JOIN events e ON e.id = cse.event_id
            WHERE cse.id = $1 AND cse.event_id = $2""",
        ec_id, event_id,
    )
    if not coll:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    # Резолвим contact_id по любой платформе
    contact_id: Optional[int] = None
    if body.tg_id:
        contact_id = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'telegram' AND platform_user_id = $2
                LIMIT 1""",
            coll["client_id"], str(body.tg_id),
        )
    if not contact_id and body.vk_user_id:
        contact_id = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'vk' AND platform_user_id = $2
                LIMIT 1""",
            coll["client_id"], str(body.vk_user_id),
        )
    if not contact_id and body.max_user_id:
        contact_id = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'max' AND platform_user_id = $2
                LIMIT 1""",
            coll["client_id"], str(body.max_user_id),
        )

    # Снапшот идентичностей контакта (миграция 110): чтобы клик пережил
    # удаление контакта (152-ФЗ) и в статистике остался виден кто кликнул.
    snap_name: Optional[str] = None
    snap_tg_id: Optional[str] = str(body.tg_id) if body.tg_id else None
    snap_tg_nickname: Optional[str] = None
    snap_vk_id: Optional[str] = str(body.vk_user_id) if body.vk_user_id else None
    snap_max_id: Optional[str] = str(body.max_user_id) if body.max_user_id else None

    if contact_id:
        # Берём имя из contacts, ники из platform_users (если контакт известен).
        snap_row = await db.fetchrow(
            """SELECT c.name AS name,
                      (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id=c.id AND pu.platform_slug='telegram' LIMIT 1) AS tg_id,
                      (SELECT pu.username FROM platform_users pu
                        WHERE pu.contact_id=c.id AND pu.platform_slug='telegram' LIMIT 1) AS tg_nickname,
                      (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id=c.id AND pu.platform_slug='vk' LIMIT 1) AS vk_id,
                      (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id=c.id AND pu.platform_slug='max' LIMIT 1) AS max_id
                 FROM contacts c WHERE c.id = $1""",
            contact_id,
        )
        if snap_row:
            snap_name = (snap_row["name"] or "").strip() or None
            snap_tg_id = snap_tg_id or snap_row["tg_id"]
            snap_tg_nickname = (snap_row["tg_nickname"] or "").strip() or None
            snap_vk_id = snap_vk_id or snap_row["vk_id"]
            snap_max_id = snap_max_id or snap_row["max_id"]

    await db.execute(
        """INSERT INTO event_collaborator_clicks
              (event_collaborator_id, contact_id, click_kind,
               contact_name, tg_id, tg_nickname, vk_id, max_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)""",
        ec_id, contact_id, kind,
        snap_name, snap_tg_id, snap_tg_nickname, snap_vk_id, snap_max_id,
    )
    return {"ok": True}


def _parse_jsonb(v: Any, default):
    if v is None:
        return default
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return default


@public.get("/clients/{client_id}/profile", summary="Визитка клиента (для Mini App)")
async def public_client_profile(client_id: int, db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """SELECT id, name, telegram_username,
                  brand_name, brand_logo_url, profile_photo_url, positioning, achievements,
                  owner_photo_url, owner_positioning, owner_achievements,
                  bio, social_links, events_tab_visibility
             FROM clients
            WHERE id = $1 AND is_active = TRUE""",
        client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    d = dict(row)
    d["achievements"]       = _parse_jsonb(d.get("achievements"), [])
    d["owner_achievements"] = _parse_jsonb(d.get("owner_achievements"), [])
    d["social_links"]       = _parse_jsonb(d.get("social_links"), {})
    return d


@public.get("/clients/{client_id}/offerings", summary="Продукты клиента (для Mini App)")
async def public_client_offerings(client_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, title, description, action_url, is_paid, cover_url, sort_order
             FROM client_offerings
            WHERE client_id = $1
            ORDER BY is_paid DESC, sort_order, id""",
        client_id
    )
    items = [dict(r) for r in rows]
    return {
        "paid":  [i for i in items if i["is_paid"]],
        "free":  [i for i in items if not i["is_paid"]],
    }


@public.get("/clients/{client_id}/events", summary="События клиента, разбитые на бакеты")
async def public_client_events(
    client_id: int,
    bucket: Optional[str] = Query(None, description="now | upcoming | past — если не задан, возвращает все три"),
    tg_id: Optional[int] = Query(None, description="Telegram ID — для расчёта participation_status"),
    db: asyncpg.Connection = Depends(get_db),
):
    # Для конференций start_at/end_at в events игнорируем —
    # источник истины это conf_days (программа дней). Для остальных
    # типов событий берём поля из events напрямую.
    # Если задан tg_id — добавляем participation_status:
    #   'new' (нет записи в event_participants) | 'interested' (есть, не зарегистрирован) | 'registered'.
    rows = await db.fetch(
        """WITH conf_dates AS (
              -- Для конференций/турниров дата старта/окончания события =
              -- MIN/MAX между датами программы (conf_days) и датами этапов
              -- (conf_stages). Этап может существовать без детальных дней
              -- (напр. «Предстарт 15–26 июн»), и его даты тоже должны
              -- учитываться — иначе турнир со старшим conf_days, но ранним
              -- этапом, уезжает в конец списка ниже мероприятий, которые
              -- по факту начинаются позже.
              -- LEAST/GREATEST в Postgres игнорируют NULL — если этапов
              -- или дней нет, используется только то, что есть.
              SELECT e.id AS event_id,
                     LEAST(
                       (SELECT (d2.day_date + COALESCE(
                                  NULLIF(d2.open_time,'')::time,
                                  (SELECT MIN(NULLIF(s.start_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                  '00:00'::time
                                )) AT TIME ZONE 'Europe/Moscow'
                          FROM conf_days d2
                          WHERE d2.event_id = e.id AND d2.day_date IS NOT NULL
                          ORDER BY d2.day_date ASC LIMIT 1),
                       (SELECT MIN(st.start_date::timestamp AT TIME ZONE 'Europe/Moscow')
                          FROM conf_stages st
                          WHERE st.event_id = e.id AND st.start_date IS NOT NULL)
                     ) AS start_at,
                     GREATEST(
                       (SELECT (d2.day_date + COALESCE(
                                  NULLIF(d2.close_time,'')::time,
                                  (SELECT MAX(NULLIF(s.end_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                  (SELECT MAX(NULLIF(s.start_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                  '23:59'::time
                                )) AT TIME ZONE 'Europe/Moscow'
                          FROM conf_days d2
                          WHERE d2.event_id = e.id AND d2.day_date IS NOT NULL
                          ORDER BY d2.day_date DESC LIMIT 1),
                       (SELECT MAX((st.end_date + '23:59'::time) AT TIME ZONE 'Europe/Moscow')
                          FROM conf_stages st
                          WHERE st.event_id = e.id AND st.end_date IS NOT NULL)
                     ) AS end_at
                FROM events e
               WHERE e.module_slug IN ('conference', 'turnir')
            ),
            user_participation AS (
              SELECT ep.event_id, ep.is_registered
                FROM event_participants ep
                JOIN contacts c        ON c.id  = ep.contact_id
                JOIN platform_users pu ON pu.contact_id = c.id
               WHERE pu.platform_slug = 'telegram'
                 AND pu.platform_user_id = $2
            )
            -- Для конференций приоритет — даты программы (conf_days). Но если
            -- программа ещё не заведена, а в events.start_at дата уже выставлена —
            -- fallback на неё, чтобы событие не «проваливалось» в конец из-за NULL
            -- (видно в Mini App «Календарь»: «Ж.И.В.У.» без conf_days оказывалось
            -- ниже мероприятия с более поздним start_at).
            SELECT e.id, e.slug, e.title, e.description, e.module_slug,
                   (SELECT url FROM event_posters
                     WHERE event_id = e.id
                     ORDER BY CASE orientation
                                WHEN 'square'     THEN 1
                                WHEN 'horizontal' THEN 2
                                WHEN 'vertical'   THEN 3
                                ELSE 4
                              END, sort, id
                     LIMIT 1) AS poster_url,
                   e.status,
                   COALESCE(
                     CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END,
                     e.start_at
                   ) AS start_at,
                   COALESCE(
                     CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at END,
                     e.end_at
                   ) AS end_at,
                   CASE
                     WHEN COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at) IS NULL
                       OR COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at)   IS NULL
                          THEN 'upcoming'
                     WHEN NOW() BETWEEN
                          COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at)
                          AND
                          COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at)
                          THEN 'now'
                     WHEN COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at) < NOW()
                          THEN 'past'
                     ELSE 'upcoming'
                   END AS bucket,
                   CASE
                     WHEN $2::text IS NULL          THEN NULL
                     WHEN up.event_id IS NULL       THEN 'new'
                     WHEN up.is_registered IS TRUE  THEN 'registered'
                     ELSE 'interested'
                   END AS participation_status
              FROM events e
              LEFT JOIN conf_dates cd        ON cd.event_id = e.id
              LEFT JOIN user_participation up ON up.event_id = e.id
             WHERE EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=$1 AND eo.status='accepted') AND e.status IN ('published','ended')
             ORDER BY COALESCE(
                        CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END,
                        e.start_at
                      ) NULLS LAST""",
        client_id,
        str(tg_id) if tg_id else None,
    )
    items = [dict(r) for r in rows]
    if bucket:
        items = [i for i in items if i["bucket"] == bucket]
        return {"items": items}
    return {
        "now":      [i for i in items if i["bucket"] == "now"],
        "upcoming": [i for i in items if i["bucket"] == "upcoming"],
        "past":     [i for i in items if i["bucket"] == "past"],
    }


@public.get(
    "/events/{event_id}/share-texts",
    summary="Тексты-примеры реф-программы для шеринга (публично, для Mini App)"
)
async def public_share_texts(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, content, sort
             FROM event_referral_share_texts
            WHERE event_id = $1
            ORDER BY sort, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@public.get(
    "/events/{event_id}/share-materials",
    summary="Картинки и видео реф-программы для шеринга (публично, для Mini App)"
)
async def public_share_materials(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, media_type, image_url, video_url, source, sort
             FROM event_referral_materials
            WHERE event_id = $1
            ORDER BY sort, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@public.get("/events/{event_id}/collaborators", summary="Коллабораторы события (публично, для Mini App)")
async def public_event_collaborators(
    event_id: int,
    role: Optional[str] = None,  # 'organizer' / 'speaker' / 'partner' / None=все
    db: asyncpg.Connection = Depends(get_db),
):
    sql = """
        SELECT ec.id, ec.role, ec.sort_order,
               co.id AS collaborator_id, co.name, co.title, co.photo_url,
               co.achievements, co.tg_channel_url, co.instagram_url,
               co.website_url,
               pu_tg.username AS personal_tg_username
          FROM event_collaborators ec
          JOIN collaborators co ON co.id = ec.speaker_id
          LEFT JOIN platform_users pu_tg
            ON pu_tg.contact_id = co.contact_id AND pu_tg.platform_slug = 'telegram'
         WHERE ec.event_id = $1 AND ec.is_visible = TRUE
    """
    args: list[Any] = [event_id]
    if role:
        args.append(role)
        sql += f" AND ec.role = ${len(args)}"
    # Тот же порядок, что и в очереди рассылок (broadcasts.py: speaker_intro):
    # ORDER BY priority, sort_order, id — даём клиенту единую логику приоритета.
    sql += " ORDER BY ec.priority NULLS LAST, ec.sort_order, ec.id"
    rows = await db.fetch(sql, *args)
    return {"items": [dict(r) for r in rows]}


@public.get("/events/{event_id}/raffle/prizes", summary="Призы розыгрыша (публично, для Mini App)")
async def public_raffle_prizes(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order
             FROM event_raffle_prizes
            WHERE event_id = $1 AND is_active = TRUE
            ORDER BY sort_order, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@public.get("/events/{event_id}/raffle/settings", summary="Настройки розыгрыша (публично, для Mini App)")
async def public_raffle_settings(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """SELECT is_enabled, draw_at, subscription_grants_starter_ticket, intro_text
             FROM event_raffle_settings WHERE event_id = $1""",
        event_id
    )
    if not row:
        return {"is_enabled": False, "draw_at": None, "subscription_grants_starter_ticket": True, "intro_text": None}
    return dict(row)


@public.get(
    "/events/{slug}/landing-redirect",
    summary="Узкий endpoint для inline-скрипта Mini App: куда редиректить ДО React",
)
async def public_event_landing_redirect(
    slug: str,
    background_tasks: BackgroundTasks,
    tg_id: Optional[int] = None,
    vk_id: Optional[int] = None,
    platform: Optional[str] = None,  # неиспользуется, оставлен для совместимости со старыми клиентами
    pid: Optional[str] = None,
    utm_source: Optional[str] = None,
    q: Optional[str] = None,  # CSV произвольных флагов: ?q=shpw,vip → &shpw=1&vip=1 на лендинге
    db: asyncpg.Connection = Depends(get_db),
):
    """Если событию задан landing_url и пользователь ещё не зарегистрирован
    (или tg_id не передан) — возвращает {redirect_url: ...} с пробросом
    параметров. Иначе пустой объект. Используется в mini-app/index.html
    inline-скриптом для мгновенного редиректа на сторонний лендинг."""
    row = await db.fetchrow(
        "SELECT id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, landing_url, status FROM events WHERE slug = $1 LIMIT 1",
        slug,
    )
    if not row:
        return {}
    if row["status"] != "published":
        return {}
    landing_url = (row["landing_url"] or "").strip()
    if not landing_url:
        return {}

    # Если уже зарегистрирован — не редиректим (Mini App покажет welcome
    # или сразу Программу).
    if tg_id is not None:
        is_reg = await db.fetchval(
            """SELECT ep.is_registered
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id
                WHERE ep.event_id = $1
                  AND pu.platform_slug = 'telegram'
                  AND pu.platform_user_id = $2
                LIMIT 1""",
            row["id"], str(tg_id),
        )
        if is_reg:
            return {}

    # Резолвим (или UPSERT-им) participant_id + contact_id из tg_id/vk_id,
    # чтобы подсунуть в URL стороннего лендинга оба идентификатора:
    #   - participant_id — для webhook /integrations/getcourse/register
    #     (пометить регистрацию + обновить email/phone)
    #   - contact_id — для webhook /integrations/getcourse/external-ref
    #     (обновить партнёрский код внешней системы клиента)
    # Для нового человека без contact (ещё не было event_start) оба будут None
    # и параметры просто не попадут в URL.
    participant_id_out: Optional[int] = None
    contact_id_out: Optional[int] = None
    if tg_id is not None:
        participant_id_out, contact_id_out = await resolve_or_create_participant(
            db, client_id=row["client_id"], event_id=row["id"],
            platform_slug='telegram', platform_user_id=str(tg_id),
            utm_source=utm_source, partner_id=pid,
        )
    elif vk_id is not None:
        participant_id_out, contact_id_out = await resolve_or_create_participant(
            db, client_id=row["client_id"], event_id=row["id"],
            platform_slug='vk', platform_user_id=str(vk_id),
            utm_source=utm_source, partner_id=pid,
        )

    # Поля контакта (name/email/phone) + платформенные идентичности (tg/vk/tg_nickname)
    from app.services.external_landing import get_contact_landing_params
    contact_params = await get_contact_landing_params(db, contact_id_out) if contact_id_out else {}

    # external_ref_param для URL — код РЕФОВОДА (не самого контакта):
    # приоритет pid → event_participants.referrer_ref_code → first_referrer_contact_id.
    erp_to_use = await resolve_referrer_external_ref_param(
        db, row["client_id"],
        pid=pid,
        participant_id=participant_id_out,
        contact_id=contact_id_out,
    )

    redirect_url = build_external_landing_url(
        landing_url,
        event_slug=slug,
        participant_id=participant_id_out,
        contact_id=contact_id_out,
        pid=pid,
        utm_source=utm_source,
        external_ref_param=erp_to_use,
        flags=q,
        **contact_params,  # name/email/phone/tg_id/vk_id/tg_nickname (только непустые)
    )

    # При редиректе на сторонний лендинг React-bundle Mini App не запустится →
    # POST /event не придёт. Шлём контекстное приветствие в бот сами,
    # фоном — чтобы не задерживать ответ. tg_id обязателен (без него некому слать).
    if tg_id is not None:
        pool = await get_pool()
        if pool:
            background_tasks.add_task(
                send_event_open_message,
                pool,
                tg_id=int(tg_id),
                event_slug=slug,
                client_id_hint=row["client_id"],
                partner_id=pid or "",
            )

    return {"redirect_url": redirect_url}


@public.get(
    "/events/{slug}/vip-redirect",
    summary="Обогащённый URL VIP-тарифа с GET-параметрами контакта (миграция 105+)",
)
async def public_event_vip_redirect(
    slug: str,
    tg_id: Optional[int] = None,
    vk_id: Optional[int] = None,
    pid: Optional[str] = None,
    utm_source: Optional[str] = None,
    q: Optional[str] = None,  # CSV произвольных флагов — см. /landing-redirect
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает {redirect_url: ...} — событийный VIP URL с приписанными
    GET-параметрами контакта (pluson_contact_id, pluson_participant_id,
    tg_id/vk_id, email, phone, name, tg_nickname, external_ref_param).
    Mini App кнопка «VIP-тариф» открывает window.location.href = redirect_url.
    Если у события нет vip_url или vip-тариф выключен — {redirect_url: null}.
    """
    row = await db.fetchrow(
        """SELECT id, vip_url,
                  (SELECT eo.client_id FROM event_owners eo
                    WHERE eo.event_id = events.id AND eo.status = 'accepted'
                    ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
             FROM events WHERE slug = $1 LIMIT 1""",
        slug,
    )
    if not row:
        return {"redirect_url": None}
    vip_url = (row["vip_url"] or "").strip()
    if not vip_url:
        return {"redirect_url": None}

    from app.services.external_landing import (
        get_contact_landing_params,
        enrich_external_url,
    )

    # Контакт + participant_id из tg_id/vk_id (если переданы)
    participant_id_out: Optional[int] = None
    contact_id_out: Optional[int] = None
    if tg_id is not None:
        participant_id_out, contact_id_out = await resolve_or_create_participant(
            db, client_id=row["client_id"], event_id=row["id"],
            platform_slug='telegram', platform_user_id=str(tg_id),
            utm_source=utm_source, partner_id=pid,
        )
    elif vk_id is not None:
        participant_id_out, contact_id_out = await resolve_or_create_participant(
            db, client_id=row["client_id"], event_id=row["id"],
            platform_slug='vk', platform_user_id=str(vk_id),
            utm_source=utm_source, partner_id=pid,
        )

    contact_params = await get_contact_landing_params(db, contact_id_out) if contact_id_out else {}
    erp_to_use = await resolve_referrer_external_ref_param(
        db, row["client_id"],
        pid=pid,
        participant_id=participant_id_out,
        contact_id=contact_id_out,
    )

    enriched = enrich_external_url(
        vip_url,
        pluson_contact_id=contact_id_out,
        pluson_participant_id=participant_id_out,
        pid=pid,
        utm_source=utm_source,
        event_slug=slug,
        external_ref_param=erp_to_use,
        flags=q,
        **contact_params,
    )
    return {"redirect_url": enriched}


@public.get(
    "/events/{slug}/external-ref",
    summary="Партнёрский параметр внешней платформы клиента по pid (gcpc=fdd97 и т.p.)",
)
async def public_event_external_ref(
    slug: str,
    pid: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    """Резолвит pid → contacts.external_ref_param. Используется в SSR /l/[slug]
    и в Mini App SPA-навигации (когда landing-redirect ДО React не сработал —
    например, для draft-событий или при внутренней навигации внутри Mini App).
    Работает независимо от status события. Если pid не привязан к контакту
    с external_ref_param — возвращает {external_ref_param: null}."""
    if not pid:
        return {"external_ref_param": None}
    row = await db.fetchrow(
        "SELECT (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE slug = $1 LIMIT 1", slug,
    )
    if not row:
        return {"external_ref_param": None}
    value = await resolve_external_ref_param(db, row["client_id"], pid)
    return {"external_ref_param": value}


@public.get(
    "/events/{slug}/bot-handle",
    summary="Handle telegram-бота для события (VIP-клиент или общий @pluson_bot)",
)
async def public_event_bot_handle(slug: str, db: asyncpg.Connection = Depends(get_db)):
    """Используется страницей /r/{slug} в fallback'е — отдаёт client_id события
    и handle бота (для информации о VIP-статусе)."""
    row = await db.fetchrow(
        "SELECT (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE slug = $1 LIMIT 1", slug,
    )
    if not row:
        return {"bot_handle": "pluson_bot", "is_vip_bot": False, "client_id": None}
    vip_handle = await db.fetchval(
        """SELECT ch.handle
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
              AND cc.is_active = TRUE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id LIMIT 1""",
        row["client_id"],
    )
    if vip_handle:
        return {"bot_handle": vip_handle.lstrip('@'), "is_vip_bot": True, "client_id": row["client_id"]}
    return {"bot_handle": "pluson_bot", "is_vip_bot": False, "client_id": row["client_id"]}


@public.get("/events/{slug}/landing", summary="Данные лендинга события (для Mini App до регистрации)")
async def public_event_landing(slug: str, db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """WITH cd AS (
              -- start = первый день: open_time дня 1, иначе MIN(start_time) сессий дня 1
              -- end   = последний день: close_time, иначе MAX(end_time) сессий посл. дня
              SELECT d.event_id,
                     (SELECT (d2.day_date + COALESCE(
                                NULLIF(d2.open_time,'')::time,
                                (SELECT MIN(NULLIF(s.start_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                '00:00'::time
                              )) AT TIME ZONE 'Europe/Moscow'
                        FROM conf_days d2
                        WHERE d2.event_id = d.event_id AND d2.day_date IS NOT NULL
                        ORDER BY d2.day_date ASC LIMIT 1) AS start_at,
                     (SELECT (d2.day_date + COALESCE(
                                NULLIF(d2.close_time,'')::time,
                                (SELECT MAX(NULLIF(s.end_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                (SELECT MAX(NULLIF(s.start_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                '23:59'::time
                              )) AT TIME ZONE 'Europe/Moscow'
                        FROM conf_days d2
                        WHERE d2.event_id = d.event_id AND d2.day_date IS NOT NULL
                        ORDER BY d2.day_date DESC LIMIT 1) AS end_at
                FROM conf_days d
               GROUP BY d.event_id
            )
            SELECT e.id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, e.slug, e.title, e.description,
                   e.description_post_register, e.module_slug,
                   (SELECT url FROM event_posters
                     WHERE event_id = e.id
                     ORDER BY CASE orientation
                                WHEN 'square'     THEN 1
                                WHEN 'horizontal' THEN 2
                                WHEN 'vertical'   THEN 3
                                ELSE 4
                              END, sort, id
                     LIMIT 1) AS poster_url,
                   e.landing_url, e.address, e.status,
                   CASE WHEN e.module_slug IN ('conference','turnir')
                        THEN cd.start_at ELSE e.start_at END AS start_at,
                   CASE WHEN e.module_slug IN ('conference','turnir')
                        THEN cd.end_at   ELSE e.end_at   END AS end_at,
                   e.vip_url, e.vip_button_label,
                   (SELECT chat_url FROM client_broadcast_chats
                      WHERE id = CASE e.primary_chat_platform
                                   WHEN 'vk'  THEN e.vk_chat_ref
                                   WHEN 'max' THEN e.max_chat_ref
                                   ELSE e.tg_chat_ref END) AS chat_url,
                   (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS chat_url_tg,
                   (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS chat_url_vk,
                   (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS chat_url_max,
                   e.primary_chat_platform,
                   e.chat_member_count_label, e.chat_button_label, e.accent_button,
                   e.require_subscription,
                   e.stream_url, e.hide_stream_button, e.skip_contact_form,
                   c.name AS client_name, c.brand_name AS client_brand,
                   c.profile_photo_url AS client_photo,
                   c.brand_logo_url AS client_brand_logo,
                   (SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                      FROM channels ch
                      JOIN client_channels cc ON cc.channel_id = ch.id
                     WHERE cc.client_id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
                       AND ch.platform_slug = 'telegram'
                       AND cc.is_active = TRUE
                       AND ch.is_system = FALSE
                       AND ch.bot_token IS NOT NULL
                     LIMIT 1) AS client_bot_handle,
                   COALESCE((SELECT is_enabled FROM event_referral_settings
                              WHERE event_id = e.id), FALSE) AS referral_enabled,
                   COALESCE((SELECT is_enabled FROM event_raffle_settings
                              WHERE event_id = e.id), FALSE) AS raffle_enabled
              FROM events e
              JOIN clients c ON c.id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
              LEFT JOIN cd ON cd.event_id = e.id
             WHERE e.slug = $1""",
        slug
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    d = dict(row)

    # Афиши события (горизонтальные используем как hero)
    posters = await db.fetch(
        """SELECT url, orientation FROM event_posters
            WHERE event_id = $1 ORDER BY sort, id""",
        row["id"]
    )
    d["posters"] = [dict(p) for p in posters]

    # Successor — автоматически: ближайшее опубликованное событие того же
    # клиента, начинающееся ПОСЛЕ конца текущего. Для конференций start_at
    # берём из conf_days (MIN day_date + open_time, Europe/Moscow), для
    # остальных модулей — events.start_at. Текущее событие исключаем.
    succ = await db.fetchrow(
        """WITH ev_start AS (
              SELECT e.id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, e.slug, e.title, e.module_slug, e.status,
                     CASE WHEN e.module_slug IN ('conference','turnir') THEN
                       (SELECT (d.day_date + COALESCE(
                                  NULLIF(d.open_time,'')::time,
                                  (SELECT MIN(NULLIF(s.start_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = e.id AND s.day = d.day_number),
                                  '00:00'::time
                                )) AT TIME ZONE 'Europe/Moscow'
                          FROM conf_days d
                         WHERE d.event_id = e.id AND d.day_date IS NOT NULL
                         ORDER BY d.day_date ASC LIMIT 1)
                     ELSE e.start_at END AS start_at
                FROM events e
            )
            SELECT s.id, s.slug, s.title, s.start_at,
                   (SELECT url FROM event_posters
                     WHERE event_id = s.id
                     ORDER BY CASE orientation
                                WHEN 'square'     THEN 1
                                WHEN 'horizontal' THEN 2
                                WHEN 'vertical'   THEN 3
                                ELSE 4
                              END, sort, id
                     LIMIT 1) AS poster_url
              FROM ev_start s
             WHERE s.client_id = $1
               AND s.status = 'published'
               AND s.id <> $2
               AND s.start_at IS NOT NULL
               AND s.start_at > COALESCE($3::timestamptz, NOW())
             ORDER BY s.start_at ASC
             LIMIT 1""",
        row["client_id"], row["id"], d.get("end_at") or d.get("start_at")
    )
    d["successor"] = dict(succ) if succ else None

    return d


# ═══════════════════════════════════════════
# ПРИВАТНЫЕ ЭНДПОИНТЫ (дашборд клиента)
# ═══════════════════════════════════════════
profile_router = APIRouter(prefix="/clients/me", tags=["Профиль клиента"])


class ProfileUpdate(BaseModel):
    # Бренд
    brand_name:         Optional[str]  = None
    brand_logo_url:     Optional[str]  = None       # логотип в углу страниц
    profile_photo_url:  Optional[str]  = None       # фото бренда
    positioning:        Optional[str]  = None       # позиционирование бренда
    achievements:       Optional[list] = None       # [{label, value}] факты бренда
    # Основатель (имя берётся из clients.name — не редактируется в UI)
    owner_photo_url:    Optional[str]  = None
    owner_positioning:  Optional[str]  = None
    owner_achievements: Optional[list] = None       # [{label, value}] факты основателя
    bio:                Optional[str]  = None       # биография основателя
    social_links:       Optional[dict] = None       # соцсети основателя
    # Общая настройка открытия ссылок: 'miniapp' | 'bot'
    default_link_mode:  Optional[str]  = None
    # Приветствие /start у бота клиента
    start_greeting_text:    Optional[str] = None
    start_btn_events_label: Optional[str] = None
    start_btn_owner_label:  Optional[str] = None
    # Что открывать при /start: 'greeting' | 'event' | 'lead_magnet'
    start_mode:     Optional[str] = None
    start_event_id: Optional[int] = None
    start_lead_magnet_id: Optional[int] = None
    start_package_id:     Optional[int] = None
    # Видимость вкладки «События»: 'always' | 'active' | 'any'
    events_tab_visibility: Optional[str] = None


@profile_router.get("/profile", summary="Получить свою визитку")
async def get_my_profile(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await db.fetchrow(
        """SELECT id, name, telegram_username, email,
                  brand_name, brand_logo_url, profile_photo_url, positioning, achievements,
                  owner_photo_url, owner_positioning, owner_achievements,
                  bio, social_links,
                  default_link_mode, start_greeting_text,
                  start_btn_events_label, start_btn_owner_label,
                  start_mode, start_event_id,
                  start_lead_magnet_id, start_package_id,
                  events_tab_visibility
             FROM clients WHERE id = $1""",
        int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    d = dict(row)
    d["achievements"]       = _parse_jsonb(d.get("achievements"), [])
    d["owner_achievements"] = _parse_jsonb(d.get("owner_achievements"), [])
    d["social_links"]       = _parse_jsonb(d.get("social_links"), {})
    return d


@profile_router.patch("/profile", summary="Обновить визитку")
async def update_my_profile(
    data: ProfileUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    sets: list[str] = []
    args: list[Any] = []

    def add(field: str, value: Any, jsonb: bool = False):
        sets.append(f"{field} = ${len(args)+1}" + ("::jsonb" if jsonb else ""))
        args.append(json.dumps(value) if jsonb else value)

    # ⚠️ Очистка полей (удалить фото/регалии/текст) работает через ПРИСУТСТВИЕ
    #   ключа в запросе, а не значение. Pydantic не различает «прислали null»
    #   и «не прислали» по `is None`, поэтому смотрим model_fields_set: поле
    #   есть в JSON (хоть null, хоть "") → применяем (очищаем на None); нет → не трогаем.
    fs = data.model_fields_set

    if "brand_name"        in fs: add("brand_name",        data.brand_name or None)
    if "brand_logo_url"    in fs: add("brand_logo_url",    data.brand_logo_url or None)
    if "profile_photo_url" in fs: add("profile_photo_url", data.profile_photo_url or None)
    if "positioning"       in fs: add("positioning",       data.positioning or None)
    if "achievements"      in fs: add("achievements",      data.achievements or [], jsonb=True)

    if "owner_photo_url"    in fs: add("owner_photo_url",    data.owner_photo_url or None)
    if "owner_positioning"  in fs: add("owner_positioning",  data.owner_positioning or None)
    if "owner_achievements" in fs: add("owner_achievements", data.owner_achievements or [], jsonb=True)

    if "bio"          in fs: add("bio",          data.bio or None)

    if data.default_link_mode is not None:
        if data.default_link_mode not in ("miniapp", "bot"):
            raise HTTPException(status_code=400, detail="default_link_mode должен быть 'miniapp' или 'bot'")
        add("default_link_mode", data.default_link_mode)
    if data.events_tab_visibility is not None:
        if data.events_tab_visibility not in ("always", "active", "any"):
            raise HTTPException(status_code=400, detail="events_tab_visibility должен быть 'always', 'active' или 'any'")
        add("events_tab_visibility", data.events_tab_visibility)
    if data.start_greeting_text    is not None: add("start_greeting_text",    data.start_greeting_text or None)
    if data.start_btn_events_label is not None: add("start_btn_events_label", data.start_btn_events_label or None)
    if data.start_btn_owner_label  is not None: add("start_btn_owner_label",  data.start_btn_owner_label or None)

    if data.start_mode is not None:
        if data.start_mode not in ("greeting", "event", "lead_magnet"):
            raise HTTPException(status_code=400, detail="start_mode должен быть 'greeting', 'event' или 'lead_magnet'")
        add("start_mode", data.start_mode)
    if data.start_event_id is not None:
        # 0 / отрицательное → сбросить выбор. Иначе — событие ОБЯЗАНО принадлежать
        # этому клиенту (иначе межклиентская утечка: бот показал бы чужое событие).
        if data.start_event_id and data.start_event_id > 0:
            owns = await db.fetchval(
                """SELECT 1 FROM event_owners
                    WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
                data.start_event_id, int(client["sub"]),
            )
            if not owns:
                raise HTTPException(status_code=403, detail="Это событие вам не принадлежит")
            add("start_event_id", data.start_event_id)
        else:
            add("start_event_id", None)
    if data.start_lead_magnet_id is not None:
        # 0 → сброс. Иначе лид-магнит ОБЯЗАН принадлежать клиенту.
        if data.start_lead_magnet_id and data.start_lead_magnet_id > 0:
            owns = await db.fetchval(
                "SELECT 1 FROM lead_magnets WHERE id=$1 AND client_id=$2",
                data.start_lead_magnet_id, int(client["sub"]),
            )
            if not owns:
                raise HTTPException(status_code=403, detail="Этот лид-магнит вам не принадлежит")
            add("start_lead_magnet_id", data.start_lead_magnet_id)
            add("start_package_id", None)  # взаимоисключение: магнит ИЛИ пакет
        else:
            add("start_lead_magnet_id", None)
    if data.start_package_id is not None:
        if data.start_package_id and data.start_package_id > 0:
            owns = await db.fetchval(
                "SELECT 1 FROM lead_magnet_packages WHERE id=$1 AND client_id=$2",
                data.start_package_id, int(client["sub"]),
            )
            if not owns:
                raise HTTPException(status_code=403, detail="Этот пакет вам не принадлежит")
            add("start_package_id", data.start_package_id)
            add("start_lead_magnet_id", None)
        else:
            add("start_package_id", None)

    if data.social_links is not None:
        # Приводим TG/VK ссылки к https-формату — для воронки лид-магнитов и согласованности.
        normalized = normalize_social_links(data.social_links)
        # Авто-резолв VK group_id для проверки подписки на сообщество клиента.
        # Если поле vk изменилось (или vk_group_id отсутствует) — резолвим через utils.resolveScreenName.
        if normalized.get("vk"):
            from app.services.social_links import vk_screen_name_from_link
            from app.services.vk_api import vk_call
            screen = vk_screen_name_from_link(normalized["vk"])
            if screen:
                try:
                    resp = await vk_call("utils.resolveScreenName", {"screen_name": screen})
                    if isinstance(resp, dict) and resp.get("type") in ("group", "page") and resp.get("object_id"):
                        normalized["vk_group_id"] = int(resp["object_id"])
                    else:
                        normalized.pop("vk_group_id", None)
                except Exception as _e:
                    # резолв не получился — не блокируем сохранение профиля
                    pass
        else:
            normalized.pop("vk_group_id", None)
        # Авто-резолв group_id для КАЖДОГО VK-сообщества основателя из массива
        # vk_channels (для groups.isMember при проверке подписки).
        if isinstance(normalized.get("vk_channels"), list):
            from app.services.social_links import vk_screen_name_from_link as _vk_screen
            from app.services.vk_api import vk_call as _vk_call
            for _vc in normalized["vk_channels"]:
                if _vc.get("group_id"):
                    continue  # уже задан вручную
                _screen = _vk_screen(_vc.get("url") or "")
                if not _screen:
                    continue
                try:
                    _r = await _vk_call("utils.resolveScreenName", {"screen_name": _screen})
                    if isinstance(_r, dict) and _r.get("type") in ("group", "page") and _r.get("object_id"):
                        _vc["group_id"] = str(int(_r["object_id"]))
                except Exception:  # noqa: BLE001 — не блокируем сохранение
                    pass
        add("social_links", normalized, jsonb=True)

    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    args.append(int(client["sub"]))
    try:
        row = await db.fetchrow(
            f"""UPDATE clients SET {', '.join(sets)}
                WHERE id = ${len(args)}
                RETURNING id,
                          brand_name, brand_logo_url, profile_photo_url, positioning, achievements,
                          owner_photo_url, owner_positioning, owner_achievements,
                          bio, social_links""",
            *args
        )
    except asyncpg.exceptions.CheckViolationError:
        # Невалидное значение (напр. неизвестный режим) — понятная ошибка, не 500.
        raise HTTPException(status_code=400, detail="Не получилось сохранить: одно из значений недопустимо. Проверьте поля и попробуйте снова.")
    d = dict(row)
    d["achievements"]       = _parse_jsonb(d.get("achievements"), [])
    d["owner_achievements"] = _parse_jsonb(d.get("owner_achievements"), [])
    d["social_links"]       = _parse_jsonb(d.get("social_links"), {})
    return d


class ResolveTgChatIdIn(BaseModel):
    # @username или просто username (без @) — если передан, резолвим именно его.
    username: Optional[str] = None
    # URL канала из массива social_links.telegram_channels — резолвим chat_id и
    # сохраняем обратно в этот же элемент массива. Если не передан и нет username —
    # 400.
    url: Optional[str] = None


@profile_router.post("/profile/resolve-telegram-chat-id",
                     summary="Получить chat_id канала по @username (без сохранения)")
async def resolve_telegram_chat_id(
    payload: ResolveTgChatIdIn = ResolveTgChatIdIn(),
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Получить chat_id публичного TG-канала через `getChat`.

    Источник @username (приоритет):
      1. `payload.username` — явно переданный @username/username (для закрытого канала, который реально публичный).
      2. `payload.url` — URL канала (https://t.me/foo) → из него вытаскивается @username.

    Возвращает `{chat_id, username}` — фронт сам кладёт chat_id в нужный элемент
    массива `social_links.telegram_channels` и шлёт PATCH /me/profile.
    Этот endpoint больше НЕ сохраняет ничего в БД — потому что в массиве каналов
    несколько элементов и без явного указания «куда сохранить» он не угадает.

    Для канала без публичного @username (только инвайт-ссылка) — 400 `invite_only`.
    """
    api_id = ""
    if payload.username and payload.username.strip():
        u = payload.username.strip().lstrip("@")
        u = u.split("/")[-1]
        if u:
            api_id = f"@{u}"
    if not api_id and payload.url:
        api_id = telegram_api_id(payload.url)
    if not api_id:
        raise HTTPException(
            status_code=400,
            detail="invite_only",  # фронт превратит в попап «введите @username или см. инструкцию»
        )
    from app.services.channels import get_client_telegram_token
    token = await get_client_telegram_token(int(client["sub"]), db)  # только свой бот клиента
    if not token:
        raise HTTPException(status_code=400, detail="Не настроен главный бот клиента — подключите его в разделе «Каналы»")
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": api_id},
            )
            data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Не дозвонились до Telegram: {e}")
    if not data.get("ok"):
        desc = data.get("description", "unknown")
        raise HTTPException(status_code=400, detail=f"Telegram отказал: {desc}")
    chat_id = data["result"].get("id")
    if not chat_id:
        raise HTTPException(status_code=502, detail="getChat не вернул id")
    return {"chat_id": chat_id, "username": api_id}


class ResolveMaxChatIdIn(BaseModel):
    url: Optional[str] = None


@profile_router.post("/profile/resolve-max-chat-id",
                     summary="Попытаться получить chat_id MAX-канала (если бот — админ)")
async def resolve_max_chat_id(
    payload: ResolveMaxChatIdIn = ResolveMaxChatIdIn(),
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Получить chat_id MAX-канала по ссылке.

    MAX отдаёт chat_id только боту-АДМИНИСТРАТОРУ канала. Через GET /chats бот
    видит все каналы/чаты, где он состоит, с их chat_id и link. Ищем среди них
    канал по совпадению ссылки (по join-токену из max.ru/join/<token> или по
    точному url). Нашли → возвращаем chat_id. Не нашли → 400 not_found (бот не
    админ канала / неверная ссылка).
    """
    url = (payload.url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="no_url")

    client_id = int(client["sub"])
    from app.services.channels import get_client_max_token
    token = await get_client_max_token(client_id, db)
    if not token:
        raise HTTPException(status_code=400, detail="no_max_bot")

    # join-токен из ссылки max.ru/join/<token> для надёжного сравнения
    def _join_token(s: str) -> str:
        s = (s or "").strip().rstrip("/")
        if "/join/" in s:
            return s.split("/join/", 1)[1].split("?", 1)[0]
        return ""
    target_join = _join_token(url)
    target_url = url.rstrip("/")

    from app.services.max_api import max_call
    try:
        # MAX лимит count ≤ 100 (count=200 → 400 proto.payload).
        resp = await max_call("GET", "/chats", token=token, params={"count": 100})
    except Exception:
        raise HTTPException(status_code=400, detail="not_found")
    chats = (resp or {}).get("chats") or []
    for c in chats:
        c_link = (c.get("link") or "").strip().rstrip("/")
        if not c_link:
            continue
        c_join = _join_token(c_link)
        if (target_join and c_join and target_join == c_join) or (c_link == target_url):
            return {"chat_id": c.get("chat_id"), "title": c.get("title")}
    raise HTTPException(status_code=400, detail="not_found")


# ═══════════════════════════════════════════
# Продукты клиента (CRUD)
# ═══════════════════════════════════════════
offerings_router = APIRouter(prefix="/client-offerings", tags=["Продукты клиента"])


class OfferingIn(BaseModel):
    title:        str
    description:  Optional[str] = None
    action_url:   Optional[str] = None
    is_paid:      bool = True
    cover_url:    Optional[str] = None
    sort_order:   int = 0


class OfferingPatch(BaseModel):
    title:        Optional[str] = None
    description:  Optional[str] = None
    action_url:   Optional[str] = None
    is_paid:      Optional[bool] = None
    cover_url:    Optional[str] = None
    sort_order:   Optional[int] = None


@offerings_router.get("", summary="Список продуктов клиента")
async def list_offerings(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        """SELECT id, title, description, action_url, is_paid, cover_url, sort_order, created_at, updated_at
             FROM client_offerings
            WHERE client_id = $1
            ORDER BY is_paid DESC, sort_order, id""",
        int(client["sub"])
    )
    return {"items": [dict(r) for r in rows]}


@offerings_router.post("", summary="Создать продукт")
async def create_offering(
    data: OfferingIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await db.fetchrow(
        """INSERT INTO client_offerings
              (client_id, title, description, action_url, is_paid, cover_url, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, title, description, action_url, is_paid, cover_url, sort_order""",
        int(client["sub"]), data.title.strip(), data.description, data.action_url,
        data.is_paid, data.cover_url, data.sort_order
    )
    return dict(row)


@offerings_router.patch("/{offering_id}", summary="Обновить продукт")
async def update_offering(
    offering_id: int,
    data: OfferingPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    sets = []
    args: list[Any] = []
    for field in ("title", "description", "action_url", "is_paid", "cover_url", "sort_order"):
        v = getattr(data, field)
        if v is not None:
            sets.append(f"{field} = ${len(args)+1}")
            args.append(v.strip() if isinstance(v, str) else v)
    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")
    sets.append("updated_at = NOW()")
    args.extend([offering_id, int(client["sub"])])
    row = await db.fetchrow(
        f"""UPDATE client_offerings SET {', '.join(sets)}
            WHERE id = ${len(args)-1} AND client_id = ${len(args)}
            RETURNING id, title, description, action_url, is_paid, cover_url, sort_order""",
        *args
    )
    if not row:
        raise HTTPException(status_code=404, detail="Продукт не найден")
    return dict(row)


@offerings_router.delete("/{offering_id}", summary="Удалить продукт")
async def delete_offering(
    offering_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    res = await db.execute(
        "DELETE FROM client_offerings WHERE id = $1 AND client_id = $2",
        offering_id, int(client["sub"])
    )
    if res == "DELETE 0":
        raise HTTPException(status_code=404, detail="Продукт не найден")
    return {"ok": True}
