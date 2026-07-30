"""Единая сортировка спикеров/жюри/организаторов/партнёров события.

Один порядок везде: Mini App (ProgramTab — лента вверху и список внизу),
Celery (выдача подарков day_end, рассылка знакомства speaker_intro), дашборд
(SpeakersTab, список соорганизаторов).

Группы (group_rank, меньше = выше):
  1  organizer
  2  commercial jury
  3  commercial headliner
  4  commercial speaker
  5  commercial general_partner
  6  commercial partner
  7  jury
  8  headliner
  9  speaker
  10 general_partner
  11 partner
  12 остальное

Внутри группы:
  referrals DESC — кто привёл больше людей (по ref_code в event_participants)
  priority ASC   — меньше число = выше (как в calcPriority дашборда)
  id ASC

ВАЖНО: «приведённые» считаются ВСЕ перешедшие — независимо от is_registered.
"""

from typing import Final

_GROUP_RANK: Final[str] = """CASE
  WHEN {tbl}.role = 'organizer'                                                       THEN 1
  WHEN {tbl}.is_commercial = TRUE  AND {tbl}.role = 'jury'                            THEN 2
  WHEN {tbl}.is_commercial = TRUE  AND {tbl}.role = 'headliner'                       THEN 3
  WHEN {tbl}.is_commercial = TRUE  AND {tbl}.role = 'speaker'                         THEN 4
  WHEN {tbl}.is_commercial = TRUE  AND {tbl}.role = 'general_partner'                 THEN 5
  WHEN {tbl}.is_commercial = TRUE  AND {tbl}.role = 'partner'                         THEN 6
  WHEN {tbl}.role = 'jury'                                                            THEN 7
  WHEN {tbl}.role = 'headliner'                                                       THEN 8
  WHEN {tbl}.role = 'speaker'                                                         THEN 9
  WHEN {tbl}.role = 'general_partner'                                                 THEN 10
  WHEN {tbl}.role = 'partner'                                                         THEN 11
  ELSE 12
END"""

_REFERRALS_COUNT: Final[str] = """COALESCE((
  SELECT COUNT(*) FROM event_participants ep
   WHERE ep.event_id = {tbl}.event_id
     AND ep.referrer_ref_code IS NOT NULL
     AND ep.referrer_ref_code = (
       SELECT ct.ref_code FROM collaborators co_sort
         JOIN contacts ct ON ct.id = co_sort.contact_id
        WHERE co_sort.id = {tbl}.speaker_id
     )
), 0)"""


def group_rank_sql(tbl: str = "cse") -> str:
    """SQL-выражение `group_rank` (int). Меньше — выше в списке."""
    return _GROUP_RANK.format(tbl=tbl)


def referrals_count_sql(tbl: str = "cse") -> str:
    """SQL-выражение `referrals_count` (int). Все перешедшие по ref_code коллаба."""
    return _REFERRALS_COUNT.format(tbl=tbl)


# Жёсткий порядок ГРУПП (2026-07-04): организатор → жюри → партнёры → спикеры.
# Меньше = выше. Внутри группы — referrals DESC → priority ASC → id ASC.
_ROLE_GROUP: Final[str] = """CASE
  WHEN {tbl}.role = 'organizer'                          THEN 1
  WHEN {tbl}.role = 'jury'                               THEN 2
  WHEN {tbl}.role IN ('general_partner', 'partner')      THEN 3
  WHEN {tbl}.role IN ('headliner', 'speaker')            THEN 4
  ELSE 5
END"""


def role_group_sql(tbl: str = "cse") -> str:
    """SQL-выражение жёсткого порядка ГРУПП по роли (int). Меньше — выше.

    Нужно там, где ORDER BY нельзя задать одной строкой: например при
    DISTINCT ON (дедуп спикеров, у которых несколько слотов в дне) сортировка
    разносится на подзапрос и внешний ORDER BY по отдельным колонкам.
    """
    return _ROLE_GROUP.format(tbl=tbl)


def order_by_sql(tbl: str = "cse") -> str:
    """Строка для ORDER BY (без слова ORDER BY).

    tbl — алиас таблицы event_collaborators в запросе. Таблица должна иметь
    колонки role, is_commercial, priority, speaker_id, event_id, id.

    Логика (2026-07-04): жёсткий порядок ГРУПП по роли —
    организатор → жюри → партнёры (general_partner+partner) → спикеры
    (headliner+speaker). Внутри группы: кто больше привёл, тот выше
    (referrals DESC), потом priority ASC (меньше число = выше), потом id.

    Логика применяется везде где SELECT с этим ORDER BY: Mini App
    (ProgramTab лента вверху + SpeakersTab список) — кроме случаев когда
    Mini App дополнительно ГРУППИРУЕТ визуально по сегментам, тогда
    порядок внутри сегмента такой же. Рассылки speaker_intro / day_end.
    Дашборд list_event_speakers. Веб-страница события (event_page_html.py).
    Виджет для сторонних лендингов (landing_widget.py) — НЕ использует эту
    функцию, у него своя копия сортировки.
    """
    return (
        # 0. Жёсткий порядок групп по роли.
        f"{_ROLE_GROUP.format(tbl=tbl)} ASC, "
        # 1. Внутри группы — кто больше привёл, тот выше.
        f"{referrals_count_sql(tbl)} DESC, "
        # 2. Приоритет (меньше = выше) как tie-breaker среди равных по referrals.
        f"COALESCE({tbl}.priority, 60) ASC, "
        f"{tbl}.id ASC"
    )


# Старая логика (до 2026-05-29) — сначала group_rank (commercial vs not),
# потом referrals. Оставлено как комментарий для отката если потребуется.
# def order_by_sql(tbl: str = "cse") -> str:
#     return (
#         f"{group_rank_sql(tbl)} ASC, "
#         f"{referrals_count_sql(tbl)} DESC, "
#         f"COALESCE({tbl}.priority, 60) ASC, "
#         f"{tbl}.id ASC"
#     )
