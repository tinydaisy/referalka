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
from pydantic import BaseModel

from app.auth import get_current_tech
from app.database import get_db
# ⚠️ Перевод «клиент → его внедренец» берём из единой точки, а не пишем свой
# подзапрос: своя копия разошлась бы с расчётом начислений, а это деньги.
from app.services.tech_accruals import (
    REFERRER_SPEC_SQL, PAYING_SQL, TRIAL_SQL, CRM_CASE_SQL, CRM_STATUSES,
)

router = APIRouter(prefix="/tech", tags=["Кабинет тех-специалиста"])


@router.get("/me", summary="Кто я и что мне открыто")
async def me(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    spec_id = int(user["sub"])
    row = await db.fetchrow(
        # ⚠️ `can_delete_faq` (мигр. 461) отдаём сюда же: по нему кабинет
        # решает, показывать ли кнопку удаления в частых вопросах. Сам запрет
        # стоит на эндпоинте удаления — здесь только вид.
        # ⚠️ Почта, имя, телефон и телеграм — из КЛИЕНТА (миграция 486):
        # внедренец роль над клиентом, своих копий этих полей у него нет.
        """SELECT ts.id, c.email, c.name, c.phone, c.telegram_username,
                  ts.can_edit_materials, ts.can_delete_faq, ts.is_active,
                  ts.client_id
             FROM tech_specialists ts
             JOIN clients c ON c.id = ts.client_id
            WHERE ts.id = $1""",
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
        # ⚠️ И по ФАМИЛИИ тоже (23.09.2026): у клиента фамилия отдельным полем,
        # и поиск по ней ничего не находил — человека, которого знаешь по
        # фамилии, было не найти.
        where.append(f"(c.name ILIKE ${len(args)} OR c.last_name ILIKE ${len(args)}"
                     f" OR c.email ILIKE ${len(args)}"
                     f" OR c.telegram_username ILIKE ${len(args)})")

    # ⚠️⚠️ CRM-СТАТУС И «ПЛАТИТ» — ИЗ ОБЩЕГО МОДУЛЯ (`services/tech_accruals`),
    # а не своей копией здесь. Те же выражения считают деньги и показывают
    # сводную CRM в админке: расхождение означало бы «удержан» в одном экране,
    # «активирован» в другом и начисление по третьему правилу.
    paying, trial, crm_case = PAYING_SQL, TRIAL_SQL, CRM_CASE_SQL
    CRM = CRM_STATUSES
    if status == "paying":
        where.append(paying)
    elif status == "trial":
        where.append(trial)
    elif status == "cold":
        where.append(f"NOT {paying} AND NOT {trial}")
    elif status in CRM:
        args.append(status)
        where.append(f"({crm_case}) = ${len(args)}")

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
                     WHEN {REFERRER_SPEC_SQL} = $1 THEN 1
                     WHEN (SELECT ts_l2.id FROM tech_specialists ts_l2
                            WHERE ts_l2.client_id = (SELECT l1.referred_by_client_id
                                                       FROM clients l1
                                                      WHERE l1.id = c.referred_by_client_id)
                          ) = $1 THEN 2
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
                   (SELECT COUNT(*) FROM contacts ct WHERE ct.client_id = c.id) AS contacts_count,
                   ({crm_case}) AS crm_status,
                   -- Свой или из базы ПЛЮСОНА: от этого зависят проценты.
                   ({REFERRER_SPEC_SQL} = $1) AS is_own,
                   -- ⚠️ Контакты площадок у клиента — это `work_max`/`work_vk`
                   -- (рабочие ники, которые он указал сам), а не id профилей:
                   -- колонок max_username/vk_user_id в `clients` нет вовсе.
                   c.work_max, c.work_vk
              FROM clients c
              LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
              LEFT JOIN tariffs t ON t.id = cs.tariff_id
             WHERE {' AND '.join(where)}
             ORDER BY c.created_at DESC""",
        *args,
    )
    return {"clients": [dict(r) for r in rows]}


class NotifyIn(BaseModel):
    """⚠️ `notify_tg_user_id` СЮДА НЕ ВХОДИТ намеренно: личка привязывается
    автоматически по ссылке-связке. Позволить ввести чужой id значило бы слать
    уведомления о клиентах не тому человеку."""
    notify_chat_id: Optional[str] = None
    notify_kinds: Optional[list[str]] = None


@router.get("/notify-settings", summary="Куда мне шлют уведомления")
async def notify_settings(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    from app.services.support_link import make_support_param
    from app.services.tech_notify import KINDS

    spec_id = int(user["sub"])
    row = await db.fetchrow(
        """SELECT notify_tg_user_id, notify_chat_id, notify_kinds,
                  notify_tg_linked_at
             FROM tech_specialists WHERE id = $1""",
        spec_id,
    )
    if not row:
        raise HTTPException(404, "Не найден")

    kinds = row["notify_kinds"] or []
    if isinstance(kinds, str):
        import json as _json
        kinds = _json.loads(kinds)

    # ⚠️ Ссылка-связка ПОДПИСАНА: без подписи любой подставил бы чужой id
    # специалиста и увёл бы себе чужие уведомления.
    param = make_support_param(reason="techlink", client_id=spec_id)

    return {
        "linked": bool(row["notify_tg_user_id"]),
        "linked_at": (row["notify_tg_linked_at"].isoformat()
                      if row["notify_tg_linked_at"] else None),
        "chat_id": row["notify_chat_id"],
        "kinds": kinds,
        "all_kinds": [{"id": k, "tag": v} for k, v in KINDS.items()],
        "link_url": f"https://telegram.me/pluson_bot?start={param}",
    }


@router.post("/notify-settings", summary="Сохранить настройки уведомлений")
async def save_notify_settings(
    data: NotifyIn,
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    import json as _json

    from app.services.tech_notify import KINDS

    spec_id = int(user["sub"])
    fs = data.model_fields_set
    sets, args = [], []

    if "notify_chat_id" in fs:
        chat = (data.notify_chat_id or "").strip() or None
        # ⚠️ Проверяем формат: id чата — это число (у групп со знаком минус).
        # Ник вида @group сюда не годится — Telegram примет его не везде, и
        # ошибка вылезет только в момент отправки уведомления.
        if chat and not chat.lstrip("-").isdigit():
            raise HTTPException(
                400, "ID чата — это число, например -1001234567890. "
                     "Узнать его можно командой /getmyid в нужной группе.")
        args.append(chat)
        sets.append(f"notify_chat_id = ${len(args)}")

    if "notify_kinds" in fs:
        kinds = [k for k in (data.notify_kinds or []) if k in KINDS]
        args.append(_json.dumps(kinds))
        sets.append(f"notify_kinds = ${len(args)}::jsonb")

    if not sets:
        raise HTTPException(400, "Нечего менять")

    args.append(spec_id)
    await db.execute(
        f"UPDATE tech_specialists SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)}",
        *args,
    )
    return {"ok": True}


@router.get("/money", summary="Мои деньги за месяц")
async def my_money(
    period: Optional[str] = Query(None, description="YYYY-MM, по умолчанию текущий"),
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Разбивка заработка по видам: сколько человек и сколько денег.

    ⚠️⚠️ БЕРЁМ ИЗ `tech_accruals`, А НЕ СЧИТАЕМ ЗАНОВО. Начисление — это уже
    принятое решение о деньгах, записанное со ставкой на момент события.
    Пересчёт «по текущим ставкам» показал бы другие суммы, чем будут выплачены,
    и экран начал бы спорить с выплатой.

    ⚠️ Оборот — из оплат клиентов, а не из начислений: это разные величины.
    Оборот показываем СВОЙ и КОМАНДНЫЙ, но без прибыли компании — её внедренец
    видеть не должен.
    """
    from datetime import date

    spec_id = int(user["sub"])
    period = (period or date.today().strftime("%Y-%m")).strip()

    rows = await db.fetch(
        """SELECT kind,
                  COUNT(*) AS cnt,
                  COUNT(DISTINCT client_id) FILTER (WHERE client_id IS NOT NULL)
                    AS people,
                  COALESCE(SUM(amount_kopecks), 0) AS total,
                  COALESCE(SUM(amount_kopecks) FILTER (WHERE paid_at IS NULL), 0)
                    AS unpaid
             FROM tech_accruals
            WHERE spec_id = $1 AND period = $2
            GROUP BY kind""",
        spec_id, period,
    )
    by_kind = {r["kind"]: {
        "count": int(r["cnt"]), "people": int(r["people"]),
        "amount_kopecks": int(r["total"]),
        "unpaid_kopecks": int(r["unpaid"]),
    } for r in rows}

    total = sum(v["amount_kopecks"] for v in by_kind.values())
    unpaid = sum(v["unpaid_kopecks"] for v in by_kind.values())

    # Свой оборот за месяц — оплаты закреплённых за мной клиентов.
    own_turnover = await db.fetchval(
        """SELECT COALESCE(SUM(so.amount_paid_card_kopecks), 0)
             FROM subscription_orders so
             JOIN clients c ON c.id = so.client_id
            WHERE c.tech_specialist_id = $1
              AND so.status = 'paid'
              AND to_char(so.paid_at, 'YYYY-MM') = $2""",
        spec_id, period,
    )

    # Командный оборот — вся платформа за месяц.
    # ⚠️ Это ОБОРОТ, а не прибыль: от оборота зависит ступень премиального
    # фонда, и человеку надо видеть, близко ли она. Прибыль не показываем.
    team_turnover = await db.fetchval(
        """SELECT COALESCE(SUM(amount_paid_card_kopecks), 0)
             FROM subscription_orders
            WHERE status = 'paid' AND to_char(paid_at, 'YYYY-MM') = $1""",
        period,
    )

    # Тип внедренца и веса — из справочника, не из кода.
    spec = await db.fetchrow(
        """SELECT ts.bonus_role, w.weight
             FROM tech_specialists ts
             LEFT JOIN tech_bonus_weights w ON w.role = ts.bonus_role
            WHERE ts.id = $1""",
        spec_id,
    )

    return {
        "period": period,
        "by_kind": by_kind,
        "total_kopecks": total,
        "unpaid_kopecks": unpaid,
        "own_turnover_kopecks": int(own_turnover or 0),
        "team_turnover_kopecks": int(team_turnover or 0),
        "role": spec["bonus_role"] if spec else None,
        "role_weight": float(spec["weight"]) if spec and spec["weight"] else None,
    }


@router.get("/funnel", summary="Моя воронка и сводка по базе")
async def my_funnel(
    user: dict = Depends(get_current_tech),
    db: asyncpg.Connection = Depends(get_db),
):
    """Сводка по базе и воронка по статусам — цифры над списком клиентов.

    ⚠️⚠️ СЧИТАЕТСЯ ТЕМ ЖЕ ВЫРАЖЕНИЕМ, что и статус в списке: одна копия правил
    на оба экрана. Разъедутся — в сводке будет «удержанных 5», а в списке их
    окажется четыре, и доверие к цифрам пропадёт.
    """
    spec_id = int(user["sub"])

    # ⚠️ Те же общие выражения, что и в «Мои клиенты» и в начислениях.
    paying, trial = PAYING_SQL, TRIAL_SQL
    paid_cnt, revived = PAID_CNT_SQL, REVIVED_SQL

    row = await db.fetchrow(
        f"""SELECT
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE {REFERRER_SPEC_SQL} = $1) AS own,
              COUNT(*) FILTER (WHERE {REFERRER_SPEC_SQL} IS DISTINCT FROM $1)
                AS from_pluson,
              COUNT(*) FILTER (WHERE {paying}) AS active_now,
              COUNT(*) FILTER (WHERE NOT {paying} AND {paid_cnt} > 0) AS churned,
              COUNT(*) FILTER (WHERE {trial} AND {paid_cnt} = 0) AS trial,
              COUNT(*) FILTER (WHERE {paying} AND {paid_cnt} = 1) AS activated,
              COUNT(*) FILTER (WHERE {paying} AND {paid_cnt} >= 2
                               AND NOT {revived}) AS retained,
              COUNT(*) FILTER (WHERE {paying} AND {revived}) AS revived
            FROM clients c
           WHERE c.tech_specialist_id = $1""",
        spec_id,
    )

    # По месяцам — чтобы видеть движение, а не только срез «сейчас».
    # ⚠️ Берём из начислений: там записан ФАКТ события с датой. По текущему
    # состоянию подписки «когда активировался» уже не восстановить.
    months = await db.fetch(
        """SELECT to_char(date_trunc('month', a.created_at), 'YYYY-MM') AS month,
                  COUNT(*) FILTER (WHERE a.kind = 'activation') AS activated,
                  COUNT(*) FILTER (WHERE a.kind = 'retention') AS retained,
                  COUNT(*) FILTER (WHERE a.kind = 'revival') AS revived
             FROM tech_accruals a
            WHERE a.spec_id = $1
              AND a.kind IN ('activation', 'retention', 'revival')
              AND a.created_at > NOW() - INTERVAL '12 months'
            GROUP BY 1 ORDER BY 1 DESC""",
        spec_id,
    )

    return {
        "summary": {
            "total": row["total"], "own": row["own"],
            "from_pluson": row["from_pluson"],
            "active_now": row["active_now"], "churned": row["churned"],
        },
        "funnel": {
            "trial": row["trial"], "activated": row["activated"],
            "retained": row["retained"], "revived": row["revived"],
            "churned": row["churned"],
        },
        "months": [dict(m) for m in months],
    }


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
    # «Платит» — то же условие, что в `accrue_monthly_fix` и во всех экранах:
    # активная подписка с source='paid'. Триал и выданное админом не деньги.
    paying = PAYING_SQL

    base = await db.fetchrow(
        f"""SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE {paying}) AS paying,
                   -- Свои приведённые: за них идёт процент, в фикс они НЕ идут.
                   COUNT(*) FILTER (WHERE {REFERRER_SPEC_SQL} = $1) AS mine,
                   COUNT(*) FILTER (WHERE {REFERRER_SPEC_SQL} = $1 AND {paying})
                     AS mine_paying,
                   -- Чужие платящие — именно они дают ступень фикса.
                   COUNT(*) FILTER (WHERE {REFERRER_SPEC_SQL} IS DISTINCT FROM $1
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
    # ⚠️⚠️ ИМЯ `qual_next`, А НЕ `q_next`: выше по функции уже есть `q_next` —
    # следующая ступень ПРЕМИИ (`tech_quarter_tiers`, колонка `rate_from`).
    # Здесь другая вилка — КВАЛИФИКАЦИИ (`tech_qualification_tiers`, колонка
    # `turnover_from`), и одинаковое имя затирало первую: экран «Показатели»
    # падал с `KeyError: 'rate_from'` на блоке премии. Поймано на проде
    # 22.09.2026 живой проверкой кабинета.
    qual_next = await db.fetchrow(
        """SELECT turnover_from, percent FROM tech_qualification_tiers
            WHERE turnover_from > $1 ORDER BY turnover_from LIMIT 1""", turnover)

    return {
        "qualification": {
            "turnover_kopecks": turnover,
            "percent": float(q_cur["percent"]) if q_cur else None,
            "next_at_kopecks": int(qual_next["turnover_from"]) if qual_next else None,
            "next_percent": float(qual_next["percent"]) if qual_next else None,
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
