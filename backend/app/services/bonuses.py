"""Атомарные операции с бонусным балансом клиента.

Источник правды — таблица `client_bonus_transactions`. Колонка
`client_bonus_balance.balance_kopecks` — денормализованный кэш для быстрого
чтения; ВСЕГДА обновляется в той же транзакции что и transaction-row.

Каждая публичная функция здесь выполняется внутри `async with db.transaction()`
и берёт `FOR UPDATE` лок на client_bonus_balance, чтобы конкурентные
начисления/списания не теряли копейки.
"""
import logging
from typing import Optional
import asyncpg

logger = logging.getLogger(__name__)


async def credit_bonus(
    db: asyncpg.Connection,
    *,
    client_id: int,
    amount_kopecks: int,
    source_order_id: Optional[int] = None,
    source_payer_id: Optional[int] = None,
    description: str = "",
) -> int:
    """Начисление бонусов (type='accrual'). amount_kopecks > 0.

    Возвращает новый баланс.
    """
    if amount_kopecks <= 0:
        return await get_balance(db, client_id)
    async with db.transaction():
        await db.execute(
            "INSERT INTO client_bonus_balance (client_id, balance_kopecks) VALUES ($1, 0) ON CONFLICT DO NOTHING",
            client_id,
        )
        await db.execute(
            "SELECT 1 FROM client_bonus_balance WHERE client_id = $1 FOR UPDATE",
            client_id,
        )
        await db.execute(
            """INSERT INTO client_bonus_transactions
                 (client_id, type, amount_kopecks, source_order_id, source_payer_id, description)
               VALUES ($1, 'accrual', $2, $3, $4, $5)""",
            client_id, amount_kopecks, source_order_id, source_payer_id, description,
        )
        new_balance = await db.fetchval(
            """UPDATE client_bonus_balance
                  SET balance_kopecks = balance_kopecks + $2, updated_at = NOW()
                WHERE client_id = $1
                RETURNING balance_kopecks""",
            client_id, amount_kopecks,
        )
        return int(new_balance or 0)


async def debit_bonus_for_payment(
    db: asyncpg.Connection,
    *,
    client_id: int,
    amount_kopecks: int,
    source_order_id: Optional[int],
    description: str = "Оплата подписки бонусами",
) -> int:
    """Списание бонусов на оплату подписки (type='payment').
    amount_kopecks > 0 (передаём положительное число — функция запишет минус).

    Бросает ValueError если бонусов не хватает.
    Возвращает новый баланс.
    """
    if amount_kopecks <= 0:
        return await get_balance(db, client_id)
    async with db.transaction():
        await db.execute(
            "INSERT INTO client_bonus_balance (client_id, balance_kopecks) VALUES ($1, 0) ON CONFLICT DO NOTHING",
            client_id,
        )
        current = await db.fetchval(
            "SELECT balance_kopecks FROM client_bonus_balance WHERE client_id = $1 FOR UPDATE",
            client_id,
        )
        if (current or 0) < amount_kopecks:
            raise ValueError(f"Недостаточно бонусов: есть {current or 0}, нужно {amount_kopecks}")
        await db.execute(
            """INSERT INTO client_bonus_transactions
                 (client_id, type, amount_kopecks, source_order_id, description)
               VALUES ($1, 'payment', $2, $3, $4)""",
            client_id, -amount_kopecks, source_order_id, description,
        )
        new_balance = await db.fetchval(
            """UPDATE client_bonus_balance
                  SET balance_kopecks = balance_kopecks - $2, updated_at = NOW()
                WHERE client_id = $1
                RETURNING balance_kopecks""",
            client_id, amount_kopecks,
        )
        return int(new_balance or 0)


async def hold_for_withdrawal(
    db: asyncpg.Connection,
    *,
    client_id: int,
    amount_kopecks: int,
    withdrawal_id: int,
) -> int:
    """Заморозка под заявку на вывод (type='withdrawal_hold').
    Списывает с баланса сразу — финализация (withdrawal_done) не меняет баланс.
    Возврат при отмене (withdrawal_cancel) восстанавливает баланс.
    """
    if amount_kopecks <= 0:
        return await get_balance(db, client_id)
    async with db.transaction():
        await db.execute(
            "INSERT INTO client_bonus_balance (client_id, balance_kopecks) VALUES ($1, 0) ON CONFLICT DO NOTHING",
            client_id,
        )
        current = await db.fetchval(
            "SELECT balance_kopecks FROM client_bonus_balance WHERE client_id = $1 FOR UPDATE",
            client_id,
        )
        if (current or 0) < amount_kopecks:
            raise ValueError(f"Недостаточно бонусов для вывода: есть {current or 0}, нужно {amount_kopecks}")
        await db.execute(
            """INSERT INTO client_bonus_transactions
                 (client_id, type, amount_kopecks, withdrawal_id, description)
               VALUES ($1, 'withdrawal_hold', $2, $3, 'Заморозка под заявку на вывод')""",
            client_id, -amount_kopecks, withdrawal_id,
        )
        new_balance = await db.fetchval(
            """UPDATE client_bonus_balance
                  SET balance_kopecks = balance_kopecks - $2, updated_at = NOW()
                WHERE client_id = $1
                RETURNING balance_kopecks""",
            client_id, amount_kopecks,
        )
        return int(new_balance or 0)


async def cancel_withdrawal_return(
    db: asyncpg.Connection,
    *,
    client_id: int,
    amount_kopecks: int,
    withdrawal_id: int,
    reason: str = "",
) -> int:
    """Возврат на баланс при отмене заявки (type='withdrawal_cancel')."""
    if amount_kopecks <= 0:
        return await get_balance(db, client_id)
    async with db.transaction():
        await db.execute(
            "SELECT 1 FROM client_bonus_balance WHERE client_id = $1 FOR UPDATE",
            client_id,
        )
        await db.execute(
            """INSERT INTO client_bonus_transactions
                 (client_id, type, amount_kopecks, withdrawal_id, description)
               VALUES ($1, 'withdrawal_cancel', $2, $3, $4)""",
            client_id, amount_kopecks, withdrawal_id, reason or "Возврат отменённой заявки",
        )
        new_balance = await db.fetchval(
            """UPDATE client_bonus_balance
                  SET balance_kopecks = balance_kopecks + $2, updated_at = NOW()
                WHERE client_id = $1
                RETURNING balance_kopecks""",
            client_id, amount_kopecks,
        )
        return int(new_balance or 0)


async def mark_withdrawal_done(
    db: asyncpg.Connection,
    *,
    client_id: int,
    amount_kopecks: int,
    withdrawal_id: int,
) -> None:
    """Информационная запись о завершении вывода. Баланс НЕ трогаем —
    он уже был списан при hold."""
    await db.execute(
        """INSERT INTO client_bonus_transactions
             (client_id, type, amount_kopecks, withdrawal_id, description)
           VALUES ($1, 'withdrawal_done', 0, $2, $3)""",
        client_id, withdrawal_id, f"Выплачено {amount_kopecks / 100:.2f}₽",
    )


async def get_balance(db: asyncpg.Connection, client_id: int) -> int:
    """Текущий баланс в копейках. 0 если записи нет."""
    val = await db.fetchval(
        "SELECT balance_kopecks FROM client_bonus_balance WHERE client_id = $1",
        client_id,
    )
    return int(val or 0)


def calc_cashback_kopecks(amount_paid_card_kopecks: int, percent: int = 10) -> int:
    """10% от карточной части оплаты. Округление вниз до копейки."""
    if amount_paid_card_kopecks <= 0:
        return 0
    return (amount_paid_card_kopecks * percent) // 100
