"""API дашбордов аналитики — наборы квадратиков-разрезов.

Два входа, ОДИН движок:
  • раздел «Аналитика»                → дашборды клиента (event_id IS NULL)
  • карточка события → «Отслеживания» → дашборды события (event_id = N)

У событийного ко всем квадратикам молча добавляется условие «контакт —
участник этого события»; в остальном логика та же.

⚠️ Дашбордов у клиента МНОГО (решение владельца) — «Портрет базы», «Кто
готов покупать» и т.п. Поэтому это список, а не единственная запись.
"""
import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.analytics_cards import (
    AUTO_KINDS,
    OPERATORS_BY_KIND,
    compute_card,
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


class CardIn(BaseModel):
    source: str = "field"
    ref_id: int
    title: Optional[str] = None
    filters: Optional[Any] = None
    hide_absolute: Optional[bool] = None
    hide_percent: Optional[bool] = None


# ── Справочник разрезов ───────────────────────────────────────────────────
@router.get("/sources", summary="Доступные разрезы: поля контакта и вопросы анкет")
async def list_sources(client=Depends(get_current_client), db=Depends(get_db)):
    """Чем можно резать базу и какие операторы у каждого типа.

    ⚠️ Отдаём ОБА источника — поля контакта и вопросы анкет. У клиента
    вопросы анкет обычно не привязаны к полям (`field_id IS NULL`), и без
    них нечем было бы пересекать «доход × готовность к наставнику».
    """
    client_id = int(client["sub"])
    sources = await resolve_sources(db, client_id)
    items = list(sources.values())
    for it in items:
        it["key"] = f"{it['source']}:{it['ref_id']}"
        it["operators"] = OPERATORS_BY_KIND.get(it["kind"], ["filled", "empty"])
        it["auto"] = it["kind"] in AUTO_KINDS
    return {"sources": items}


# ── Дашборды ──────────────────────────────────────────────────────────────
@router.get("/dashboards", summary="Список дашбордов")
async def list_dashboards(
    event_id: Optional[int] = Query(default=None),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    client_id = int(client["sub"])
    if event_id:
        await _assert_owns_event(db, event_id, client_id)
        rows = await db.fetch(
            """SELECT * FROM analytics_dashboards
                WHERE client_id = $1 AND event_id = $2
                ORDER BY sort_order, id""",
            client_id, event_id,
        )
    else:
        rows = await db.fetch(
            """SELECT * FROM analytics_dashboards
                WHERE client_id = $1 AND event_id IS NULL
                ORDER BY sort_order, id""",
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

    title = (data.title or "").strip() or "Дашборд"
    row = await db.fetchrow(
        """INSERT INTO analytics_dashboards (client_id, event_id, title, sort_order)
           VALUES ($1, $2, $3,
                   COALESCE((SELECT MAX(sort_order) + 10 FROM analytics_dashboards
                              WHERE client_id = $1
                                AND event_id IS NOT DISTINCT FROM $2), 0))
           RETURNING *""",
        client_id, data.event_id, title,
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

    if "title" in data.model_fields_set:
        await db.execute(
            """UPDATE analytics_dashboards
                  SET title = $1, updated_at = NOW() WHERE id = $2""",
            (data.title or "").strip() or "Дашборд", dashboard_id,
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
            "hide_absolute": r["hide_absolute"], "hide_percent": r["hide_percent"],
            "sort_order": r["sort_order"],
        }
        if not meta:
            item["missing"] = True
            cards.append(item)
            continue

        item["kind"] = meta["kind"]
        item["options"] = meta["options"]
        try:
            item.update(await compute_card(
                db, client_id=client_id, source=r["source"], ref_id=r["ref_id"],
                filters=r["filters"], event_id=dash["event_id"], meta=meta,
            ))
        except Exception as e:                      # noqa: BLE001
            # Один битый квадратик не должен обрушить весь дашборд.
            item["error"] = str(e)[:200]
        cards.append(item)

    return {"dashboard": dash, "cards": cards}


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
              hide_absolute, hide_percent, sort_order)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,
                   COALESCE((SELECT MAX(sort_order) + 10 FROM analytics_cards
                              WHERE dashboard_id = $1), 0))
           RETURNING *""",
        dashboard_id, source, data.ref_id, (data.title or "").strip() or None,
        json.dumps(data.filters or {}),
        bool(data.hide_absolute), bool(data.hide_percent),
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
    if "hide_absolute" in fs:
        _add("hide_absolute = ${i}", bool(data.hide_absolute))
    if "hide_percent" in fs:
        _add("hide_percent = ${i}", bool(data.hide_percent))
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


@router.post("/dashboards/{dashboard_id}/autofill", summary="Собрать квадратики автоматически")
async def autofill(
    dashboard_id: int, client=Depends(get_current_client), db=Depends(get_db),
):
    """Создаёт квадратики по всем подходящим разрезам разом.

    ⚠️ Только выпадающие списки и числовые (решение владельца): у свободного
    текста почти все ответы уникальны, полоски по одному человеку — мусор.

    Уже добавленные разрезы пропускаем — повторный вызов не плодит дубли.
    """
    client_id = int(client["sub"])
    if await assistant_is_restricted(client):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    await _assert_feature(db, client_id)
    await _get_dashboard(db, dashboard_id, client_id)

    sources = await resolve_sources(db, client_id)
    existing = {
        f"{r['source']}:{r['ref_id']}"
        for r in await db.fetch(
            "SELECT source, ref_id FROM analytics_cards WHERE dashboard_id = $1",
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
            if key in existing or meta["kind"] not in AUTO_KINDS:
                continue
            added += 1
            await db.execute(
                """INSERT INTO analytics_cards
                     (dashboard_id, source, ref_id, sort_order)
                   VALUES ($1, $2, $3, $4)""",
                dashboard_id, meta["source"], meta["ref_id"], base + added * 10,
            )

    return {"ok": True, "added": added}
