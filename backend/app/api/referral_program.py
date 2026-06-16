"""
Реф-программа события — вкладка внутри карточки события.

Включает:
- Афиши события (event_posters)
- Настройки реф-программы (event_referral_settings: gift_count_mode, is_enabled)
- Пороги-подарки (event_referral_thresholds: 1/3/10 → лид-магнит + сертификат)
- Материалы для шеринга:
    - картинки (event_referral_materials)
    - тексты-примеры (event_referral_share_texts) — миграция 059
- Тексты-анонсы события (event_announcement_texts, миграция 112) — для спикеров
  и партнёров. Отличаются от share_texts: те — «зови друзей за подарки»
  (аудитория = участник), эти — «анонсируй событие подписчикам»
  (аудитория = аудитория спикера/партнёра).
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List
from datetime import timezone, timedelta
import io
import re
import zipfile
import asyncio
import httpx
from app.auth import get_current_client
from app.database import get_db
from app.config import settings
from app.services.r2_storage import key_from_url, get_r2_client
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
        "SELECT id FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')", data.from_event_id, client_id
    )
    if not src:
        raise HTTPException(status_code=404, detail="Событие-источник не найдено")
    dst = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')", event_id, client_id
    )
    if not dst:
        raise HTTPException(status_code=404, detail="Событие-приёмник не найдено")
    if data.from_event_id == event_id:
        raise HTTPException(status_code=400, detail="Источник и приёмник совпадают")

    async with db.transaction():
        # Удаляем текущие настройки/пороги/материалы/тексты у приёмника
        await db.execute("DELETE FROM event_referral_settings    WHERE event_id = $1", event_id)
        await db.execute("DELETE FROM event_referral_thresholds  WHERE event_id = $1", event_id)
        await db.execute("DELETE FROM event_referral_materials   WHERE event_id = $1", event_id)
        await db.execute("DELETE FROM event_referral_share_texts WHERE event_id = $1", event_id)

        # settings (если есть)
        srs = await db.fetchrow(
            "SELECT gift_count_mode, is_enabled FROM event_referral_settings WHERE event_id = $1",
            data.from_event_id
        )
        if srs:
            await db.execute(
                """INSERT INTO event_referral_settings (event_id, gift_count_mode, is_enabled)
                   VALUES ($1, $2, $3)""",
                event_id, srs['gift_count_mode'], srs['is_enabled']
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
        # materials — без ссылки на чужие event_posters; всё переводим в source='custom'
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
        # share texts
        share_texts = await db.fetch(
            "SELECT content, sort FROM event_referral_share_texts WHERE event_id = $1 ORDER BY sort, id",
            data.from_event_id
        )
        for st in share_texts:
            await db.execute(
                """INSERT INTO event_referral_share_texts (event_id, content, sort)
                   VALUES ($1, $2, $3)""",
                event_id, st['content'], st['sort']
            )

    return {
        "ok": True,
        "thresholds":  len(thresholds),
        "materials":   len(materials),
        "share_texts": len(share_texts),
        "settings":    srs is not None,
    }


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
           WHERE EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=$1 AND eo.status='accepted')
             AND e.id <> $2
             AND (
               EXISTS (SELECT 1 FROM event_referral_thresholds   WHERE event_id = e.id) OR
               EXISTS (SELECT 1 FROM event_referral_materials    WHERE event_id = e.id) OR
               EXISTS (SELECT 1 FROM event_referral_share_texts  WHERE event_id = e.id) OR
               EXISTS (SELECT 1 FROM event_referral_settings     WHERE event_id = e.id)
             )
           ORDER BY e.created_at DESC""",
        client_id, event_id
    )
    return {"items": [dict(r) for r in rows]}


async def _check_event_owned(event_id: int, client_id: int, db: asyncpg.Connection) -> dict:
    event = await db.fetchrow(
        "SELECT id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
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
    # 'registered' | 'visited' | 'clicked_link' (миграции 042, 082)
    gift_count_mode: Optional[str]  = None
    is_enabled:      Optional[bool] = None   # вкл/выкл вкладки «Игра» в Mini App (миграция 053)


@router.get("/referral/settings", summary="Получить настройки реф-программы")
async def get_referral_settings(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    row = await db.fetchrow(
        "SELECT gift_count_mode, is_enabled FROM event_referral_settings WHERE event_id = $1",
        event_id
    )
    if row:
        return dict(row)
    return {"gift_count_mode": "registered", "is_enabled": False}


@router.put("/referral/settings", summary="Обновить настройки реф-программы (upsert)")
async def upsert_referral_settings(
    event_id: int,
    data: ReferralSettingsIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    mode = data.gift_count_mode or "registered"
    if mode not in ("registered", "visited", "clicked_link"):
        raise HTTPException(400, "gift_count_mode must be 'registered', 'visited' or 'clicked_link'")
    is_enabled = bool(data.is_enabled) if data.is_enabled is not None else False
    row = await db.fetchrow(
        """INSERT INTO event_referral_settings (event_id, gift_count_mode, is_enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id) DO UPDATE
             SET gift_count_mode = EXCLUDED.gift_count_mode,
                 is_enabled      = EXCLUDED.is_enabled,
                 updated_at      = NOW()
           RETURNING gift_count_mode, is_enabled""",
        event_id, mode, is_enabled
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
    # owner_name/owner_client_id — чей это подарок (через лид-магнит → его клиент).
    # Нужно для пометки «чей подарок» в дашборде коллаб-события. У обычного события
    # и в Mini App участника пометка не показывается (решает фронт по is_collab).
    rows = await db.fetch(
        """SELECT t.id, t.threshold_count, t.lead_magnet_id, t.certificate_url,
                  t.gift_template_text, t.sort,
                  lm.name AS lead_magnet_name, lm.url AS lead_magnet_url,
                  lm.client_id AS owner_client_id,
                  COALESCE(oc.brand_name, oc.name) AS owner_name
           FROM event_referral_thresholds t
           LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
           LEFT JOIN clients oc ON oc.id = lm.client_id
           WHERE t.event_id = $1
           ORDER BY t.threshold_count""",
        event_id
    )
    from app.services.event_access import is_collab_event
    is_collab = await is_collab_event(db, event_id)
    return {"items": [dict(r) for r in rows], "is_collab": is_collab}


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
    if data.threshold_count < 0:
        raise HTTPException(status_code=400, detail="threshold_count должен быть >= 0")
    if data.lead_magnet_id:
        await _check_lead_magnet_owned(data.lead_magnet_id, client_id, db)
    row = await db.fetchrow(
        """INSERT INTO event_referral_thresholds
             (event_id, threshold_count, lead_magnet_id, certificate_url, gift_template_text, sort)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, threshold_count, lead_magnet_id, certificate_url, gift_template_text, sort""",
        event_id, data.threshold_count, data.lead_magnet_id,
        data.certificate_url, data.gift_template_text, data.sort
    )
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
    if data.threshold_count < 0:
        raise HTTPException(status_code=400, detail="Количество приведённых должно быть 0 или больше")
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


# ──────────────────────────────────────────────
# ТЕКСТЫ-ПРИМЕРЫ ДЛЯ ШЕРИНГА (event_referral_share_texts)
# ──────────────────────────────────────────────

class ShareTextIn(BaseModel):
    content: str
    sort:    int = 0


@router.get("/referral/share-texts", summary="Список текстов для шеринга")
async def list_share_texts(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT id, content, sort, created_at, updated_at
           FROM event_referral_share_texts WHERE event_id = $1
           ORDER BY sort, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/referral/share-texts", summary="Добавить текст-пример")
async def add_share_text(
    event_id: int,
    data: ShareTextIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    content = (data.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Текст не может быть пустым")
    row = await db.fetchrow(
        """INSERT INTO event_referral_share_texts (event_id, content, sort)
           VALUES ($1, $2, $3)
           RETURNING id, content, sort, created_at, updated_at""",
        event_id, content, data.sort
    )
    return dict(row)


@router.patch("/referral/share-texts/{text_id}", summary="Обновить текст-пример")
async def update_share_text(
    event_id: int, text_id: int,
    data: ShareTextIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    content = (data.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Текст не может быть пустым")
    row = await db.fetchrow(
        """UPDATE event_referral_share_texts
              SET content = $1, sort = $2, updated_at = NOW()
            WHERE id = $3 AND event_id = $4
            RETURNING id, content, sort, created_at, updated_at""",
        content, data.sort, text_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Текст не найден")
    return dict(row)


@router.delete("/referral/share-texts/{text_id}", summary="Удалить текст-пример")
async def delete_share_text(
    event_id: int, text_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    result = await db.execute(
        "DELETE FROM event_referral_share_texts WHERE id=$1 AND event_id=$2",
        text_id, event_id
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Текст не найден")
    return {"ok": True}


# ──────────────────────────────────────────────
# ТЕКСТЫ-АНОНСЫ СОБЫТИЯ (event_announcement_texts) — миграция 112
# Назначение: готовые тексты, которые СПИКЕР/ПАРТНЁР копирует и шлёт
# своей аудитории, чтобы анонсировать событие. Отдельная от share_texts
# сущность — другая аудитория и другие плейсхолдеры.
# ──────────────────────────────────────────────

class AnnouncementTextIn(BaseModel):
    content: str
    sort:    int = 0


@router.get("/announcement-texts", summary="Список текстов-анонсов события")
async def list_announcement_texts(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT id, content, sort, created_at, updated_at
           FROM event_announcement_texts WHERE event_id = $1
           ORDER BY sort, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/announcement-texts", summary="Добавить текст-анонс")
async def add_announcement_text(
    event_id: int,
    data: AnnouncementTextIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    content = (data.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Текст не может быть пустым")
    row = await db.fetchrow(
        """INSERT INTO event_announcement_texts (event_id, content, sort)
           VALUES ($1, $2, $3)
           RETURNING id, content, sort, created_at, updated_at""",
        event_id, content, data.sort
    )
    return dict(row)


@router.patch("/announcement-texts/{text_id}", summary="Обновить текст-анонс")
async def update_announcement_text(
    event_id: int, text_id: int,
    data: AnnouncementTextIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    content = (data.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Текст не может быть пустым")
    row = await db.fetchrow(
        """UPDATE event_announcement_texts
              SET content = $1, sort = $2, updated_at = NOW()
            WHERE id = $3 AND event_id = $4
            RETURNING id, content, sort, created_at, updated_at""",
        content, data.sort, text_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Текст не найден")
    return dict(row)


@router.delete("/announcement-texts/{text_id}", summary="Удалить текст-анонс")
async def delete_announcement_text(
    event_id: int, text_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    result = await db.execute(
        "DELETE FROM event_announcement_texts WHERE id=$1 AND event_id=$2",
        text_id, event_id
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Текст не найден")
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
# ЭКСПОРТ МАТЕРИАЛОВ ДЛЯ СПИКЕРОВ / ЖЮРИ (ZIP-архив)
# ══════════════════════════════════════════════════════════════════
#
# Кнопка «МАТЕРИАЛЫ ДЛЯ СПИКЕРОВ» (конференция/турнир) или «МАТЕРИАЛЫ ДЛЯ
# ЖЮРИ» (премия) на вкладке «Афиши» дашборда. Собирает в один ZIP:
#   • Реферальные ссылки.txt — на каждого коллаба: имя + TG + ВК (через
#     двойной перенос), коллабы разделены строкой-разделителем.
#   • Тексты для анонсов/Анонс N.txt — все тексты-анонсы события
#     (плейсхолдеры {event}/{date}/{brand} подставлены, {link} оставлен —
#     он персональный, лежит в «Реферальных ссылках»).
#   • Афиши/<Ориентация>.<ext> — афиши события (event_posters) в корне.
#   • Афиши/Индивидуальные афиши/Имя_Фамилия.<ext> — афиши коллабов,
#     отмеченные «для анонсов» (event_collaborators.announcement_poster_ids).
#   • Кодовые слова для розыгрыша.txt — если розыгрыш включён.
#
# Кого включаем зависит от типа события:
#   • премия (awards)        → роли jury + organizer
#   • конференция/турнир/др. → роли organizer + speaker + headliner

_MSK = timezone(timedelta(hours=3))

_ORIENTATION_RU = {
    "horizontal": "Горизонтальная афиша",
    "vertical":   "Вертикальная афиша",
    "square":     "Квадратная афиша",
}


def _is_jury_module(module_slug: Optional[str]) -> bool:
    # «Премии/Турниры» (module_slug='turnir', историч. 'awards') — там роли
    # по умолчанию «жюри». Конференция — «спикеры».
    return module_slug in ("awards", "turnir")


def _export_roles(module_slug: Optional[str]) -> list[str]:
    if _is_jury_module(module_slug):
        return ["jury", "organizer"]
    return ["organizer", "speaker", "headliner"]


def _safe_filename(name: Optional[str]) -> str:
    """Безопасное имя файла: режем спецсимволы ФС, пробелы → подчёркивание.
    Кириллицу сохраняем (ZIP пишется в UTF-8)."""
    name = (name or "").strip()
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "", name)
    name = re.sub(r"\s+", "_", name)
    return name or "Без_имени"


def _ext_from_url(url: Optional[str], default: str = "jpg") -> str:
    path = (url or "").split("?")[0].split("#")[0].rstrip("/")
    base = path.rsplit("/", 1)[-1]
    if "." in base:
        ext = base.rsplit(".", 1)[-1].lower()
        if 1 <= len(ext) <= 5 and ext.isalnum():
            return ext
    return default


def _fmt_event_date_msk(start_at) -> str:
    if not start_at:
        return ""
    dt = start_at
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_MSK).strftime("%d.%m.%Y %H:%M") + " МСК"


async def _download_file_bytes(url: Optional[str]) -> Optional[bytes]:
    """Качает файл из R2 (по ключу через boto3) с fallback на обычный HTTP."""
    if not url:
        return None
    key = key_from_url(url)
    if key:
        try:
            r2 = get_r2_client()
            loop = asyncio.get_event_loop()
            obj = await loop.run_in_executor(
                None,
                lambda: r2.get_object(Bucket=settings.cf_r2_bucket_name, Key=key),
            )
            return obj["Body"].read()
        except Exception:
            pass
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as hc:
            resp = await hc.get(url)
            if resp.status_code == 200:
                return resp.content
    except Exception:
        return None
    return None


@router.get("/materials-export", summary="ZIP-архив материалов для спикеров/жюри")
async def export_speaker_materials(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    ev = await db.fetchrow(
        """SELECT id, slug, title, $2::int AS client_id, module_slug, start_at, link_mode
             FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')""",
        event_id, client_id,
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    brand = await db.fetchval(
        "SELECT COALESCE(NULLIF(brand_name, ''), name) FROM clients WHERE id = $1",
        client_id,
    )
    roles = _export_roles(ev["module_slug"])

    # ── Коллабораторы нужных ролей (с реф-кодом) ──
    from app.services import collaborator_sort
    from app.api.modules.conference import ensure_collaborator_contact
    from app.services.share_links import build_share_links

    rows = await db.fetch(
        f"""SELECT ec.id AS ec_id, ec.role, ec.announcement_poster_ids,
                   co.id AS collaborator_id, co.name, ctc.ref_code
              FROM event_collaborators ec
              JOIN collaborators co  ON co.id = ec.speaker_id
         LEFT JOIN contacts ctc      ON ctc.id = co.contact_id
             WHERE ec.event_id = $1
               AND ec.role = ANY($2::text[])
             ORDER BY {collaborator_sort.order_by_sql("ec")}""",
        event_id, roles,
    )
    collabs = []
    for r in rows:
        d = dict(r)
        if not d.get("ref_code"):
            try:
                d["ref_code"] = await ensure_collaborator_contact(d["collaborator_id"], db)
            except Exception:
                d["ref_code"] = None
        collabs.append(d)

    # ── 1. Реферальные ссылки.txt ──
    blocks = []
    for c in collabs:
        ref_code = c.get("ref_code")
        links = {}
        if ref_code:
            try:
                links = await build_share_links(
                    db, client_id=client_id, event_slug=ev["slug"], partner_id=ref_code,
                    link_mode=ev["link_mode"] or "miniapp",
                )
            except Exception:
                links = {}
        lines = [c["name"] or "Без имени"]
        if links.get("telegram"):
            lines.append(f"Телеграм: {links['telegram']}")
        if links.get("vk"):
            lines.append(f"Без ВПН через ВК: {links['vk']}")
        blocks.append("\n\n".join(lines))
    separator = "\n\n" + ("—" * 30) + "\n\n"
    ref_doc = separator.join(blocks) if blocks else "Нет коллабораторов с реф-ссылками."

    # ── 2. Тексты для анонсов ──
    texts = await db.fetch(
        "SELECT content FROM event_announcement_texts WHERE event_id = $1 ORDER BY sort, id",
        event_id,
    )
    subst = {
        "{event}": ev["title"] or "",
        "{date}":  _fmt_event_date_msk(ev["start_at"]),
        "{brand}": brand or "",
    }

    def _apply_placeholders(t: Optional[str]) -> str:
        t = t or ""
        for k, v in subst.items():
            t = t.replace(k, v)
        return t

    # ── 3. Афиши события ──
    posters = await db.fetch(
        """SELECT url, orientation FROM event_posters
            WHERE event_id = $1
            ORDER BY CASE orientation
                       WHEN 'horizontal' THEN 1
                       WHEN 'vertical'   THEN 2
                       WHEN 'square'     THEN 3
                       ELSE 4
                     END, sort, id""",
        event_id,
    )

    # ── Сборка ZIP ──
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Реферальные ссылки.txt", ref_doc)

        for i, t in enumerate(texts, start=1):
            zf.writestr(f"Тексты для анонсов/Анонс {i}.txt", _apply_placeholders(t["content"]))

        # Афиши события в корень папки «Афиши»
        used_counts: dict[str, int] = {}
        for p in posters:
            data = await _download_file_bytes(p["url"])
            if data is None:
                continue
            label = _ORIENTATION_RU.get(p["orientation"], "Афиша")
            used_counts[label] = used_counts.get(label, 0) + 1
            suffix = "" if used_counts[label] == 1 else f" {used_counts[label]}"
            ext = _ext_from_url(p["url"])
            zf.writestr(f"Афиши/{label}{suffix}.{ext}", data)

        # Индивидуальные афиши коллабов (отмеченные «для анонсов»)
        for c in collabs:
            ids = list(c.get("announcement_poster_ids") or [])
            if not ids:
                continue
            prows = await db.fetch(
                """SELECT url FROM collaborator_posters
                    WHERE id = ANY($1::int[]) AND collaborator_id = $2
                    ORDER BY sort_order, id""",
                ids, c["collaborator_id"],
            )
            safe = _safe_filename(c["name"])
            n = 0
            for pr in prows:
                data = await _download_file_bytes(pr["url"])
                if data is None:
                    continue
                n += 1
                ext = _ext_from_url(pr["url"])
                fname = f"{safe}.{ext}" if n == 1 else f"{safe}_{n}.{ext}"
                zf.writestr(f"Афиши/Индивидуальные афиши/{fname}", data)

    zip_bytes = buf.getvalue()
    fname_base = "materialy-zhyuri" if _is_jury_module(ev["module_slug"]) else "materialy-spikery"
    return StreamingResponse(
        iter([zip_bytes]),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{fname_base}-{ev["slug"]}.zip"',
            "Content-Length": str(len(zip_bytes)),
        },
    )
