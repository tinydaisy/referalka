"""Расчёт квадратиков-разрезов для дашборда аналитики.

Квадратик = РАЗРЕЗ (по какому полю строим полоски) + УСЛОВИЯ (кого вообще
считаем). Пример клиента: разрез «Рассматривает наставника», условие «доход
из вилок от 200 тысяч» — и видно, кто из платёжеспособных готов покупать.

⚠️ Разрез бывает ДВУХ происхождений, и оба обязательны:

  source='field'    contact_fields.id   → contact_field_values (текущее
                                          значение человека, 1 строка)
  source='question' survey_questions.id → survey_answers через
                                          survey_responses.contact_id

У клиента 1 на проде у ВСЕХ вопросов анкет field_id IS NULL, то есть
«Рассматривает наставника» физически НЕ лежит в contact_field_values.
Поддержать только contact_fields значило бы потерять ровно то, что просили
пересекать. Оба источника сводятся к contact_id и потому свободно
пересекаются друг с другом.

⚠️ Источник истины значения — колонка `value` (TEXT), не `value_json`.
Анкета пишет в value_json настоящий тип (число 50000), а ручная правка в
карточке контакта — всегда строку. Числа поэтому приводим из value регуляркой.
"""
from __future__ import annotations

import json
from typing import Any

# Разрезы, которые вообще имеет смысл считать полосками.
# ⚠️ text/textarea НЕ автогенерируем и не считаем разбивкой: у свободного
# текста почти все ответы разные, полоски по одному человеку — мусор.
CHOICE_KINDS = ("select", "multiselect", "bool")
NUMERIC_KINDS = ("number", "scale")
# Что автогенерируется при открытии дашборда (решение владельца:
# «автогенерировать только выпадающие списки и числовые поля»).
AUTO_KINDS = CHOICE_KINDS + NUMERIC_KINDS

# Операторы, доступные по типу разреза. Показываются в UI выборочно, чтобы
# нельзя было задать бессмыслицу: «Уровень дохода» — это select с вилками
# («200.000- 300.000 рублей»), сравнения > < там невозможны в принципе.
OPERATORS_BY_KIND: dict[str, list[str]] = {
    "select": ["in", "not_in", "filled", "empty"],
    "multiselect": ["in", "not_in", "filled", "empty"],
    "bool": ["in", "filled", "empty"],
    "number": ["gt", "gte", "lt", "lte", "eq", "neq", "filled", "empty"],
    "scale": ["gt", "gte", "lt", "lte", "eq", "neq", "filled", "empty"],
    "text": ["contains", "eq", "filled", "empty"],
    "textarea": ["contains", "eq", "filled", "empty"],
    "date": ["gt", "lt", "filled", "empty"],
}

_NUMERIC_CAST = (
    "NULLIF(regexp_replace({col},'[^0-9.-]','','g'),'')::numeric"
)
_IS_NUMERIC = "{col} ~ '^-?[0-9]+(\\.[0-9]+)?$'"

_MAX_DEPTH = 5   # глубина вложенности групп условий — защита от зацикливания


def _jsonb(value: Any) -> Any:
    """asyncpg отдаёт JSONB строкой — разворачиваем."""
    if isinstance(value, (dict, list)):
        return value
    if not value:
        return {}
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return {}


class _Params:
    """Накопитель параметров запроса: $1, $2, ... по мере добавления."""

    def __init__(self, initial: list | None = None):
        self.values: list = list(initial or [])

    def add(self, value: Any) -> str:
        self.values.append(value)
        return f"${len(self.values)}"


def _value_expr(source: str) -> tuple[str, str, str]:
    """Возвращает (FROM-часть без WHERE, предикат привязки, выражение значения).

    Обе ветки дают набор строк «значение этого человека» — дальше логика
    общая. WHERE намеренно не зашит в FROM-часть: этот же кусок нужен и
    внутри EXISTS (там WHERE), и внутри JOIN LATERAL (там его быть не должно).
    """
    if source == "question":
        return (
            """FROM survey_answers a
                 JOIN survey_responses r ON r.id = a.response_id""",
            "a.question_id = {ref} AND r.contact_id = c.id",
            "a.value",
        )
    return (
        "FROM contact_field_values v",
        "v.field_id = {ref} AND v.contact_id = c.id",
        "v.value",
    )


def build_condition_sql(cond: dict, p: _Params, depth: int = 0) -> str:
    """Одно условие или группа условий → SQL-предикат по контакту `c`.

    Дерево: {"op":"and"|"or", "items":[...]} либо лист
    {"source","ref_id","operator","values"}.

    Возвращает 'TRUE' на пустом/битом узле — фильтр, который не смогли
    разобрать, не должен молча выкидывать людей из подсчёта.
    """
    if not isinstance(cond, dict) or depth > _MAX_DEPTH:
        return "TRUE"

    # ── Группа ────────────────────────────────────────────────────────────
    items = cond.get("items")
    if isinstance(items, list):
        op = "OR" if str(cond.get("op", "and")).lower() == "or" else "AND"
        parts = [build_condition_sql(it, p, depth + 1) for it in items]
        parts = [x for x in parts if x and x != "TRUE"]
        if not parts:
            return "TRUE"
        return "(" + f" {op} ".join(parts) + ")"

    # ── Лист ──────────────────────────────────────────────────────────────
    try:
        ref_id = int(cond.get("ref_id"))
    except (TypeError, ValueError):
        return "TRUE"

    source = "question" if cond.get("source") == "question" else "field"
    operator = str(cond.get("operator") or "in")
    raw_values = cond.get("values")
    values = [str(v) for v in raw_values if str(v).strip()] if isinstance(raw_values, list) else []
    single = str(cond.get("value") or "").strip()
    if single and not values:
        values = [single]

    from_sql, bind_tpl, col = _value_expr(source)
    bind = bind_tpl.format(ref=p.add(ref_id))
    frm = f"{from_sql} WHERE {bind}"
    non_empty = f"COALESCE({col},'') <> ''"

    # «Заполнено / не заполнено» — работает у любого типа.
    if operator == "filled":
        return f"EXISTS (SELECT 1 {frm} AND {non_empty})"
    if operator == "empty":
        return f"NOT EXISTS (SELECT 1 {frm} AND {non_empty})"

    if operator in ("gt", "gte", "lt", "lte", "eq", "neq") and values:
        sql_op = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<=",
                  "eq": "=", "neq": "<>"}[operator]
        try:
            num = float(values[0])
        except ValueError:
            return "TRUE"
        cast = _NUMERIC_CAST.format(col=col)
        guard = _IS_NUMERIC.format(col=col)
        expr = f"EXISTS (SELECT 1 {frm} AND {guard} AND {cast} {sql_op} {p.add(num)})"
        # «не равно» должно захватывать и тех, у кого значение непустое, но
        # нечисловое — иначе они молча выпадут из выборки.
        return expr

    if operator == "contains" and values:
        like = p.add(f"%{values[0]}%")
        return f"EXISTS (SELECT 1 {frm} AND {col} ILIKE {like})"

    if not values:
        return "TRUE"

    # ⚠️ Списковые операторы. У multiselect значения хранятся СКЛЕЕННЫМИ
    # через запятую («Творчество, Заработок»), поэтому простое `= ANY`
    # не найдёт человека по одному варианту. Разворачиваем value_json,
    # а если он не массив — сравниваем текст целиком.
    arr = p.add(values)
    alias = "a" if source == "question" else "v"
    # ⚠️ jsonb_array_elements_text — функция, возвращающая НАБОР строк, и
    # Postgres запрещает её внутри CASE («set-returning functions are not
    # allowed in CASE»). Поэтому массив разворачиваем отдельным LATERAL, а
    # ветку «не массив» добавляем через UNION ALL.
    unnest = f"""
        EXISTS (
          SELECT 1 {frm} AND EXISTS (
            SELECT 1 FROM (
              SELECT jsonb_array_elements_text({alias}.value_json) AS one
               WHERE jsonb_typeof({alias}.value_json) = 'array'
              UNION ALL
              SELECT {col} AS one
               WHERE {alias}.value_json IS NULL
                  OR jsonb_typeof({alias}.value_json) <> 'array'
            ) y WHERE y.one = ANY({arr}::text[])
          )
        )"""
    if operator == "not_in":
        return f"NOT {unnest.strip()}"
    return unnest.strip()


def build_filters_sql(filters: Any, p: _Params) -> str:
    """Всё дерево условий квадратика → предикат. Пусто → TRUE."""
    tree = _jsonb(filters)
    if not tree:
        return "TRUE"
    return build_condition_sql(tree, p)


async def resolve_sources(db, client_id: int) -> dict[int | str, dict]:
    """Справочник доступных разрезов: поля контакта + вопросы анкет.

    Ключ — 'field:3' / 'question:24', как во фронте и в analytics_cards.
    """
    out: dict[str, dict] = {}

    fields = await db.fetch(
        """SELECT id, title, kind, options, scale_min, scale_max
             FROM contact_fields
            WHERE client_id = $1 AND is_active = TRUE
            ORDER BY sort_order, id""",
        client_id,
    )
    for f in fields:
        out[f"field:{f['id']}"] = {
            "source": "field", "ref_id": f["id"], "title": f["title"],
            "kind": f["kind"], "options": _jsonb(f["options"]) or [],
            "scale_min": f["scale_min"], "scale_max": f["scale_max"],
            "group": "Поля контакта",
        }

    questions = await db.fetch(
        """SELECT q.id, q.title, q.kind, q.options, q.scale_min, q.scale_max,
                  s.title AS survey_title
             FROM survey_questions q
             JOIN surveys s ON s.id = q.survey_id
            WHERE s.client_id = $1
            ORDER BY s.id, q.sort_order, q.id""",
        client_id,
    )
    for q in questions:
        out[f"question:{q['id']}"] = {
            "source": "question", "ref_id": q["id"], "title": q["title"],
            "kind": q["kind"], "options": _jsonb(q["options"]) or [],
            "scale_min": q["scale_min"], "scale_max": q["scale_max"],
            "group": q["survey_title"] or "Анкета",
        }

    return out


async def compute_card(
    db, *, client_id: int, source: str, ref_id: int, filters: Any,
    event_id: int | None = None, meta: dict | None = None,
) -> dict:
    """Считает один квадратик.

    ⚠️ Знаменатель процентов — те, кто прошёл условия И ответил на сам разрез
    (`answered`), а не все прошедшие условия (`scope`). Молчащий человек не
    должен тянуть долю вниз: он не «против», он неизвестен. Обе цифры
    отдаём наружу, чтобы на карточке было видно полноту разреза.
    """
    p = _Params([client_id])
    where = "c.client_id = $1 AND c.is_active = TRUE"

    # У дашборда события ко всем квадратикам молча добавляется участие.
    if event_id:
        where += f" AND EXISTS (SELECT 1 FROM event_participants ep " \
                 f"WHERE ep.contact_id = c.id AND ep.event_id = {p.add(event_id)})"

    where += " AND " + build_filters_sql(filters, p)

    scope = await db.fetchval(
        f"SELECT COUNT(*) FROM contacts c WHERE {where}", *p.values) or 0

    from_sql, bind_tpl, col = _value_expr(source)
    bind = bind_tpl.format(ref=p.add(ref_id))
    alias = "a" if source == "question" else "v"

    answered = await db.fetchval(
        f"""SELECT COUNT(*) FROM contacts c
             WHERE {where}
               AND EXISTS (SELECT 1 {from_sql} WHERE {bind}
                            AND COALESCE({col},'') <> '')""",
        *p.values,
    ) or 0

    kind = (meta or {}).get("kind") or "text"
    out: dict[str, Any] = {"scope": scope, "answered": answered, "breakdown": []}

    if kind in CHOICE_KINDS or kind in NUMERIC_KINDS:
        # ⚠️ Мультиселект разворачиваем: иначе каждая КОМБИНАЦИЯ ответов
        # («Творчество, Заработок») станет отдельной полоской, и разбивка
        # превратится в мусор из уникальных строк.
        rows = await db.fetch(
            f"""SELECT y.one AS option, COUNT(DISTINCT c.id) AS cnt
                  FROM contacts c
                  JOIN LATERAL (
                    SELECT jsonb_array_elements_text({alias}.value_json) AS one
                      {from_sql} WHERE {bind}
                       AND jsonb_typeof({alias}.value_json) = 'array'
                    UNION ALL
                    SELECT {col} AS one
                      {from_sql} WHERE {bind}
                       AND ({alias}.value_json IS NULL
                            OR jsonb_typeof({alias}.value_json) <> 'array')
                  ) y ON TRUE
                 WHERE {where} AND COALESCE(y.one,'') <> ''
                 GROUP BY y.one
                 ORDER BY cnt DESC""",
            *p.values,
        )
        items = [
            {
                "option": r["option"],
                "count": r["cnt"],
                "percent": round(r["cnt"] * 100.0 / answered, 1) if answered else 0.0,
            }
            for r in rows
        ]
        # У числовых сортируем по значению, а не по популярности — иначе
        # шкала 1..10 выглядит случайной россыпью.
        if kind in NUMERIC_KINDS:
            def _num(x):
                try:
                    return float(str(x["option"]).replace(",", "."))
                except ValueError:
                    return float("inf")
            items.sort(key=_num)
        out["breakdown"] = items

    if kind in NUMERIC_KINDS:
        cast = _NUMERIC_CAST.format(col=col)
        guard = _IS_NUMERIC.format(col=col)
        agg = await db.fetchrow(
            f"""SELECT AVG(t.v)::numeric(12,2) AS avg, MIN(t.v) AS min, MAX(t.v) AS max
                  FROM contacts c
                  JOIN LATERAL (
                    SELECT {cast} AS v {from_sql} WHERE {bind} AND {guard}
                  ) t ON TRUE
                 WHERE {where}""",
            *p.values,
        )
        out["avg"] = float(agg["avg"]) if agg and agg["avg"] is not None else None
        out["min"] = float(agg["min"]) if agg and agg["min"] is not None else None
        out["max"] = float(agg["max"]) if agg and agg["max"] is not None else None

    return out
