"""
Сколько дней даём по бонусу ПЛЮСОНа — ОДНА точка расчёта.

⚠️ Цифры берутся из настроек, а не из кода: база триала — в тарифе `trial`
(`default_duration_days`), бонус за реферала — в админке
(`referral_program_settings.trial_bonus_days`). Владелец меняет их в
интерфейсе, и письма с лендингом обязаны говорить новое число сами.

⚠️ Правило одно на все случаи (решение владельца):
  • НОВЫЙ (кабинета в ПЛЮСОНе нет) → полный триал = база + бонус (сейчас 30);
  • ДЕЙСТВУЮЩИЙ (кабинет уже есть) → продление на EXTRA_DAYS (3 дня),
    независимо от того, какой у него тариф — Профи, Экстра или триал.
    Полный триал ему не положен: он рассчитан на тех, кто ещё не пробовал.
"""
from typing import Tuple

# Продление для тех, у кого кабинет уже есть. Держим здесь, а не в базе:
# значение одно на всю платформу и меняется примерно никогда. Понадобится
# менять из админки — переносим в referral_program_settings.
EXTRA_DAYS_FOR_EXISTING = 3


async def bonus_day_numbers(db) -> Tuple[int, int]:
    """(дней новому, дней действующему).

    Сбой чтения настроек не должен ронять лендинг — отдаём разумные
    значения по умолчанию.
    """
    try:
        base = await db.fetchval(
            "SELECT COALESCE(default_duration_days, 7) FROM tariffs WHERE slug = 'trial'")
        bonus = await db.fetchval(
            "SELECT trial_bonus_days FROM referral_program_settings ORDER BY id LIMIT 1")
        total = int(base or 7) + int(bonus or 0)
    except Exception:
        total = 30
    return total, EXTRA_DAYS_FOR_EXISTING
