"""Ставка реф-программы ПЛЮСОНа: настройки + заморозка на клиенте.

Ставка НЕ читается глобально в момент начисления — она замораживается на
приведённом клиенте при его регистрации (`clients.referral_rate_percent` +
`referral_accrual_until`). Поэтому смена процента в админке действует только
на тех, кто зарегистрируется после неё: обещание «10% до 31.07.2027» для уже
приведённых остаётся в силе.

Миграция 227.
"""
from datetime import date

DEFAULT_PERCENT = 10
DEFAULT_SIGNUP_UNTIL = date(2026, 7, 31)
DEFAULT_ACCRUAL_UNTIL = date(2027, 7, 31)

# Сколько дней триала добавляет валидная реф-ссылка поверх базы тарифа `trial`
# (миграция 306). База = 7 дней, бонус = 23 → по ссылке ровно месяц. Смысл в
# том, чтобы реф-ссылке было что предложить: без рекомендации — короткая проба.
DEFAULT_TRIAL_BONUS_DAYS = 23


async def get_settings(db) -> dict:
    """Текущие настройки программы. Нет строки → дефолты (10% / 2026 / 2027)."""
    row = await db.fetchrow(
        "SELECT percent, signup_until, accrual_until, trial_bonus_days, updated_at "
        "FROM referral_program_settings WHERE id = 1"
    )
    if not row:
        return {
            "percent": DEFAULT_PERCENT,
            "signup_until": DEFAULT_SIGNUP_UNTIL,
            "accrual_until": DEFAULT_ACCRUAL_UNTIL,
            "trial_bonus_days": DEFAULT_TRIAL_BONUS_DAYS,
            "updated_at": None,
        }
    return dict(row)


async def get_trial_bonus_days(db) -> int:
    """Бонус к триалу за реф-ссылку. Сбой чтения → дефолт (регистрацию не роняем)."""
    try:
        s = await get_settings(db)
        val = s.get("trial_bonus_days")
        return int(val) if val is not None else DEFAULT_TRIAL_BONUS_DAYS
    except Exception:
        return DEFAULT_TRIAL_BONUS_DAYS


async def freeze_rate_for_new_client(db, client_id: int) -> None:
    """Заморозить действующую ставку и срок начислений на новом клиенте.

    Зовётся при регистрации, только если у клиента есть referred_by_client_id.
    После `signup_until` набор по текущей ставке закрыт — новым замораживаем
    её же значение (админ к тому моменту должен выставить новую), но срок
    начислений всё равно берём из настроек.
    """
    s = await get_settings(db)
    await db.execute(
        "UPDATE clients SET referral_rate_percent = $2, referral_accrual_until = $3 "
        "WHERE id = $1 AND referred_by_client_id IS NOT NULL",
        client_id, int(s["percent"]), s["accrual_until"],
    )


def effective_percent(payer_row, today: date | None = None) -> int:
    """Ставка для конкретного плательщика: замороженная на нём.

    Срок начислений истёк → 0 (не начисляем). Ставка не заморожена (старые
    записи до миграции) → дефолтные 10%.
    """
    today = today or date.today()
    until = payer_row.get("referral_accrual_until") if isinstance(payer_row, dict) \
        else payer_row["referral_accrual_until"]
    if until and today > until:
        return 0
    pct = payer_row.get("referral_rate_percent") if isinstance(payer_row, dict) \
        else payer_row["referral_rate_percent"]
    return int(pct) if pct is not None else DEFAULT_PERCENT
