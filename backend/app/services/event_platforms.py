"""Через какие площадки событие ведёт зрителей. ЕДИНАЯ ТОЧКА.

Источник — `events.disabled_platforms` (миграция 263): галочки в «Публичных
ссылках» события. Здесь не заводится новых настроек, только читается эта.

⚠️ Организаторы решают САМИ, куда вести людей. Особенно важно для коллабы: чат
может быть заведён на всех трёх площадках, но у одного из организаторов нет,
скажем, ВК-бота — и с аудиторией, пришедшей из ВК, он работать не сможет (ни
рассылку послать, ни подписку на свой канал проверить). Тогда они
договариваются вести только через Telegram и выключают остальные.

⚠️ Выключенная площадка не предлагается НИГДЕ: окно выбора чата на веб-странице,
кабинет спикера, материалы, письмо о регистрации, меню бота, список ссылок.
Иначе договорённость бессмысленна — спикер всё равно раздаст ссылку на
выключенную площадку. Исключение одно: САМ КАБИНЕТ организатора, где строка
остаётся со снятой галочкой (иначе площадку нечем вернуть) —
`build_share_links(include_disabled=True)`.

⚠️ Это НЕ то же самое, что «у события заведён чат на площадке». Чат может быть
и остаётся (туда пишут), а вести туда новых зрителей — отдельное решение.
"""
from typing import Iterable, Optional

# Порядок показа площадок человеку — одинаковый везде.
PLATFORM_ORDER = ("telegram", "vk", "max")


def enabled_from_row(row) -> set[str]:
    """Включённые площадки из строки события с колонкой `disabled_platforms`.

    Колонки нет в выборке (старый запрос) → считаем включёнными все:
    поведение как до появления галочек, никого не режем.
    """
    try:
        disabled = row["disabled_platforms"] or []
    except (KeyError, TypeError, IndexError):
        disabled = []
    return {p for p in PLATFORM_ORDER if p not in set(disabled)}


async def enabled_platforms(db, event_id: int) -> set[str]:
    """Включённые площадки события. Сбой чтения → все три (не блокируем людей)."""
    try:
        row = await db.fetchrow(
            "SELECT disabled_platforms FROM events WHERE id = $1", event_id)
    except Exception:
        return set(PLATFORM_ORDER)
    if not row:
        return set(PLATFORM_ORDER)
    return enabled_from_row(row)


def filter_platforms(platforms: Iterable[str], enabled: Optional[set[str]]) -> list[str]:
    """Оставить из списка только включённые, сохранив порядок PLATFORM_ORDER."""
    src = set(platforms)
    if enabled is not None:
        src &= enabled
    return [p for p in PLATFORM_ORDER if p in src]
