"""
Универсальный endpoint загрузки файлов в R2.

POST   /api/v1/uploads    — загрузить файл (multipart/form-data)
DELETE /api/v1/uploads/{file_id} — удалить файл (по client_files.id)
GET    /api/v1/storage/usage     — текущее использование квоты
GET    /api/v1/storage/files     — детализация: какой файл где используется

Поддерживаемые kind:
    event_poster      (требует event_id, poster_type=horizontal|vertical|square)
    certificate       (требует event_id)
    referral_material (требует event_id)
    lead_magnet
    speaker_photo     (требует collaborator_id)
    brand_photo       (профиль клиента: фото бренда)
    brand_logo        (профиль клиента: логотип в углу страниц Mini App.
                       ⚠️ Одним kind грузятся ОБА логотипа — для тёмного фона
                       (clients.brand_logo_url) и для светлого (brand_logo_light_url).)
    owner_photo       (профиль клиента: фото основателя)
    funnel_media      (фото/видео для текстов воронки лид-магнитов)
    broadcast_photo   (фото для произвольной рассылки; авто-удаляется через 24 часа
                       после отправки воркером cleanup_broadcast_photos)
    broadcast_video   (видео для рассылки; лимит 100 МБ; авто-удаляется как broadcast_photo)
    event_video       (требует event_id; общее видео события — для скачивания спикерами)
    speaker_video     (требует collaborator_id; индивидуальное видео коллаба)
    referral_video    (требует event_id; видео-материал для шеринга в реф-программе; лимит 100 МБ)

Картинки автоматически ресайзятся под kind (см. image_processor.MAX_DIM_BY_KIND).
Видео (event_video, speaker_video) сохраняются как есть, лимит 100 МБ (Cloudflare cap).
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from typing import Optional
import asyncpg
from app.auth import get_current_client
from app.database import get_db
from app.services import r2_storage
from app.services.image_processor import process_image, is_image


# ⚠️ ЕДИНЫЙ список разрешённых kind. Держится константой, а не литералом внутри
# проверки, чтобы его можно было сверить с настройками сжатия
# (image_processor.uncompressed_image_kinds): забытый в сжатии kind не даёт
# ошибки — файл просто уходит в хранилище несжатым.
IMAGE_UPLOAD_KINDS = {
    "event_poster", "certificate", "referral_material", "lead_magnet", "speaker_photo",
    "speaker_poster",
    "brand_photo", "brand_logo", "owner_photo", "funnel_media", "broadcast_photo",
    "broadcast_video",
    "event_video", "speaker_video", "referral_video",
    "landing_bg", "landing_media",
    # Картинки лендинга ПРОДУКТА (миграция 293) и материалов продукта.
    # ⚠️ event_id НЕ требуют — продукт живёт вне событий.
    "product_media", "material_media",
    # Картинки анкет (миграция 281): обложка анкеты и картинка вопроса.
    # ⚠️ event_id НЕ требуют — анкеты общие, к событиям не привязаны.
    "survey_media",
}

router = APIRouter(tags=["Загрузка файлов"])


MAX_FILE_SIZE = 50 * 1024 * 1024            # 50 МБ — дефолтный лимит
MAX_FILE_SIZE_VIDEO = 100 * 1024 * 1024     # 100 МБ — лимит для видео (упирается в Cloudflare cap)
VIDEO_KINDS = {"event_video", "speaker_video", "broadcast_video", "referral_video"}


def _is_video(content_type: str) -> bool:
    return (content_type or "").lower().startswith("video/")


def _human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} Б"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} КБ"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} МБ"
    return f"{n / (1024 * 1024 * 1024):.2f} ГБ"


async def _check_event_belongs(event_id: int, client_id: int, db: asyncpg.Connection):
    row = await db.fetchrow("SELECT id FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')", event_id, client_id)
    if not row:
        raise HTTPException(status_code=403, detail="Событие не принадлежит клиенту")


async def _check_collaborator_belongs(collaborator_id: int, client_id: int, db: asyncpg.Connection):
    row = await db.fetchrow(
        "SELECT id FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=403, detail="Коллаборатор не принадлежит клиенту")


@router.post("/uploads", summary="Загрузить файл в R2")
async def upload_file(
    file: UploadFile = File(...),
    kind: str = Form(...),
    event_id: Optional[int] = Form(None),
    collaborator_id: Optional[int] = Form(None),
    poster_type: Optional[str] = Form(None),
    lead_magnet_id: Optional[int] = Form(None),
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])

    # 1. Валидация kind и обязательных параметров
    if kind not in IMAGE_UPLOAD_KINDS:
        raise HTTPException(400, detail=f"Неизвестный kind: {kind}")

    if kind in ("event_poster", "certificate", "referral_material", "event_video",
                "referral_video", "landing_bg", "landing_media"):
        if not event_id:
            raise HTTPException(400, detail=f"{kind} требует event_id")
        await _check_event_belongs(event_id, client_id, db)
    if kind == "event_poster" and poster_type not in ("horizontal", "vertical", "square"):
        raise HTTPException(400, detail="event_poster требует poster_type=horizontal|vertical|square")
    if kind in ("speaker_photo", "speaker_poster", "speaker_video"):
        if not collaborator_id:
            raise HTTPException(400, detail=f"{kind} требует collaborator_id")
        await _check_collaborator_belongs(collaborator_id, client_id, db)

    # 2. Проверка типа файла (п. 7.10 Оферты) — ДО чтения содержимого,
    # чтобы не тянуть в память заведомо запрещённый файл.
    from app.services.file_safety import is_blocked_file, blocked_file_message
    if is_blocked_file(file.filename, file.content_type):
        raise HTTPException(400, detail=blocked_file_message(file.filename))

    # 3. Читаем содержимое. Для видео лимит выше — 100 МБ (cap Cloudflare).
    raw = await file.read()
    if len(raw) == 0:
        raise HTTPException(400, detail="Пустой файл")
    size_limit = MAX_FILE_SIZE_VIDEO if kind in VIDEO_KINDS else MAX_FILE_SIZE
    if len(raw) > size_limit:
        raise HTTPException(413, detail=f"Файл больше {_human_bytes(size_limit)}")

    # 4. Ресайз картинок (если применимо). Видео сохраняем как есть.
    content_type = file.content_type or "application/octet-stream"
    if kind in VIDEO_KINDS:
        if not _is_video(content_type):
            raise HTTPException(400, detail="Ожидается видео (video/mp4, video/webm и т.п.)")
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "mp4"
    elif is_image(content_type):
        processed, new_ct, new_ext = process_image(raw, kind, content_type)
        raw, content_type, ext = processed, new_ct, new_ext
    else:
        # для PDF и др. — оставляем как есть, расширение из имени
        ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "bin"

    size = len(raw)

    # 5. Проверка квоты
    quota_row = await db.fetchrow(
        "SELECT storage_used_bytes, storage_quota_bytes FROM clients WHERE id = $1",
        client_id,
    )
    if not quota_row:
        raise HTTPException(404, detail="Клиент не найден")
    used = int(quota_row["storage_used_bytes"])
    quota = int(quota_row["storage_quota_bytes"])
    if used + size > quota:
        raise HTTPException(
            413,
            detail=f"Превышена квота. Использовано {_human_bytes(used)} из {_human_bytes(quota)}, файл {_human_bytes(size)}.",
        )

    # 5. Строим key и грузим в R2
    key = r2_storage.build_key(
        client_id, kind, ext,
        event_id=event_id, collaborator_id=collaborator_id, poster_type=poster_type,
    )
    url = await r2_storage.upload_bytes(key, raw, content_type)

    # 6. Запись в client_files + обновление used_bytes (одной транзакцией).
    # Для kind='speaker_poster' дополнительно регистрируем загрузку в
    # библиотеке афиш коллаба (миграция 121) — фронту не нужно делать
    # отдельный POST /collaborators/{id}/posters.
    poster_id: Optional[int] = None
    async with db.transaction():
        row = await db.fetchrow(
            """
            INSERT INTO client_files
                (client_id, kind, r2_key, url, size_bytes, content_type,
                 event_id, collaborator_id, lead_magnet_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id
            """,
            client_id, kind, key, url, size, content_type,
            event_id, collaborator_id, lead_magnet_id,
        )
        await db.execute(
            "UPDATE clients SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2",
            size, client_id,
        )
        if kind == "speaker_poster" and collaborator_id:
            next_sort = await db.fetchval(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collaborator_posters WHERE collaborator_id = $1",
                collaborator_id,
            )
            poster_id = await db.fetchval(
                """INSERT INTO collaborator_posters (collaborator_id, url, sort_order)
                   VALUES ($1, $2, $3) RETURNING id""",
                collaborator_id, url, int(next_sort),
            )

    return {
        "id": row["id"],
        "url": url,
        "key": key,
        "size_bytes": size,
        "content_type": content_type,
        **({"poster_id": poster_id} if poster_id is not None else {}),
    }


@router.delete("/uploads/{file_id}", summary="Удалить файл из R2 и БД")
async def delete_file(
    file_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT id, r2_key, size_bytes FROM client_files WHERE id = $1 AND client_id = $2",
        file_id, client_id,
    )
    if not row:
        raise HTTPException(404, detail="Файл не найден")

    try:
        await r2_storage.delete_object(row["r2_key"])
    except Exception:
        pass  # даже если R2 не отвечает, чистим запись в БД

    async with db.transaction():
        await db.execute("DELETE FROM client_files WHERE id = $1", file_id)
        await db.execute(
            "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
            int(row["size_bytes"]), client_id,
        )
    return {"ok": True}


@router.delete("/uploads/by-url", summary="Удалить файл по URL (для совместимости со старыми компонентами)")
async def delete_by_url(
    url: str,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Если файл был загружен через новую систему — удалит из R2 и БД.
    Если URL внешний (не наш R2) — просто 200 без действий."""
    client_id = int(client["sub"])
    key = r2_storage.key_from_url(url)
    if not key:
        return {"ok": True, "skipped": "external_url"}

    row = await db.fetchrow(
        "SELECT id, size_bytes FROM client_files WHERE r2_key = $1 AND client_id = $2",
        key, client_id,
    )
    if row:
        try:
            await r2_storage.delete_object(key)
        except Exception:
            pass
        async with db.transaction():
            await db.execute("DELETE FROM client_files WHERE id = $1", row["id"])
            await db.execute(
                "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
                int(row["size_bytes"]), client_id,
            )
        return {"ok": True}

    # Файл в R2 но не в client_files (например, до миграции 037) — просто удалим из R2
    try:
        await r2_storage.delete_object(key)
    except Exception:
        pass
    return {"ok": True, "legacy": True}


@router.get("/storage/usage", summary="Использование файлового хранилища клиентом")
async def storage_usage(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT storage_used_bytes, storage_quota_bytes FROM clients WHERE id = $1",
        client_id,
    )
    if not row:
        raise HTTPException(404, detail="Клиент не найден")
    used = int(row["storage_used_bytes"])
    quota = int(row["storage_quota_bytes"])
    return {
        "used_bytes": used,
        "quota_bytes": quota,
        "used_percent": round((used / quota) * 100, 1) if quota else 0,
        "used_human": _human_bytes(used),
        "quota_human": _human_bytes(quota),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Детализация хранилища: какой файл, где используется, как туда перейти
# ─────────────────────────────────────────────────────────────────────────────
# Человеческие названия типов файлов. Клиент не должен видеть слово kind —
# ему нужно понимать, что это за файл и откуда он взялся.
_KIND_LABEL = {
    "event_poster": "Афиша события",
    "event_video": "Видео события",
    "referral_material": "Материал для друзей",
    "referral_video": "Видео для друзей",
    "certificate": "Сертификат",
    "speaker_photo": "Фото спикера",
    "speaker_poster": "Афиша спикера",
    "speaker_video": "Видео спикера",
    "landing_media": "Картинка лендинга",
    "landing_bg": "Фон лендинга",
    "product_media": "Картинка продукта",
    "material_media": "Материал урока",
    "lead_magnet": "Файл подарка",
    "funnel_media": "Медиа воронки",
    "survey_media": "Картинка анкеты",
    "brand_photo": "Фото бренда",
    "brand_logo": "Логотип бренда",  # оба варианта: для тёмного и светлого фона
    "owner_photo": "Фото основателя",
    "broadcast_photo": "Фото рассылки",
    "broadcast_video": "Видео рассылки",
    "dialog_media": "Медиа переписки",
    "webinar_recording": "Запись эфира",
    "untracked": "Загружен вручную",
}

# Куда ведёт кнопка «Перейти» — вкладка, на которой этот файл живёт.
# ⚠️ Адреса завязаны на реальные маршруты дашборда: событие и конференция —
# разные разделы, поэтому путь выбирается по module_slug события.
_KIND_TAB = {
    "event_poster": "posters",
    "event_video": "posters",
    "referral_material": "referral",
    "referral_video": "referral",
    "certificate": "referral",
    "landing_media": "landing",
    "landing_bg": "landing",
    "speaker_photo": "speakers",
    "speaker_poster": "speakers",
    "speaker_video": "speakers",
}


@router.get("/storage/files", summary="Детализация файлового хранилища")
async def storage_files(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список файлов клиента: что это, сколько весит и где используется.

    Группируется по «месту»: событие, продукт, профиль, рассылки и т.д. —
    так клиент видит, что именно занимает место, а не просто список имён.
    """
    client_id = int(client["sub"])

    rows = await db.fetch(
        """
        SELECT f.id, f.kind, f.r2_key, f.url, f.size_bytes, f.created_at,
               f.event_id, f.collaborator_id,
               e.title       AS event_title,
               e.module_slug AS event_module,
               c.name        AS collaborator_name,
               -- Продукт определяется по пути в ключе: продуктовые файлы
               -- лежат вне событий и своего event_id не имеют.
               (SELECT p.id FROM products p
                 WHERE p.client_id = f.client_id
                   AND (f.url LIKE '%/products/' || p.id || '/%'
                        OR f.r2_key LIKE '%/products/' || p.id || '/%')
                 LIMIT 1) AS product_id
          FROM client_files f
          LEFT JOIN events e        ON e.id = f.event_id
          LEFT JOIN collaborators c ON c.id = f.collaborator_id
         WHERE f.client_id = $1
         ORDER BY f.size_bytes DESC
        """,
        client_id,
    )

    # Справочник событий — чтобы подставить название событию, найденному по пути.
    event_by_id = {
        e["id"]: {"title": e["title"], "module_slug": e["module_slug"]}
        for e in await db.fetch(
            """SELECT e.id, e.title, e.module_slug FROM events e
                JOIN event_owners eo ON eo.event_id = e.id
               WHERE eo.client_id = $1 AND eo.status = 'accepted'""",
            client_id,
        )
    }

    # Запись эфира привязана к событию не через client_files, а через комнату.
    rec_map = {
        r["url"]: (r["event_id"], r["event_title"], r["day_number"])
        for r in await db.fetch(
            """
            SELECT rec.url, wr.event_id, e.title AS event_title, wr.day_number
              FROM webinar_recordings rec
              JOIN webinar_rooms wr ON wr.id = rec.room_id
              JOIN events e         ON e.id = wr.event_id
             WHERE rec.url IS NOT NULL
            """
        )
    }

    # У файлов, залитых вручную мимо кабинета (kind='untracked'), связей в БД нет —
    # но путь в бакете почти всегда говорит, что это. Разбираем его, иначе клиент
    # видит сотни строк «Загружен вручную» без единой подсказки, что это за файлы.
    import re as _re

    def _guess_from_key(key: str):
        """(kind, event_id, collaborator_id) по пути в бакете. None — не угадали."""
        if not key:
            return None, None, None
        m = _re.search(r"/events/(\d+)/posters/", key)
        if m:
            return "event_poster", int(m.group(1)), None
        m = _re.search(r"/events/(\d+)/videos/", key)
        if m:
            return "event_video", int(m.group(1)), None
        m = _re.search(r"/events/(\d+)/landing/", key)
        if m:
            return "landing_media", int(m.group(1)), None
        m = _re.search(r"/events/(\d+)/", key)
        if m:
            return None, int(m.group(1)), None
        m = _re.search(r"/(?:speakers|collaborators)/(\d+)/", key)
        if m:
            return "speaker_photo", None, int(m.group(1))
        if "/webinar/" in key:
            return "webinar_recording", None, None
        if "/cases/" in key:
            return "landing_media", None, None
        if "/products/" in key:
            return "product_media", None, None
        if key.startswith("lessons/"):
            return "material_media", None, None
        return None, None, None

    files = []
    for r in rows:
        kind = r["kind"]
        size = int(r["size_bytes"])
        event_id, event_title = r["event_id"], r["event_title"]
        module = r["event_module"]
        collaborator_id = r["collaborator_id"]
        link = None

        if kind == "untracked":
            g_kind, g_event, g_collab = _guess_from_key(r["r2_key"] or "")
            if g_kind:
                kind = g_kind
            if g_event and not event_id:
                event_id = g_event
                ev = event_by_id.get(g_event)
                if ev:
                    event_title, module = ev["title"], ev["module_slug"]
            if g_collab and not collaborator_id:
                collaborator_id = g_collab

        # Запись эфира: событие берём из комнаты вебинара.
        if r["url"] in rec_map:
            event_id, event_title, _day = rec_map[r["url"]]
            module = module or "conference"
            kind = "webinar_recording"

        if event_id:
            base = "/dashboard/conferences" if module in ("conference", "turnir") else "/dashboard/events"
            tab = _KIND_TAB.get(kind)
            link = f"{base}/{event_id}" + (f"?tab={tab}" if tab else "")
            place = event_title or f"Событие #{event_id}"
        elif r["product_id"]:
            link = f"/dashboard/products/{r['product_id']}"
            place = "Продукт"
        elif kind in ("brand_photo", "brand_logo", "owner_photo"):
            link = "/dashboard/mini-app"
            place = "Профиль и бренд"
        elif kind in ("broadcast_photo", "broadcast_video"):
            link = "/dashboard/broadcasts"
            place = "Рассылки"
        elif kind in ("lead_magnet", "funnel_media"):
            link = "/dashboard/lead-magnets"
            place = "Подарки и воронки"
        elif kind == "survey_media":
            link = "/dashboard/surveys"
            place = "Анкеты"
        elif kind == "dialog_media":
            link = "/dashboard/clients"
            place = "Переписки"
        elif collaborator_id:
            link = f"/dashboard/collaborations/{collaborator_id}"
            place = r["collaborator_name"] or "Спикер"
        else:
            place = "Без привязки"

        files.append({
            "id": r["id"],
            "kind": kind,
            "kind_label": _KIND_LABEL.get(kind, kind),
            "url": r["url"],
            "size_bytes": size,
            "size_human": _human_bytes(size),
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "place": place,
            "event_id": event_id,
            "event_title": event_title,
            "link": link,
            "is_temp": kind in ("broadcast_photo", "broadcast_video"),
        })

    # Сводка по местам — что именно съедает объём.
    groups: dict = {}
    for f in files:
        g = groups.setdefault(f["place"], {"place": f["place"], "link": f["link"],
                                           "count": 0, "size_bytes": 0})
        g["count"] += 1
        g["size_bytes"] += f["size_bytes"]
    for g in groups.values():
        g["size_human"] = _human_bytes(g["size_bytes"])

    by_kind: dict = {}
    for f in files:
        k = by_kind.setdefault(f["kind_label"], {"label": f["kind_label"], "count": 0, "size_bytes": 0})
        k["count"] += 1
        k["size_bytes"] += f["size_bytes"]
    for k in by_kind.values():
        k["size_human"] = _human_bytes(k["size_bytes"])

    return {
        "files": files,
        "groups": sorted(groups.values(), key=lambda x: -x["size_bytes"]),
        "by_kind": sorted(by_kind.values(), key=lambda x: -x["size_bytes"]),
        "total_files": len(files),
        "total_bytes": sum(f["size_bytes"] for f in files),
    }


# Публичный (без авторизации) — блок «Подключите своё хранилище» в настройках.
# Ссылка живёт в переменной окружения STORAGE_PROMO_URL: партнёрская ссылка
# меняется, и менять её деплоем фронта неправильно. Пусто → фронт блок не рисует.
public_router = APIRouter(prefix="/public", tags=["Загрузка файлов"])


@public_router.get("/storage-promo", summary="Промо своего файлового хранилища")
async def storage_promo():
    from app.config import settings as _s
    return {
        "ref_url": _s.storage_promo_url or "",
        "free_gb": int(_s.storage_promo_free_gb or 0),
    }
