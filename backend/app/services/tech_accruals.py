"""Начисления тех-специалистам: активации, оживления, фикс, процент.

⚠️⚠️ ПОЧЕМУ СЧИТАЕТСЯ ПО СОБЫТИЮ, А НЕ ЗАПРОСОМ НА ЛЕТУ. Соблазн велик: взять и
посчитать «сколько активаций у него в марте» одним SELECT. Но клиента могли
передать другому специалисту, тариф сменить, оплату вернуть — и цифра за
прошлый месяц изменилась бы задним числом, уже после выплаты. Начисление это
факт: случилось — записали строкой, дальше она не меняется.

⚠️ Ставки читаются из `tech_rates`, а не из констант: сегодня фикс 300 ₽, завтра
500, и правка не должна требовать выкатки.

⚠️ Двойное начисление не даёт БАЗА (уникальные индексы миграции 391), а не
проверка в коде. Задача идёт по расписанию и может быть перезапущена, а деньги
дважды за одно и то же — это спор с человеком, которому платят.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

# Сколько месяцев тишины делают клиента «остывшим». ⚠️ Не в коде решается, что
# считать оживлением — только этот порог; сама ставка живёт в `tech_rates`.
REVIVAL_SILENCE_DAYS = 60


async def _rate(db, kind: str) -> tuple[int, float]:
    """Ставка вида начисления: (копейки, процент). Нет строки → нули."""
    row = await db.fetchrow(
        "SELECT amount_kopecks, percent FROM tech_rates WHERE kind = $1 AND is_active",
        kind,
    )
    if not row:
        return 0, 0.0
    return int(row["amount_kopecks"] or 0), float(row["percent"] or 0)


async def _add(db, *, spec_id: int, client_id: Optional[int], kind: str,
               amount: int, order_id: Optional[int] = None,
               period: Optional[str] = None, note: Optional[str] = None) -> bool:
    """Записывает начисление. `False` — если такое уже есть (индекс не пустил).

    ⚠️ ON CONFLICT DO NOTHING, а не проверка «есть ли уже»: между проверкой и
    вставкой параллельный запуск задачи успел бы вставить свою строку.
    """
    if amount <= 0:
        return False
    row = await db.fetchrow(
        """INSERT INTO tech_accruals
             (spec_id, client_id, kind, amount_kopecks, source_order_id, period, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING
           RETURNING id""",
        spec_id, client_id, kind, amount, order_id, period, note,
    )
    return row is not None


async def on_payment(db: asyncpg.Connection, order_id: int) -> None:
    """Оплата подтверждена — начисляем тому, кто ведёт клиента.

    Зовётся из той же точки, что кэшбэк рефовода. Исключений не бросает: деньги
    уже приняты, и сбой начисления не должен ломать выдачу подписки.
    """
    try:
        await _on_payment(db, order_id)
    except Exception as e:                                      # noqa: BLE001
        logger.exception("tech accrual failed (order %s): %s", order_id, e)


async def _on_payment(db: asyncpg.Connection, order_id: int) -> None:
    o = await db.fetchrow(
        """SELECT so.id, so.client_id, so.amount_paid_card_kopecks AS paid,
                  so.paid_at, c.tech_specialist_id AS spec_id,
                  c.name AS client_name
             FROM subscription_orders so JOIN clients c ON c.id = so.client_id
            WHERE so.id = $1 AND so.status = 'paid'""",
        order_id,
    )
    if not o or not o["spec_id"]:
        # Клиент ни за кем не закреплён — начислять некому. Это норма, а не сбой.
        return

    spec_id = o["spec_id"]
    client_id = o["client_id"]
    paid = int(o["paid"] or 0)
    period = (o["paid_at"] or datetime.now(timezone.utc)).strftime("%Y-%m")

    # Сколько платных оплат у клиента всего (включая эту).
    payments = await db.fetch(
        """SELECT id, paid_at FROM subscription_orders
            WHERE client_id = $1 AND status = 'paid' AND amount_paid_card_kopecks > 0
            ORDER BY paid_at""",
        client_id,
    )
    n = len(payments)

    # ── Активация: довёл до ВТОРОЙ оплаты ────────────────────────────────
    # ⚠️ Именно вторая, а не первая: первую человек часто делает сам, придя с
    # лендинга. Вторая — это уже удержание, то есть работа специалиста.
    if n == 2 and payments[-1]["id"] == order_id:
        amount, _ = await _rate(db, "activation")
        if await _add(db, spec_id=spec_id, client_id=client_id, kind="activation",
                      amount=amount, order_id=order_id, period=period,
                      note="вторая оплата"):
            logger.info("tech: активация клиента %s спецу %s", client_id, spec_id)

    # ── Оживление: оплата после долгой тишины ────────────────────────────
    # ⚠️ Считаем по РАЗРЫВУ между оплатами, а не по статусу подписки: статус
    # меняет задача раз в час и он отстаёт, а даты оплат — факт.
    elif n >= 2:
        prev = payments[-2]["paid_at"]
        cur = payments[-1]["paid_at"]
        if prev and cur and (cur - prev).days >= REVIVAL_SILENCE_DAYS:
            amount, _ = await _rate(db, "revival")
            if await _add(db, spec_id=spec_id, client_id=client_id, kind="revival",
                          amount=amount, order_id=order_id, period=period,
                          note=f"перерыв {(cur - prev).days} дн."):
                logger.info("tech: оживление клиента %s спецу %s", client_id, spec_id)

    # ── Процент за приведённого ──────────────────────────────────────────
    # ⚠️⚠️ «ПРИВЁЛ ЛИЧНО» — это `referred_by_tech_id` (миграция 393), а НЕ
    # `referred_by_client_id`. Прежняя проверка спрашивала «тех-спец того, кто
    # привёл = я» — то есть «привёл кто-то, кого я обслуживаю». Процент уходил
    # бы не тому: закрепить могли и чужого клиента, а привёл его другой человек.
    _, percent = await _rate(db, "referral")
    if percent > 0 and paid > 0:
        by_tech = await db.fetchval(
            "SELECT referred_by_tech_id FROM clients WHERE id = $1", client_id)
        if by_tech == spec_id:
            await _add(db, spec_id=spec_id, client_id=client_id, kind="referral",
                       amount=int(paid * percent / 100), order_id=order_id,
                       period=period, note=f"{percent:g}% с оплаты")


async def accrue_monthly_fix(db: asyncpg.Connection, period: Optional[str] = None) -> int:
    """Фикс за обслуживание — раз в месяц, за каждого ПЛАТЯЩЕГО клиента.

    ⚠️ Только за платящих: фикс это плата за работу с живым клиентом, а не за
    строку в списке. Триальные и остывшие в него не идут.

    ⚠️ Период передаётся параметром, а не берётся всегда «сейчас»: иначе
    невозможно досчитать пропущенный месяц, если задача не отработала.
    """
    period = period or datetime.now(timezone.utc).strftime("%Y-%m")
    amount, _ = await _rate(db, "fix")
    if amount <= 0:
        return 0

    rows = await db.fetch(
        """SELECT c.id AS client_id, c.tech_specialist_id AS spec_id
             FROM clients c
             JOIN tech_specialists ts ON ts.id = c.tech_specialist_id
            WHERE c.tech_specialist_id IS NOT NULL
              AND ts.is_active
              AND EXISTS (SELECT 1 FROM client_subscriptions cs
                           WHERE cs.id = c.current_subscription_id
                             AND cs.status = 'active' AND cs.expires_at > NOW()
                             AND cs.source = 'paid')"""
    )
    done = 0
    for r in rows:
        if await _add(db, spec_id=r["spec_id"], client_id=r["client_id"],
                      kind="fix", amount=amount, period=period,
                      note=f"обслуживание, {period}"):
            done += 1
    logger.info("tech: фикс за %s — %s начислений", period, done)
    return done


async def assign_client(db: asyncpg.Connection, *, client_id: int,
                        spec_id: Optional[int], reason: str = "") -> None:
    """Закрепить клиента за специалистом (или снять, `spec_id=None`).

    ⚠️ Передача пишется В ИСТОРИЮ: начисления идут новому (решение владельца), и
    без записи нельзя объяснить, почему за март фикс достался одному, а за
    апрель другому.
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
