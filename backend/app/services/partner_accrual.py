"""Начисление вознаграждения партнёру.

⚠️⚠️ НАЧИСЛЕНИЕ РОЖДАЕТСЯ ТОЛЬКО В МОМЕНТ ПОДТВЕРЖДЕНИЯ ОПЛАТЫ (№ 27).
Это не отчёт по таблице заказов: пришёл вебхук → смотрим получателя → пишем
строку. Тот же приём, что у кэшбэка ПЛЮСОНа (`_credit_referral_cashback`).

⚠️⚠️ МАССОВОГО ПЕРЕСЧЁТА БЫТЬ НЕ ДОЛЖНО — ни кнопкой, ни скриптом. Начисление
меняет только статус выплаты. «Кнопка пересчитать» способна переписать уже
выплаченное и увести деньги другому человеку.

Два места ответственности, и их важно не перепутать:

    resolve_reward_recipient() — КОГО пишем в поле рефовода заказа.
        Здесь живёт РАЗВИЛКА ПО РЕЖИМУ (№ 33). Вызывается в момент СОЗДАНИЯ
        заказа.

    accrue_for_order()         — СКОЛЬКО и КОМУ начисляем.
        Читает УЖЕ ЗАПИСАННОЕ поле и не рассуждает о режиме (№ 36).
        Вызывается в момент ОПЛАТЫ.

Такое разделение — сознательное. Благодаря ему в истории не нужно хранить,
какой режим стоял на момент покупки: получатель уже записан, и выплаты в
дашборде читаются по одному полю.
"""

from __future__ import annotations

import logging
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional

logger = logging.getLogger(__name__)

# Ниже этой суммы начисление не создаём: копейка вознаграждения — мусор в
# отчёте и лишняя строка в выплате, за которую неудобно платить.
_MIN_ACCRUAL = Decimal("1")


# ─── Кому платим: развилка по режиму ──────────────────────────────────────────

async def resolve_reward_recipient(
    db, *, client_id: int, buyer_contact_id: Optional[int],
    referrer_ref_code: Optional[str] = None,
) -> Optional[str]:
    """Возвращает реф-код ТОГО, КОМУ ПЛАТИМ. И это всегда партнёр (№ 33).

    ⚠️⚠️ Здесь и ТОЛЬКО здесь живёт развилка по режиму выплат:

        пассивный  → закреплённый партнёр покупателя
        активный   → приведший на эту покупку, если он партнёр
        иначе      → None (в поле пишем пусто, платить некому)

    ⚠️ Чей режим применяется — ЗАКРЕПЛЁННОГО партнёра (№ 43). Пассивный доход
    его привилегия; если сам сидит на активном договоре, значит на чужие
    продажи не претендует — платим приведшему. Закрепления нет вовсе — берём
    режим приведшего.

    ⚠️ Возвращаем именно РЕФ-КОД, а не id партнёра: поля на заказах текстовые
    (`referrer_ref_code`), и по ним же считает дашборд.
    """
    from app.services.partner_binding import find_partner_by_ref_code, get_binding

    if not buyer_contact_id:
        return None

    try:
        client_mode = await db.fetchval(
            "SELECT COALESCE(partner_payout_mode, 'passive') FROM clients WHERE id = $1",
            client_id,
        ) or "passive"

        binding = await get_binding(db, buyer_contact_id)
        inviter = await find_partner_by_ref_code(
            db, client_id=client_id, ref_code=referrer_ref_code)

        # Режим берём у закреплённого; нет закрепления — у приведшего.
        if binding:
            mode = binding["payout_mode"] or client_mode
        elif inviter:
            mode = inviter["payout_mode"] or client_mode
        else:
            return None

        if mode == "passive":
            if binding:
                # ⚠️ Закрепление ЕСТЬ — платим только ему и никому больше.
                # Партнёр отключён → не платим ВООБЩЕ, а не «тогда приведшему»:
                # закрепление не перебивается (№ 13), и клиент отключает
                # партнёра, чтобы перестать платить, а не чтобы деньги ушли
                # другому человеку.
                if not binding["is_active"]:
                    return None
                return await _ref_code_of_partner(db, binding["id"])
            # Закрепления нет, но привёл партнёр — он и становится
            # закреплённым (это делает partner_binding), ему и платим.
            return inviter["ref_code"] if inviter else None

        # Активный режим: платим тому, кто привёл на ЭТУ покупку.
        # ⚠️ Приведший не партнёр или его нет — поле пустое. За самостоятельную
        # повторную покупку в активном режиме не платит никто: человека на неё
        # никто не приводил. Это не поломка, а смысл режима.
        return inviter["ref_code"] if inviter else None

    except Exception as e:  # noqa: BLE001
        # Fail-open: сбой партнёрки не должен срывать создание заказа.
        logger.warning("Партнёрка: получатель по заказу не определён: %s", e)
        return None


async def _source_participates(db, source_kind: str, source_order_id: int) -> bool:
    """Участвует ли событие/продукт этого заказа в партнёрской программе.

    ⚠️ Спрашиваем у САМОГО ЗАКАЗА, а не у переданного тарифа: тариф мог быть
    удалён, а заказ остаться — и тогда молчаливое «участвует» открыло бы
    выплаты по сделке, которую клиент в программу не отдавал.
    """
    if source_kind == "event":
        return bool(await db.fetchval(
            """SELECT e.partner_enabled
                 FROM event_participant_tariffs o
                 JOIN events e ON e.id = o.event_id
                WHERE o.id = $1""",
            source_order_id,
        ))
    if source_kind == "product":
        return bool(await db.fetchval(
            """SELECT p.partner_enabled
                 FROM product_orders o
                 JOIN products p ON p.id = o.product_id
                WHERE o.id = $1""",
            source_order_id,
        ))
    return False


async def _ref_code_of_partner(db, partner_id: int) -> Optional[str]:
    return await db.fetchval(
        """SELECT c.ref_code FROM client_partners p
             JOIN contacts c ON c.id = p.contact_id
            WHERE p.id = $1""",
        partner_id,
    )


# ─── Сколько платим ───────────────────────────────────────────────────────────

def _calc_reward(kind: Optional[str], value, base: Decimal) -> Decimal:
    """Вознаграждение первого уровня: процент от суммы либо фикс в рублях."""
    if not kind or value is None:
        return Decimal("0")
    val = Decimal(str(value))
    if kind == "percent":
        return (base * val / Decimal("100")).quantize(Decimal("0.01"), ROUND_HALF_UP)
    if kind == "fixed":
        # ⚠️ Фикс не может превышать сумму заказа: иначе клиент платит партнёру
        # больше, чем получил от покупателя.
        return min(val, base).quantize(Decimal("0.01"), ROUND_HALF_UP)
    return Decimal("0")


async def _reward_settings(db, *, client_id: int, tariff_kind: str,
                           tariff_id: Optional[int]) -> tuple[Optional[str], object]:
    """Вознаграждение для тарифа: своё, иначе умолчание кабинета (№ 29).

    Мест ровно два — тариф и настройки кабинета. Промежуточного уровня
    «процент на событии» нет: там только галочка участия.
    """
    if tariff_id:
        table = "event_tariffs" if tariff_kind == "event" else "product_tariffs"
        row = await db.fetchrow(
            f"SELECT partner_reward_kind AS k, partner_reward_value AS v "
            f"FROM {table} WHERE id = $1",
            tariff_id,
        )
        if row and row["k"]:
            return row["k"], row["v"]

    row = await db.fetchrow(
        "SELECT partner_default_reward_kind AS k, partner_default_reward_value AS v "
        "FROM clients WHERE id = $1",
        client_id,
    )
    return (row["k"], row["v"]) if row else (None, None)


# ─── Начисление ───────────────────────────────────────────────────────────────

async def accrue_for_order(
    db, *, client_id: int, source_kind: str, source_order_id: int,
    buyer_contact_id: Optional[int], amount, tariff_id: Optional[int],
    recipient_ref_code: Optional[str],
) -> int:
    """Создаёт начисления по оплаченному заказу. Возвращает их число.

    ⚠️ Читает УЖЕ ЗАПИСАННОЕ поле получателя и не рассуждает о режиме (№ 36):
    кто там записан, тому и деньги.

    ⚠️ Идемпотентно: `UNIQUE (source_kind, source_order_id, level)` не даст
    начислить дважды по одному заказу. Платёжные системы шлют оповещение по
    нескольку раз — это норма, а не сбой.

    ⚠️ Своих исключений не бросает: оплата уже принята, и сорвавшееся
    начисление не должно превращаться в ошибку вебхука — иначе платёжка сочтёт
    оповещение недоставленным и начнёт слать повторы.
    """
    try:
        return await _accrue(
            db, client_id=client_id, source_kind=source_kind,
            source_order_id=source_order_id, buyer_contact_id=buyer_contact_id,
            amount=amount, tariff_id=tariff_id,
            recipient_ref_code=recipient_ref_code,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Партнёрка: начисление по заказу %s/%s не создано: %s",
                       source_kind, source_order_id, e)
        return 0


async def _accrue(db, *, client_id: int, source_kind: str, source_order_id: int,
                  buyer_contact_id: Optional[int], amount, tariff_id: Optional[int],
                  recipient_ref_code: Optional[str]) -> int:
    from app.services.features import client_has_feature
    from app.services.partner_binding import find_partner_by_ref_code

    if not recipient_ref_code:
        return 0
    if not await client_has_feature(db, client_id, "partner_program"):
        return 0

    base = Decimal(str(amount or 0))
    if base <= 0:
        # Бесплатные тарифы вознаграждения не дают — платить не с чего,
        # там работают подарки.
        return 0

    # ⚠️⚠️ ГАЛОЧКА «УЧАСТВУЕТ В ПАРТНЁРКЕ» ПРОВЕРЯЕТСЯ ЗДЕСЬ (решение № 29).
    # Без этой проверки она не значила бы ничего: клиент включил партнёрку на
    # одном вебинаре, а платил бы со ВСЕХ своих событий и продуктов — деньги
    # уходили бы по сделкам, которые он в программу не отдавал.
    if not await _source_participates(db, source_kind, source_order_id):
        return 0

    partner = await find_partner_by_ref_code(
        db, client_id=client_id, ref_code=recipient_ref_code)
    if not partner:
        return 0

    kind, value = await _reward_settings(
        db, client_id=client_id, tariff_kind=source_kind, tariff_id=tariff_id)
    first = _calc_reward(kind, value, base)
    if first < _MIN_ACCRUAL:
        return 0

    settings = await db.fetchrow(
        """SELECT COALESCE(partner_levels, 1) AS levels,
                  partner_level_decay AS decay,
                  COALESCE(partner_payout_mode, 'passive') AS mode
             FROM clients WHERE id = $1""",
        client_id,
    )
    levels = int(settings["levels"] or 1)
    decay = Decimal(str(settings["decay"])) if settings["decay"] else None

    # ⚠️⚠️ УРОВНИ РАБОТАЮТ ТОЛЬКО В ПАССИВНОМ РЕЖИМЕ (№ 44). В активном на
    # заказе лежит ОДИН реф-код — вверх по нему идти не из чего.
    partner_mode = partner["payout_mode"] or settings["mode"]
    if partner_mode != "passive" or not decay or decay <= 1:
        levels = 1

    created = 0
    current_partner_id = partner["id"]
    reward = first

    for level in range(1, levels + 1):
        if reward < _MIN_ACCRUAL or not current_partner_id:
            break

        inserted = await db.fetchval(
            """INSERT INTO partner_accruals
                   (client_id, partner_id, level, source_kind, source_order_id,
                    buyer_contact_id, base_amount, amount)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (source_kind, source_order_id, level) DO NOTHING
               RETURNING id""",
            client_id, current_partner_id, level, source_kind, source_order_id,
            buyer_contact_id, base, reward,
        )
        if inserted:
            created += 1

        # ⚠️ Выходим ДО расчёта следующего уровня: при levels=1 коэффициент
        # затухания может быть не задан вовсе (None), и `reward / decay` упал
        # бы делением на None — начисление первого уровня уже создано, но
        # функция вернула бы ошибку.
        if level >= levels or not decay:
            break

        # Следующий уровень — вверх по contacts.partner_id того же партнёра.
        # ⚠️ Всё дерево держится на ОДНОМ поле: партнёр — тоже контакт (№ 44).
        # Отдельной таблицы связей между партнёрами не нужно.
        current_partner_id = await db.fetchval(
            """SELECT c.partner_id FROM client_partners p
                 JOIN contacts c ON c.id = p.contact_id
                WHERE p.id = $1""",
            current_partner_id,
        )
        reward = (reward / decay).quantize(Decimal("0.01"), ROUND_HALF_UP)

    if created:
        logger.info("Партнёрка: по заказу %s/%s создано начислений: %s",
                    source_kind, source_order_id, created)
    return created
