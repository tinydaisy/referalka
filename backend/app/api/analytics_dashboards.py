"""API дашбордов аналитики — наборы квадратиков-разрезов.

Два входа, ОДИН движок:
  • раздел «Аналитика»                → дашборды клиента (event_id IS NULL)
  • карточка события → «Отслеживания» → дашборды события (event_id = N)

У событийного ко всем квадратикам молча добавляется условие «контакт —
участник этого события»; в остальном логика та же.

⚠️ Дашбордов у клиента МНОГО (решение владельца) — «Портрет базы», «Кто
готов покупать» и т.п. Поэтому это список, а не единственная запись.
"""
import csv
import io
import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.analytics_cards import (
    AUTO_KINDS,
    OPERATORS_BY_KIND,
    card_people,
    compute_card,
    compute_tile,
    resolve_sources,
)
from app.services.assistant_access import assistant_is_restricted
from app.services.features import client_has_feature

router = APIRouter(prefix="/analytics", tags=["Аналитика"])

_FEATURE = "analytics_dashboard"
_DENY = "Дашборды аналитики доступны на тарифе Экстра."


async def _assert_feature(db, client_id: int) -> None:
    """Гейт по фиче (Экстра и админ).

    ⚠️ Только на ЗАПИСЬ — общее правило проекта «смотреть можно, менять
    нельзя»: собранные срезы это данные клиента, отбирать их при смене
    тарифа неправильно.
    """
    if not await client_has_feature(db, client_id, _FEATURE):
        raise HTTPException(status_code=403, detail=_DENY)


async def _assert_owns_event(db, event_id: int, client_id: int) -> None:
    """Событие принадлежит клиенту. Иначе по чужому id читались бы чужие срезы."""
    ok = await db.fetchval(
        """SELECT 1 FROM event_owners
            WHERE event_id = $1 AND client_id = $2 AND status = 'accepted'""",
        event_id, client_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Событие не найдено")


async def _get_dashboard(db, dashboard_id: int, client_id: int) -> dict:
    row = await db.fetchrow(
        "SELECT * FROM analytics_dashboards WHERE id = $1 AND client_id = $2",
        dashboard_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Дашборд не найден")
    return dict(row)


class DashboardIn(BaseModel):
    title: Optional[str] = None
    event_id: Optional[int] = None
    # Привязка к анкете: дашборд виден и внутри анкеты, и в «Аналитике».
    survey_id: Optional[int] = None
    # Общие настройки показа — действуют на ВСЕ квадратики дашборда.
    hide_absolute: Optional[bool] = None
    hide_percent: Optional[bool] = None
    primary_metric: Optional[str] = None   # 'count' | 'percent'
    # Вид показа: 'cards' — плитками, 'columns' — колонками со списком людей.
    layout: Optional[str] = None


class CardIn(BaseModel):
    source: str = "field"
    ref_id: int
    title: Optional[str] = None
    filters: Optional[Any] = None
    hide_absolute: Optional[bool] = None
    hide_percent: Optional[bool] = None
    # 'list' — карточка со всеми вариантами, 'tile' — одна крупная цифра.
    view: Optional[str] = None
    option_value: Optional[str] = None


# ── Справочник разрезов ───────────────────────────────────────────────────
@router.get("/sources", summary="Доступные разрезы: поля контакта и вопросы анкет")
async def list_sources(
    survey_id: Optional[int] = Query(default=None),
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Чем можно резать базу и какие операторы у каждого типа.

    ⚠️ Отдаём ОБА источника — поля контакта и вопросы анкет. У клиента
    вопросы анкет обычно не привязаны к полям (`field_id IS NULL`), и без
    них нечем было бы пересекать «доход × готовность к наставнику».

    `survey_id` сужает список до вопросов ОДНОЙ анкеты — это нужно разделу
    «Дашборды анкеты»: там выбирают из своих вопросов, а не из всех сразу
    (у клиента их под сотню, и одинаковые вопросы разных анкет не различить).
    Поля контакта остаются: ими режут ответы («кто из ответивших с доходом
    от 200 тысяч»).
    """
    client_id = int(client["sub"])
    sources = await resolve_sources(db, client_id)
    items = list(sources.values())
    if survey_id:
        items = [it for it in items
                 if it["source"] == "field" or it.get("survey_id") == survey_id]
    for it in items:
        it["key"] = f"{it['source']}:{it['ref_id']}"
        it["operators"] = OPERATORS_BY_KIND.get(it["kind"], ["filled", "empty"])
        it["auto"] = it["kind"] in AUTO_KINDS
    return {"sources": items}


# ── Дашборды ──────────────────────────────────────────────────────────────
@router.get("/dashboards", summary="Список дашбордов")
async def list_dashboards(
    event_id: Optional[int] = Query(default=None),
    survey_id: Optional[int] = Query(default=None),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Дашборды: все клиента, конкретного события или конкретной анкеты.

    ⚠️ Дашборд анкеты — не отдельная сущность, а обычный дашборд с привязкой.
    Поэтому в разделе «Аналитика» видны ВСЕ дашборды клиента, включая
    анкетные, а внутри анкеты — только её (решение владельца: это два входа
    в одно место, а не два разных списка).
    """
    client_id = int(client["sub"])
    if event_id:
        await _assert_owns_event(db, event_id, client_id)
        rows = await db.fetch(
            """SELECT * FROM analytics_dashboards
                WHERE client_id = $1 AND event_id = $2
                ORDER BY sort_order, id""",
            client_id, event_id,
        )
    elif survey_id:
        own = await db.fetchval(
            "SELECT 1 FROM surveys WHERE id=$1 AND client_id=$2", survey_id, client_id)
        if not own:
            raise HTTPException(status_code=404, detail="Анкета не найдена")
        rows = await db.fetch(
            """SELECT * FROM analytics_dashboards
                WHERE client_id = $1 AND survey_id = $2
                ORDER BY sort_order, id""",
            client_id, survey_id,
        )
    else:
        # Раздел «Аналитика»: общие + анкетные. Событийные остаются внутри
        # своего события — там их и настраивают, а в общем списке они
        # выглядели бы оторванными от события, к которому относятся.
        rows = await db.fetch(
            """SELECT d.*, s.title AS survey_title
                 FROM analytics_dashboards d
                 LEFT JOIN surveys s ON s.id = d.survey_id
                WHERE d.client_id = $1 AND d.event_id IS NULL
                ORDER BY d.sort_order, d.id""",
            client_id,
        )
    return {"dashboards": [dict(r) for r in rows]}


@router.post("/dashboards", summary="Создать дашборд")
async def create_dashboard(
    data: DashboardIn, client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    if data.event_id:
        await _assert_owns_event(db, data.event_id, client_id)

    if data.survey_id:
        own = await db.fetchval(
            "SELECT 1 FROM surveys WHERE id=$1 AND client_id=$2",
            data.survey_id, client_id)
        if not own:
            raise HTTPException(status_code=404, detail="Анкета не найдена")

    title = (data.title or "").strip() or "Дашборд"
    row = await db.fetchrow(
        """INSERT INTO analytics_dashboards
             (client_id, event_id, survey_id, title, sort_order)
           VALUES ($1, $2, $4, $3,
                   COALESCE((SELECT MAX(sort_order) + 10 FROM analytics_dashboards
                              WHERE client_id = $1
                                AND event_id IS NOT DISTINCT FROM $2
                                AND survey_id IS NOT DISTINCT FROM $4), 0))
           RETURNING *""",
        client_id, data.event_id, title, data.survey_id,
    )
    return dict(row)


@router.patch("/dashboards/{dashboard_id}", summary="Переименовать дашборд")
async def update_dashboard(
    dashboard_id: int, data: DashboardIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)

    fs = data.model_fields_set
    sets, params = [], []

    def _add(sql: str, val: Any) -> None:
        params.append(val)
        sets.append(sql.format(i=len(params)))

    if "title" in fs:
        _add("title = ${i}", (data.title or "").strip() or "Дашборд")
    if "hide_absolute" in fs:
        _add("hide_absolute = ${i}", bool(data.hide_absolute))
    if "hide_percent" in fs:
        _add("hide_percent = ${i}", bool(data.hide_percent))
    if "primary_metric" in fs:
        _add("primary_metric = ${i}",
             "percent" if data.primary_metric == "percent" else "count")
    if "layout" in fs:
        _add("layout = ${i}", "columns" if data.layout == "columns" else "cards")

    if sets:
        params.append(dashboard_id)
        await db.execute(
            f"""UPDATE analytics_dashboards SET {', '.join(sets)}, updated_at = NOW()
                 WHERE id = ${len(params)}""",
            *params,
        )
    return dict(await _get_dashboard(db, dashboard_id, client_id))


@router.delete("/dashboards/{dashboard_id}", summary="Удалить дашборд")
async def delete_dashboard(
    dashboard_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)
    await db.execute("DELETE FROM analytics_dashboards WHERE id = $1", dashboard_id)
    return {"ok": True}


# ── Квадратики ────────────────────────────────────────────────────────────
@router.get("/dashboards/{dashboard_id}", summary="Дашборд с посчитанными квадратиками")
async def get_dashboard(
    dashboard_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    """Отдаёт квадратики уже с цифрами.

    ⚠️ Разрез мог быть удалён (поле выключили, анкету снесли) — такой
    квадратик отдаём с `missing: true`, а не роняем весь дашборд.
    """
    client_id = int(client["sub"])
    dash = await _get_dashboard(db, dashboard_id, client_id)
    sources = await resolve_sources(db, client_id)

    rows = await db.fetch(
        """SELECT * FROM analytics_cards
            WHERE dashboard_id = $1 ORDER BY sort_order, id""",
        dashboard_id,
    )

    cards = []
    for r in rows:
        key = f"{r['source']}:{r['ref_id']}"
        meta = sources.get(key)
        item: dict[str, Any] = {
            "id": r["id"], "source": r["source"], "ref_id": r["ref_id"],
            "key": key,
            "title": r["title"] or (meta or {}).get("title") or "Разрез удалён",
            "filters": r["filters"],
            # ⚠️ NULL у карточки = «как на дашборде». Отдаём и своё значение
            # (для галочки в шестерёнке), и итоговое (для отрисовки).
            "hide_absolute": r["hide_absolute"],
            "hide_percent": r["hide_percent"],
            "primary_metric": r["primary_metric"],
            "eff_hide_absolute": dash["hide_absolute"]
                if r["hide_absolute"] is None else r["hide_absolute"],
            "eff_hide_percent": dash["hide_percent"]
                if r["hide_percent"] is None else r["hide_percent"],
            "eff_primary_metric": r["primary_metric"] or dash["primary_metric"],
            "sort_order": r["sort_order"],
        }
        if not meta:
            item["missing"] = True
            cards.append(item)
            continue

        item["kind"] = meta["kind"]
        item["options"] = meta["options"]
        item["view"] = r["view"]
        item["option_value"] = r["option_value"]
        # Из какой анкеты вопрос — иначе четыре одинаковых «Готовы выступать
        # спикером?» на дашборде не различить.
        item["survey_title"] = meta.get("survey_title")
        try:
            if r["view"] == "tile":
                item.update(await compute_tile(
                    db, client_id=client_id, source=r["source"], ref_id=r["ref_id"],
                    filters=r["filters"], option=r["option_value"],
                    event_id=dash["event_id"],
                ))
            else:
                item.update(await compute_card(
                    db, client_id=client_id, source=r["source"], ref_id=r["ref_id"],
                    filters=r["filters"], event_id=dash["event_id"], meta=meta,
                ))
        except Exception as e:                      # noqa: BLE001
            # Один битый квадратик не должен обрушить весь дашборд.
            item["error"] = str(e)[:200]
        cards.append(item)

    # ⚠️ Строка-итог наверху: «в базе N · ответили M». Без неё непонятно, ОТ
    # ЧЕГО считается процент на плитке — «49.4%» висит в воздухе.
    # `answered` берём максимальный по квадратикам: у одного дашборда обычно
    # один разрез, а если их несколько — показываем самый полный охват.
    if dash["event_id"]:
        base_total = await db.fetchval(
            """SELECT COUNT(*) FROM contacts c
                WHERE c.client_id = $1 AND c.is_active = TRUE
                  AND EXISTS (SELECT 1 FROM event_participants ep
                               WHERE ep.contact_id = c.id AND ep.event_id = $2)""",
            client_id, dash["event_id"],
        ) or 0
    else:
        base_total = await db.fetchval(
            "SELECT COUNT(*) FROM contacts WHERE client_id = $1 AND is_active = TRUE",
            client_id,
        ) or 0

    answered_vals = [c.get("answered") or 0 for c in cards if not c.get("missing")]
    scope_vals = [c.get("scope") or 0 for c in cards if c.get("scope") is not None]

    return {
        "dashboard": dash,
        "cards": cards,
        "totals": {
            "base_total": base_total,                       # всего в базе
            "scope": max(scope_vals) if scope_vals else base_total,  # после условий
            "answered": max(answered_vals) if answered_vals else 0,  # знаменатель %
        },
    }


@router.get("/dashboards/{dashboard_id}/cards/{card_id}/people",
            summary="Кто эти люди — за цифрой в квадратике")
async def card_people_list(
    dashboard_id: int, card_id: int,
    option: Optional[str] = Query(default=None, description="Конкретный вариант ответа"),
    limit: int = Query(default=200), offset: int = Query(default=0),
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Список людей за цифрой. Считается ТЕМИ ЖЕ правилами, что и сама цифра."""
    client_id = int(client["sub"])
    dash = await _get_dashboard(db, dashboard_id, client_id)
    row = await db.fetchrow(
        "SELECT * FROM analytics_cards WHERE id = $1 AND dashboard_id = $2",
        card_id, dashboard_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Квадратик не найден")

    return await card_people(
        db, client_id=client_id, source=row["source"], ref_id=row["ref_id"],
        filters=row["filters"], event_id=dash["event_id"], option=option,
        limit=limit, offset=offset,
    )


@router.get("/dashboards/{dashboard_id}/cards/{card_id}/people.csv",
            summary="Выгрузить этих людей в CSV")
async def card_people_csv(
    dashboard_id: int, card_id: int,
    option: Optional[str] = Query(default=None),
    client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    dash = await _get_dashboard(db, dashboard_id, client_id)
    row = await db.fetchrow(
        "SELECT * FROM analytics_cards WHERE id = $1 AND dashboard_id = $2",
        card_id, dashboard_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Квадратик не найден")

    data = await card_people(
        db, client_id=client_id, source=row["source"], ref_id=row["ref_id"],
        filters=row["filters"], event_id=dash["event_id"], option=option,
        limit=5000,
    )

    # ⚠️ Разделитель «;» и BOM — иначе Excel открывает кириллицу кракозябрами
    # и сваливает всё в один столбец (как в остальных выгрузках проекта).
    out = io.StringIO()
    out.write("﻿")
    w = csv.writer(out, delimiter=";")
    w.writerow(["ID", "Имя", "Email", "Телефон", "Telegram"])
    for p in data["people"]:
        w.writerow([p["id"], p["name"] or "", p["email"] or "",
                    p["phone"] or "", ("@" + p["telegram"]) if p["telegram"] else ""])

    return Response(
        content=out.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="people-{card_id}.csv"'},
    )


@router.post("/dashboards/{dashboard_id}/cards", summary="Добавить квадратик")
async def create_card(
    dashboard_id: int, data: CardIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)

    sources = await resolve_sources(db, client_id)
    source = "question" if data.source == "question" else "field"
    if f"{source}:{data.ref_id}" not in sources:
        raise HTTPException(status_code=400, detail="Разрез не найден")

    row = await db.fetchrow(
        """INSERT INTO analytics_cards
             (dashboard_id, source, ref_id, title, filters,
              hide_absolute, hide_percent, view, option_value, survey_id, sort_order)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,
                   COALESCE((SELECT MAX(sort_order) + 10 FROM analytics_cards
                              WHERE dashboard_id = $1), 0))
           RETURNING *""",
        dashboard_id, source, data.ref_id, (data.title or "").strip() or None,
        json.dumps(data.filters or {}),
        # NULL = «как на дашборде» (см. update_card).
        data.hide_absolute, data.hide_percent,
        "tile" if data.view == "tile" else "list",
        data.option_value,
        sources[f"{source}:{data.ref_id}"].get("survey_id"),
    )
    return dict(row)


@router.patch("/dashboards/{dashboard_id}/cards/{card_id}", summary="Изменить квадратик")
async def update_card(
    dashboard_id: int, card_id: int, data: CardIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)

    fs = data.model_fields_set
    sets, params = [], []

    def _add(sql: str, val: Any) -> None:
        params.append(val)
        sets.append(sql.format(i=len(params)))

    if "title" in fs:
        _add("title = ${i}", (data.title or "").strip() or None)
    if "filters" in fs:
        _add("filters = ${i}::jsonb", json.dumps(data.filters or {}))
    # ⚠️ NULL здесь осмысленный — «как на дашборде». bool() превратил бы его
    # в False («показывать»), и общая настройка перестала бы действовать.
    if "hide_absolute" in fs:
        _add("hide_absolute = ${i}",
             None if data.hide_absolute is None else bool(data.hide_absolute))
    if "hide_percent" in fs:
        _add("hide_percent = ${i}",
             None if data.hide_percent is None else bool(data.hide_percent))
    if "primary_metric" in fs:
        _add("primary_metric = ${i}",
             data.primary_metric if data.primary_metric in ("count", "percent") else None)
    if "ref_id" in fs:
        _add("ref_id = ${i}", data.ref_id)
    if "source" in fs:
        _add("source = ${i}", "question" if data.source == "question" else "field")

    if not sets:
        return {"ok": True}

    params.extend([card_id, dashboard_id])
    row = await db.fetchrow(
        f"""UPDATE analytics_cards SET {', '.join(sets)}, updated_at = NOW()
             WHERE id = ${len(params) - 1} AND dashboard_id = ${len(params)}
             RETURNING *""",
        *params,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Квадратик не найден")
    return dict(row)


@router.delete("/dashboards/{dashboard_id}/cards/{card_id}", summary="Удалить квадратик")
async def delete_card(
    dashboard_id: int, card_id: int,
    client=Depends(get_current_client), db=Depends(get_db),
):
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)
    await db.execute(
        "DELETE FROM analytics_cards WHERE id = $1 AND dashboard_id = $2",
        card_id, dashboard_id,
    )
    return {"ok": True}


@router.post("/dashboards/{dashboard_id}/cards/reorder", summary="Порядок квадратиков")
async def reorder_cards(
    dashboard_id: int, data: dict,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Перетаскивание. Шаг 10 — чтобы можно было вставить между."""
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)

    ids = data.get("ids") or []
    async with db.transaction():
        for i, cid in enumerate(ids):
            await db.execute(
                """UPDATE analytics_cards SET sort_order = $1, updated_at = NOW()
                    WHERE id = $2 AND dashboard_id = $3""",
                i * 10, int(cid), dashboard_id,
            )
    return {"ok": True}


@router.post("/dashboards/{dashboard_id}/autofill", summary="Добавить квадратики по выбранным полям")
async def autofill(
    dashboard_id: int, data: dict | None = None,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Добавляет квадратики пачкой.

    ⚠️ `keys` — какие именно разрезы добавить ('field:3', 'question:24').
    Клиент выбирает поля сам галочками: «а можно нагенерить сразу по полям».
    Без `keys` берём все подходящие — но UI так больше не делает: без выбора
    натаскивалось 30 квадратиков подряд, включая числовые с бесполезной
    россыпью «21 — 1 человек, 22 — 1 человек».

    Уже добавленные разрезы пропускаем — повторный вызов не плодит дубли.
    """
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)

    wanted = (data or {}).get("keys")
    wanted_set = {str(k) for k in wanted} if isinstance(wanted, list) else None
    view = "tile" if (data or {}).get("view") == "tile" else "list"

    sources = await resolve_sources(db, client_id)
    # Дубли ловим по (разрез + вид + вариант): у плиток на один разрез
    # приходится несколько строк, по одной на вариант.
    existing = {
        (f"{r['source']}:{r['ref_id']}", r["view"], r["option_value"])
        for r in await db.fetch(
            """SELECT source, ref_id, view, option_value
                 FROM analytics_cards WHERE dashboard_id = $1""",
            dashboard_id,
        )
    }

    base = await db.fetchval(
        "SELECT COALESCE(MAX(sort_order), 0) FROM analytics_cards WHERE dashboard_id = $1",
        dashboard_id,
    ) or 0

    added = 0
    async with db.transaction():
        for key, meta in sources.items():
            if wanted_set is not None:
                if key not in wanted_set:
                    continue
            elif meta["kind"] not in AUTO_KINDS:
                continue

            # ⚠️ Плитки: по квадратику на КАЖДЫЙ вариант — это и есть
            # «квадратик с цифрой» из GetCourse. У «да/нет» вариантов в
            # options нет, подставляем их явно; у числовых плитки не имеют
            # смысла (значений десятки) — там остаётся список.
            if view == "tile":
                opts = meta["options"] or (["Да", "Нет"] if meta["kind"] == "bool" else [])
                if not opts:
                    if (key, "list", None) in existing:
                        continue
                    added += 1
                    await db.execute(
                        """INSERT INTO analytics_cards
                             (dashboard_id, source, ref_id, sort_order, view, survey_id)
                           VALUES ($1,$2,$3,$4,'list',$5)""",
                        dashboard_id, meta["source"], meta["ref_id"],
                        base + added * 10, meta.get("survey_id"),
                    )
                    continue
                for opt in opts:
                    if (key, "tile", opt) in existing:
                        continue
                    added += 1
                    await db.execute(
                        """INSERT INTO analytics_cards
                             (dashboard_id, source, ref_id, sort_order,
                              view, option_value, survey_id)
                           VALUES ($1,$2,$3,$4,'tile',$5,$6)""",
                        dashboard_id, meta["source"], meta["ref_id"],
                        base + added * 10, opt, meta.get("survey_id"),
                    )
            else:
                if (key, "list", None) in existing:
                    continue
                added += 1
                await db.execute(
                    """INSERT INTO analytics_cards
                         (dashboard_id, source, ref_id, sort_order, view, survey_id)
                       VALUES ($1,$2,$3,$4,'list',$5)""",
                    dashboard_id, meta["source"], meta["ref_id"],
                    base + added * 10, meta.get("survey_id"),
                )

    return {"ok": True, "added": added}
