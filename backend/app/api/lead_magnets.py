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
from app.services.share_links import build_funnel_landing_links
from app.config import settings
import asyncpg
import secrets


async def _public_base(db, client_id: int) -> str:
    """База публичных landing-ссылок воронок — домен КЛИЕНТА (миграция 270).

    ⚠️ Раньше отдавали `settings.frontend_url`, то есть всегда pluson.ru:
    клиент со своим доменом раздавал аудитории наш адрес. Ссылку `/m/…`
    он копирует и рассылает — значит она должна быть на его домене.
    Нет своего домена → резолвер сам вернёт pluson.ru, поведение прежнее.
    """
    from app.services.client_domains import client_public_url
    return (await client_public_url(db, client_id)).rstrip('/')

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


def _norm_link_mode(v):
    """Режим выдачи → безопасное значение.

    ⚠️ Мусор приводим к 'text' (прежнее поведение), а не роняем запрос: набор
    вариантов может пополниться, и старый фронт не должен ломать сохранение.
    """
    return v if v in ('text', 'button', 'both') else 'text'


def _norm_button_label(v):
    """Надпись кнопки: обрезаем под лимит площадок и чистим пробелы.

    ⚠️ Режем и на сервере, а не только в поле ввода: длинную надпись ВКонтакте
    отвергает целиком — вместе со всем сообщением, а не только с кнопкой.
    """
    from app.services.lead_magnet_buttons import BUTTON_LABEL_LIMIT
    s = (v or '').strip()
    return s[:BUTTON_LABEL_LIMIT] or None


class LeadMagnetIn(BaseModel):
    name: str
    description: Optional[str] = None
    url: str
    # Анкета-шлагбаум перед выдачей (миграция 280). NULL = не требуется,
    # это поведение по умолчанию у всех существующих лид-магнитов.
    # ⚠️ Порядок в воронке: подписка на канал → анкета → файл.
    require_survey_id: Optional[int] = None
    # Как отдавать материал: ссылкой в тексте (как было), кнопкой под
    # сообщением или и так, и так. См. миграцию 330.
    link_mode: Optional[str] = None
    # Надпись на кнопке, до 40 символов (предел ВКонтакте). Пусто → берём
    # название материала и режем под лимит.
    button_label: Optional[str] = None


@router.get("", summary="Список лид-магнитов клиента")
async def list_lead_magnets(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    rows = await db.fetch(
        """SELECT id, name, description, url, slug, require_survey_id,
                  link_mode, button_label, created_at, updated_at
           FROM lead_magnets WHERE client_id = $1
           ORDER BY name""",
        cid
    )
    items = [dict(r) for r in rows]
    base = await _public_base(db, cid)
    for it in items:
        it["platform_links"] = await build_funnel_landing_links(
            db, client_id=cid, slug=it["slug"], kind='m', base_url=base
        )
    return {"items": items}


@router.post("", summary="Создать лид-магнит")
async def create_lead_magnet(
    data: LeadMagnetIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    slug = await _make_unique_lead_magnet_slug(db)
    row = await db.fetchrow(
        """INSERT INTO lead_magnets (client_id, name, description, url, slug,
                                     link_mode, button_label)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6,'text'), $7)
           RETURNING id, name, description, url, slug, require_survey_id,
                      link_mode, button_label, created_at, updated_at""",
        cid, data.name.strip(), data.description, data.url.strip(), slug,
        _norm_link_mode(data.link_mode), _norm_button_label(data.button_label),
    )
    out = dict(row)
    out["platform_links"] = await build_funnel_landing_links(
        db, client_id=cid, slug=out["slug"], kind='m', base_url=await _public_base(db, cid)
    )
    return out


@router.get("/counts", summary="Батч-счётчики воронки по всем лид-магнитам клиента")
async def list_counts(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Возвращает [{id, landed, known, started, delivered, not_delivered}].

    `landed` — все хиты по ссылке (включая анонимные до создания контакта).
    `known` / `delivered` / `not_delivered` считаются по ЖИВЫМ контактам клиента
    (contacts.is_active) — той же выборкой, что фильтр /dashboard/clients, чтобы
    цифра на плитке совпадала с числом строк в списке контактов:
      known         → ?lead_magnet_ids=N
      delivered     → ?lead_magnet_ids=N&lead_magnet_stage=delivered
      not_delivered → ?lead_magnet_ids=N&lead_magnet_stage=not_delivered
    """
    rows = await db.fetch(
        """SELECT
              lm.id,
              COALESCE(COUNT(fr.id) FILTER (WHERE fr.stage IN ('landed','started','subscribed','delivered')), 0) AS landed,
              COALESCE(COUNT(DISTINCT c.id), 0) AS known,
              COALESCE(COUNT(DISTINCT c.id) FILTER (WHERE fr.stage IN ('started','subscribed','delivered')), 0) AS started,
              COALESCE(COUNT(DISTINCT c.id) FILTER (WHERE fr.stage = 'delivered'), 0) AS delivered
             FROM lead_magnets lm
        LEFT JOIN funnel_runs fr ON fr.lead_magnet_id = lm.id
        LEFT JOIN contacts c ON c.id = fr.contact_id
                            AND c.is_active = TRUE
                            AND c.client_id = lm.client_id
            WHERE lm.client_id = $1
         GROUP BY lm.id""",
        int(client["sub"])
    )
    return {"items": [
        {
            "id": r["id"],
            "landed": int(r["landed"]),
            "known": int(r["known"]),
            "started": int(r["started"]),
            "delivered": int(r["delivered"]),
            # «не забрали» = зашли по ссылке, но ни один их run не дошёл до delivered
            "not_delivered": int(r["known"]) - int(r["delivered"]),
        }
        for r in rows
    ]}


@router.get("/{lead_magnet_id}", summary="Получить лид-магнит")
async def get_lead_magnet(
    lead_magnet_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    row = await db.fetchrow(
        """SELECT id, name, description, url, slug, require_survey_id,
                  link_mode, button_label, created_at, updated_at
           FROM lead_magnets WHERE id = $1 AND client_id = $2""",
        lead_magnet_id, cid
    )
    if not row:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    out = dict(row)
    out["platform_links"] = await build_funnel_landing_links(
        db, client_id=cid, slug=out["slug"], kind='m', base_url=await _public_base(db, cid)
    )
    return out


@router.patch("/{lead_magnet_id}", summary="Обновить лид-магнит")
async def update_lead_magnet(
    lead_magnet_id: int,
    data: LeadMagnetIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    row = await db.fetchrow(
        # ⚠️ `require_survey_id` меняем только если фронт его прислал
        # (`model_fields_set`) — иначе сохранение формы без этого поля молча
        # снимало бы уже настроенный шлагбаум.
        """UPDATE lead_magnets
              SET name = $1, description = $2, url = $3,
                  require_survey_id = CASE WHEN $6 THEN $7 ELSE require_survey_id END,
                  -- ⚠️ Как и у анкеты: правим ТОЛЬКО присланное. Форма может
                  -- слать не все поля, и без этой проверки сохранение молча
                  -- сбрасывало бы уже настроенную выдачу кнопкой.
                  link_mode    = CASE WHEN $8  THEN COALESCE($9,'text') ELSE link_mode END,
                  button_label = CASE WHEN $10 THEN $11 ELSE button_label END,
                  updated_at = NOW()
            WHERE id = $4 AND client_id = $5
            RETURNING id, name, description, url, slug, require_survey_id,
                      link_mode, button_label, created_at, updated_at""",
        data.name.strip(), data.description, data.url.strip(),
        lead_magnet_id, cid,
        'require_survey_id' in data.model_fields_set, data.require_survey_id,
        'link_mode' in data.model_fields_set, _norm_link_mode(data.link_mode),
        'button_label' in data.model_fields_set, _norm_button_label(data.button_label),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    out = dict(row)
    out["platform_links"] = await build_funnel_landing_links(
        db, client_id=cid, slug=out["slug"], kind='m', base_url=await _public_base(db, cid)
    )
    return out


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


@router.get("/{lead_magnet_id}/crm", summary="CRM лид-магнита: люди по этапам")
async def lead_magnet_crm_view(
    lead_magnet_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Колонки «перешли → подписались → получили» со списками людей.

    Раньше клик по цифрам уводил в «Контакты» с фильтром: человек терял
    страницу лид-магнитов, а увидеть все этапы разом было нельзя.
    """
    from app.services.lead_magnet_crm import lead_magnet_crm
    data = await lead_magnet_crm(
        db, client_id=int(client["sub"]), lead_magnet_id=lead_magnet_id)
    if not data:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    return data
