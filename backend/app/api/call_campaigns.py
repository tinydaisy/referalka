"""
Автообзвоны — кампании (миграция 359).

Клиент выбирает аудиторию тем же фильтром, что в рассылках, и запускает обзвон
роботом через свой аккаунт Звонопса.

⚠️ Запуск идёт ЧЕРЕЗ ОЧЕРЕДЬ (Celery), а не прямо в этом запросе: обзвон на
тысячи номеров режется на пачки и уходит несколькими запросами к их API — на
это нужны минуты, и HTTP-запрос из браузера успел бы отвалиться по таймауту,
оставив кампанию в непонятном состоянии.

Гейт — фича `calls` (только admin). Ассистенту запись закрыта общим middleware.
"""
import asyncpg
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.database import get_db
from app.api.client_call_settings import assert_calls_feature
from app.services import calldog
from app.services.call_audience import collect_call_targets

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/call-campaigns", tags=["Автообзвоны"])
public_router = APIRouter(prefix="/public/calls", tags=["Автообзвоны"])

_STATUSES_EDITABLE = ("draft", "pending")


class CampaignIn(BaseModel):
    name: Optional[str] = None
    event_id: Optional[int] = None
    template_id: Optional[int] = None
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    audience_tags_include: Optional[list] = None
    audience_tags_exclude: Optional[list] = None
    fire_at: Optional[str] = None          # ISO-строка, МСК
    start_time: Optional[str] = None       # "HH:MM"
    end_time: Optional[str] = None
    weekdays: Optional[list] = None
    smart_delay: Optional[int] = None
    require_consent: Optional[bool] = None


class AudienceIn(BaseModel):
    """Для счётчика «дозвонимся до N из M» — до запуска."""
    event_id: Optional[int] = None
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    audience_tags_include: Optional[list] = None
    audience_tags_exclude: Optional[list] = None
    require_consent: Optional[bool] = None


async def _owns(db, client_id: int, campaign_id: int) -> dict:
    row = await db.fetchrow(
        "SELECT * FROM call_campaigns WHERE id = $1 AND client_id = $2",
        campaign_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Обзвон не найден.")
    return dict(row)


def _parse_dt(value: Optional[str]):
    """ISO-строка → datetime. Пусто/мусор → None (кампания останется черновиком)."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


@router.get("", summary="Список обзвонов")
async def list_campaigns(
    event_id: Optional[int] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    where = "cc.client_id = $1"
    args: list = [client_id]
    if event_id:
        args.append(event_id)
        where += f" AND cc.event_id = ${len(args)}"
    rows = await db.fetch(
        f"""SELECT cc.*, e.title AS event_title,
                   (SELECT count(*) FROM call_log cl WHERE cl.campaign_id = cc.id) AS calls_total,
                   (SELECT count(*) FROM call_log cl WHERE cl.campaign_id = cc.id
                     AND cl.status = 'answered') AS calls_answered
              FROM call_campaigns cc
              LEFT JOIN events e ON e.id = cc.event_id
             WHERE {where}
             ORDER BY cc.created_at DESC
             LIMIT 200""",
        *args,
    )
    return {"campaigns": [dict(r) for r in rows]}


@router.post("/audience-count", summary="Сколько человек обзвоним")
async def audience_count(
    data: AudienceIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Показать охват ДО запуска.

    ⚠️ Телефон есть далеко не у всех (на проде — у 17% базы), поэтому показываем
    обе цифры: «дозвонимся до N из M». Иначе клиент решит, что обзвон сломался,
    когда из 5000 контактов позвонит 800.
    """
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    res = await collect_call_targets(
        db,
        client_id=client_id,
        event_id=data.event_id,
        audience_include=data.audience_include,
        audience_exclude=data.audience_exclude,
        tags_include=data.audience_tags_include,
        tags_exclude=data.audience_tags_exclude,
        require_consent=bool(data.require_consent),
    )
    return {
        "reachable": len(res["targets"]),
        "total": res["total_contacts"],
        "skipped_no_phone": res["skipped_no_phone"],
        "skipped_unsub": res["skipped_unsub"],
    }


@router.post("", summary="Создать обзвон")
async def create_campaign(
    data: CampaignIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)

    if not data.template_id:
        raise HTTPException(status_code=400, detail="Выберите сценарий звонка.")

    row = await db.fetchrow(
        """INSERT INTO call_campaigns
             (client_id, event_id, name, template_id,
              audience_include, audience_exclude,
              audience_tags_include, audience_tags_exclude,
              fire_at, start_time, end_time, weekdays, smart_delay, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft')
           RETURNING *""",
        client_id,
        data.event_id,
        (data.name or "").strip() or "Обзвон",
        int(data.template_id),
        data.audience_include,
        data.audience_exclude,
        data.audience_tags_include or None,
        data.audience_tags_exclude or None,
        _parse_dt(data.fire_at),
        (data.start_time or "").strip() or None,
        (data.end_time or "").strip() or None,
        data.weekdays or None,
        data.smart_delay,
    )
    return dict(row)


@router.patch("/{campaign_id}", summary="Изменить обзвон")
async def update_campaign(
    campaign_id: int,
    data: CampaignIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    current = await _owns(db, client_id, campaign_id)
    # ⚠️ Уже звоним или отзвонили — менять нечего: звонки на стороне сервиса
    # изменить нельзя, а правка настроек создала бы ложное впечатление.
    if current["status"] not in _STATUSES_EDITABLE:
        raise HTTPException(
            status_code=409,
            detail="Этот обзвон уже запущен — его настройки изменить нельзя.",
        )

    fs = data.model_fields_set
    mapping = {
        "name": lambda v: (v or "").strip() or "Обзвон",
        "template_id": lambda v: int(v) if v else None,
        "audience_include": lambda v: v,
        "audience_exclude": lambda v: v,
        "audience_tags_include": lambda v: v or None,
        "audience_tags_exclude": lambda v: v or None,
        "fire_at": _parse_dt,
        "start_time": lambda v: (v or "").strip() or None,
        "end_time": lambda v: (v or "").strip() or None,
        "weekdays": lambda v: v or None,
        "smart_delay": lambda v: v,
    }
    sets, vals = [], []
    for field, conv in mapping.items():
        if field not in fs:
            continue
        vals.append(conv(getattr(data, field)))
        sets.append(f"{field} = ${len(vals)}")
    if not sets:
        return current
    vals.extend([campaign_id, client_id])
    row = await db.fetchrow(
        f"""UPDATE call_campaigns SET {', '.join(sets)}, updated_at = NOW()
             WHERE id = ${len(vals) - 1} AND client_id = ${len(vals)} RETURNING *""",
        *vals,
    )
    return dict(row)


@router.post("/{campaign_id}/start", summary="Запустить обзвон")
async def start_campaign(
    campaign_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Поставить обзвон в очередь.

    ⚠️ Сами звонки создаёт Celery-задача, а не этот запрос: тысячи номеров
    режутся на пачки, это минуты работы — HTTP-запрос отвалился бы по таймауту.
    """
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    camp = await _owns(db, client_id, campaign_id)
    if camp["status"] not in _STATUSES_EDITABLE:
        raise HTTPException(status_code=409, detail="Этот обзвон уже запущен.")

    # Настройки подключения проверяем ДО постановки в очередь — иначе кампания
    # молча упадёт в фоне, и клиент увидит «ошибка» без объяснения.
    settings = await db.fetchrow(
        """SELECT calls_calldog_api_key, calls_calldog_outgoing_phone,
                  calls_calldog_duty_phone FROM clients WHERE id = $1""",
        client_id,
    )
    if not calldog.is_configured(dict(settings or {})):
        raise HTTPException(
            status_code=400,
            detail="Сначала подключите Звонопёс: укажите API-ключ и номер, "
                   "с которого звонить (Настройки → Интеграция).",
        )

    res = await collect_call_targets(
        db,
        client_id=client_id,
        event_id=camp["event_id"],
        audience_include=camp["audience_include"],
        audience_exclude=camp["audience_exclude"],
        tags_include=camp["audience_tags_include"],
        tags_exclude=camp["audience_tags_exclude"],
    )
    if not res["targets"]:
        raise HTTPException(
            status_code=400,
            detail="Некому звонить: ни у кого из выбранных нет телефона "
                   "или все отказались от звонков.",
        )

    fire_at = camp["fire_at"] or datetime.now(timezone.utc)
    await db.execute(
        """UPDATE call_campaigns
              SET status = 'pending', fire_at = $2, updated_at = NOW()
            WHERE id = $1""",
        campaign_id, fire_at,
    )
    return {"ok": True, "queued": len(res["targets"])}


@router.post("/{campaign_id}/cancel", summary="Отменить обзвон")
async def cancel_campaign(
    campaign_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Снять с очереди и отменить ещё не состоявшиеся звонки у сервиса."""
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    camp = await _owns(db, client_id, campaign_id)

    # Отменяем на их стороне только то, что ещё не прозвонило.
    pending = await db.fetch(
        """SELECT external_call_id FROM call_log
            WHERE campaign_id = $1 AND status = 'queued'
              AND external_call_id IS NOT NULL""",
        campaign_id,
    )
    ids = []
    for r in pending:
        try:
            ids.append(int(r["external_call_id"]))
        except (TypeError, ValueError):
            continue
    if ids:
        key = await db.fetchval(
            "SELECT calls_calldog_api_key FROM clients WHERE id = $1", client_id
        )
        if key:
            try:
                # ⚠️ is_template обязателен для звонков из шаблона, иначе сервис
                # их не удалит и деньги спишутся.
                await calldog.remove_calls(key.strip(), ids, is_template=True)
            except calldog.CalldogError as e:
                logger.warning("calldog cancel failed for campaign %s: %s", campaign_id, e)

    await db.execute(
        """UPDATE call_campaigns SET status = 'cancelled', finished_at = NOW(),
                  updated_at = NOW() WHERE id = $1""",
        campaign_id,
    )
    return {"ok": True, "cancelled_calls": len(ids)}


@router.delete("/{campaign_id}", summary="Удалить обзвон")
async def delete_campaign(
    campaign_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    camp = await _owns(db, client_id, campaign_id)
    if camp["status"] == "running":
        raise HTTPException(
            status_code=409,
            detail="Обзвон сейчас идёт — сначала отмените его.",
        )
    await db.execute("DELETE FROM call_campaigns WHERE id = $1", campaign_id)
    return {"ok": True}


@router.get("/{campaign_id}/log", summary="Результаты обзвона")
async def campaign_log(
    campaign_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Кто ответил, кто не взял трубку, что нажал."""
    client_id = int(client["sub"])
    await assert_calls_feature(db, client_id)
    await _owns(db, client_id, campaign_id)
    rows = await db.fetch(
        """SELECT cl.*, c.name AS contact_name
             FROM call_log cl
             LEFT JOIN contacts c ON c.id = cl.contact_id
            WHERE cl.campaign_id = $1
            ORDER BY cl.id
            LIMIT 5000""",
        campaign_id,
    )
    stats = await db.fetchrow(
        """SELECT count(*) AS total,
                  count(*) FILTER (WHERE status = 'answered')   AS answered,
                  count(*) FILTER (WHERE status = 'no_answer')  AS no_answer,
                  count(*) FILTER (WHERE status = 'queued')     AS queued,
                  count(*) FILTER (WHERE status = 'failed')     AS failed,
                  count(*) FILTER (WHERE ivr_answer IS NOT NULL AND ivr_answer <> '') AS with_answer,
                  COALESCE(sum(cost), 0) AS total_cost
             FROM call_log WHERE campaign_id = $1""",
        campaign_id,
    )
    return {"calls": [dict(r) for r in rows], "stats": dict(stats or {})}


# ─────────────────────────────────────────────────────────────────────────────
# Вебхук: результат звонка от Звонопса
# ─────────────────────────────────────────────────────────────────────────────
@public_router.post("/webhook", summary="Результат звонка от Звонопса")
async def calls_webhook(
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """Сервис сообщает, чем закончился звонок.

    ⚠️ Подписи у их вебхука нет — сверяем адрес отправителя (он указан в их
    документации). Без сверки кто угодно, зная адрес, прислал бы поддельный
    результат: «человек нажал 1» и получил бы тег заинтересованного.

    ⚠️ Отвечаем 200 всегда, когда запрос разобран: они повторяют отправку до
    трёх раз, пока не получат 200. Ошибка на нашей стороне не должна плодить
    повторы бесконечно.
    """
    # Реальный адрес: за nginx стоит X-Forwarded-For.
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    src = fwd or (request.client.host if request.client else "")
    if src and src != calldog.WEBHOOK_SOURCE_IP:
        logger.warning("calls webhook from unexpected ip=%s", src)
        raise HTTPException(status_code=403, detail="forbidden")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="bad json")

    if not isinstance(body, dict):
        return {"ok": True}

    # Их формат: объект звонка, либо {"call": {...}} у вебхука из IVR-блока.
    call = body.get("call") if isinstance(body.get("call"), dict) else body
    ext_id = call.get("id") or body.get("id")
    phone = str(call.get("phone") or body.get("phone") or "").strip()
    if not ext_id and not phone:
        return {"ok": True}

    ivr = call.get("answer")
    if ivr is None:
        ivr = call.get("ivrAnswers") or call.get("ivrDigit")
    ivr = None if ivr is None else str(ivr).strip()

    status = calldog.map_status(call.get("status"), call.get("answeredAt"))

    # Ищем строку: сначала по их id, иначе по номеру среди ещё не отзвонивших.
    row = None
    if ext_id:
        row = await db.fetchrow(
            "SELECT * FROM call_log WHERE external_call_id = $1", str(ext_id)
        )
    if not row and phone:
        row = await db.fetchrow(
            """SELECT * FROM call_log WHERE phone = $1 AND status = 'queued'
                ORDER BY id DESC LIMIT 1""",
            phone,
        )
    if not row:
        logger.info("calls webhook: unknown call ext_id=%s phone=%s", ext_id, phone)
        return {"ok": True}

    started, answered, finished = (
        call.get("startedAt"), call.get("answeredAt"), call.get("finishedAt"),
    )
    duration = None
    try:
        if answered and finished:
            duration = max(0, int(finished) - int(answered))
    except (TypeError, ValueError):
        duration = None

    cost = call.get("cost")
    try:
        cost = float(cost) if cost is not None else None
    except (TypeError, ValueError):
        cost = None

    await db.execute(
        """UPDATE call_log
              SET status = $2,
                  ivr_answer = COALESCE($3, ivr_answer),
                  duration_sec = COALESCE($4, duration_sec),
                  cost = COALESCE($5, cost),
                  record_url = COALESCE($6, record_url),
                  called_at = COALESCE(called_at, NOW()),
                  external_call_id = COALESCE(external_call_id, $7),
                  updated_at = NOW()
            WHERE id = $1""",
        row["id"], status, ivr, duration, cost,
        call.get("recordFilePath"), str(ext_id) if ext_id else None,
    )

    # ⚠️ Нажал «не звоните» (9) — снимаем согласие у себя И заносим в их чёрный
    # список. Только у себя мало: сервис продолжит звонить по другим кампаниям.
    if ivr and str(ivr).strip() == "9" and row["contact_id"]:
        await _handle_opt_out(db, row["contact_id"], row["phone"])

    return {"ok": True}


async def _handle_opt_out(db, contact_id: int, phone: str) -> None:
    """Человек отказался от звонков."""
    client_id = await db.fetchval(
        """UPDATE contacts SET calls_unsubscribed_at = COALESCE(calls_unsubscribed_at, NOW())
            WHERE id = $1 RETURNING client_id""",
        contact_id,
    )
    if not client_id or not phone:
        return
    key = await db.fetchval(
        "SELECT calls_calldog_api_key FROM clients WHERE id = $1", client_id
    )
    if not key:
        return
    try:
        await calldog.add_to_blacklist(
            key.strip(), [{"phone": phone, "comment": "Отказ от звонков (нажал 9)"}]
        )
    except calldog.CalldogError as e:
        # Отметка у нас уже стоит — звонить мы ему больше не будем в любом случае.
        logger.warning("calldog blacklist failed for %s: %s", phone, e)
