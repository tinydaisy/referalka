"""Кабинет тех-специалиста (внедренца) — миграция 391.

⚠️⚠️ ФИЛЬТР «ТОЛЬКО СВОИ» СТОИТ В SQL, А НЕ В ИНТЕРФЕЙСЕ. Каждый запрос здесь
жёстко ограничен `tech_specialist_id = <из токена>`. Отдать список целиком и
отфильтровать на фронте нельзя: запрос повторяется мимо интерфейса, и специалист
увидел бы чужих клиентов с их деньгами.

⚠️ Это НЕ кабинет клиента и НЕ админка. Клиента он видит карточкой: тариф,
оплаты, контакты для связи. Внутрь его кабинета не заходит — туда доступ даётся
отдельно, механизмом помощников.
"""

from __future__ import annotations

from typing import Optional

from datetime import datetime, timezone

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_current_tech
from app.database import get_db

router = APIRouter(prefix="/tech", tags=["Кабинет тех-специалиста"])


@router.get("/me", summary="Кто я и что мне открыто")
async def me(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    spec_id = int(user["sub"])
    row = await db.fetchrow(
        """SELECT id, email, name, phone, telegram_username,
                  can_edit_materials, is_active
             FROM tech_specialists WHERE id = $1""",
        spec_id,
    )
    if not row or not row["is_active"]:
        raise HTTPException(403, "Доступ закрыт")
    return dict(row)


@router.get("/clients", summary="Мои клиенты")
async def my_clients(
    search: Optional[str] = Query(None),
    status: Optional[str] = Query(None, description="paying | trial | cold"),
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Закреплённые за мной клиенты платформы.

    ⚠️ Считаем оплаты по `subscription_orders`, а НЕ по `client_subscriptions`:
    продление там делает UPDATE и затирает ссылку на заказ — «сколько раз
    продлил» из подписки не восстановить.
    """
    spec_id = int(user["sub"])
    args: list = [spec_id]
    where = ["c.tech_specialist_id = $1"]

    if search:
        args.append(f"%{search}%")
        where.append(f"(c.name ILIKE ${len(args)} OR c.email ILIKE ${len(args)}"
                     f" OR c.telegram_username ILIKE ${len(args)})")

    # ⚠️ «Платит» — активная подписка с `source='paid'`. Триал и выданное
    # админом сюда не идут: это не деньги, и фикс за них не начисляется.
    paying = ("EXISTS (SELECT 1 FROM client_subscriptions cs2"
              " WHERE cs2.id = c.current_subscription_id AND cs2.status='active'"
              " AND cs2.expires_at > NOW() AND cs2.source='paid')")
    trial = ("EXISTS (SELECT 1 FROM client_subscriptions cs2"
             " WHERE cs2.id = c.current_subscription_id AND cs2.status='active'"
             " AND cs2.expires_at > NOW() AND cs2.source <> 'paid')")
    if status == "paying":
        where.append(paying)
    elif status == "trial":
        where.append(trial)
    elif status == "cold":
        where.append(f"NOT {paying} AND NOT {trial}")

    rows = await db.fetch(
        f"""SELECT c.id, c.name, c.email, c.phone, c.telegram_username,
                   c.created_at, c.tech_assigned_at,
                   t.slug AS tariff_slug, t.name AS tariff_name,
                   cs.expires_at, cs.status AS sub_status, cs.source AS sub_source,
                   {paying} AS is_paying,
                   -- ⚠️ УРОВЕНЬ ПРИВЕДЁННОГО. Раньше здесь был признак,
                   -- считавший «тех-спец того, кто привёл = я» — это «привёл
                   -- кто-то, кого я обслуживаю», а не «привёл я сам».
                   --   1 — привёл ЛИЧНО (по своей реф-ссылке);
                   --   2 — привёл тот, кого привёл он;
                   --   NULL — просто назначен на обслуживание.
                   CASE
                     WHEN c.referred_by_tech_id = $1 THEN 1
                     WHEN (SELECT l1.referred_by_tech_id FROM clients l1
                            WHERE l1.id = c.referred_by_client_id) = $1 THEN 2
                     ELSE NULL
                   END AS referral_level,
                   (SELECT COUNT(*) FROM subscription_orders so
                     WHERE so.client_id = c.id AND so.status='paid'
                       AND so.amount_paid_card_kopecks > 0) AS payments_count,
                   (SELECT MAX(so.paid_at) FROM subscription_orders so
                     WHERE so.client_id = c.id AND so.status='paid') AS last_paid_at,
                   (SELECT COALESCE(SUM(so.amount_paid_card_kopecks),0)
                      FROM subscription_orders so
                     WHERE so.client_id = c.id AND so.status='paid') AS total_paid_kopecks,
                   (SELECT COUNT(*) FROM contacts ct WHERE ct.client_id = c.id) AS contacts_count
              FROM clients c
              LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
              LEFT JOIN tariffs t ON t.id = cs.tariff_id
             WHERE {' AND '.join(where)}
             ORDER BY c.created_at DESC""",
        *args,
    )
    return {"clients": [dict(r) for r in rows]}


@router.get("/clients/{client_id}", summary="Карточка клиента")
async def client_card(
    client_id: int,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Один клиент — с историей оплат.

    ⚠️ Проверка «мой ли» в SQL: по чужому id ответ должен быть 404, а не данные.
    """
    spec_id = int(user["sub"])
    c = await db.fetchrow(
        """SELECT c.id, c.name, c.email, c.phone, c.telegram_username,
                  c.created_at, c.tech_assigned_at,
                  t.slug AS tariff_slug, t.name AS tariff_name,
                  cs.expires_at, cs.status AS sub_status, cs.source AS sub_source
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             LEFT JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.id = $1 AND c.tech_specialist_id = $2""",
        client_id, spec_id,
    )
    if not c:
        raise HTTPException(404, "Клиент не найден")

    # История денег — и подписки, и модули: иначе картина неполная.
    orders = await db.fetch(
        """SELECT 'tariff' AS kind, so.id, so.amount_paid_card_kopecks AS amount,
                  so.status, so.paid_at, t.name AS title
             FROM subscription_orders so LEFT JOIN tariffs t ON t.id = so.tariff_id
            WHERE so.client_id = $1
            UNION ALL
           SELECT 'addon', ao.id, ao.amount_total_kopecks, ao.status, ao.paid_at, f.name
             FROM addon_orders ao LEFT JOIN features f ON f.id = ao.feature_id
            WHERE ao.client_id = $1
            ORDER BY paid_at DESC NULLS LAST LIMIT 50""",
        client_id,
    )
    return {"client": dict(c), "orders": [dict(o) for o in orders]}


@router.get("/accruals", summary="Мои начисления")
async def my_accruals(
    period: Optional[str] = Query(None, description="YYYY-MM"),
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Начисления и сводка по видам.

    ⚠️ Сводку считает БД тем же запросом, что и список: посчитанная отдельно,
    она разошлась бы со строками, и доверять ей стало бы нельзя.
    """
    spec_id = int(user["sub"])
    args: list = [spec_id]
    where = ["a.spec_id = $1"]
    if period:
        args.append(period)
        where.append(f"a.period = ${len(args)}")

    rows = await db.fetch(
        f"""SELECT a.id, a.kind, a.amount_kopecks, a.period, a.note,
                   a.paid_at, a.created_at,
                   c.name AS client_name, c.id AS client_id
              FROM tech_accruals a LEFT JOIN clients c ON c.id = a.client_id
             WHERE {' AND '.join(where)}
             ORDER BY a.created_at DESC LIMIT 500""",
        *args,
    )
    totals = await db.fetch(
        f"""SELECT a.kind, COUNT(*) AS n, SUM(a.amount_kopecks) AS sum_kopecks,
                   SUM(CASE WHEN a.paid_at IS NULL THEN a.amount_kopecks ELSE 0 END)
                     AS unpaid_kopecks
              FROM tech_accruals a
             WHERE {' AND '.join(where)}
             GROUP BY a.kind""",
        *args,
    )
    return {
        "accruals": [dict(r) for r in rows],
        "totals": [dict(t) for t in totals],
        "unpaid_kopecks": sum(int(t["unpaid_kopecks"] or 0) for t in totals),
    }


@router.get("/kpi", summary="Мои показатели")
async def my_kpi(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Показатели, по которым считаются деньги внедренца.

    ⚠️⚠️ ЦИФРЫ СЧИТАЮТСЯ ТЕМИ ЖЕ ВЫРАЖЕНИЯМИ, ЧТО И НАЧИСЛЕНИЯ
    ([tech_accruals.py](../services/tech_accruals.py)). Своя «примерно такая же»
    формула разошлась бы с выплатой, и экран, который должен объяснять деньги,
    начал бы спорить с ними.

    ⚠️ Ставки и ступени берутся ИЗ БАЗЫ, а не хардкодом: лист KPI прямо говорит,
    что ставки меняются в одном месте. Захардкоженная вилка на экране пережила бы
    правку ставки и врала бы молча.
    """
    spec_id = int(user["sub"])

    # ── Клиенты в работе ─────────────────────────────────────────────────
    # «Платит» — то же условие, что в `accrue_monthly_fix`: активная подписка
    # с source='paid'. Триал и выданное админом деньгами не считаются.
    paying = ("EXISTS (SELECT 1 FROM client_subscriptions cs2"
              " WHERE cs2.id = c.current_subscription_id AND cs2.status='active'"
              " AND cs2.expires_at > NOW() AND cs2.source='paid')")

    base = await db.fetchrow(
        f"""SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE {paying}) AS paying,
                   -- Свои приведённые: за них идёт процент, в фикс они НЕ идут.
                   COUNT(*) FILTER (WHERE c.referred_by_tech_id = $1) AS mine,
                   COUNT(*) FILTER (WHERE c.referred_by_tech_id = $1 AND {paying})
                     AS mine_paying,
                   -- Чужие платящие — именно они дают ступень фикса.
                   COUNT(*) FILTER (WHERE c.referred_by_tech_id IS DISTINCT FROM $1
                                      AND {paying}) AS others_paying,
                   -- Остывшие: не платят сейчас, но платили раньше. Это работа
                   -- на оживление, а не потеря.
                   COUNT(*) FILTER (
                     WHERE NOT {paying}
                       AND EXISTS (SELECT 1 FROM subscription_orders so
                                    WHERE so.client_id = c.id AND so.status='paid'
                                      AND so.amount_paid_card_kopecks > 0)) AS cold
              FROM clients c
             WHERE c.tech_specialist_id = $1""",
        spec_id,
    )

    # ── Ступень фикса ────────────────────────────────────────────────────
    others = int(base["others_paying"] or 0)
    cur_tier = await db.fetchrow(
        """SELECT clients_from, clients_to, amount_kopecks FROM tech_fix_tiers
            WHERE $1 BETWEEN clients_from AND clients_to
            ORDER BY clients_from DESC LIMIT 1""",
        others,
    )
    next_tier = await db.fetchrow(
        """SELECT clients_from, amount_kopecks FROM tech_fix_tiers
            WHERE clients_from > $1 AND amount_kopecks > 0
            ORDER BY clients_from LIMIT 1""",
        others,
    )

    # ── Доля доживших за текущий квартал ─────────────────────────────────
    # ⚠️ Тот же запрос, что в `accrue_quarter_bonus`, но по ИДУЩЕМУ кварталу —
    # чтобы человек видел, к какой ступени премии идёт, пока может влиять.
    quarter = await db.fetchrow(
        """WITH q AS (SELECT date_trunc('quarter', NOW()) AS s,
                             date_trunc('quarter', NOW()) + INTERVAL '3 months' AS e)
           SELECT COUNT(DISTINCT f.client_id) AS first_payers,
                  COUNT(DISTINCT f.client_id) FILTER (WHERE f.payments >= 2) AS survived
             FROM clients c, q
             JOIN LATERAL (
               SELECT so.client_id, MIN(so.paid_at) AS first_at, COUNT(*) AS payments
                 FROM subscription_orders so
                WHERE so.client_id = c.id AND so.status = 'paid'
                  AND so.amount_paid_card_kopecks > 0
                GROUP BY so.client_id
                HAVING MIN(so.paid_at) >= q.s AND MIN(so.paid_at) < q.e
             ) f ON TRUE
            WHERE c.tech_specialist_id = $1""",
        spec_id,
    )
    first_payers = int(quarter["first_payers"] or 0)
    survived = int(quarter["survived"] or 0)
    # ⚠️ Ноль оплативших — это «нечего считать», а не 0 %: показывать «0%»
    # значило бы пугать человека провалом там, где квартал только начался.
    rate = round(survived * 100 / first_payers, 1) if first_payers else None

    q_tier = None
    if rate is not None:
        q_tier = await db.fetchrow(
            """SELECT rate_from, rate_to, amount_kopecks FROM tech_quarter_tiers
                WHERE $1 >= rate_from AND $1 < rate_to
                ORDER BY rate_from DESC LIMIT 1""",
            rate,
        )
    q_next = await db.fetchrow(
        """SELECT rate_from, amount_kopecks FROM tech_quarter_tiers
            WHERE rate_from > COALESCE($1, -1) AND amount_kopecks > 0
            ORDER BY rate_from LIMIT 1""",
        rate,
    )

    # ── Деньги ───────────────────────────────────────────────────────────
    money = await db.fetchrow(
        """SELECT COALESCE(SUM(amount_kopecks),0) AS total,
                  COALESCE(SUM(amount_kopecks) FILTER (WHERE paid_at IS NULL),0)
                    AS unpaid,
                  COALESCE(SUM(amount_kopecks) FILTER (
                    WHERE period = to_char(NOW(),'YYYY-MM')),0) AS this_month
             FROM tech_accruals WHERE spec_id = $1""",
        spec_id,
    )

    rates = await db.fetch(
        """SELECT kind, amount_kopecks, percent, of_tariff
             FROM tech_rates WHERE is_active ORDER BY kind""")

    # ── Условия квартала и свои активации по источникам ──────────────────
    # ⚠️⚠️ Показываем ИМЕННО активации, а не оборот: оборот — экономика
    # владельца, внедренцу её видеть незачем. Ему нужно понимать, выполняет ли
    # он условия премии, а условия — в активациях.
    #
    # ⚠️ Разделены по источнику: «от ПЛЮСОНА» (клиента выдали) и «свои»
    # (привёл сам). Условия для этих видов работы разные.
    from app.services.tech_accruals import (
        quarter_requirements, _quarter_months, activations_by_source,
        activations_by_source_dates, current_period, period_months_count,
        meets_requirements,
    )
    # ⚠️ Сначала ищем период по ДАТАМ — рабочие периоды не совпадают с
    # календарными кварталами. Нет такого — откатываемся на квартал.
    cur = await current_period(db)
    if cur:
        q_period, req = cur["period"], cur
        got = await activations_by_source_dates(
            db, spec_id, req["starts_on"], req["ends_on"])
    else:
        now = datetime.now(timezone.utc)
        q_period = f"{now.year}-Q{(now.month - 1) // 3 + 1}"
        req = await quarter_requirements(db, q_period)
        got = await activations_by_source(db, spec_id, _quarter_months(q_period))
    months = period_months_count(req)
    role = await db.fetchval(
        "SELECT bonus_role FROM tech_specialists WHERE id = $1", spec_id)

    # ── Квалификация: где человек сейчас и сколько до следующей ступени ──
    # ⚠️ Показываем оборот СЕТИ — это не экономика компании, а масштаб его
    # собственной работы, от которого зависит его же процент.
    from app.services.tech_accruals import network_turnover_kopecks
    turnover = await network_turnover_kopecks(db, spec_id)
    q_cur = await db.fetchrow(
        """SELECT turnover_from, turnover_to, percent FROM tech_qualification_tiers
            WHERE $1 >= turnover_from AND $1 < turnover_to
            ORDER BY turnover_from DESC LIMIT 1""", turnover)
    q_next = await db.fetchrow(
        """SELECT turnover_from, percent FROM tech_qualification_tiers
            WHERE turnover_from > $1 ORDER BY turnover_from LIMIT 1""", turnover)

    return {
        "qualification": {
            "turnover_kopecks": turnover,
            "percent": float(q_cur["percent"]) if q_cur else None,
            "next_at_kopecks": int(q_next["turnover_from"]) if q_next else None,
            "next_percent": float(q_next["percent"]) if q_next else None,
        },
        "bonus_conditions": {
            "period": q_period,
            # Как период называют вслух и его границы — человек должен видеть,
            # за какой отрезок с него спрашивают.
            "title": req.get("title"),
            "starts_on": str(req["starts_on"]) if req.get("starts_on") else None,
            "ends_on": str(req["ends_on"]) if req.get("ends_on") else None,
            "months": months,
            "role": role,
            # Пороги заданы В МЕСЯЦ — отдаём и месячные, и квартальные, чтобы
            # человек видел, сколько осталось, а не пересчитывал сам.
            "need_from_pluson": (req["network_from_pluson"] if role == "implementer_network"
                                 else req["base_from_pluson"]),
            "need_own": req["network_own"] if role == "implementer_network" else 0,
            # ⚠️ ×длину периода, а не ×3: «с 15 сентября по 31 декабря» — это
            # 3,5 месяца, и требовать за него как за квартал неверно.
            "need_from_pluson_quarter": round(
                (req["network_from_pluson"] if role == "implementer_network"
                 else req["base_from_pluson"]) * months),
            "need_own_quarter": round(
                req["network_own"] * months if role == "implementer_network" else 0),
            "got_from_pluson": got["from_pluson"],
            "got_own": got["own"],
            "meets": meets_requirements(role, got, req, months),
        },
        "clients": {
            "total": int(base["total"] or 0),
            "paying": int(base["paying"] or 0),
            "mine": int(base["mine"] or 0),
            "mine_paying": int(base["mine_paying"] or 0),
            "others_paying": others,
            "cold": int(base["cold"] or 0),
        },
        "fix": {
            "clients_counted": others,
            "amount_kopecks": int(cur_tier["amount_kopecks"]) if cur_tier else 0,
            "tier_from": int(cur_tier["clients_from"]) if cur_tier else None,
            "tier_to": int(cur_tier["clients_to"]) if cur_tier else None,
            "next_at": int(next_tier["clients_from"]) if next_tier else None,
            "next_amount_kopecks": int(next_tier["amount_kopecks"]) if next_tier else None,
        },
        "quarter": {
            "first_payers": first_payers,
            "survived": survived,
            "rate": rate,
            "amount_kopecks": int(q_tier["amount_kopecks"]) if q_tier else 0,
            "next_rate": float(q_next["rate_from"]) if q_next else None,
            "next_amount_kopecks": int(q_next["amount_kopecks"]) if q_next else None,
        },
        "money": {
            "total_kopecks": int(money["total"] or 0),
            "unpaid_kopecks": int(money["unpaid"] or 0),
            "this_month_kopecks": int(money["this_month"] or 0),
        },
        "rates": [dict(r) for r in rates],
    }
