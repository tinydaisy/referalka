"""Склейка имени человека — ЕДИНАЯ точка на весь проект.

С миграции 302 у коллаборатора два поля: `name` (имя) и `last_name` (фамилия).
Порядок слов при выводе зависит от того, ЧТО делает человек на экране:

    ПОКАЗ   → «Имя Фамилия»   — лендинг, карточки спикеров, Mini App,
                                веб-страница события, рассылки, сторонние API.
    ПОИСК   → «Фамилия Имя»   — списки номинаций, распределение жюри,
                                турнирная таблица, привязка людей к номинациям,
                                база коллабораторов.

Решение владельца (2026-08-14): «везде где нужен поиск — фамилия имя,
везде где нужно просто отображение — имя фамилия».

⚠️ НЕ писать склейку руками в модулях-потребителях. Иначе порядок слов
   разъедется между экранами — ровно так уже случилось до миграции 302,
   когда speaker_cabinet резал строку считая первое слово ИМЕНЕМ,
   а tournament.py той же операцией считал его ФАМИЛИЕЙ.

⚠️ Пустая фамилия — норма, а не ошибка: у компаний и партнёров-организаций
   («Грани (GRANI)», «Love Media») фамилии нет, вся строка лежит в `name`.
   Функции никогда не возвращают строку с лишним пробелом по краям.
"""

from typing import Any, Optional

__all__ = [
    "display_name",
    "search_name",
    "name_from_row",
    "DISPLAY_NAME_SQL",
    "SEARCH_NAME_SQL",
    "SEARCH_NAME_ORDER_SQL",
]


def _clean(value: Any) -> str:
    return str(value).strip() if value else ""


def display_name(first: Any, last: Any = None) -> str:
    """«Имя Фамилия» — там, где человека просто показывают."""
    f, l = _clean(first), _clean(last)
    return f"{f} {l}".strip() if f and l else (f or l)


def search_name(first: Any, last: Any = None) -> str:
    """«Фамилия Имя» — там, где человека ищут глазами в списке."""
    f, l = _clean(first), _clean(last)
    return f"{l} {f}".strip() if f and l else (l or f)


def name_from_row(row: Any, *, search: bool = False,
                  first_key: str = "name", last_key: str = "last_name") -> str:
    """Собрать имя из строки БД или словаря.

    Терпимо к отсутствию ключа `last_name`: старые запросы, которые его
    не выбирают, вернут одно имя, а не упадут.
    """
    if row is None:
        return ""
    try:
        first = row[first_key]
    except (KeyError, IndexError, TypeError):
        first = None
    try:
        last = row[last_key]
    except (KeyError, IndexError, TypeError):
        last = None
    return search_name(first, last) if search else display_name(first, last)


def _sql(table: str, *, search: bool) -> str:
    a, b = (f"{table}.last_name", f"{table}.name") if search else (f"{table}.name", f"{table}.last_name")
    return (
        f"btrim(CASE WHEN COALESCE(btrim({table}.last_name), '') = '' "
        f"THEN COALESCE({table}.name, '') "
        f"ELSE COALESCE({a}, '') || ' ' || COALESCE({b}, '') END)"
    )


def DISPLAY_NAME_SQL(table: str = "c") -> str:
    """SQL-выражение «Имя Фамилия» для запросов на показ."""
    return _sql(table, search=False)


def SEARCH_NAME_SQL(table: str = "c") -> str:
    """SQL-выражение «Фамилия Имя» для списков поиска."""
    return _sql(table, search=True)


def SEARCH_NAME_ORDER_SQL(table: str = "c") -> str:
    """ORDER BY для списков: по фамилии, затем по имени.

    Пустая фамилия уходит вниз (NULLS LAST по сути): компании и записи
    без фамилии не должны занимать начало алфавитного списка людей.
    """
    return (
        f"NULLIF(btrim(COALESCE({table}.last_name, '')), '') ASC NULLS LAST, "
        f"{table}.name ASC"
    )
