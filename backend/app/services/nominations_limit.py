"""Сколько номинаций доступно человеку в событии — ЕДИНАЯ точка (миграция 328).

У премии номинаций бывает полсотни, и участие в них покупают штучно: кто-то
берёт одну, кто-то три. Человек отмечает свои номинации сам в кабинете, а
сколько ему можно — считается здесь.

ИТОГ = минимум из ЗАПОЛНЕННЫХ:
  • event_collaborators.nominations_limit — личное число человека в этом событии
  • conf_conferences.max_nominations_*    — потолок его роли на событии
  • сколько всего номинаций у события     — учитывается ВСЕГДА
Ничего не заполнено → ограничения нет (None).

⚠️ Считать лимит на месте нельзя — правило живёт в трёх экранах сразу
(кабинет, карточка в дашборде, приём оплаты), и посчитанное по-своему
неминуемо разойдётся: человек увидит «доступно 3», а сохранить сможет 2.

⚠️ Лимит — в границах ОДНОГО события. Поэтому личное число лежит на карточке
(`event_collaborators`), а не на контакте: в премии 2026 у человека может быть
три номинации, в премии 2027 — одна, и оба числа живут одновременно.

⚠️ Проверять лимит обязан СЕРВЕР. Браузер только рисует счётчик — фронтовой
проверкой ограничение обходится обычным запросом мимо интерфейса.
"""

from typing import Any, Optional

import asyncpg

__all__ = [
    "role_kind",
    "self_pick_allowed",
    "effective_limit",
    "sync_limit_with_marked",
]

# Роли из event_collaborators.role, которые считаются «жюри». Остальные
# (speaker, headliner, participant, партнёры) идут по ветке номинантов —
# у них участие покупается, у жюри нет.
_JURY_ROLES = frozenset({"jury"})


def role_kind(role: Any) -> str:
    """'jury' или 'speaker' — по какой из двух настроек судить человека."""
    return "jury" if str(role or "").strip().lower() in _JURY_ROLES else "speaker"


async def _conf_settings(db: asyncpg.Connection, event_id: int) -> Optional[asyncpg.Record]:
    return await db.fetchrow(
        """SELECT self_pick_stages_speakers, self_pick_stages_jury,
                  max_nominations_speakers, max_nominations_jury
             FROM conf_conferences WHERE event_id = $1""",
        event_id,
    )


async def self_pick_allowed(db: asyncpg.Connection, event_id: int, role: Any) -> bool:
    """Разрешено ли человеку этой роли самому отмечать номинации."""
    conf = await _conf_settings(db, event_id)
    if not conf:
        return False
    key = ("self_pick_stages_jury" if role_kind(role) == "jury"
           else "self_pick_stages_speakers")
    return bool(conf[key])


async def effective_limit(
    db: asyncpg.Connection,
    *,
    event_id: int,
    ec_id: int,
    role: Any = None,
) -> Optional[int]:
    """Итоговый лимит номинаций человека. None — без ограничений.

    `role` можно не передавать — тогда прочитаем из карточки.
    """
    row = await db.fetchrow(
        """SELECT ec.nominations_limit, ec.role,
                  (SELECT count(*) FROM conf_stages s WHERE s.event_id = ec.event_id)
                    AS stages_total
             FROM event_collaborators ec WHERE ec.id = $1""",
        ec_id,
    )
    if not row:
        return None

    conf = await _conf_settings(db, event_id)
    kind = role_kind(role if role is not None else row["role"])
    cap = None
    if conf:
        cap = conf["max_nominations_jury" if kind == "jury" else "max_nominations_speakers"]

    # Всего номинаций у события — потолок, который действует всегда: вписанные
    # «50 номинаций» при шести существующих означают ровно шесть.
    candidates = [v for v in (row["nominations_limit"], cap, row["stages_total"]) if v is not None]
    if not candidates:
        return None
    return max(0, min(int(v) for v in candidates))


async def sync_limit_with_marked(db: asyncpg.Connection, ec_id: int) -> None:
    """Лимит следует за отметками организатора.

    Организатор отметил человеку пять номинаций — значит ему доступно пять,
    вписывать число отдельно не надо. Снял одну — стало четыре: сколько
    отмечено, столько и можно (решение владельца).

    ⚠️ Зовётся только из ручной правки карточки в дашборде. Самовыбор в
    кабинете лимит НЕ двигает — иначе человек поднимал бы себе потолок сам,
    отмечая номинации.

    ⚠️ НОЛЬ отметок = NULL («без ограничений»), а не «нельзя ни одной».
    Иначе самовыбор ломался бы у всех новых: организатор заводит карточку,
    ничего не отмечает — и человек в кабинете упирается в «доступно 0»,
    хотя лимита ему никто не ставил. Запрет выражается потолком события
    или числом в карточке, а не пустотой.

    ⚠️ НИЖЕ ОПЛАЧЕННОГО не опускаем. Человек купил три номинации, организатор
    отметил ему пока одну — оплаченные два места обязаны остаться, иначе
    покупка молча пропадёт, а человек в кабинете увидит «доступно 1».
    """
    await db.execute(
        """UPDATE event_collaborators ec
              SET nominations_limit = NULLIF(GREATEST(
                    (SELECT count(*) FROM event_collaborator_stages ecs
                      WHERE ecs.ec_id = ec.id),
                    COALESCE((
                      SELECT t.nominations_grant
                        FROM event_participant_tariffs o
                        JOIN event_tariffs t ON t.id = o.tariff_id
                        JOIN collaborators c ON c.id = ec.speaker_id
                       WHERE o.event_id = ec.event_id
                         AND o.status = 'paid'
                         AND o.contact_id = c.contact_id
                         AND COALESCE(t.nominations_grant, 0) > 0
                       ORDER BY o.paid_at DESC NULLS LAST, o.id DESC
                       LIMIT 1), 0)), 0)
            WHERE ec.id = $1""",
        ec_id,
    )
