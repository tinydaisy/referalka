"""Отдача спикера по его лид-магнитам: сколько людей перешло и сколько новых.

Организатор рассылает подарки спикера по своей базе и анонсирует его канал —
и хочет видеть, что это дало. Спикер хочет того же про себя.

⚠️ ДВА ПЕРИОДА РЯДОМ (решение владельца): «+3 дня» и «+7 дней» после последнего
дня программы. Оба считаются от ОДНОГО начала — дня первого выступления
спикера. Смысл в том, чтобы видеть, сколько людей добирает подарок уже после
эфира: по одной цифре этого не понять.

⚠️ ОТСЧЁТ — С НАЧАЛА ДНЯ ВЫСТУПЛЕНИЯ, а не с точного времени слота (решение
владельца): анонс уходит утром, люди переходят до начала эфира, и привязка к
минуте слота их теряла. У спикера бывает несколько слотов (у Евгения в
событии 24 их три) — берём ПЕРВЫЙ день.

⚠️ Пакет — ОДНА строка целиком, внутрь на отдельные магниты не раскладываем
(решение владельца): спикер дарит пакет как один подарок, дробить его в отчёте
значит показывать то, чего человек не выбирал.

⚠️ «Новый» = контакт СОЗДАН в базе клиента не раньше дня выступления. То есть
человека привёл спикер, а не он уже лежал в базе.

⚠️ Ручные подарки (manual_url) в статистику не попадают — это ссылка на чужой
файл мимо ПЛЮСОНа, переходов по ней мы не видим. В таблице их не рисуем, иначе
рядом с цифрами встанут пустые строки и это прочтётся как «ноль людей».
"""

from datetime import date, timedelta
from typing import Any

import asyncpg

# Хвосты после окончания программы. Порядок важен — в таком виде и показываем.
TAIL_DAYS = (3, 7)

# Одна точка правды на оба экрана: кабинет спикера и карточка в дашборде.
# Разъедутся запросы — разъедутся и цифры, а спикер сверяет их с организатором.
_BOUNDS_SQL = """
SELECT
    (SELECT MIN(d.day_date)
       FROM conf_sessions s
       JOIN conf_days d ON d.event_id = s.event_id AND d.day_number = s.day
      WHERE s.speaker_id = $1)                        AS speech_date,
    (SELECT MAX(d.day_date) FROM conf_days d
      WHERE d.event_id = (SELECT event_id FROM event_collaborators WHERE id = $1))
                                                      AS last_program_date
"""

_STATS_SQL = """
WITH gifts AS (
    -- Подарки спикера, живущие в ПЛЮСОНе. Ручные ссылки (manual_url) сюда не
    -- попадают: переходы по ним мы не видим.
    SELECT g.lead_magnet_id, g.package_id, g.sort_order, g.id,
           COALESCE(lm.name, pk.name) AS title,
           (g.package_id IS NOT NULL)  AS is_package
      FROM event_collaborator_lead_magnets g
      LEFT JOIN lead_magnets         lm ON lm.id = g.lead_magnet_id
      LEFT JOIN lead_magnet_packages pk ON pk.id = g.package_id
     WHERE g.ec_id = $1
       AND (g.lead_magnet_id IS NOT NULL OR g.package_id IS NOT NULL)
)
SELECT g.id, g.title, g.is_package, g.sort_order,
       COUNT(fr.id)                                                AS visits,
       COUNT(fr.id) FILTER (WHERE fr.stage = 'delivered')          AS delivered,
       COUNT(fr.id) FILTER (WHERE ct.created_at::date >= $2::date) AS fresh
  FROM gifts g
  LEFT JOIN funnel_runs fr
         ON ((g.lead_magnet_id IS NOT NULL AND fr.lead_magnet_id = g.lead_magnet_id)
          OR (g.package_id     IS NOT NULL AND fr.package_id     = g.package_id))
        -- Сравниваем ДАТЫ, а не отметки времени: период считается с начала дня.
        AND fr.landed_at::date BETWEEN $2::date AND $3::date
  LEFT JOIN contacts ct ON ct.id = fr.contact_id
 GROUP BY g.id, g.title, g.is_package, g.sort_order
 ORDER BY g.sort_order, g.title
"""


def _fmt(d: date) -> str:
    return d.strftime("%d.%m.%Y")


async def speaker_lead_magnet_stats(db: asyncpg.Connection, ec_id: int) -> dict[str, Any]:
    """Статистика подарков спикера. `ec_id` — event_collaborators.id.

    Возвращает `{available, from_date, periods[]}`, где каждый период —
    `{days, from, to, label, rows[], total{}}`.

    `available=False` означает, что у спикера нет слота с датой: отсчитывать
    не от чего, и экран должен объяснить это словами, а не рисовать нули.
    """
    b = await db.fetchrow(_BOUNDS_SQL, ec_id)
    speech: date | None = b["speech_date"] if b else None
    last_day: date | None = b["last_program_date"] if b else None

    if not speech:
        return {"available": False, "reason": "no_slot", "from_date": None, "periods": []}

    # Программы может не быть вовсе — тогда хвост считаем от дня выступления.
    base_end = last_day or speech

    periods: list[dict[str, Any]] = []
    for days in TAIL_DAYS:
        end = base_end + timedelta(days=days)
        rows = await db.fetch(_STATS_SQL, ec_id, speech, end)
        items = [
            {
                "title": r["title"] or "Без названия",
                "is_package": r["is_package"],
                "visits": r["visits"],
                "delivered": r["delivered"],
                "fresh": r["fresh"],
            }
            for r in rows
        ]
        periods.append({
            "days": days,
            "from": speech.isoformat(),
            "to": end.isoformat(),
            # Подпись готовится на бэкенде — чтобы два экрана не расходились
            # в форматах дат.
            "label": f"с {_fmt(speech)} по {_fmt(end)}",
            "rows": items,
            "total": {
                "visits": sum(i["visits"] for i in items),
                "delivered": sum(i["delivered"] for i in items),
                "fresh": sum(i["fresh"] for i in items),
            },
        })

    return {
        "available": True,
        "from_date": speech.isoformat(),
        "program_end": base_end.isoformat(),
        "periods": periods,
    }
