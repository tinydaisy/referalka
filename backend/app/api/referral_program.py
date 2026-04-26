"""
Реф-программа события — вкладка внутри карточки события.

Включает:
- Афиши события (event_posters)
- Настройки реф-программы (event_referral_settings: welcome_text, share_text)
- Пороги-подарки (event_referral_thresholds: 1/3/10 → лид-магнит + сертификат)
- Материалы для шеринга (event_referral_materials: картинки)
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/events/{event_id}", tags=["Реф-программа"])


# ──────────────────────────────────────────────
# ИМПОРТ РЕФ-ПРОГРАММЫ ИЗ ДРУГОГО СОБЫТИЯ
# ──────────────────────────────────────────────

class ImportFromIn(BaseModel):
    from_event_id: int


@router.post("/referral/import", summary="Импортировать реф-программу из другого события клиента")
async def import_referral_program(
    event_id: int,
    data: ImportFromIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    # Проверяем что и источник, и приёмник принадлежат клиенту
    src = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", data.from_event_id, client_id
    )
    if not src:
        raise HTTPException(status_code=404, detail="Событие-источник не найдено")
    dst = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not dst:
        raise HTTPException(status_code=404, detail="Событие-приёмник не найдено")
    if data.from_event_id == event_id:
        raise HTTPException(status_code=400, detail="Источник и приёмник совпадают")

    async with db.transaction():
        # Удаляем текущие настройки/пороги/материалы у приёмника
        await db.execute("DELETE FROM event_referral_settings WHERE event_id = $1", event_id)
        await db.execute("DELETE FROM event_referral_thresholds WHERE event_id = $1", event_id)
        await db.execute("DELETE FROM event_referral_materials WHERE event_id = $1", event_id)

        # settings (если есть)
        srs = await db.fetchrow(
            "SELECT welcome_text, share_text FROM event_referral_settings WHERE event_id = $1",
            data.from_event_id
        )
        if srs:
            await db.execute(
                """INSERT INTO event_referral_settings (event_id, welcome_text, share_text)
                   VALUES ($1, $2, $3)""",
                event_id, srs['welcome_text'], srs['share_text']
            )
        # thresholds
        thresholds = await db.fetch(
            "SELECT * FROM event_referral_thresholds WHERE event_id = $1",
            data.from_event_id
        )
        for t in thresholds:
            await db.execute(
                """INSERT INTO event_referral_thresholds
                     (event_id, threshold_count, lead_magnet_id, certificate_url, gift_template_text, sort)
                   VALUES ($1,$2,$3,$4,$5,$6)""",
                event_id, t['threshold_count'], t['lead_magnet_id'],
                t['certificate_url'], t['gift_template_text'], t['sort']
            )
        # materials — без поссылки на чужие event_posters; всё переводим в source='custom'
        materials = await db.fetch(
            "SELECT image_url, sort FROM event_referral_materials WHERE event_id = $1 ORDER BY id",
            data.from_event_id
        )
        for m in materials:
            await db.execute(
                """INSERT INTO event_referral_materials (event_id, image_url, source, source_poster_id, sort)
                   VALUES ($1, $2, 'custom', NULL, $3)""",
                event_id, m['image_url'], m['sort']
            )

    return {"ok": True, "thresholds": len(thresholds), "materials": len(materials), "settings": srs is not None}


# ──────────────────────────────────────────────
# СОБЫТИЯ-ИСТОЧНИКИ ДЛЯ ИМПОРТА
# ──────────────────────────────────────────────

@router.get("/referral/import-sources", summary="События клиента у которых есть реф-программа (для импорта)")
async def list_import_sources(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT e.id, e.title, e.module_slug,
                  (SELECT COUNT(*) FROM event_referral_thresholds WHERE event_id = e.id) AS thresholds_count
           FROM events e
           WHERE e.client_id = $1
             AND e.id <> $2
             AND (
               EXISTS (SELECT 1 FROM event_referral_thresholds WHERE event_id = e.id) OR
               EXISTS (SELECT 1 FROM event_referral_materials WHERE event_id = e.id) OR
               EXISTS (SELECT 1 FROM event_referral_settings WHERE event_id = e.id)
             )
           ORDER BY e.created_at DESC""",
        client_id, event_id
    )
    return {"items": [dict(r) for r in rows]}


async def _check_event_owned(event_id: int, client_id: int, db: asyncpg.Connection) -> dict:
    event = await db.fetchrow(
        "SELECT id, client_id FROM events WHERE id = $1 AND client_id = $2",
        event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return dict(event)


# ──────────────────────────────────────────────
# АФИШИ СОБЫТИЯ (event_posters)
# ──────────────────────────────────────────────

class PosterIn(BaseModel):
    url: str
    orientation: str = "horizontal"   # 'horizontal' | 'vertical' | 'square'
    sort: int = 0


@router.get("/posters", summary="Список афиш события")
async def list_posters(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        "SELECT id, url, orientation, sort, created_at FROM event_posters WHERE event_id = $1 ORDER BY sort, id",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/posters", summary="Добавить афишу")
async def add_poster(
    event_id: int,
    data: PosterIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    if data.orientation not in ("horizontal", "vertical", "square"):
        raise HTTPException(status_code=400, detail="orientation должен быть 'horizontal', 'vertical' или 'square'")
    row = await db.fetchrow(
        """INSERT INTO event_posters (event_id, url, orientation, sort)
           VALUES ($1, $2, $3, $4)
           RETURNING id, url, orientation, sort, created_at""",
        event_id, data.url, data.orientation, data.sort
    )
    return dict(row)


@router.patch("/posters/{poster_id}", summary="Обновить афишу")
async def update_poster(
    event_id: int, poster_id: int,
    data: PosterIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    row = await db.fetchrow(
        """UPDATE event_posters SET url=$1, orientation=$2, sort=$3
           WHERE id=$4 AND event_id=$5
           RETURNING id, url, orientation, sort, created_at""",
        data.url, data.orientation, data.sort, poster_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Афиша не найдена")
    return dict(row)


@router.delete("/posters/{poster_id}", summary="Удалить афишу")
async def delete_poster(
    event_id: int, poster_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    result = await db.execute(
        "DELETE FROM event_posters WHERE id=$1 AND event_id=$2", poster_id, event_id
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Афиша не найдена")
    return {"ok": True}


# ──────────────────────────────────────────────
# НАСТРОЙКИ РЕФ-ПРОГРАММЫ (event_referral_settings)
# ──────────────────────────────────────────────

class ReferralSettingsIn(BaseModel):
    welcome_text: Optional[str] = None
    share_text:   Optional[str] = None


@router.get("/referral/settings", summary="Получить настройки реф-программы")
async def get_referral_settings(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    row = await db.fetchrow(
        "SELECT welcome_text, share_text FROM event_referral_settings WHERE event_id = $1",
        event_id
    )
    return dict(row) if row else {"welcome_text": None, "share_text": None}


@router.put("/referral/settings", summary="Обновить настройки реф-программы (upsert)")
async def upsert_referral_settings(
    event_id: int,
    data: ReferralSettingsIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    row = await db.fetchrow(
        """INSERT INTO event_referral_settings (event_id, welcome_text, share_text)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id) DO UPDATE
             SET welcome_text = EXCLUDED.welcome_text,
                 share_text   = EXCLUDED.share_text,
                 updated_at   = NOW()
           RETURNING welcome_text, share_text""",
        event_id, data.welcome_text, data.share_text
    )
    return dict(row)


# ──────────────────────────────────────────────
# ПОРОГИ-ПОДАРКИ (event_referral_thresholds)
# ──────────────────────────────────────────────

class ThresholdIn(BaseModel):
    threshold_count:    int                # 1, 3, 10, ...
    lead_magnet_id:     Optional[int] = None
    certificate_url:    Optional[str] = None
    gift_template_text: Optional[str] = None
    sort:               int = 0


@router.get("/referral/thresholds", summary="Список порогов-подарков")
async def list_thresholds(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT t.id, t.threshold_count, t.lead_magnet_id, t.certificate_url,
                  t.gift_template_text, t.sort,
                  lm.name AS lead_magnet_name, lm.url AS lead_magnet_url
           FROM event_referral_thresholds t
           LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
           WHERE t.event_id = $1
           ORDER BY t.threshold_count""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


async def _check_lead_magnet_owned(lead_magnet_id: int, client_id: int, db: asyncpg.Connection):
    if lead_magnet_id is None:
        return
    ok = await db.fetchval(
        "SELECT 1 FROM lead_magnets WHERE id = $1 AND client_id = $2",
        lead_magnet_id, client_id
    )
    if not ok:
        raise HTTPException(status_code=400, detail="Лид-магнит не принадлежит клиенту")


@router.post("/referral/thresholds", summary="Добавить порог-подарок")
async def add_threshold(
    event_id: int,
    data: ThresholdIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event_owned(event_id, client_id, db)
    if data.threshold_count < 1:
        raise HTTPException(status_code=400, detail="threshold_count должен быть >= 1")
    if data.lead_magnet_id:
        await _check_lead_magnet_owned(data.lead_magnet_id, client_id, db)
    try:
        row = await db.fetchrow(
            """INSERT INTO event_referral_thresholds
                 (event_id, threshold_count, lead_magnet_id, certificate_url, gift_template_text, sort)
               VALUES ($1,$2,$3,$4,$5,$6)
               RETURNING id, threshold_count, lead_magnet_id, certificate_url, gift_template_text, sort""",
            event_id, data.threshold_count, data.lead_magnet_id,
            data.certificate_url, data.gift_template_text, data.sort
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=400, detail="Порог с таким количеством уже существует")
    return dict(row)


@router.patch("/referral/thresholds/{threshold_id}", summary="Обновить порог")
async def update_threshold(
    event_id: int, threshold_id: int,
    data: ThresholdIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event_owned(event_id, client_id, db)
    if data.lead_magnet_id:
        await _check_lead_magnet_owned(data.lead_magnet_id, client_id, db)
    row = await db.fetchrow(
        """UPDATE event_referral_thresholds
              SET threshold_count = $1, lead_magnet_id = $2,
                  certificate_url = $3, gift_template_text = $4, sort = $5,
                  updated_at = NOW()
            WHERE id = $6 AND event_id = $7
            RETURNING id, threshold_count, lead_magnet_id, certificate_url, gift_template_text, sort""",
        data.threshold_count, data.lead_magnet_id,
        data.certificate_url, data.gift_template_text, data.sort,
        threshold_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Порог не найден")
    return dict(row)


@router.delete("/referral/thresholds/{threshold_id}", summary="Удалить порог")
async def delete_threshold(
    event_id: int, threshold_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    result = await db.execute(
        "DELETE FROM event_referral_thresholds WHERE id=$1 AND event_id=$2",
        threshold_id, event_id
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Порог не найден")
    return {"ok": True}


# ──────────────────────────────────────────────
# МАТЕРИАЛЫ ДЛЯ ШЕРИНГА (event_referral_materials)
# ──────────────────────────────────────────────

class MaterialIn(BaseModel):
    image_url:        str
    source:           str = "custom"   # 'event_poster' | 'custom'
    source_poster_id: Optional[int] = None
    sort:             int = 0


@router.get("/referral/materials", summary="Список материалов для шеринга")
async def list_materials(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT id, image_url, source, source_poster_id, sort, created_at
           FROM event_referral_materials WHERE event_id = $1 ORDER BY sort, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/referral/materials", summary="Добавить материал")
async def add_material(
    event_id: int,
    data: MaterialIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    if data.source not in ("event_poster", "custom"):
        raise HTTPException(status_code=400, detail="source: 'event_poster' или 'custom'")
    if data.source == "event_poster" and data.source_poster_id:
        ok = await db.fetchval(
            "SELECT 1 FROM event_posters WHERE id = $1 AND event_id = $2",
            data.source_poster_id, event_id
        )
        if not ok:
            raise HTTPException(status_code=400, detail="Афиша не принадлежит этому событию")
    row = await db.fetchrow(
        """INSERT INTO event_referral_materials (event_id, image_url, source, source_poster_id, sort)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, image_url, source, source_poster_id, sort, created_at""",
        event_id, data.image_url, data.source, data.source_poster_id, data.sort
    )
    return dict(row)


@router.delete("/referral/materials/{material_id}", summary="Удалить материал")
async def delete_material(
    event_id: int, material_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    result = await db.execute(
        "DELETE FROM event_referral_materials WHERE id=$1 AND event_id=$2",
        material_id, event_id
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Материал не найден")
    return {"ok": True}
