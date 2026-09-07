"""
Срок доступа к продукту и история событий по нему (миграция 369).

⚠️⚠️ ДОСТУП НЕ УДАЛЯЕТСЯ. «Забрать» — это `revoked_at`, а не DELETE: клиент
должен видеть, у кого доступ БЫЛ и когда кончился. Удалённая строка отвечает на
этот вопрос молчанием — человек просто исчезает из списка вместе с фактом
покупки, и понять, платил ли он вообще, потом нечем.

⚠️ Статус НЕ хранится в базе, а СЧИТАЕТСЯ из двух дат. Хранимый статус пришлось
бы обновлять по расписанию, и он врал бы ровно в тот час, когда срок истёк, а
задача ещё не отработала. Одна точка расчёта — `access_status` и `STATUS_SQL`.

⚠️ NULL в `expires_at` = БЕССРОЧНО. Это основной случай (так выданы все
существующие доступы), поэтому пустота здесь означает «навсегда», а не
«забыли заполнить».
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ⚠️ То же выражение, что в `access_status`, но на стороне БД — чтобы отбор и
# сортировка в списке шли по тому же правилу, что и подпись в строке. Иначе
# фильтр «истёкшие» покажет не тех, у кого в строке написано «истёк».
STATUS_SQL = """
    CASE WHEN pa.revoked_at IS NOT NULL THEN 'revoked'
         WHEN pa.expires_at IS NOT NULL AND pa.expires_at <= NOW() THEN 'expired'
         ELSE 'active' END
"""


def access_status(expires_at: Optional[datetime],
                  revoked_at: Optional[datetime]) -> str:
    """`active` — открыт, `expired` — срок вышел, `revoked` — закрыли руками."""
    if revoked_at is not None:
        return "revoked"
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        return "expired"
    return "active"


def expires_from_days(days: Optional[int],
                      start: Optional[datetime] = None) -> Optional[datetime]:
    """Дата окончания по сроку тарифа. NULL/0 дней → бессрочно (None)."""
    if not days or days <= 0:
        return None
    return (start or datetime.now(timezone.utc)) + timedelta(days=days)


async def tariff_access_days(db, tariff_id: Optional[int]) -> Optional[int]:
    """Сколько дней даёт тариф. Нет тарифа или не задано → бессрочно."""
    if not tariff_id:
        return None
    return await db.fetchval(
        "SELECT access_days FROM product_tariffs WHERE id = $1", tariff_id)


async def log_access_event(db, access_id: int, kind: str, *,
                           detail: Optional[str] = None,
                           actor: str = "client") -> None:
    """Строка в историю доступа.

    ⚠️ Никогда не роняет вызывающего: история важна, но выдача доступа важнее.
    Провалившаяся запись в лог не должна оставить человека без материалов.
    """
    try:
        await db.execute(
            """INSERT INTO product_access_events (access_id, kind, detail, actor)
               VALUES ($1, $2, $3, $4)""",
            access_id, kind, detail, actor,
        )
    except Exception:
        logger.exception("Событие доступа %s не записано", kind)


async def log_cabinet_visit(db, *, client_id: int, contact_id: int, kind: str,
                            product_id: Optional[int] = None,
                            material_id: Optional[int] = None,
                            title: Optional[str] = None,
                            dedup_minutes: int = 60) -> None:
    """Заход в кабинет или открытый материал.

    ⚠️ `title` пишем СНИМКОМ: материал переименуют или удалят, а в истории
    должно остаться понятное человеку название, а не пустая строка.

    ⚠️ ОДНА ЗАПИСЬ НА ЧАС для одного и того же события (`dedup_minutes`).
    Страница кабинета дёргает бэкенд при каждом возврате на вкладку — без
    склейки один визит давал бы десятки одинаковых строк, и история про
    «заходил ли человек» превращалась бы в нечитаемую ленту.

    ⚠️ Fail-open — статистика не может ломать открытие урока покупателю.
    """
    try:
        recent = await db.fetchval(
            """SELECT 1 FROM product_cabinet_visits
                WHERE client_id = $1 AND contact_id = $2 AND kind = $3
                  AND product_id IS NOT DISTINCT FROM $4
                  AND material_id IS NOT DISTINCT FROM $5
                  AND created_at > NOW() - ($6 || ' minutes')::interval
                LIMIT 1""",
            client_id, contact_id, kind, product_id, material_id,
            str(max(0, dedup_minutes)),
        )
        if recent:
            return
        await db.execute(
            """INSERT INTO product_cabinet_visits
                 (client_id, contact_id, kind, product_id, material_id, title)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            client_id, contact_id, kind, product_id, material_id, title,
        )
    except Exception:
        logger.exception("Заход в кабинет (%s) не записан", kind)


async def is_access_open(db, product_id: int, contact_id: int) -> bool:
    """Открыт ли доступ ПРЯМО СЕЙЧАС — с учётом срока и закрытия.

    ⚠️ Единая проверка для всех точек выдачи материалов. Проверять голое
    «есть строка в product_access» больше нельзя: строка остаётся и после
    окончания срока, и человек с истёкшим доступом продолжал бы читать.
    """
    return bool(await db.fetchval(
        """SELECT 1 FROM product_access pa
            WHERE pa.product_id = $1 AND pa.contact_id = $2
              AND pa.revoked_at IS NULL
              AND (pa.expires_at IS NULL OR pa.expires_at > NOW())
            LIMIT 1""",
        product_id, contact_id,
    ))
