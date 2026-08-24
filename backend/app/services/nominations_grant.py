"""Выдача номинаций по оплаченному тарифу (миграция 328).

Человек покупает участие в премии: тариф «Одна номинация», «Три номинации».
После оплаты ему открывается ровно столько мест, сколько он купил, — а
отмечает он их сам в кабинете.

⚠️ ОПЛАТИВШИЙ И НОМИНАНТ — РАЗНЫЕ ЗАПИСИ. Оплата живёт у участника
(`event_participant_tariffs`), а номинант — это карточка коллаборатора
(`event_collaborators`). Оплата карточку НЕ создаёт: её заводит организатор
либо сам человек по ссылке регистрации (`spkreg_`). Поэтому порядок бывает
любой, и обе стороны обязаны уметь дочитать друг друга:

  оплатил → карточка уже есть  → пишем лимит сразу (`apply_paid_nominations`)
  оплатил → карточки ещё нет   → ничего не теряем: при её создании
                                  вызывается `pull_paid_nominations`

Без второй половины оплата молча пропадала бы — а это самый частый порядок:
человек платит с лендинга и только потом заводит карточку.

⚠️ Новая покупка ПЕРЕЗАТИРАЕТ прежнее число, а не складывается с ним
(решение владельца): повысил тариф — действует новый.
"""

import logging
from typing import Optional

import asyncpg

logger = logging.getLogger(__name__)

__all__ = ["apply_paid_nominations", "pull_paid_nominations"]


async def apply_paid_nominations(db: asyncpg.Connection, order_id: int) -> Optional[int]:
    """Оплачен заказ → записать лимит в карточку номинанта, если она есть.

    Возвращает записанное число или None (тариф без номинаций / нет карточки).
    """
    row = await db.fetchrow(
        """SELECT o.event_id, o.contact_id, t.nominations_grant
             FROM event_participant_tariffs o
             JOIN event_tariffs t ON t.id = o.tariff_id
            WHERE o.id = $1""",
        order_id,
    )
    if not row or not row["nominations_grant"] or not row["contact_id"]:
        return None

    grant = int(row["nominations_grant"])
    if grant <= 0:
        return None

    ec_id = await db.fetchval(
        """SELECT ec.id FROM event_collaborators ec
             JOIN collaborators c ON c.id = ec.speaker_id
            WHERE ec.event_id = $1 AND c.contact_id = $2
            ORDER BY ec.id LIMIT 1""",
        row["event_id"], row["contact_id"],
    )
    if not ec_id:
        # Карточки ещё нет — это нормально: человек чаще платит раньше, чем
        # регистрируется номинантом. Число дочитается из оплаты при создании
        # карточки (`pull_paid_nominations`), терять его не надо.
        return None

    await db.execute(
        "UPDATE event_collaborators SET nominations_limit = $2 WHERE id = $1",
        ec_id, grant,
    )
    logger.info("Заказ %s: номинанту ec=%s открыто номинаций: %s", order_id, ec_id, grant)
    return grant


async def pull_paid_nominations(db: asyncpg.Connection, ec_id: int, event_id: int) -> Optional[int]:
    """Карточка создана → дочитать номинации из уже оплаченных тарифов.

    Берём ПОСЛЕДНЮЮ оплату (новая перезатирает прежнюю). Ошибок не бросает:
    сорвавшаяся выдача не должна ломать регистрацию номинанта.
    """
    try:
        grant = await db.fetchval(
            """SELECT t.nominations_grant
                 FROM event_participant_tariffs o
                 JOIN event_tariffs t ON t.id = o.tariff_id
                 JOIN collaborators c ON c.id = (
                        SELECT speaker_id FROM event_collaborators WHERE id = $1)
                WHERE o.event_id = $2 AND o.status = 'paid'
                  AND o.contact_id = c.contact_id
                  AND COALESCE(t.nominations_grant, 0) > 0
                ORDER BY o.paid_at DESC NULLS LAST, o.id DESC
                LIMIT 1""",
            ec_id, event_id,
        )
        if not grant:
            return None
        await db.execute(
            "UPDATE event_collaborators SET nominations_limit = $2 WHERE id = $1",
            ec_id, int(grant),
        )
        logger.info("Карточка ec=%s: номинаций из оплаты — %s", ec_id, grant)
        return int(grant)
    except Exception as e:  # noqa: BLE001 — регистрацию номинанта не роняем
        logger.warning("Не удалось дочитать номинации для ec=%s: %s", ec_id, e)
        return None
