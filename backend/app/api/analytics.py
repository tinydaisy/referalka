"""
API аналитики по UTM-меткам.

Два источника UTM в системе:
1. `funnel_runs.utm` (JSONB) — полный набор меток на каждый заход по лид-магниту.
   Тут есть воронка: зашёл в бот (started) → получил файл (delivered).
2. `contacts.utm_source` — одна метка «откуда контакт вообще появился в базе».
   Тут воронки нет, только распределение всей базы по источникам.

Метрики намеренно НЕ показывают стадию `landed` (клик по ссылке) — начинаем
сразу с «Зашло в бот» (`started`), потому что до бота человек мог не дойти.
"""
from fastapi import APIRouter, Depends, Query
from app.auth import get_current_client
from app.database import get_db

router = APIRouter(prefix="/analytics", tags=["Аналитика"])

# Ключи UTM, по которым можно группировать funnel-сводку.
_UTM_KEYS = {"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"}


@router.get("/utm", summary="Сводка по UTM: воронка лид-магнитов + база контактов")
async def utm_summary(
    group_by: str = Query(
        default="utm_source",
        description="По какой метке группировать воронку: utm_source|utm_medium|utm_campaign|utm_content|utm_term",
    ),
    lead_magnet_id: int | None = Query(default=None, description="Фильтр по одному лид-магниту"),
    package_id: int | None = Query(default=None, description="Фильтр по одному пакету"),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """
    Возвращает:
    - `funnel[]` — по каждому значению выбранной UTM-метки: сколько людей зашло
      в бот (`started`, distinct contact_id), сколько получили файл (`delivered`)
      и конверсия. Источник — `funnel_runs`.
    - `contacts_by_source[]` — распределение ВСЕЙ базы контактов по `contacts.utm_source`.
    - `totals` — суммарные цифры воронки.
    - `lead_magnets[]` / `packages[]` — списки для селектора фильтра.
    """
    client_id = int(client["sub"])

    key = group_by if group_by in _UTM_KEYS else "utm_source"

    # ── Воронка по лид-магнитам, сгруппированная по значению UTM-метки ──
    # started  = distinct contact_id на стадии started/subscribed/delivered
    # delivered = distinct contact_id на стадии delivered
    # Забеги без contact_id (анонимные) в distinct-подсчёт не попадают, поэтому
    # started берём как «дошедшие до бота с известным контактом».
    filt = "WHERE fr.client_id = $1"
    params: list = [client_id]
    if lead_magnet_id is not None:
        params.append(lead_magnet_id)
        filt += f" AND fr.lead_magnet_id = ${len(params)}"
    if package_id is not None:
        params.append(package_id)
        filt += f" AND fr.package_id = ${len(params)}"

    funnel_rows = await db.fetch(
        f"""
        SELECT
            COALESCE(NULLIF(fr.utm->>'{key}', ''), '(без метки)') AS source,
            COUNT(DISTINCT fr.contact_id)
                FILTER (WHERE fr.stage IN ('started','subscribed','delivered')
                        AND fr.contact_id IS NOT NULL)                         AS started,
            COUNT(DISTINCT fr.contact_id)
                FILTER (WHERE fr.stage = 'delivered'
                        AND fr.contact_id IS NOT NULL)                         AS delivered,
            COUNT(*) FILTER (WHERE fr.stage IN ('started','subscribed','delivered')) AS started_runs
        FROM funnel_runs fr
        {filt}
        GROUP BY source
        ORDER BY started DESC, source
        """,
        *params,
    )

    funnel = []
    tot_started = tot_delivered = 0
    for r in funnel_rows:
        started = r["started"] or 0
        delivered = r["delivered"] or 0
        tot_started += started
        tot_delivered += delivered
        funnel.append({
            "source": r["source"],
            "started": started,          # зашло в бот
            "delivered": delivered,      # получили файл
            "conversion": round(delivered / started * 100) if started else 0,
        })

    # ── Распределение всей базы контактов по utm_source ──
    contacts_rows = await db.fetch(
        """
        SELECT COALESCE(NULLIF(utm_source, ''), '(без метки)') AS source,
               COUNT(*) AS cnt
        FROM contacts
        WHERE client_id = $1 AND is_active = TRUE
        GROUP BY source
        ORDER BY cnt DESC, source
        """,
        client_id,
    )
    contacts_total = sum(r["cnt"] for r in contacts_rows)
    contacts_by_source = [
        {
            "source": r["source"],
            "count": r["cnt"],
            "share": round(r["cnt"] / contacts_total * 100) if contacts_total else 0,
        }
        for r in contacts_rows
    ]

    # ── Списки для селектора фильтра ──
    lm_rows = await db.fetch(
        "SELECT id, name FROM lead_magnets WHERE client_id = $1 ORDER BY name",
        client_id,
    )
    pkg_rows = await db.fetch(
        "SELECT id, name FROM lead_magnet_packages WHERE client_id = $1 ORDER BY name",
        client_id,
    )

    return {
        "group_by": key,
        "funnel": funnel,
        "totals": {
            "started": tot_started,
            "delivered": tot_delivered,
            "conversion": round(tot_delivered / tot_started * 100) if tot_started else 0,
        },
        "contacts_by_source": contacts_by_source,
        "contacts_total": contacts_total,
        "lead_magnets": [{"id": r["id"], "name": r["name"]} for r in lm_rows],
        "packages": [{"id": r["id"], "name": r["name"]} for r in pkg_rows],
    }
