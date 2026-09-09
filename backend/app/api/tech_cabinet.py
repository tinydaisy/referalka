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
                   -- Лично приведённый: за него идёт процент.
                   (c.referred_by_client_id IS NOT NULL
                    AND (SELECT tech_specialist_id FROM clients r
                          WHERE r.id = c.referred_by_client_id) = $1) AS is_mine_referral,
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
