"""Лимит контактов по тарифу: предупреждение и автопереход на старший тариф.

⚠️ ГЛАВНОЕ ПРАВИЛО: контакт создаётся ВСЕГДА, даже сверх лимита.
Контакты появляются не по воле клиента — человек сам нажимает «Старт» в боте,
регистрируется на событие, забирает лид-магнит. Заблокируй создание — и
пострадает не клиент, а его аудитория: человек пришёл и молча потерялся, бот
ему не ответил, подарок не выдался. Клиент узнает об этом последним, а
претензия прилетит платформе.

Поэтому вместо блокировки — автоматический переход на тариф, соответствующий
фактическому объёму использования (п. 3.9 Оферты):

    новый срок = осталось дней × цена старого тарифа ÷ цена нового тарифа

Доплаты нет — оплаченное просто расходуется быстрее. Так устроен биллинг
хостингов: положил денег, перешёл на тариф дороже, они кончились раньше.

⚠️ Предупреждаем ЗАРАНЕЕ (WARN_RATIO), а не по факту превышения: у клиента
должна быть возможность либо почистить базу, либо осознанно принять переход,
а не узнать о смене тарифа задним числом.
"""
import logging
from typing import Optional

log = logging.getLogger(__name__)

# Доля лимита, при которой начинаем предупреждать. 0.83 ≈ «осталось 500 из 3000».
WARN_RATIO = 0.83


async def count_contacts(db, client_id: int) -> int:
    """Число живых контактов клиента. Слитые (merged_into) не считаем — это дубли."""
    return int(await db.fetchval(
        "SELECT COUNT(*) FROM contacts WHERE client_id = $1 AND merged_into IS NULL",
        client_id,
    ) or 0)


async def _next_tariff(db, *, current_price, needed: int) -> Optional[dict]:
    """
    Самый дешёвый ПРОДАВАЕМЫЙ тариф, вмещающий `needed` контактов и не дешевле
    текущего. Безлимит (contact_limit IS NULL) подходит под любое число.

    ⚠️ Только is_active — служебные тарифы (admin, снятый с продажи start)
    клиенту выдавать нельзя.
    """
    return await db.fetchrow(
        """SELECT id, slug, name, price, contact_limit
             FROM tariffs
            WHERE is_active
              AND slug <> 'admin'
              AND price >= $1
              AND (contact_limit IS NULL OR contact_limit >= $2)
            ORDER BY price, id
            LIMIT 1""",
        current_price, needed,
    )


def recalc_days(days_left: int, old_price, new_price) -> int:
    """
    Пересчёт оставшегося срока при переходе на другой тариф (п. 3.9.1 Оферты).

    ⚠️ Округление ВВЕРХ — в пользу клиента, как написано в Оферте.
    ⚠️ Минимум 1 день: обнулить оплаченный срок сменой тарифа нельзя.
    """
    import math
    old_p, new_p = float(old_price or 0), float(new_price or 0)
    if new_p <= 0 or old_p <= 0:
        return max(1, days_left)
    return max(1, math.ceil(days_left * old_p / new_p))


async def check_contact_limit(db, client_id: int) -> Optional[dict]:
    """
    Проверяет лимит и при необходимости переводит клиента на старший тариф.

    Возвращает описание события или None, если ничего делать не нужно:
      {'kind': 'warn',    'used', 'limit'}                  — подходит к лимиту
      {'kind': 'upgrade', 'used', 'from', 'to', 'expires'}  — тариф изменён
      {'kind': 'exceeded','used', 'limit'}                  — превышен, но
          перейти некуда (клиент уже на самом ёмком тарифе)

    ⚠️ Никогда не бросает исключение: вызывается из путей создания контакта
    (боты, воронки, формы), и сбой проверки не должен ронять регистрацию
    человека. Все ошибки — в лог.
    """
    try:
        from app.services.subscriptions import get_subscription

        sub = await get_subscription(db, client_id)
        if not sub or sub.get("status") != "active":
            return None                      # истёкшую подписку двигать некуда
        limit = sub.get("contact_limit")
        if not limit:
            return None                      # безлимит — проверять нечего

        used = await count_contacts(db, client_id)

        if used <= limit:
            if used >= int(limit * WARN_RATIO):
                return {"kind": "warn", "used": used, "limit": int(limit)}
            return None

        # Лимит превышен — ищем, куда перевести
        target = await _next_tariff(db, current_price=sub["tariff_price"], needed=used)
        if not target or target["id"] == sub["tariff_id"]:
            return {"kind": "exceeded", "used": used, "limit": int(limit)}

        # Пересчёт срока и перевод — одной транзакцией
        async with db.transaction():
            days_left = int(await db.fetchval(
                "SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM ($1::timestamptz - NOW())) / 86400))",
                sub["expires_at"],
            ) or 0)
            new_days = recalc_days(days_left, sub["tariff_price"], target["price"])
            new_expires = await db.fetchval(
                """UPDATE client_subscriptions
                      SET tariff_id = $2,
                          expires_at = NOW() + ($3 || ' days')::interval,
                          updated_at = NOW(),
                          notified_7d = FALSE, notified_3d = FALSE, notified_1d = FALSE,
                          notified_email_7d = FALSE, notified_email_3d = FALSE,
                          notified_email_1d = FALSE
                    WHERE id = $1
                RETURNING expires_at""",
                sub["id"], target["id"], str(new_days),
            )

        log.info(
            "client %s: тариф %s → %s (контактов %s, лимит %s), срок %s дн.",
            client_id, sub["tariff_slug"], target["slug"], used, limit, new_days,
        )
        return {
            "kind": "upgrade", "used": used,
            "from": sub["tariff_name"], "to": target["name"],
            "expires": new_expires, "days": new_days,
        }
    except Exception as e:  # noqa: BLE001
        log.warning("contact limit check failed for client %s: %s", client_id, e)
        return None
