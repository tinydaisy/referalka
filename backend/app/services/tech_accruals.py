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
        amount = await _amount(db, "referral", client_id)
        await _add(db, spec_id=row["l1"], client_id=client_id, kind="referral",
                   amount=amount, order_id=order_id, period=period,
                   note="10% свой приведённый")

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

    # Кто участвует: работающие внедренцы с весом своей роли.
    rows = await db.fetch(
        """SELECT ts.id AS spec_id, COALESCE(w.weight, 0) AS weight
             FROM tech_specialists ts
             LEFT JOIN tech_bonus_weights w ON w.role = ts.bonus_role
            WHERE ts.is_active"""
    )
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
                note=f"доля {w:g} из {weights:g}"):
            done += 1

    await db.execute(
        "UPDATE tech_bonus_funds SET distributed_at = NOW() WHERE period = $1",
        period,
    )
    logger.info("tech: премия за %s роздана — %s начислений", period, done)
    return done


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
        await db.execute(
            """UPDATE clients
                  SET tech_specialist_id = $2,
                      tech_assigned_at = CASE WHEN $2 IS NULL THEN NULL ELSE NOW() END
                WHERE id = $1""",
            client_id, spec_id,
        )
        await db.execute(
            """INSERT INTO tech_client_transfers
                 (client_id, from_spec_id, to_spec_id, reason)
               VALUES ($1,$2,$3,$4)""",
            client_id, cur, spec_id, reason or None,
        )
