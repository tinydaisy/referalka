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
            "SELECT media_type, image_url, video_url, sort FROM event_referral_materials WHERE event_id = $1 ORDER BY id",
            data.from_event_id
        )
        for m in materials:
            await db.execute(
                """INSERT INTO event_referral_materials
                     (event_id, media_type, image_url, video_url, source, source_poster_id, sort)
                   VALUES ($1, $2, $3, $4, 'custom', NULL, $5)""",
                event_id, m['media_type'], m['image_url'], m['video_url'], m['sort']
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
    # День программы (conf_days.day_number), к которому относится афиша.
    # None = общая афиша события (поведение по умолчанию, как было всегда).
    day: Optional[int] = None


@router.get("/posters", summary="Список афиш события")
async def list_posters(
    event_id: int,
    day: Optional[int] = None,          # None = все афиши (общие + дневные)
    only_common: bool = False,          # True = только общие (day IS NULL)
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Афиши события. Без фильтров — все (у каждой в ответе есть `day`:
    NULL у общей, номер дня у дневной). `day=N` — только афиши дня N,
    `only_common=true` — только общие."""
    await _check_event_owned(event_id, int(client["sub"]), db)
    if day is not None:
        rows = await db.fetch(
            "SELECT id, url, orientation, sort, day, created_at FROM event_posters "
            "WHERE event_id=$1 AND day=$2 ORDER BY sort, id",
            event_id, day
        )
    elif only_common:
        rows = await db.fetch(
            "SELECT id, url, orientation, sort, day, created_at FROM event_posters "
            "WHERE event_id=$1 AND day IS NULL ORDER BY sort, id",
            event_id
        )
    else:
        rows = await db.fetch(
            "SELECT id, url, orientation, sort, day, created_at FROM event_posters "
            "WHERE event_id=$1 ORDER BY day NULLS FIRST, sort, id",
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
        """INSERT INTO event_posters (event_id, url, orientation, sort, day)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, url, orientation, sort, day, created_at""",
        event_id, data.url, data.orientation, data.sort, data.day
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
    # ⚠️ Запоминаем СТАРЫЙ файл: при замене он остаётся в хранилище навсегда,
    # если его не удалить. Так у одного события накопилось 5 мёртвых афиш.
    old_url = await db.fetchval(
        "SELECT url FROM event_posters WHERE id=$1 AND event_id=$2", poster_id, event_id)

    row = await db.fetchrow(
        """UPDATE event_posters SET url=$1, orientation=$2, sort=$3, day=$4
           WHERE id=$5 AND event_id=$6
           RETURNING id, url, orientation, sort, day, created_at""",
        data.url, data.orientation, data.sort, data.day, poster_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Афиша не найдена")

    if old_url and old_url != data.url:
        await _drop_orphan_file(db, old_url)
    return dict(row)


async def _drop_orphan_file(db, url: str) -> None:
    """Удаляет файл из хранилища, если на него больше никто не ссылается.

    ⚠️ Проверка «никто не ссылается» ОБЯЗАТЕЛЬНА: одна и та же картинка может
    стоять в нескольких афишах или лендингах (копирование лендинга переиспользует
    файлы, а не дублирует их). Удалить сразу — значит выбить картинку у соседей.

    Ошибку не поднимаем: не удалившийся файл — это лишние мегабайты, а упавший
    запрос — это сломанная замена афиши у клиента.
    """
    from app.services import r2_storage
    try:
        still_used = await db.fetchval(
            """SELECT EXISTS (SELECT 1 FROM event_posters WHERE url = $1)
                   OR EXISTS (SELECT 1 FROM event_landing_blocks
                               WHERE image_url = $1 OR bg_image_url = $1
                                  OR items::text LIKE '%' || $1 || '%')
                   OR EXISTS (SELECT 1 FROM collaborator_posters WHERE url = $1)""",
            url)
        if still_used:
            return
        key = r2_storage.key_from_url(url)
        if not key:
            return          # внешняя ссылка — не наш файл
        await r2_storage.delete_object(key)
        await r2_storage.unregister_file(db, key)
    except Exception:
        import logging
        logging.getLogger(__name__).exception("не удалось удалить файл %s", url)


@router.delete("/posters/{poster_id}", summary="Удалить афишу")
async def delete_poster(
    event_id: int, poster_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    url = await db.fetchval(
        "SELECT url FROM event_posters WHERE id=$1 AND event_id=$2", poster_id, event_id)
    result = await db.execute(
        "DELETE FROM event_posters WHERE id=$1 AND event_id=$2", poster_id, event_id
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Афиша не найдена")
    if url:
        await _drop_orphan_file(db, url)
    return {"ok": True}


# ──────────────────────────────────────────────
# НАСТРОЙКИ РЕФ-ПРОГРАММЫ (event_referral_settings)
# ──────────────────────────────────────────────

class ReferralSettingsIn(BaseModel):
    # 'registered' | 'visited' | 'clicked_link' (миграции 042, 082)
    gift_count_mode: Optional[str]  = None
    is_enabled:      Optional[bool] = None   # вкл/выкл вкладки «Игра» в Mini App (миграция 053)
    hide_rating:     Optional[bool] = None   # скрыть ТОП рейтинг в кабинете участника (миграция 162)
    gift_via_funnel: Optional[bool] = None   # выдавать подарки через воронку /m/ (миграция 189)
    show_referrer:   Optional[bool] = None   # показывать участнику, кто его привёл (миграция 481)


@router.get("/referral/settings", summary="Получить настройки реф-программы")
async def get_referral_settings(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    row = await db.fetchrow(
        "SELECT gift_count_mode, is_enabled, hide_rating, gift_via_funnel, show_referrer "
        "FROM event_referral_settings WHERE event_id = $1",
        event_id
    )
    if row:
        return dict(row)
    # ⚠️ `hide_rating: True` — рейтинг по умолчанию СКРЫТ (мигр. 405). Значение
    # отдаётся, когда строки настроек ещё нет: дефолт колонки в этом случае не
    # участвует вовсе, и оставленный здесь False показывал бы рейтинг вопреки
    # настройке по умолчанию.
    return {"gift_count_mode": "registered", "is_enabled": False,
            "hide_rating": True, "gift_via_funnel": False, "show_referrer": False}


@router.put("/referral/settings", summary="Обновить настройки реф-программы (upsert)")
async def upsert_referral_settings(
    event_id: int,
    data: ReferralSettingsIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await _check_event_owned(event_id, int(client["sub"]), db)
    if data.gift_count_mode is not None and data.gift_count_mode not in (
        "registered", "visited", "clicked_link"
    ):
        raise HTTPException(400, "gift_count_mode must be 'registered', 'visited' or 'clicked_link'")
    # Частичный апдейт: переданные поля применяются, непереданные (None) —
    # сохраняют текущее значение в БД (COALESCE на $-параметр). Дефолты для
    # INSERT новой записи — registered / FALSE / FALSE.
    row = await db.fetchrow(
        """INSERT INTO event_referral_settings
             (event_id, gift_count_mode, is_enabled, hide_rating, gift_via_funnel,
              show_referrer)
           VALUES ($1, COALESCE($2, 'registered'), COALESCE($3, FALSE),
                   COALESCE($4, FALSE), COALESCE($5, FALSE), COALESCE($6, FALSE))
           ON CONFLICT (event_id) DO UPDATE
             SET gift_count_mode = COALESCE($2, event_referral_settings.gift_count_mode),
                 is_enabled      = COALESCE($3, event_referral_settings.is_enabled),
                 hide_rating     = COALESCE($4, event_referral_settings.hide_rating),
                 gift_via_funnel = COALESCE($5, event_referral_settings.gift_via_funnel),
                 show_referrer   = COALESCE($6, event_referral_settings.show_referrer),
                 updated_at      = NOW()
           RETURNING gift_count_mode, is_enabled, hide_rating, gift_via_funnel,
                     show_referrer""",
        event_id, data.gift_count_mode, data.is_enabled, data.hide_rating,
        data.gift_via_funnel, data.show_referrer
    )
    return dict(row)


# ──────────────────────────────────────────────
# ПОРОГИ-ПОДАРКИ (event_referral_thresholds)
# ──────────────────────────────────────────────

class ThresholdIn(BaseModel):
    threshold_count:    int                # 1, 3, 10, ...
    lead_magnet_id:     Optional[int] = None
    # Пакет лид-магнитов как подарок за порог (миграция 430). Магнит ИЛИ пакет.
    package_id:         Optional[int] = None
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
        """SELECT t.id, t.threshold_count, t.lead_magnet_id, t.package_id,
                  t.certificate_url, t.gift_template_text, t.sort,
                  -- Название подарка: магнит ИЛИ пакет, что заполнено.
                  COALESCE(lm.name, pk.name) AS lead_magnet_name,
                  lm.url AS lead_magnet_url,
                  COALESCE(lm.client_id, pk.client_id) AS owner_client_id,
                  COALESCE(oc.brand_name, oc.name) AS owner_name
           FROM event_referral_thresholds t
           LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
           LEFT JOIN lead_magnet_packages pk ON pk.id = t.package_id
           LEFT JOIN clients oc ON oc.id = COALESCE(lm.client_id, pk.client_id)
           WHERE t.event_id = $1
           ORDER BY t.threshold_count, t.sort, t.id""",
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


async def _check_package_owned(package_id: int, client_id: int, db: asyncpg.Connection):
    if package_id is None:
        return
    ok = await db.fetchval(
        "SELECT 1 FROM lead_magnet_packages WHERE id = $1 AND client_id = $2",
        package_id, client_id
    )
    if not ok:
        raise HTTPException(status_code=400, detail="Пакет не принадлежит клиенту")


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
    if data.package_id:
        await _check_package_owned(data.package_id, client_id, db)
    row = await db.fetchrow(
        """INSERT INTO event_referral_thresholds
             (event_id, threshold_count, lead_magnet_id, package_id,
              certificate_url, gift_template_text, sort)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, threshold_count, lead_magnet_id, package_id,
                     certificate_url, gift_template_text, sort""",
        event_id, data.threshold_count, data.lead_magnet_id or None,
        data.package_id or None,
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
    if data.package_id:
        await _check_package_owned(data.package_id, client_id, db)
    row = await db.fetchrow(
        """UPDATE event_referral_thresholds
              SET threshold_count = $1, lead_magnet_id = $2, package_id = $8,
                  certificate_url = $3, gift_template_text = $4, sort = $5,
                  updated_at = NOW()
            WHERE id = $6 AND event_id = $7
            RETURNING id, threshold_count, lead_magnet_id, package_id,
                      certificate_url, gift_template_text, sort""",
        data.threshold_count, data.lead_magnet_id or None,
        data.certificate_url, data.gift_template_text, data.sort,
        threshold_id, event_id, data.package_id or None
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


@router.post("/referral/thresholds/{threshold_id}/move", summary="Сдвинуть порог вверх/вниз в пределах одного числа друзей")
async def move_threshold(
    event_id: int, threshold_id: int,
    dir: str,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Меняет порядок показа порога СРЕДИ порогов с ТЕМ ЖЕ threshold_count (два
    подарка «за 0 друзей» и т.п.). Между разными числами друзей двигать нельзя —
    там порядок задаёт само число. Обмен sort с соседом; при равных sort стабилизируем по id."""
    if dir not in ("up", "down"):
        raise HTTPException(status_code=400, detail="dir должен быть up или down")
    await _check_event_owned(event_id, int(client["sub"]), db)

    cur = await db.fetchrow(
        "SELECT id, threshold_count, sort FROM event_referral_thresholds WHERE id=$1 AND event_id=$2",
        threshold_id, event_id,
    )
    if not cur:
        raise HTTPException(status_code=404, detail="Порог не найден")

    # Все пороги с тем же числом друзей, в порядке показа.
    group = await db.fetch(
        """SELECT id, sort FROM event_referral_thresholds
            WHERE event_id=$1 AND threshold_count=$2
            ORDER BY sort, id""",
        event_id, cur["threshold_count"],
    )
    ids = [r["id"] for r in group]
    idx = ids.index(threshold_id)
    swap_idx = idx - 1 if dir == "up" else idx + 1
    if swap_idx < 0 or swap_idx >= len(ids):
        return {"ok": True, "moved": False}  # уже с краю — двигать некуда

    # Нормализуем sort всей группы по текущему порядку, затем меняем местами
    # выбранный элемент и соседа (надёжно даже если sort у всех был 0).
    order = ids[:]
    order[idx], order[swap_idx] = order[swap_idx], order[idx]
    async with db.transaction():
        for pos, tid in enumerate(order):
            await db.execute(
                "UPDATE event_referral_thresholds SET sort=$1, updated_at=NOW() WHERE id=$2 AND event_id=$3",
                pos, tid, event_id,
            )
    return {"ok": True, "moved": True}


# ──────────────────────────────────────────────
# МАТЕРИАЛЫ ДЛЯ ШЕРИНГА (event_referral_materials)
# ──────────────────────────────────────────────

class MaterialIn(BaseModel):
    media_type:       str = "image"    # 'image' | 'video'
    image_url:        Optional[str] = None  # для картинки (или обложки видео)
    video_url:        Optional[str] = None  # для видео
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
        """SELECT id, media_type, image_url, video_url, source, source_poster_id, sort, created_at
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
    if data.media_type not in ("image", "video"):
        raise HTTPException(status_code=400, detail="media_type: 'image' или 'video'")
    if data.source not in ("event_poster", "custom"):
        raise HTTPException(status_code=400, detail="source: 'event_poster' или 'custom'")

    if data.media_type == "video":
        if not data.video_url:
            raise HTTPException(status_code=400, detail="Для видео укажите video_url")
        source = "custom"  # видео всегда загружается, не выбирается из афиш
        row = await db.fetchrow(
            """INSERT INTO event_referral_materials
                 (event_id, media_type, video_url, image_url, source, source_poster_id, sort)
               VALUES ($1, 'video', $2, NULL, 'custom', NULL, $3)
               RETURNING id, media_type, image_url, video_url, source, source_poster_id, sort, created_at""",
            event_id, data.video_url, data.sort
        )
        return dict(row)

    # media_type == 'image'
    if not data.image_url:
        raise HTTPException(status_code=400, detail="Для картинки укажите image_url")
    if data.source == "event_poster" and data.source_poster_id:
        ok = await db.fetchval(
            "SELECT 1 FROM event_posters WHERE id = $1 AND event_id = $2",
            data.source_poster_id, event_id
        )
        if not ok:
            raise HTTPException(status_code=400, detail="Афиша не принадлежит этому событию")
    row = await db.fetchrow(
        """INSERT INTO event_referral_materials
             (event_id, media_type, image_url, source, source_poster_id, sort)
           VALUES ($1, 'image', $2, $3, $4, $5)
           RETURNING id, media_type, image_url, video_url, source, source_poster_id, sort, created_at""",
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
#   • Афиши/Индивидуальные афиши/Имя Фамилия/<Ориентация>.<ext> — афиши
#     спикера, ПАПКА НА ЧЕЛОВЕКА (22.09.2026). Источник — слоты
#     `event_speaker_posters` (миграция 492), где ориентация это поле.
#     Раньше всё валилось в одну папку файлами «Имя_Фамилия_2.png», и какая
#     из них горизонтальная, было не понять. Запасной источник для ещё не
#     перенесённых афиш — старая библиотека по announcement_poster_ids.
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

# Короткая форма — для имён файлов вида «Имя_Фамилия_горизонтальная.png».
# Отдельно от _ORIENTATION_RU: там подписи для папок общих афиш («Квадратная
# афиша»), а в имени файла слово «афиша» после имени человека уже лишнее.
_ORIENTATION_SHORT = {
    "horizontal": "горизонтальная",
    "vertical":   "вертикальная",
    "square":     "квадратная",
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
        """SELECT id, slug, title, $2::int AS client_id, module_slug, start_at
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
    from app.services import collaborator_sort, person_name
    from app.api.modules.conference import ensure_collaborator_contact
    from app.services.share_links import build_share_links, resolve_event_link_mode
    _lm = await resolve_event_link_mode(db, client_id=client_id)

    rows = await db.fetch(
        f"""SELECT ec.id AS ec_id, ec.role,
                   -- Миграция 237: тумблер «не использовать индивидуальную афишу»
                   -- → афиши этого спикера в архив не кладём.
                   CASE WHEN ec.use_photo_instead_of_poster THEN NULL
                        ELSE ec.announcement_poster_ids END AS announcement_poster_ids,
                   co.id AS collaborator_id,
                   -- ⚠️ ИМЯ С ФАМИЛИЕЙ. Здесь стояло голое `co.name`, и в
                   -- выгрузке для спикеров человек был без фамилии — и в
                   -- «Реферальные ссылки.txt», и в именах файлов афиш.
                   -- Склейку берём общим хелпером, а не руками (правило проекта).
                   """ + person_name.DISPLAY_NAME_SQL("co") + f""" AS name,
                   ctc.ref_code
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
                    link_mode=_lm,
                )
            except Exception:
                links = {}
        # Формат блока (по запросу клиента): подпись площадки отдельной строкой,
        # затем ПУСТАЯ строка, затем сама ссылка — чтобы спикер копировал ссылку
        # одним кликом, не задевая подпись.
        #     Имя
        #
        #     Через ТГ:
        #
        #     https://…
        lines = [c["name"] or "Без имени"]
        for key, label in (("telegram", "Через ТГ"),
                           ("vk", "Через ВК"),
                           ("max", "Через МАХ")):
            if links.get(key):
                lines.append(f"{label}:\n\n{links[key]}")
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
    # Общие (day IS NULL) — в корень папки «Афиши».
    posters = await db.fetch(
        """SELECT url, orientation FROM event_posters
            WHERE event_id = $1 AND day IS NULL
            ORDER BY CASE orientation
                       WHEN 'horizontal' THEN 1
                       WHEN 'vertical'   THEN 2
                       WHEN 'square'     THEN 3
                       ELSE 4
                     END, sort, id""",
        event_id,
    )
    # Афиши ДНЕЙ (миграция 215) — в подпапки «Афиши/День N — Название дня/».
    day_posters = await db.fetch(
        """SELECT ep.url, ep.orientation, ep.day,
                  COALESCE(NULLIF(cd.title, ''), '') AS day_title
             FROM event_posters ep
             LEFT JOIN conf_days cd ON cd.event_id = ep.event_id AND cd.day_number = ep.day
            WHERE ep.event_id = $1 AND ep.day IS NOT NULL
            ORDER BY ep.day,
                     CASE ep.orientation
                       WHEN 'horizontal' THEN 1
                       WHEN 'vertical'   THEN 2
                       WHEN 'square'     THEN 3
                       ELSE 4
                     END, ep.sort, ep.id""",
        event_id,
    )

    # ── Сборка ZIP ──
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Реферальные ссылки.txt", ref_doc)

        for i, t in enumerate(texts, start=1):
            zf.writestr(f"Тексты для анонсов/Анонс {i}.txt", _apply_placeholders(t["content"]))

        # Общие афиши события — в корень папки «Афиши»
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

        # Афиши дней события — в подпапки «Афиши/День N — Название дня/»
        day_counts: dict[tuple, int] = {}
        for p in day_posters:
            data = await _download_file_bytes(p["url"])
            if data is None:
                continue
            title = (p["day_title"] or "").strip()
            folder = _safe_filename(f"День {p['day']}" + (f" — {title}" if title else ""))
            label = _ORIENTATION_RU.get(p["orientation"], "Афиша")
            key = (p["day"], label)
            day_counts[key] = day_counts.get(key, 0) + 1
            suffix = "" if day_counts[key] == 1 else f" {day_counts[key]}"
            ext = _ext_from_url(p["url"])
            zf.writestr(f"Афиши/{folder}/{label}{suffix}.{ext}", data)

        # ── Индивидуальные афиши: ПАПКА НА СПИКЕРА (22.09.2026) ──────────
        # Было: все афиши валились в одну папку файлами «Имя_Фамилия.png»,
        # «Имя_Фамилия_2.png» — по имени файла не понять, где горизонтальная,
        # а где вертикальная. Стало: папка на человека, внутри файлы названы
        # ориентацией — ровно то, что человек ищет глазами.
        #
        #   Афиши/Индивидуальные афиши/Наталья Барвинская/Квадратная.png
        #                                                /Горизонтальная.png
        #                                                /Вертикальная.png
        #
        # ⚠️ Источник — НОВЫЕ СЛОТЫ (`event_speaker_posters`, миграция 492):
        # там ориентация это поле, а не строка в подписи. Старая библиотека
        # остаётся запасным источником для афиш, которые ещё не перенесены
        # (у 66 из 96 на проде подпись пуста — ориентацию не восстановить).
        for c in collabs:
            safe_dir = _safe_filename(c["name"])
            wrote_any = False

            # 1) Новые слоты по ориентациям.
            srows = await db.fetch(
                """SELECT orientation, url FROM event_speaker_posters
                    WHERE ec_id = $1
                    ORDER BY CASE orientation
                               WHEN 'horizontal' THEN 1
                               WHEN 'square'     THEN 2
                               WHEN 'vertical'   THEN 3
                               ELSE 4 END""",
                c["ec_id"],
            )
            # Тумблер «фото вместо афиши» гасит выдачу и здесь: клиент явно
            # сказал, что афиши этого спикера использовать не надо.
            if c.get("announcement_poster_ids") is None:
                srows = []
            for sr in srows:
                data = await _download_file_bytes(sr["url"])
                if data is None:
                    continue
                ext = _ext_from_url(sr["url"])
                # ⚠️ ИМЯ ЧЕЛОВЕКА В ИМЕНИ ФАЙЛА, а не только в имени папки
                # (требование владельца 23.09.2026): «Имя_Фамилия_квадратная».
                # Спикеру файл отправляют по одному — вытащенная из папки
                # «Квадратная.png» теряет всякую связь с человеком, и в папке
                # «Загрузки» у организатора их лежит десяток одноимённых,
                # перезаписывающих друг друга.
                name_ru = _ORIENTATION_SHORT.get(sr["orientation"], sr["orientation"])
                zf.writestr(
                    f"Афиши/Индивидуальные афиши/{safe_dir}/{safe_dir}_{name_ru}.{ext}", data)
                wrote_any = True

            # 2) Запасной источник — старая библиотека, только если слотов нет
            # вовсе. Иначе одна и та же афиша легла бы в папку дважды.
            if wrote_any:
                continue
            ids = list(c.get("announcement_poster_ids") or [])
            if not ids:
                continue
            prows = await db.fetch(
                """SELECT url FROM collaborator_posters
                    WHERE id = ANY($1::int[]) AND collaborator_id = $2
                    ORDER BY sort_order, id""",
                ids, c["collaborator_id"],
            )
            n = 0
            for pr in prows:
                data = await _download_file_bytes(pr["url"])
                if data is None:
                    continue
                n += 1
                ext = _ext_from_url(pr["url"])
                fname = f"Афиша.{ext}" if n == 1 else f"Афиша {n}.{ext}"
                zf.writestr(
                    f"Афиши/Индивидуальные афиши/{safe_dir}/{fname}", data)

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


# ──────────────────────────────────────────────
# ОТЧЁТ ПО РЕФЕРАЛАМ (живой, без снимков)
# ──────────────────────────────────────────────
#
# ⚠️ Не путать с «Отчётом» конференции: тот про КЛИКИ по карточкам спикеров и
# снимки на дату (`tournament_snapshots`). Здесь — живой срез по
# `event_participants.referrer_ref_code`: кто сколько привёл на это событие,
# сколько из приведённых зарегистрировалось и сколько заплатило.
#
# ⚠️ Реф-код резолвится ЧЕРЕЗ `merged_ref_codes` (`rc.merged_ref_codes ? ...`):
# после объединения контактов старый код продолжает стоять у уже пришедших
# участников, и без этой проверки часть приведённых потерялась бы. Тот же
# приём — в отчёте коллабы и в `brought_count_sql`.
#
# ⚠️ Считается ВЖИВУЮ, при заходе на вкладку, без кнопки «построить» (решение
# владельца 09.09.2026): отчёт нужен как экран наблюдения, а не как документ.

# Оплата участника — сумма его тарифов со статусом `paid`.
#
# ⚠️⚠️ СЧИТАЕМ ТОЛЬКО ПО `amount`. Цену тарифа подставлять вместо пустой суммы
# НЕЛЬЗЯ (решение владельца 09.09.2026): вручную отмечают и тех, кто прошёл
# бесплатно — например пришедших от Михайленко на событии 24 за 0 ₽. Подстановка
# приписала бы им деньги, которых они не платили, и завысила выручку.
#
# Пустая сумма — это дыра в ДАННЫХ, а не в подсчёте: форма «Отметить
# оплатившим» не спрашивала сумму вовсе и всегда слала NULL (починено там же).
_PAID_SUM_SQL = (
    "(SELECT COALESCE(SUM(pt.amount), 0) FROM event_participant_tariffs pt "
    "WHERE pt.participant_id = ep.id AND pt.status = 'paid')"
)
_PAID_EXISTS_SQL = (
    "EXISTS (SELECT 1 FROM event_participant_tariffs pt "
    "WHERE pt.participant_id = ep.id AND pt.status = 'paid')"
)


@router.get("/referral/report", summary="Отчёт по рефералам события: кто сколько привёл")
async def referral_report(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список ЗРИТЕЛЕЙ, по чьим ссылкам на событие пришёл хотя бы один человек.

    Строки — рефоводы (контакты клиента), у каждого: сколько людей пришло по его
    ссылке, сколько из них зарегистрировалось, сколько оплатило и на какую сумму.

    ⚠️⚠️ СПИКЕРОВ, ПАРТНЁРОВ, ОРГАНИЗАТОРОВ И ЖЮРИ ЗДЕСЬ НЕТ (25.09.2026).
    Их привлечение — отдельный отчёт, «Отслеживание → Отчёт по привлечению»:
    там своя логика (роли, обязательства по приводу, свои показатели). В одной
    таблице два этих отчёта мешали друг другу — у события 89 из 28 строк 16
    были коллабораторы, и работа зрителей терялась среди них.

    ⚠️ Рефоводы с нулём приведённых в выдачу НЕ попадают вовсе — отчёт строится
    от факта прихода, а не от списка контактов: иначе таблица была бы длиной во
    всю базу и в ней невозможно было бы найти работающих людей.
    """
    await _check_event_owned(event_id, int(client["sub"]), db)

    from app.services import person_name

    rows = await db.fetch(
        f"""
        SELECT rc.id                        AS contact_id,
               -- ⚠️ ФАМИЛИЯ СПИКЕРА (22.09.2026, просьба владельца). У контакта
               -- фамилии нет вовсе — в `contacts` одно поле `name`. А у спикера
               -- (`collaborators`) есть `last_name`, и в отчёте по привлечению
               -- он выглядел «Наталья» без фамилии: в списке из нескольких
               -- Наталий не понять, кто это.
               -- Берём имя из карточки спикера ЭТОГО события, если рефовод там
               -- есть; иначе — как раньше, имя контакта. Склейка общим
               -- хелпером (правило проекта), не руками.
               COALESCE(
                 (SELECT """ + person_name.DISPLAY_NAME_SQL("co_r") + f"""
                    FROM event_collaborators ec_r
                    JOIN collaborators co_r ON co_r.id = ec_r.speaker_id
                   WHERE ec_r.event_id = $1
                     AND co_r.contact_id = rc.id
                   LIMIT 1),
                 rc.name
               )                            AS name,
               -- Признак «этот рефовод — спикер события»: фронт помечает строку.
               EXISTS (SELECT 1 FROM event_collaborators ec_f
                        JOIN collaborators co_f ON co_f.id = ec_f.speaker_id
                       WHERE ec_f.event_id = $1 AND co_f.contact_id = rc.id)
                                            AS is_speaker,
               rc.ref_code                  AS ref_code,
               rc.phone                     AS phone,
               (SELECT pe.platform_user_id FROM platform_users pe
                 WHERE pe.contact_id = rc.id AND pe.platform_slug = 'email'
                 ORDER BY pe.id LIMIT 1)    AS email,
               -- Площадки рефовода: показываем иконкой + ником, по одной на
               -- строку — как в карточке. Нужны и id, и ник: без ника ссылку
               -- не построить, без id не видно, что человек на площадке есть.
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = rc.id AND pu.platform_slug = 'telegram'
                 LIMIT 1)                   AS tg_username,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = rc.id AND pu.platform_slug = 'telegram'
                 LIMIT 1)                   AS tg_id,
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = rc.id AND pu.platform_slug = 'vk'
                 LIMIT 1)                   AS vk_username,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = rc.id AND pu.platform_slug = 'vk'
                 LIMIT 1)                   AS vk_id,
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = rc.id AND pu.platform_slug = 'max'
                 LIMIT 1)                   AS max_username,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = rc.id AND pu.platform_slug = 'max'
                 LIMIT 1)                   AS max_id,
               -- Зарегистрирован ли САМ рефовод на это событие. Отдельный
               -- вопрос от «сколько он привёл»: человек может звать друзей,
               -- сам при этом не дойдя до регистрации, — это видно сразу.
               COALESCE((SELECT me.is_registered FROM event_participants me
                          WHERE me.event_id = $1 AND me.contact_id = rc.id
                          LIMIT 1), FALSE)  AS self_registered,
               EXISTS (SELECT 1 FROM event_participants me
                        WHERE me.event_id = $1 AND me.contact_id = rc.id) AS self_participant,
               count(*)                                          AS brought,
               count(*) FILTER (WHERE ep.is_registered)          AS registered,
               count(*) FILTER (WHERE {_PAID_EXISTS_SQL})        AS paid_count,
               COALESCE(SUM({_PAID_SUM_SQL}), 0)                 AS paid_sum
          FROM event_participants ep
          JOIN contacts rc ON rc.ref_code = ep.referrer_ref_code
                           OR rc.merged_ref_codes ? ep.referrer_ref_code
         WHERE ep.event_id = $1
           AND COALESCE(ep.referrer_ref_code, '') <> ''
           -- ⚠️⚠️ ТОЛЬКО ЗРИТЕЛИ (25.09.2026, решение владельца). Спикеры,
           -- партнёры, организаторы и жюри из отчёта исключены: их привлечение
           -- считается отдельно, в «Отслеживание → Отчёт по привлечению», и
           -- там у него своя логика (роли, обязательства, показатели).
           -- Раньше все шли одной таблицей: 16 строк из 28 были коллабораторы,
           -- и работа зрителей терялась среди них, а итоги в шапке складывали
           -- два разных отчёта в одно число.
           --
           -- ⚠️ Отбор по ФАКТУ участия в `event_collaborators` этого события,
           -- а не по списку ролей: роль может быть любой из шести
           -- (speaker, headliner, jury, organizer, partner, general_partner),
           -- и перечисление рано или поздно отстало бы от новой роли —
           -- молча вернув её носителей в отчёт зрителей.
           AND NOT EXISTS (
                 SELECT 1 FROM event_collaborators ec_x
                   JOIN collaborators co_x ON co_x.id = ec_x.speaker_id
                  WHERE ec_x.event_id = $1 AND co_x.contact_id = rc.id)
         GROUP BY rc.id, rc.name, rc.ref_code, rc.phone
         ORDER BY brought DESC, registered DESC, rc.name
        """,
        event_id,
    )

    items = [dict(r) for r in rows]
    for it in items:
        it["paid_sum"] = float(it["paid_sum"] or 0)

    # Итоги считаем ПО ТЕМ ЖЕ строкам, что показываем, — иначе шапка разойдётся
    # с таблицей, и доверять ей станет нельзя.
    totals = {
        "referrers": len(items),
        "brought": sum(int(i["brought"]) for i in items),
        "registered": sum(int(i["registered"]) for i in items),
        "paid_count": sum(int(i["paid_count"]) for i in items),
        "paid_sum": sum(float(i["paid_sum"]) for i in items),
    }
    # Сколько всего участников у события — чтобы было видно долю приведённых.
    totals["participants_total"] = await db.fetchval(
        "SELECT count(*) FROM event_participants WHERE event_id = $1", event_id) or 0

    return {"items": items, "totals": totals}


@router.get("/referral/report/{contact_id}", summary="Карточка рефовода: его люди на этом событии")
async def referral_report_person(
    event_id: int,
    contact_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Один рефовод и список людей, пришедших на событие по его ссылке."""
    client_id = int(client["sub"])
    await _check_event_owned(event_id, client_id, db)

    # ⚠️ Контакт проверяем на принадлежность кабинету: id приходит из адреса,
    # и без проверки по чужому номеру открылась бы карточка постороннего
    # человека с его почтой и телефоном.
    person = await db.fetchrow(
        """SELECT c.id, c.name, c.ref_code, c.phone,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  (SELECT pu.username FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
                    LIMIT 1) AS tg_username,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
                    LIMIT 1) AS tg_id,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk'
                    LIMIT 1) AS vk_id,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max'
                    LIMIT 1) AS max_id,
                  COALESCE((SELECT me.is_registered FROM event_participants me
                             WHERE me.event_id = $2 AND me.contact_id = c.id
                             LIMIT 1), FALSE) AS self_registered,
                  EXISTS (SELECT 1 FROM event_participants me
                           WHERE me.event_id = $2 AND me.contact_id = c.id) AS self_participant
             FROM contacts c
            WHERE c.id = $1 AND c.client_id = $3""",
        contact_id, event_id, client_id,
    )
    if not person:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    rows = await db.fetch(
        f"""
        SELECT ep.id                        AS participant_id,
               c.id                         AS contact_id,
               c.name                       AS name,
               c.phone                      AS phone,
               (SELECT pe.platform_user_id FROM platform_users pe
                 WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                 ORDER BY pe.id LIMIT 1)    AS email,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
                 LIMIT 1)                   AS tg_id,
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
                 LIMIT 1)                   AS tg_username,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk'
                 LIMIT 1)                   AS vk_id,
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk'
                 LIMIT 1)                   AS vk_username,
               (SELECT pu.platform_user_id FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'max'
                 LIMIT 1)                   AS max_id,
               (SELECT pu.username FROM platform_users pu
                 WHERE pu.contact_id = c.id AND pu.platform_slug = 'max'
                 LIMIT 1)                   AS max_username,
               -- ⚠️ Колонки `created_at` у event_participants НЕТ. Момент
               -- появления строки хранит `registered_at` (DEFAULT now()), он
               -- же становится временем регистрации — отдельного «когда зашёл»
               -- в таблице не существует.
               ep.is_registered, ep.registered_at,
               {_PAID_SUM_SQL}              AS paid_amount,
               {_PAID_EXISTS_SQL}           AS has_paid,
               (SELECT STRING_AGG(t.title, ', ' ORDER BY t.sort_order)
                  FROM event_participant_tariffs pt
                  JOIN event_tariffs t ON t.id = pt.tariff_id
                 WHERE pt.participant_id = ep.id AND pt.status = 'paid') AS paid_tariffs
          FROM event_participants ep
          JOIN contacts c ON c.id = ep.contact_id
         WHERE ep.event_id = $1
           AND COALESCE(ep.referrer_ref_code, '') <> ''
           AND EXISTS (SELECT 1 FROM contacts rc
                        WHERE rc.id = $2
                          AND (rc.ref_code = ep.referrer_ref_code
                               OR rc.merged_ref_codes ? ep.referrer_ref_code))
         ORDER BY ep.is_registered DESC, ep.registered_at DESC NULLS LAST
        """,
        event_id, contact_id,
    )

    people = [dict(r) for r in rows]
    for p in people:
        p["paid_amount"] = float(p["paid_amount"] or 0)

    # ⚠️ «Оплатил» = ЕСТЬ оплаченный тариф, а не «сумма больше нуля» — ровно то
    # же определение, что в списке рефоводов. На проде 28 записей со
    # `status='paid'` и `amount = 0` (бесплатный тариф или отмечен вручную):
    # при подсчёте по сумме карточка показывала «оплатили 0» там, где в списке
    # стояло «2», и цифры двух экранов расходились.
    totals = {
        "brought": len(people),
        "registered": sum(1 for p in people if p["is_registered"]),
        "paid_count": sum(1 for p in people if p["has_paid"]),
        "paid_sum": sum(p["paid_amount"] for p in people),
    }
    return {"person": dict(person), "people": people, "totals": totals}
