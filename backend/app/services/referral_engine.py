"""
Реферальный движок PLUSSON.

Основные функции:
- generate_ref_code() → уникальный 8-символьный код
- process_conversion() → начисляет баллы, проверяет разблокировку подарков
- check_gift_thresholds() → какие подарки разблокированы
"""
import secrets
import string
from typing import Optional


def generate_ref_code(prefix: str = "") -> str:
    """Генерирует уникальный 8-символьный код из строчных букв и цифр."""
    alphabet = string.ascii_lowercase + string.digits
    code = "".join(secrets.choice(alphabet) for _ in range(8))
    return f"{prefix}{code}" if prefix else code


async def process_conversion(
    ref_code: str,
    conversion_type: str,       # 'free' | 'paid'
    visitor_tg_id: Optional[int],
    db
) -> dict:
    """
    Обрабатывает конверсию после регистрации/оплаты.

    1. Находит участника по ref_code
    2. Определяет количество баллов (points_free или points_paid из events)
    3. Начисляет баллы реферреру
    4. Логирует в referral_events
    5. Проверяет, разблокировался ли новый подарок
    6. Возвращает результат
    """
    # Ищем участника и его событие (ref_code живёт в platform_users)
    participant = await db.fetchrow(
        """
        SELECT ep.id, ep.event_id,
               e.points_free, e.points_paid, e.title as event_title,
               0 as points_total
        FROM platform_users pu
        JOIN event_participants ep ON ep.platform_user_id = pu.id
        JOIN events e ON e.id = ep.event_id
        WHERE pu.ref_code = $1
        ORDER BY ep.registered_at DESC
        LIMIT 1
        """,
        ref_code
    )

    if not participant:
        return {"status": "error", "message": "Реферальный код не найден"}

    # Определяем баллы
    points = participant["points_free"] if conversion_type == "free" else participant["points_paid"]
    if points == 0 and conversion_type == "paid":
        points = participant["points_free"]  # Фолбэк если paid не настроен

    # Начисляем баллы
    new_total = await db.fetchval(
        "UPDATE event_participants SET points_total = points_total + $1 WHERE id = $2 RETURNING points_total",
        points, participant["id"]
    )

    # Логируем конверсию
    await db.execute(
        """
        INSERT INTO referral_events (event_id, ref_code, visitor_tg_id, type, points_awarded)
        VALUES ($1, $2, $3, $4, $5)
        """,
        participant["event_id"], ref_code, visitor_tg_id, conversion_type, points
    )

    # Проверяем разблокировку подарков
    newly_unlocked = await check_gift_thresholds(
        participant["id"], participant["event_id"], participant["points_total"], new_total, db
    )

    return {
        "status": "ok",
        "points_awarded": points,
        "points_total": new_total,
        "new_gift_unlocked": newly_unlocked[0] if newly_unlocked else None
    }


async def check_gift_thresholds(
    participant_id: int,
    event_id: int,
    old_points: int,
    new_points: int,
    db
) -> list:
    """
    Проверяет, какие новые подарки разблокированы после начисления баллов.
    Создаёт записи в gift_issuances для новых подарков.
    """
    # Подарки, порог которых преодолён сейчас (но не был раньше)
    newly_unlocked = await db.fetch(
        """
        SELECT g.id, g.title, g.link_url, g.points_cost
        FROM gifts g
        WHERE g.event_id = $1
          AND g.points_cost <= $2
          AND g.points_cost > $3
          AND NOT EXISTS (
            SELECT 1 FROM gift_issuances gi
            WHERE gi.gift_id = g.id AND gi.participant_id = $4
          )
        ORDER BY g.points_cost
        """,
        event_id, new_points, old_points, participant_id
    )

    # Создаём записи выдачи
    for gift in newly_unlocked:
        await db.execute(
            "INSERT INTO gift_issuances (gift_id, participant_id, status) VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING",
            gift["id"], participant_id
        )

    return [dict(g) for g in newly_unlocked]


async def get_participant_stats(participant_id: int, event_id: int, db) -> dict:
    """Полная статистика участника: баллы, рефералы, подарки."""
    participant = await db.fetchrow(
        "SELECT points_total FROM event_participants WHERE id = $1",
        participant_id
    )
    if not participant:
        return {}

    referrals_count = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE referrer_participant_id = $1",
        participant_id
    )

    # Подарки: разблокированные, в ожидании, заблокированные
    all_gifts = await db.fetch(
        "SELECT g.*, gi.status as issuance_status FROM gifts g LEFT JOIN gift_issuances gi ON gi.gift_id = g.id AND gi.participant_id = $1 WHERE g.event_id = $2 ORDER BY g.points_cost",
        participant_id, event_id
    )

    gifts_data = []
    for g in all_gifts:
        gifts_data.append({
            **dict(g),
            "is_unlocked": g["issuance_status"] is not None,
            "is_pending": g["issuance_status"] == "pending",
        })

    return {
        "points_total": participant["points_total"],
        "referrals_count": referrals_count,
        "gifts": gifts_data
    }
