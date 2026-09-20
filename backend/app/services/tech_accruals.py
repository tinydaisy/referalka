"""Начисления внедренцам — по листу «2. KPI и проценты» (миграции 391, 394).

Правила взяты из таблицы владельца, не придуманы:

  • АКТИВАЦИЯ — 20 % от тарифа. Три условия сразу: 10+ НОВЫХ подписчиков в боте
    через настроенную воронку, оплата после триала, оплата ВТОРОГО месяца.
    Выплата по третьему.
  • ОЖИВЛЕНИЕ — 15 % от тарифа, если не платил 2 месяца и больше. Сразу, без
    отсрочки: оплата после тишины — уже доказательство.
  • СВОЙ ПРИВЕДЁННЫЙ — 10 % ПОЖИЗНЕННО, каждый месяц пока клиент платит.
  • ВТОРОЙ УРОВЕНЬ — 5 %. Первые 4 месяца без условий, дальше нужен порог
    20 новых оплативших за квартал по линии.
  • ФИКС — вилка по числу ЧУЖИХ платящих клиентов (15–49 → 4 000 ₽ и т. д.).
  • КВАРТАЛЬНАЯ ПРЕМИЯ — за долю доживших, считается через месяц после квартала.

⚠️⚠️ ПРОЦЕНТ СЧИТАЕТСЯ ОТ ЦЕНЫ ТАРИФА, А НЕ ОТ СУММЫ ОПЛАТЫ. У Профи 20 % это
398 ₽ независимо от того, оплатил человек месяц или полгода: ставка привязана к
тарифу, а не к разовому платежу. Считать от суммы значило бы платить внедренцу
в 6 раз больше с полугодовой оплаты.

⚠️ ПОЧЕМУ СЧИТАЕТСЯ ПО СОБЫТИЮ, А НЕ ЗАПРОСОМ НА ЛЕТУ. Клиента могли передать
другому, тариф сменить, оплату вернуть — и цифра за прошлый месяц изменилась бы
задним числом уже после выплаты. Начисление это факт: случилось — записали.

⚠️ Двойное начисление не даёт БАЗА (уникальные индексы), а не проверка в коде:
задача идёт по расписанию и может быть перезапущена.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)


async def _setting(db, key: str, default: float) -> float:
    """Порог из `tech_settings`. Нет строки → значение по умолчанию."""
    v = await db.fetchval("SELECT value FROM tech_settings WHERE key = $1", key)
    return float(v) if v is not None else default


async def _rate(db, kind: str) -> tuple[int, float, bool]:
    """Ставка: (копейки, процент, считать ли от тарифа)."""
    row = await db.fetchrow(
        """SELECT amount_kopecks, percent, of_tariff
             FROM tech_rates WHERE kind = $1 AND is_active""",
        kind,
    )
    if not row:
        return 0, 0.0, False
    return (int(row["amount_kopecks"] or 0), float(row["percent"] or 0),
            bool(row["of_tariff"]))


async def _tariff_price_kopecks(db, client_id: int) -> int:
    """Цена ТЕКУЩЕГО тарифа клиента в копейках.

    ⚠️ Именно текущего: если клиент перешёл с Профи на Экстру, дальнейшие
    начисления идут по новой цене — так и задумано, работы с ним стало больше.
    """
    price = await db.fetchval(
        """SELECT t.price FROM clients c
             JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.id = $1""",
        client_id,
    )
    return int(price or 0) * 100


async def _amount(db, kind: str, client_id: int) -> int:
    """Сколько начислить за это событие у этого клиента."""
    kop, percent, of_tariff = await _rate(db, kind)
    if not of_tariff:
        return kop
    price = await _tariff_price_kopecks(db, client_id)
    return int(price * percent / 100) if price and percent else 0


async def _add(db, *, spec_id: int, client_id: Optional[int], kind: str,
               amount: int, order_id: Optional[int] = None,
               period: Optional[str] = None, note: Optional[str] = None) -> bool:
    """Записывает начисление. `False` — если такое уже есть.

    ⚠️ ON CONFLICT DO NOTHING, а не проверка «есть ли уже»: между проверкой и
    вставкой параллельный запуск успел бы вставить свою строку.
    """
    if amount <= 0:
        return False
    row = await db.fetchrow(
        """INSERT INTO tech_accruals
             (spec_id, client_id, kind, amount_kopecks, source_order_id, period, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING RETURNING id""",
        spec_id, client_id, kind, amount, order_id, period, note,
    )
    return row is not None


# ─────────────────────────── Оплата клиента ──────────────────────────────
async def on_payment(db: asyncpg.Connection, order_id: int) -> None:
    """Оплата подтверждена — считаем, что причитается внедренцу.

    Исключений не бросает: деньги уже приняты, сбой начисления не должен ломать
    выдачу подписки.
    """
    try:
        await _on_payment(db, order_id)
    except Exception as e:                                      # noqa: BLE001
        logger.exception("tech accrual failed (order %s): %s", order_id, e)


async def _on_payment(db: asyncpg.Connection, order_id: int) -> None:
    o = await db.fetchrow(
        """SELECT so.id, so.client_id, so.amount_paid_card_kopecks AS paid,
                  so.paid_at, c.tech_specialist_id AS spec_id,
                  c.referred_by_tech_id, c.referred_by_client_id
             FROM subscription_orders so JOIN clients c ON c.id = so.client_id
            WHERE so.id = $1 AND so.status = 'paid'""",
        order_id,
    )
    if not o:
        return

    client_id = o["client_id"]
    spec_id = o["spec_id"]
    period = (o["paid_at"] or datetime.now(timezone.utc)).strftime("%Y-%m")

    payments = await db.fetch(
        """SELECT id, paid_at FROM subscription_orders
            WHERE client_id = $1 AND status = 'paid' AND amount_paid_card_kopecks > 0
            ORDER BY paid_at""",
        client_id,
    )
    n = len(payments)
    is_this_last = bool(payments) and payments[-1]["id"] == order_id

    # ── Активация: ВТОРАЯ оплата + 10 новых подписчиков через воронку ────
    if spec_id and n == 2 and is_this_last:
        need = int(await _setting(db, "activation_min_subscribers", 10))
        # ⚠️ Считаем НОВЫХ подписчиков, пришедших через воронку ПОСЛЕ
        # закрепления клиента: старая база не в счёт, иначе условие
        # выполняется само собой у любого клиента с историей.
        # ⚠️ `client_id` лежит прямо в `funnel_runs` — JOIN на контакты не
        # нужен. Дата захода — `started_at` (колонки `created_at` там нет);
        # берём именно её, а не `landed_at`: «зашёл по ссылке» ещё не значит
        # «подписался», а условие про ПОДПИСЧИКОВ.
        got = await db.fetchval(
            """SELECT COUNT(DISTINCT fr.contact_id)
                 FROM funnel_runs fr
                WHERE fr.client_id = $1
                  AND fr.stage IN ('started','subscribed','delivered')
                  AND COALESCE(fr.started_at, fr.landed_at) >= COALESCE(
                        (SELECT tech_assigned_at FROM clients WHERE id = $1),
                        '-infinity'::timestamptz)""",
            client_id,
        ) or 0
        if got >= need:
            amount = await _amount(db, "activation", client_id)
            if await _add(db, spec_id=spec_id, client_id=client_id,
                          kind="activation", amount=amount, order_id=order_id,
                          period=period, note=f"вторая оплата, {got} новых в воронке"):
                logger.info("tech: активация клиента %s спецу %s", client_id, spec_id)
        else:
            logger.info("tech: активация клиента %s не засчитана — %s новых из %s",
                        client_id, got, need)

        # ── Удержание: 30 % за то, что клиент оплатил ВТОРОЙ месяц ──────
        # ⚠️ Начисляется на том же событии, что и активация, но НЕЗАВИСИМО от
        # порога подписчиков: активация — за качество запуска (10+ новых через
        # воронку), удержание — за сам факт второй оплаты. Клиент может дожить
        # до второго месяца и без выполненного порога; работа сделана, платим.
        amount = await _amount(db, "retention", client_id)
        if await _add(db, spec_id=spec_id, client_id=client_id,
                      kind="retention", amount=amount, order_id=order_id,
                      period=period, note="оплачен второй месяц"):
            logger.info("tech: удержание клиента %s спецу %s", client_id, spec_id)

    # ── Оживление: оплата после 2+ месяцев тишины ────────────────────────
    # ⚠️ По РАЗРЫВУ между оплатами, а не по статусу подписки: статус меняет
    # задача раз в час и он отстаёт, а даты оплат — факт.
    elif spec_id and n >= 2 and is_this_last:
        months = await _setting(db, "revival_silence_months", 2)
        prev, cur = payments[-2]["paid_at"], payments[-1]["paid_at"]
        if prev and cur and (cur - prev).days >= months * 30:
            amount = await _amount(db, "revival", client_id)
            if await _add(db, spec_id=spec_id, client_id=client_id, kind="revival",
                          amount=amount, order_id=order_id, period=period,
                          note=f"перерыв {(cur - prev).days} дн."):
                logger.info("tech: оживление клиента %s спецу %s", client_id, spec_id)

    # ── Проценты за приведённых ──────────────────────────────────────────
    # ⚠️ Считаются НЕЗАВИСИМО от того, кто обслуживает: 10 % пожизненно платятся
    # тому, кто ПРИВЁЛ, даже если клиента передали другому на обслуживание.
    await _referral_percents(db, client_id=client_id, order_id=order_id, period=period)


async def network_turnover_kopecks(db, spec_id: int) -> int:
    """Оборот сети внедренца за месяц — по ЦЕНАМ ТАРИФОВ его платящих клиентов.

    ⚠️ Сеть — ВСЕ действующие клиенты: и выданные ПЛЮСОНОМ, и приведённые им
    лично, и пришедшие по его линии. Так задано листом «Ставки»: квалификация
    растёт от общего масштаба работы, а не только от привлечения.
    """
    return int(await db.fetchval(
        """SELECT COALESCE(SUM(t.price), 0) * 100
             FROM clients c
             JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             JOIN tariffs t ON t.id = cs.tariff_id
            WHERE cs.status = 'active' AND cs.expires_at > NOW()
              AND cs.source = 'paid'
              AND (c.tech_specialist_id = $1 OR c.referred_by_tech_id = $1)""",
        spec_id) or 0)


async def qualification_percent(db, spec_id: int, default: float) -> float:
    """Процент 1-го уровня по КВАЛИФИКАЦИИ — растёт от оборота сети.

    ⚠️⚠️ Ставка `referral` в `tech_rates` — это СТАРТОВОЕ значение (10 %). Выше
    оно поднимается вилкой `tech_qualification_tiers`: 10 → 10,5 → 11 → 11,5 →
    12 % по мере роста оборота. Игнорировать вилку значило бы платить всем по
    стартовой ставке независимо от масштаба.
    """
    turnover = await network_turnover_kopecks(db, spec_id)
    row = await db.fetchrow(
        """SELECT percent FROM tech_qualification_tiers
            WHERE $1 >= turnover_from AND $1 < turnover_to
            ORDER BY turnover_from DESC LIMIT 1""",
        turnover)
    return float(row["percent"]) if row else default


async def _referral_percents(db, *, client_id: int, order_id: int, period: str) -> None:
    """10 % своему, 5 % второму уровню, 2 % третьему.

    ⚠️ Три уровня считаются ВСЕМ (решение владельца 15.09.2026), а не только
    внедренцам: у обычного партнёра линии такой глубины не будет и строка
    останется пустой. Одна механика дешевле двух параллельных.
    """
    row = await db.fetchrow(
        """SELECT c.referred_by_tech_id AS l1,
                  (SELECT p.referred_by_tech_id FROM clients p
                    WHERE p.id = c.referred_by_client_id) AS l2,
                  (SELECT g.referred_by_tech_id FROM clients g
                    WHERE g.id = (SELECT p2.referred_by_client_id FROM clients p2
                                   WHERE p2.id = c.referred_by_client_id)) AS l3
             FROM clients c WHERE c.id = $1""",
        client_id,
    )
    if not row:
        return

    if row["l1"]:
        # ⚠️ Процент 1-го уровня зависит от КВАЛИФИКАЦИИ: чем больше оборот сети,
        # тем выше ставка (10 → 12 %). Берём вилку, а не стартовое значение.
        _, base_pct, _ = await _rate(db, "referral")
        pct = await qualification_percent(db, row["l1"], base_pct)
        price = await _tariff_price_kopecks(db, client_id)
        amount = int(round(price * pct / 100))
        await _add(db, spec_id=row["l1"], client_id=client_id, kind="referral",
                   amount=amount, order_id=order_id, period=period,
                   note=f"{pct:g}% свой приведённый (квалификация)")

    # ⚠️ Второй уровень — только если это НЕ тот же человек: иначе за одну
    # оплату он получил бы и 10 %, и 5 %.
    if row["l2"] and row["l2"] != row["l1"]:
        if await _level2_allowed(db, row["l2"], client_id):
            amount = await _amount(db, "referral2", client_id)
            await _add(db, spec_id=row["l2"], client_id=client_id, kind="referral2",
                       amount=amount, order_id=order_id, period=period,
                       note="5% второй уровень")

    # ⚠️ Третий уровень — тот же принцип: платим, только если это НЕ тот же
    # человек, что на первом или втором уровне. Иначе за одну оплату он собрал
    # бы 10 %, 5 % и 2 % сразу.
    if row["l3"] and row["l3"] not in (row["l1"], row["l2"]):
        amount = await _amount(db, "referral3", client_id)
        await _add(db, spec_id=row["l3"], client_id=client_id, kind="referral3",
                   amount=amount, order_id=order_id, period=period,
                   note="2% третий уровень")


async def _level2_allowed(db, spec_id: int, client_id: int) -> bool:
    """Можно ли платить 5 % за второй уровень.

    Первые 4 месяца — без условий. Дальше нужен порог: 20 новых оплативших за
    квартал по линии. ⚠️ Не выполнил — начисление НА ПАУЗЕ, а не отменено
    навсегда: линия сохраняется и оживает в квартале, где порог снова взят.
    """
    free_months = await _setting(db, "level2_free_months", 4)
    first_paid = await db.fetchval(
        """SELECT MIN(paid_at) FROM subscription_orders
            WHERE client_id = $1 AND status = 'paid'""",
        client_id,
    )
    if first_paid:
        age_days = (datetime.now(timezone.utc) - first_paid).days
        if age_days <= free_months * 30:
            return True

    threshold = int(await _setting(db, "level2_quarter_threshold", 20))
    # Новые оплатившие по линии этого внедренца за последние 90 дней.
    got = await db.fetchval(
        """SELECT COUNT(DISTINCT so.client_id)
             FROM subscription_orders so
             JOIN clients c ON c.id = so.client_id
            WHERE so.status = 'paid' AND so.paid_at >= NOW() - INTERVAL '90 days'
              AND (c.referred_by_tech_id = $1
                   OR (SELECT p.referred_by_tech_id FROM clients p
                        WHERE p.id = c.referred_by_client_id) = $1)""",
        spec_id,
    ) or 0
    return got >= threshold


# ─────────────────────────── Ежемесячный фикс ────────────────────────────
async def accrue_monthly_fix(db: asyncpg.Connection, period: Optional[str] = None) -> int:
    """Фикс по вилке — за ЧУЖИХ платящих клиентов в работе.

    ⚠️⚠️ ВИЛКА, А НЕ СУММА ЗА КАЖДОГО: 15–49 клиентов → 4 000 ₽ за всех сразу.
    Умножение на число клиентов дало бы на сотне 30 000 вместо 12 000.

    ⚠️ Свои приведённые в счёт НЕ идут: за них внедренец получает 10 %, и брать
    за них ещё и фикс — двойная выплата за одного человека.

    ⚠️ Активный клиент = ОПЛАТИВШИЙ, а не «в списке»: перестал платить — в тот
    же месяц выбывает из счёта.
    """
    period = period or datetime.now(timezone.utc).strftime("%Y-%m")

    rows = await db.fetch(
        """SELECT ts.id AS spec_id,
                  COUNT(c.id) FILTER (
                    WHERE c.referred_by_tech_id IS DISTINCT FROM ts.id
                      AND EXISTS (SELECT 1 FROM client_subscriptions cs
                                   WHERE cs.id = c.current_subscription_id
                                     AND cs.status='active' AND cs.expires_at > NOW()
                                     AND cs.source='paid')
                  ) AS others
             FROM tech_specialists ts
             LEFT JOIN clients c ON c.tech_specialist_id = ts.id
            WHERE ts.is_active
            GROUP BY ts.id"""
    )

    done = 0
    for r in rows:
        n = int(r["others"] or 0)
        amount = await db.fetchval(
            """SELECT amount_kopecks FROM tech_fix_tiers
                WHERE $1 BETWEEN clients_from AND clients_to
                ORDER BY clients_from DESC LIMIT 1""",
            n,
        ) or 0
        if amount and await _add(db, spec_id=r["spec_id"], client_id=None,
                                 kind="fix", amount=int(amount), period=period,
                                 note=f"{n} клиентов на обслуживании"):
            done += 1
    logger.info("tech: фикс за %s — %s начислений", period, done)
    return done


# ──────────────────── Условия квартала и активации ───────────────────────
async def quarter_requirements(db, period: str) -> dict:
    """Условия допуска к премии на период.

    ⚠️ Период задаётся ДАТАМИ (`starts_on`/`ends_on`), а не календарным
    кварталом: рабочие периоды с ними не совпадают — первый идёт с середины
    сентября до конца года.

    ⚠️ Нет строки на период — берём значения по умолчанию из `tech_settings`:
    работа не должна вставать оттого, что условия забыли задать.
    """
    row = await db.fetchrow(
        """SELECT base_from_pluson, network_from_pluson, network_own,
                  starts_on, ends_on, title
             FROM tech_quarter_requirements WHERE period = $1""",
        period,
    )
    if row:
        return dict(row)
    return {
        "base_from_pluson": int(await _setting(db, "network_role_activations", 6)),
        "network_from_pluson": 3,
        "network_own": 5,
        "starts_on": None, "ends_on": None, "title": None,
    }


async def current_period(db) -> Optional[dict]:
    """Период, идущий СЕЙЧАС — по датам, а не по календарю.

    ⚠️ Если периодов с датами нет вовсе, возвращаем None: вызывающий код
    откатится на календарный квартал.
    """
    row = await db.fetchrow(
        """SELECT period, starts_on, ends_on, title,
                  base_from_pluson, network_from_pluson, network_own
             FROM tech_quarter_requirements
            WHERE starts_on IS NOT NULL AND ends_on IS NOT NULL
              AND CURRENT_DATE BETWEEN starts_on AND ends_on
            ORDER BY starts_on DESC LIMIT 1"""
    )
    return dict(row) if row else None


def period_months_count(req: dict) -> float:
    """Сколько МЕСЯЦЕВ в периоде — пороги задаются в месяц, а период произвольный.

    ⚠️ Период «с 15 сентября по 31 декабря» — это 3,5 месяца, а не квартал.
    Считать его как 3 значило бы занизить требование, как 4 — завысить.
    """
    if req.get("starts_on") and req.get("ends_on"):
        days = (req["ends_on"] - req["starts_on"]).days + 1
        return round(days / 30.44, 2)
    return 3.0


def _quarter_months(period: str) -> list[str]:
    """['2026-01','2026-02','2026-03'] для '2026-Q1'."""
    year, q = int(period[:4]), int(period[-1])
    return [f"{year}-{m:02d}" for m in range((q - 1) * 3 + 1, q * 3 + 1)]


async def activations_by_source_dates(db, spec_id: int, starts_on, ends_on) -> dict:
    """То же, что `activations_by_source`, но за ПРОИЗВОЛЬНЫЙ отрезок дат.

    ⚠️ Берём `created_at` начисления, а не строку `period`: при границах вроде
    «с 15 сентября» месяц попадает в период частично, и сравнение по '2026-09'
    засчитало бы работу, сделанную до старта.
    """
    row = await db.fetchrow(
        """SELECT
             COUNT(*) FILTER (WHERE c.referred_by_tech_id IS DISTINCT FROM $1)
               AS from_pluson,
             COUNT(*) FILTER (WHERE c.referred_by_tech_id = $1) AS own
           FROM tech_accruals a
           JOIN clients c ON c.id = a.client_id
          WHERE a.spec_id = $1 AND a.kind = 'activation'
            AND a.created_at::date BETWEEN $2 AND $3""",
        spec_id, starts_on, ends_on,
    )
    return {"from_pluson": int(row["from_pluson"] or 0) if row else 0,
            "own": int(row["own"] or 0) if row else 0}


async def activations_by_source(db, spec_id: int, periods: list[str]) -> dict:
    """Активации внедренца за период, РАЗДЕЛЁННЫЕ по источнику клиента.

    ⚠️⚠️ Источник решает всё: «от ПЛЮСОНА» — клиент, которого выдали, «свой» —
    которого внедренец привёл сам (`clients.referred_by_tech_id`). Условия
    премии разные для этих двух видов работы, поэтому считать их одной цифрой
    нельзя.
    """
    row = await db.fetchrow(
        """SELECT
             COUNT(*) FILTER (WHERE c.referred_by_tech_id IS DISTINCT FROM $1)
               AS from_pluson,
             COUNT(*) FILTER (WHERE c.referred_by_tech_id = $1) AS own
           FROM tech_accruals a
           JOIN clients c ON c.id = a.client_id
          WHERE a.spec_id = $1 AND a.kind = 'activation'
            AND a.period = ANY($2::text[])""",
        spec_id, periods,
    )
    return {"from_pluson": int(row["from_pluson"] or 0) if row else 0,
            "own": int(row["own"] or 0) if row else 0}


def meets_requirements(role: str, got: dict, req: dict,
                       months: Optional[float] = None) -> bool:
    """Взял ли человек условия периода.

    ⚠️ Пороги заданы В МЕСЯЦ, сверяем за ВЕСЬ период — иначе один слабый месяц
    обнулял бы работу двух сильных. Длина периода берётся из его дат: «с 15
    сентября по 31 декабря» это 3,5 месяца, а не 3.
    """
    if months is None:
        months = period_months_count(req)
    if role == "implementer_network":
        return (got["from_pluson"] >= req["network_from_pluson"] * months
                and got["own"] >= req["network_own"] * months)
    return got["from_pluson"] >= req["base_from_pluson"] * months


# ────────────────────── Квартальная премия ───────────────────────────────
async def accrue_quarter_bonus(db: asyncpg.Connection,
                               quarter: Optional[str] = None) -> int:
    """Делит введённый премиальный фонд между внедренцами ПО ВЕСАМ должностей.

    ⚠️⚠️ СУММУ ФОНДА ВВОДИТ АДМИН, А НЕ СЧИТАЕТ ПЛАТФОРМА. По таблице фонд —
    процент от ПРИБЫЛИ компании (5/7/10/12 % по ступеням). Прибыль = выручка
    минус налоги, инфраструктура, зарплаты команды и выплаты внедренцам; этих
    данных в платформе нет, и показывать их в кабинете внедренца нельзя. Админ
    считает фонд в фин-модели и вносит одним числом (`tech_bonus_funds`).

    ⚠️ Прежняя механика (доля доживших → ступени `tech_quarter_tiers`) отменена
    15.09.2026: таблица считает премию иначе. Таблицу ступеней не удаляем — по
    ней объясняются уже выплаченные премии.

    ⚠️ Вес зависит от ТИПА внедренца (`bonus_role`): «со своей сетью» ценится
    выше, чем «на клиентах ПЛЮСОН». Доля = вес человека / сумма весов всех, кто
    работает. Сумма весов значения не имеет — важны пропорции.

    ⚠️ Раздача идёт ОДИН раз: `distributed_at` + уникальный индекс по
    (spec_id, period). Повторный прогон задачи ничего не начислит заново.
    """
    fund = await db.fetchrow(
        """SELECT period, amount_kopecks FROM tech_bonus_funds
            WHERE distributed_at IS NULL AND amount_kopecks > 0
              AND ($1::text IS NULL OR period = $1)
            ORDER BY period LIMIT 1""",
        quarter,
    )
    if not fund:
        return 0

    period = fund["period"]
    total = int(fund["amount_kopecks"])

    # ── Кто допущен до дележа ───────────────────────────────────────────
    # ⚠️⚠️ Условия требуют СВЕЖЕЙ работы за квартал и РАЗНОЙ по источнику:
    # оборот может складываться из старой работы — клиенты платят, платформа
    # нравится, а новых обращений человек не ведёт. Премия за такое была бы
    # платой за прошлое.
    #
    # ⚠️ Не взял условия — доля уходит остальным, а не пропадает.
    req = await quarter_requirements(db, period)
    # ⚠️ Период может быть задан ДАТАМИ (например, с 15 сентября по 31 декабря).
    # Тогда считаем активации по датам начислений, а не по строкам месяцев:
    # иначе работа, сделанная до старта периода, засчиталась бы в него.
    by_dates = bool(req.get("starts_on") and req.get("ends_on"))
    q_months = None if by_dates else _quarter_months(period)

    all_rows = await db.fetch(
        """SELECT ts.id AS spec_id, ts.bonus_role AS role,
                  COALESCE(w.weight, 0) AS weight
             FROM tech_specialists ts
             LEFT JOIN tech_bonus_weights w ON w.role = ts.bonus_role
            WHERE ts.is_active"""
    )

    rows, skipped = [], []
    for r in all_rows:
        got = (await activations_by_source_dates(
                   db, r["spec_id"], req["starts_on"], req["ends_on"])
               if by_dates
               else await activations_by_source(db, r["spec_id"], q_months))
        if meets_requirements(r["role"], got, req):
            rows.append({**dict(r), **got})
        else:
            skipped.append((r["spec_id"], got))
    if skipped:
        logger.info("tech: премия за %s — не допущены по условиям: %s", period, skipped)
    if not rows:
        logger.warning("tech: премия за %s не роздана — условия не взял никто", period)
        return 0
    weights = sum(float(r["weight"] or 0) for r in rows)
    if weights <= 0:
        logger.warning("tech: премия за %s не роздана — нет весов", period)
        return 0

    done = 0
    for r in rows:
        w = float(r["weight"] or 0)
        if w <= 0:
            continue
        amount = int(round(total * w / weights))
        if amount and await _add(
                db, spec_id=r["spec_id"], client_id=None, kind="quarter_bonus",
                amount=amount, period=period,
                note=(f"доля {w:g} из {weights:g}; активаций: "
                      f"от ПЛЮСОНА {r['from_pluson']}, своих {r['own']}")):
            done += 1

    await db.execute(
        "UPDATE tech_bonus_funds SET distributed_at = NOW() WHERE period = $1",
        period,
    )
    logger.info("tech: премия за %s роздана — %s начислений", period, done)
    return done


# ──────────────────── Тип внедренца по факту работы ──────────────────────
async def refresh_bonus_roles(db: asyncpg.Connection,
                              period: Optional[str] = None) -> int:
    """Пересчитывает тип внедренца по числу ЕГО активаций за месяц.

    ⚠️⚠️ ПОЧЕМУ НЕ ГАЛОЧКОЙ В АДМИНКЕ. Вес в премии зависит от типа, но
    проставлять тип руками неверно в обе стороны: внедренец «на базе» может
    разово кому-то порекомендовать платформу — это случайность, а не работа по
    привлечению, и повышать за неё вес нельзя; наоборот, человек может месяцами
    системно приводить людей, а отметку ему забудут поставить.

    ⚠️ Считаем АКТИВАЦИИ, а не приведённых: привести можно и десять человек,
    которые не дойдут до оплаты. Активация — доведённый до второй оплаты клиент,
    то есть работа доделана.

    ⚠️ Роль ХРАНИТСЯ, а не вычисляется на лету: премию делят по состоянию на
    момент раздачи, пересчёт задним числом менял бы уже начисленное.

    ⚠️ `bonus_role_locked` — человека не трогаем: тип закреплён договорённостью.
    """
    now = datetime.now(timezone.utc)
    period = period or now.strftime("%Y-%m")
    # ⚠️ Порог берём из условий ТЕКУЩЕГО квартала: два разных числа для одного
    # и того же расходились бы при каждой правке.
    q_period = f"{now.year}-Q{(now.month - 1) // 3 + 1}"
    need = int((await quarter_requirements(db, q_period))["network_own"])

    rows = await db.fetch(
        """SELECT ts.id AS spec_id, ts.bonus_role,
                  COUNT(a.id) FILTER (
                      WHERE a.kind = 'activation' AND a.period = $1
                        AND c.referred_by_tech_id = ts.id) AS own_activations
             FROM tech_specialists ts
             LEFT JOIN tech_accruals a ON a.spec_id = ts.id
             LEFT JOIN clients c ON c.id = a.client_id
            WHERE ts.is_active AND NOT ts.bonus_role_locked
            GROUP BY ts.id, ts.bonus_role""",
        period,
    )

    changed = 0
    for r in rows:
        n = int(r["own_activations"] or 0)
        role = "implementer_network" if n >= need else "implementer_base"
        # След пишем всегда — по нему видно, почему тип такой.
        await db.execute(
            """INSERT INTO tech_role_history (spec_id, role, period, activations)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (spec_id, period) DO UPDATE
                 SET role = EXCLUDED.role, activations = EXCLUDED.activations""",
            r["spec_id"], role, period, n,
        )
        if role != r["bonus_role"]:
            await db.execute(
                "UPDATE tech_specialists SET bonus_role = $1 WHERE id = $2",
                role, r["spec_id"])
            changed += 1
            logger.info("tech: спец %s → %s (%s своих активаций за %s)",
                        r["spec_id"], role, n, period)

    logger.info("tech: роли за %s пересчитаны, изменено %s", period, changed)
    return changed


async def assign_client(db: asyncpg.Connection, *, client_id: int,
                        spec_id: Optional[int], reason: str = "") -> None:
    """Закрепить клиента за внедренцем (или снять, `spec_id=None`).

    ⚠️ Передача пишется В ИСТОРИЮ: начисления идут новому, и без записи нельзя
    объяснить, почему за март фикс достался одному, а за апрель другому.
    """
    cur = await db.fetchval(
        "SELECT tech_specialist_id FROM clients WHERE id = $1", client_id)
    if cur == spec_id:
        return

    async with db.transaction():
        # ⚠️⚠️ ТИП У $2 ЗАДАН ЯВНО (`::int`) — без него передача падала с 500.
        # `AmbiguousParameterError: could not determine data type of parameter $2`:
        # один и тот же параметр стоит и в `SET`, и внутри `CASE WHEN $2 IS NULL`,
        # и из второго места тип вывести неоткуда — Postgres отказывается
        # выводить его вовсе, даже когда первое место однозначное. Передача
        # клиента не работала ВООБЩЕ: экран показывал успех (строка исчезала из
        # списка), а в базе не менялось ничего и история оставалась пустой.
        await db.execute(
            """UPDATE clients
                  SET tech_specialist_id = $2::int,
                      tech_assigned_at = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() END
                WHERE id = $1""",
            client_id, spec_id,
        )
        await db.execute(
            """INSERT INTO tech_client_transfers
                 (client_id, from_spec_id, to_spec_id, reason)
               VALUES ($1,$2,$3,$4)""",
            client_id, cur, spec_id, reason or None,
        )

    # ⚠️⚠️ УВЕДОМЛЕНИЕ — ПОСЛЕ ТРАНЗАКЦИИ, а не внутри. Внутри оно ходило бы в
    # Telegram, держа открытой транзакцию на `clients`, и сетевая задержка
    # блокировала бы строку клиента; а упавший запрос откатил бы саму передачу.
    #
    # ⚠️ Это и есть момент «нового клиента» для внедренца: при регистрации его
    # никто не закрепляет — распределяет владелец руками. Слать уведомление в
    # `auth.py` было бы некому.
    if spec_id:
        try:
            await _notify_new_client(db, client_id=client_id, spec_id=spec_id)
        except Exception as e:  # noqa: BLE001 — передача важнее уведомления
            logger.warning("assign_client: уведомление не ушло: %s", e)


async def _notify_new_client(db, *, client_id: int, spec_id: int) -> None:
    """Сообщает внедренцу, что ему дали нового клиента."""
    from app.services.tech_notify import format_person, notify_tech

    row = await db.fetchrow(
        """SELECT c.id, c.email, c.phone, c.brand_name, c.telegram_username,
                  TRIM(CONCAT_WS(' ', c.name, c.last_name)) AS person,
                  (c.referred_by_tech_id = $2) AS is_own,
                  t.name AS tariff, cs.source, cs.expires_at
             FROM clients c
             LEFT JOIN client_subscriptions cs ON cs.id = c.current_subscription_id
             LEFT JOIN tariffs t ON t.id = cs.tariff_id
            WHERE c.id = $1""",
        client_id, spec_id,
    )
    if not row:
        return

    # Триал или платящий — от этого зависит, что с ним делать дальше.
    if row["source"] and row["source"] != "paid":
        state = f"На пробном до {row['expires_at'].strftime('%d.%m.%Y')}" \
            if row["expires_at"] else "На пробном"
    elif row["source"] == "paid":
        state = f"Платит, тариф «{row['tariff'] or '—'}»"
    else:
        state = "Без активной подписки"

    person = format_person(
        name=row["person"] or row["brand_name"], email=row["email"],
        phone=row["phone"], tg_username=row["telegram_username"],
    )
    text = (f"{person}\n"
            f"{'Ваш приведённый' if row['is_own'] else 'Из базы ПЛЮСОНА'}\n\n"
            f"{state}\n"
            f"Клиент закреплён за вами — познакомьтесь и помогите настроиться.")
    await notify_tech(db, spec_id, "trial", text, client_id=client_id)
