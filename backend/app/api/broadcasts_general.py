"""
Общие рассылки клиента (не привязанные к событию).
event_id у этих рассылок NULL, client_id заполнен.
Поддерживаются только произвольные сообщения и пакетная загрузка.
Аудитория всегда — all_client (вся база клиента).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from zoneinfo import ZoneInfo
import asyncpg
import json as _json

from app.database import get_db
from app.auth import get_current_client
from app.services.message_builder import build_message_content


router = APIRouter(prefix="/broadcasts", tags=["Общие рассылки"])


# ─── Pydantic модели ─────────────────────────────────────────────────────

class ButtonItem(BaseModel):
    text: str
    url: str


class AddCustomRequest(BaseModel):
    fire_at: str
    text: str
    subject: Optional[str] = None  # Email Subject + жирная первая строка для TG/VK/MAX
    photo_url: Optional[str] = None
    video_url: Optional[str] = None       # видео для рассылки (Telegram — встроенный плеер)
    media_type: Optional[str] = None      # None | 'photo' | 'video'
    buttons: List[ButtonItem] = []
    is_test: bool = False
    # Каналы для отправки: NULL/None = все каналы клиента (default),
    # [] = никуда не слать, [N,M] = только эти channel_id.
    target_channel_ids: Optional[List[int]] = None
    # Фильтр по тегам контактов (миграция 265): взять только тех, у кого есть
    # ХОТЯ БЫ ОДИН тег из include, и выбросить тех, у кого есть любой из exclude.
    # Пусто = фильтр не применяется.
    audience_tags_include: Optional[List[str]] = None
    audience_tags_exclude: Optional[List[str]] = None
    # Слать также в общие чаты клиента (client_broadcast_chats, is_private=FALSE).
    send_to_client_chats: bool = False
    # Слать также в личные каналы клиента (client_broadcast_chats, is_private=TRUE).
    send_to_private_chats: bool = False


class BulkItem(BaseModel):
    fire_at: str
    text: str
    subject: Optional[str] = None
    photo_url: Optional[str] = None
    video_url: Optional[str] = None
    media_type: Optional[str] = None
    buttons: List[ButtonItem] = []
    target_channel_ids: Optional[List[int]] = None
    # Аудитория на конкретную рассылку (для общих по умолчанию all_client).
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    # Фильтр по тегам контактов (миграция 265): включить / исключить.
    # Семантика «любой из» — как в фильтре контактов кабинета.
    audience_tags_include: Optional[List[str]] = None
    audience_tags_exclude: Optional[List[str]] = None
    send_to_client_chats: Optional[bool] = None
    send_to_private_chats: Optional[bool] = None


class BulkAddRequest(BaseModel):
    items: List[BulkItem]
    is_test: bool = False
    dry_run: bool = False
    # enqueue=True → создать сразу в очередь (status='pending'), иначе черновики (draft).
    enqueue: bool = False


# ─── Хелперы ─────────────────────────────────────────────────────────────

def _parse_fire_at(s: str, tz: ZoneInfo) -> datetime:
    dt_naive = datetime.fromisoformat(s)
    if dt_naive.tzinfo is None:
        dt_aware = dt_naive.replace(tzinfo=tz)
    else:
        dt_aware = dt_naive
    return dt_aware.astimezone(ZoneInfo("UTC"))


# Люфт для «отправить немедленно» (фронт ставит now−1мин, чтобы уйти сразу).
# Всё, что раньше now минус этот люфт, считаем ошибочно-прошедшей датой.
_PAST_GRACE_MIN = 5


def _assert_fire_at_not_past(fire_at_utc: datetime) -> None:
    """Защита от ошибочной отправки: рассылку с датой в прошлом ставить в очередь нельзя.

    Без этого скопированная старая рассылка с fire_at в прошлом при сохранении
    мгновенно уходит (Celery берёт fire_at <= NOW()). Люфт _PAST_GRACE_MIN —
    чтобы легитимное «отправить немедленно» (now−1мин) не блокировалось.
    """
    from datetime import timedelta
    now_utc = datetime.now(ZoneInfo("UTC"))
    if fire_at_utc < now_utc - timedelta(minutes=_PAST_GRACE_MIN):
        raise HTTPException(
            status_code=400,
            detail="Дата отправки уже прошла. Укажите будущее время — иначе рассылка ушла бы сразу. "
                   "Отредактируйте дату и сохраните заново.",
        )


_TG_ALLOWED_TAGS = {"b","strong","i","em","u","ins","s","strike","del","a","code","pre","blockquote","tg-spoiler","span","br"}
_TG_SELF_CLOSING = {"br"}


def validate_telegram_html(text: str) -> list:
    """Простая проверка HTML-разметки сообщения для Telegram.
    Возвращает список ошибок (пустой = всё ок). Зеркалит web/src/lib/validateTelegramHtml.ts.
    """
    import re as _re
    errors = []
    if not text:
        return errors
    stack = []
    for m in _re.finditer(r"<\s*(/?)\s*([a-zA-Z][\w-]*)\b([^>]*?)(/?)\s*>", text):
        is_close = m.group(1) == "/"
        name = m.group(2).lower()
        attrs = m.group(3) or ""
        self_close = m.group(4) == "/" or name in _TG_SELF_CLOSING
        if name not in _TG_ALLOWED_TAGS:
            errors.append(f"Тег <{name}> не поддерживается Telegram")
            continue
        if is_close:
            if not stack:
                errors.append(f"Закрывающий </{name}> без открытия")
                continue
            top = stack[-1]
            if top != name:
                errors.append(f"Тег <{top}> не закрыт — встречен </{name}>")
                stack.pop()
                continue
            stack.pop()
        elif not self_close:
            if name == "a" and not _re.search(r"href\s*=\s*[\"'][^\"']+[\"']", attrs):
                errors.append('У <a> обязателен href="..."')
            stack.append(name)
    for t in stack:
        errors.append(f"Тег <{t}> открыт, но не закрыт")
    return errors


def validate_button_pair(text: str, url: str) -> list:
    """Проверка одной inline-кнопки. Зеркалит web/src/lib/validateTelegramHtml.ts"""
    import re as _re
    errs = []
    t = (text or "").strip()
    u = (url or "").strip()
    if not t:
        errs.append("пустой текст кнопки")
    if not u:
        errs.append("пустая ссылка кнопки")
    if t and _re.search(r"<[^>]+>", t):
        errs.append("в тексте кнопки нельзя использовать HTML-теги")
    # Плейсхолдер-ссылка ({stream_url}/{landing_url}/{vip_url}/{event_chat_tg}…) раскроется
    # на сервере в реальный URL — считаем валидной.
    is_placeholder_url = bool(_re.match(r"^\{[a-z_]+\}", u)) and not _re.search(r"\s", u)
    if u and not is_placeholder_url and not _re.match(r"^(https?://|tg://|mailto:|tel:)", u):
        if _re.search(r"<[^>]+>", u) or _re.search(r"\s", u):
            errs.append("в поле ссылки указан текст вместо URL — должно быть https://...")
        else:
            errs.append("ссылка должна начинаться с https:// или быть плейсхолдером {stream_url}")
    return errs


def _validate_item(item: dict) -> list:
    errors = []
    if not item.get("fire_at"):
        errors.append("не указано время (fire_at)")
    text = (item.get("text") or "").strip()
    if not text:
        errors.append("пустой текст")
    else:
        html_errs = validate_telegram_html(text)
        for e in html_errs:
            errors.append(f"HTML: {e}")
    btns = item.get("buttons") or []
    if len(btns) > 3:
        errors.append(f"кнопок {len(btns)}, максимум 3")
    for i, b in enumerate(btns, 1):
        if not isinstance(b, dict):
            errors.append(f"кнопка #{i}: некорректный формат")
            continue
        for e in validate_button_pair(b.get("text"), b.get("url")):
            errors.append(f"кнопка #{i}: {e}")
    return errors


def _resolve_media(photo_url: Optional[str], video_url: Optional[str],
                   media_type: Optional[str]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Нормализует медиа рассылки → (snapshot_photo, snapshot_video, snapshot_media_type).

    Источник истины — media_type. Если 'video' и есть video_url → видео.
    Если 'photo' (или не указан, но есть photo_url) → фото. Иначе медиа нет.
    Чистим взаимоисключающие поля, чтобы в БД не лежало и фото, и видео сразу.
    """
    mt = (media_type or "").strip().lower() or None
    p = (photo_url or "").strip() or None
    v = (video_url or "").strip() or None
    if mt == "video" and v:
        return None, v, "video"
    if mt == "photo" and p:
        return p, None, "photo"
    # media_type не задан явно — выводим из наличия URL (обратная совместимость).
    if mt is None and v:
        return None, v, "video"
    if mt is None and p:
        return p, None, "photo"
    return None, None, None


async def _client_tz(db, client_id: int) -> ZoneInfo:
    row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    return ZoneInfo((row["timezone"] or "Europe/Moscow") if row else "Europe/Moscow")


async def _check_owner(db, schedule_id: int, client_id: int):
    row = await db.fetchrow(
        "SELECT id, client_id, event_id FROM broadcast_schedules WHERE id=$1",
        schedule_id
    )
    if not row:
        raise HTTPException(404, "Не найдено")
    if row["event_id"] is not None or row["client_id"] != client_id:
        raise HTTPException(403, "Нет доступа")
    return row


# ─── Endpoints ────────────────────────────────────────────────────────────

@router.get("/schedules", summary="Очередь общих рассылок клиента")
async def list_schedules(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    tz = await _client_tz(db, client_id)

    rows = await db.fetch(
        """
        SELECT id, type, fire_at, status, recipients_sent, is_test,
               -- «Дошло» — реальные доставки из broadcast_log, не ненадёжный
               -- счётчик recipients_sent (расходится при ретраях/доотправке).
               COALESCE(
                 (SELECT COUNT(*) FROM broadcast_log bl
                   WHERE bl.schedule_id = broadcast_schedules.id AND bl.status = 'sent'),
                 0
               ) AS log_sent,
               audience_include, audience_exclude, started_at, finished_at,
               audience_tags_include, audience_tags_exclude,
               error_log, snapshot_text, snapshot_subject, snapshot_photo, snapshot_buttons,
               snapshot_video, snapshot_media_type,
               target_channel_ids, send_to_client_chats, send_to_private_chats,
               CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (finished_at - started_at))::int
                    ELSE NULL END as duration_seconds,
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = broadcast_schedules.id AND bl.status = 'failed') as recipients_failed,
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = broadcast_schedules.id AND bl.status = 'bounced') as recipients_bounced,
               -- Сколько сообщений можно отозвать = записей с сохранённым message_id.
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = broadcast_schedules.id
                  AND bl.external_message_id IS NOT NULL AND bl.external_message_id <> '') as recallable_count,
               -- агрегаты по email-аналитике: уникальные получатели, открывшие/кликнувшие
               (SELECT COUNT(DISTINCT eo.broadcast_log_id)
                  FROM email_open_log eo JOIN broadcast_log bl ON bl.id = eo.broadcast_log_id
                 WHERE bl.schedule_id = broadcast_schedules.id) AS email_opens_total,
               (SELECT COUNT(DISTINCT ec.broadcast_log_id)
                  FROM email_click_log ec JOIN broadcast_log bl ON bl.id = ec.broadcast_log_id
                 WHERE bl.schedule_id = broadcast_schedules.id) AS email_clicks_total
        FROM broadcast_schedules
        WHERE client_id=$1 AND event_id IS NULL
        -- ⚠️ NULLS FIRST, а не LAST: копия рассылки создаётся БЕЗ даты
        -- (fire_at=NULL), и при NULLS LAST она уезжала в самый конец списка —
        -- человек нажимал «Копировать» и не понимал, куда делась копия.
        -- Рассылки без даты требуют действия, поэтому им место сверху.
        ORDER BY fire_at NULLS FIRST
        """,
        client_id
    )
    now_utc = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC"))
    result = []
    for r in rows:
        d = dict(r)
        # «Дошло» = реальные доставки из broadcast_log (см. SELECT log_sent).
        log_sent = d.pop("log_sent", 0) or 0
        if log_sent > 0:
            d["recipients_sent"] = log_sent
        if r["fire_at"]:
            fire_local = r["fire_at"].astimezone(tz)
            d["fire_at_local"] = fire_local.strftime("%d.%m.%Y %H:%M")
            d["fire_at_iso"] = r["fire_at"].isoformat()
        if r["fire_at"] and r["status"] in ("pending", "draft"):
            diff = (r["fire_at"] - now_utc).total_seconds()
            d["seconds_until"] = max(0, int(diff))
        else:
            d["seconds_until"] = None
        if r["status"] == "running" and r.get("started_at"):
            started = r["started_at"]
            if started.tzinfo is None:
                started = started.replace(tzinfo=ZoneInfo("UTC"))
            d["seconds_running"] = max(0, int((now_utc - started).total_seconds()))
        else:
            d["seconds_running"] = None
        # Превью текста и количества кнопок
        snap_btns = d.get("snapshot_buttons")
        if isinstance(snap_btns, str):
            try: snap_btns = _json.loads(snap_btns)
            except: snap_btns = []
        d["buttons_count"] = len(snap_btns or [])
        d["template_type"] = "custom"
        result.append(d)
    return {"schedules": result, "timezone": str(tz)}


@router.post("/schedules/add-custom", summary="Добавить произвольную рассылку клиента")
async def add_custom(
    data: AddCustomRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    errors = _validate_item(data.model_dump())
    if errors:
        raise HTTPException(400, "; ".join(errors))
    tz = await _client_tz(db, client_id)
    try:
        dt_utc = _parse_fire_at(data.fire_at, tz)
    except Exception:
        raise HTTPException(400, "Неверный формат даты")
    _assert_fire_at_not_past(dt_utc)
    buttons = [{"text": b.text.strip(), "url": b.url.strip()} for b in data.buttons if b.text.strip() and b.url.strip()]
    snap_photo, snap_video, snap_mtype = _resolve_media(data.photo_url, data.video_url, data.media_type)
    row = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, client_id, template_id, type, session_id, fire_at, status, is_test,
           audience_include, audience_exclude,
           snapshot_text, snapshot_subject, snapshot_photo, snapshot_buttons, target_channel_ids,
           snapshot_video, snapshot_media_type, send_to_client_chats, send_to_private_chats,
           audience_tags_include, audience_tags_exclude)
        VALUES (NULL, $1, NULL, 'custom', NULL, $2, 'pending', $3, 'all_client', 'none',
                $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id, fire_at, status
        """,
        client_id, dt_utc, data.is_test, data.text,
        (data.subject or None), snap_photo, _json.dumps(buttons),
        data.target_channel_ids, snap_video, snap_mtype, data.send_to_client_chats,
        data.send_to_private_chats,
        (data.audience_tags_include or None), (data.audience_tags_exclude or None),
    )
    return dict(row)


class AudienceCountRequest(BaseModel):
    audience_tags_include: Optional[List[str]] = None
    audience_tags_exclude: Optional[List[str]] = None


@router.post("/audience-count", summary="Сколько человек попадёт в рассылку по фильтру тегов")
async def audience_count(
    data: AudienceCountRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Предпросмотр охвата ДО отправки: сколько контактов пройдёт фильтр по тегам.

    Считаем по contact_id (а не по идентичностям), чтобы цифра совпадала с тем,
    что клиент видит в разделе Контакты: один человек = один контакт, даже если
    у него и TG, и VK, и email. Реальная доставка идёт по платформам и может быть
    меньше — у части контактов нет ни одной подписки.
    """
    inc = data.audience_tags_include or []
    exc = data.audience_tags_exclude or []
    client_id = int(client["sub"])
    where = ["ct.client_id = $1", "ct.is_active = TRUE"]
    params: list = [client_id]
    if inc:
        params.append(list(inc))
        where.append(f"jsonb_typeof(ct.tags)='array' AND ct.tags ?| ${len(params)}::text[]")
    if exc:
        params.append(list(exc))
        where.append(
            f"NOT (jsonb_typeof(ct.tags)='array' AND ct.tags ?| ${len(params)}::text[])"
        )
    total = await db.fetchval(
        f"SELECT COUNT(*) FROM contacts ct WHERE {' AND '.join(where)}", *params
    )
    # Из них реально достижимы хотя бы на одной площадке (есть идентичность).
    reachable = await db.fetchval(
        f"""SELECT COUNT(*) FROM contacts ct WHERE {' AND '.join(where)}
            AND EXISTS (SELECT 1 FROM platform_users pu WHERE pu.contact_id = ct.id)""",
        *params
    )
    return {"total": total or 0, "reachable": reachable or 0}


class GeneralTestNowRequest(BaseModel):
    text: str
    subject: Optional[str] = None
    photo_url: Optional[str] = None
    video_url: Optional[str] = None
    media_type: Optional[str] = None
    buttons: List[ButtonItem] = []


@router.post("/schedules/test-now", summary="Отправить тестовую общую рассылку немедленно")
async def general_test_now(
    data: GeneralTestNowRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Шлёт произвольное общее сообщение СРАЗУ на тестовые ID клиента (без очереди)."""
    from app.api.modules.broadcasts import _load_test_targets, _send_content_to_tests
    client_id = int(client["sub"])
    if not (data.text or "").strip():
        raise HTTPException(400, "Пустой текст")
    bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token, tz, test_email_ids = await _load_test_targets(db, client_id)
    snap_photo, snap_video, snap_mtype = _resolve_media(data.photo_url, data.video_url, data.media_type)
    # ⚠️ Заголовок приклеивается первой жирной строкой ТОЛЬКО для TG/VK/MAX —
    # там своего поля темы нет. В письме тема идёт в Subject, а тело должно
    # остаться чистым, иначе заголовок дублируется: и в теме, и в первой
    # строке письма. Так же устроена боевая рассылка (text_for_email).
    text_clean = (data.text or "")
    subject_val = (data.subject or "").strip()
    text = f"<b>{subject_val}</b>\n\n{text_clean}" if subject_val else text_clean
    buttons = [{"text": b.text.strip(), "url": b.url.strip()} for b in data.buttons if b.text.strip() and b.url.strip()]
    content = {
        "text": text,
        "text_email": text_clean,
        "subject": subject_val or None,
        "photo": snap_photo if snap_mtype != "video" else None,
        "video": snap_video if snap_mtype == "video" else None,
        "media_type": snap_mtype,
        "buttons": buttons,
    }
    results = await _send_content_to_tests(content, bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token,
                                           db=db, client_id=client_id, test_email_ids=test_email_ids)
    sent = sum(1 for r in results if r.get("ok"))
    return {"ok": True, "sent": sent, "total": len(results), "results": results}


@router.post("/schedules/bulk-add", summary="Пакетное добавление общих рассылок")
async def bulk_add(
    data: BulkAddRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    tz = await _client_tz(db, client_id)
    errors_by_idx = []
    parsed = []
    for idx, it in enumerate(data.items, 1):
        item_d = it.model_dump()
        errs = _validate_item(item_d)
        dt_utc = None
        if not errs:
            try:
                dt_utc = _parse_fire_at(it.fire_at, tz)
            except Exception:
                errs.append("неверный формат даты")
        # Если ставим сразу в очередь — дата не должна быть в прошлом
        if not errs and data.enqueue and dt_utc is not None:
            from datetime import timedelta
            if dt_utc < datetime.now(ZoneInfo("UTC")) - timedelta(minutes=_PAST_GRACE_MIN):
                errs.append("дата уже прошла — рассылка ушла бы сразу; укажите будущее время")
        if errs:
            errors_by_idx.append({"index": idx, "errors": errs})
        sp, sv, smt = _resolve_media(it.photo_url, it.video_url, it.media_type)
        parsed.append({
            "dt_utc": dt_utc,
            "text": it.text,
            "subject": it.subject,
            "photo_url": sp,
            "video_url": sv,
            "media_type": smt,
            "buttons": [{"text": b.text.strip(), "url": b.url.strip()} for b in it.buttons if b.text.strip() and b.url.strip()],
            "target_channel_ids": it.target_channel_ids,
            "audience_include": it.audience_include or "all_client",
            "audience_exclude": it.audience_exclude or "none",
            "audience_tags_include": it.audience_tags_include or None,
            "audience_tags_exclude": it.audience_tags_exclude or None,
            "send_to_client_chats": bool(it.send_to_client_chats),
            "send_to_private_chats": bool(it.send_to_private_chats),
        })
    if errors_by_idx:
        return {"ok": False, "errors": errors_by_idx, "total": len(data.items)}
    if data.dry_run:
        return {"ok": True, "errors": [], "total": len(data.items), "dry_run": True}

    # Импорт фото по внешним ссылкам в R2 (Google Drive / облака → наш URL).
    # Сбой фото не роняет партию: рассылка создаётся без фото, проблема — в отчёт.
    from app.services.remote_media import import_remote_image_to_r2
    warnings = []
    for i, p in enumerate(parsed, 1):
        if p.get("photo_url"):
            try:
                p["photo_url"] = await import_remote_image_to_r2(client_id, p["photo_url"], db=db)
            except Exception as e:
                warnings.append({"index": i, "message": f"фото не загрузилось — {e}. Рассылка создана без фото."})
                p["photo_url"] = None
                if p.get("media_type") == "photo":
                    p["media_type"] = None

    # enqueue=True → сразу в очередь (pending), иначе черновик (draft).
    new_status = "pending" if data.enqueue else "draft"
    created_ids = []
    async with db.transaction():
        for p in parsed:
            row = await db.fetchrow(
                """
                INSERT INTO broadcast_schedules
                  (event_id, client_id, template_id, type, session_id, fire_at, status, is_test,
                   audience_include, audience_exclude,
                   snapshot_text, snapshot_subject, snapshot_photo, snapshot_buttons, target_channel_ids,
                   snapshot_video, snapshot_media_type, send_to_client_chats, send_to_private_chats,
                   audience_tags_include, audience_tags_exclude)
                VALUES (NULL, $1, NULL, 'custom', NULL, $2, $14, $3, $11, $12,
                        $4, $5, $6, $7::jsonb, $8, $9, $10, $13, $15, $16, $17)
                RETURNING id
                """,
                client_id, p["dt_utc"], data.is_test, p["text"],
                (p["subject"] or None), p["photo_url"],
                _json.dumps(p["buttons"]), p["target_channel_ids"],
                p["video_url"], p["media_type"],
                p["audience_include"], p["audience_exclude"], p["send_to_client_chats"],
                new_status, p["send_to_private_chats"],
                (p.get("audience_tags_include") or None), (p.get("audience_tags_exclude") or None),
            )
            created_ids.append(row["id"])
    return {"ok": True, "errors": [], "created": len(created_ids), "ids": created_ids, "warnings": warnings}


@router.get("/schedules/{schedule_id}/preview")
async def preview(
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    row = await db.fetchrow(
        "SELECT * FROM broadcast_schedules WHERE id=$1", schedule_id
    )
    snap_btns = row.get("snapshot_buttons")
    if isinstance(snap_btns, str):
        try: snap_btns = _json.loads(snap_btns)
        except: snap_btns = []
    snap = {
        "text": row.get("snapshot_text") or "",
        "photo": row.get("snapshot_photo"),
        "video": row.get("snapshot_video"),
        "media_type": row.get("snapshot_media_type"),
        "buttons": snap_btns or [],
    }
    tz = await _client_tz(db, client_id)
    # {support_link} в превью: платформа неизвестна (текст один на все) — показываем
    # все каналы поддержки блоком. При отправке Celery подставит контакт СВОЕЙ площадки.
    from app.api.modules.broadcasts import _support_link_preview
    content = await build_message_content(
        conn=db, tpl_type="custom", tmpl_text="", photo_url=None,
        btn_text=None, btn_url="", event_id=None, session_id=None,
        fire_at=row["fire_at"], tz=tz, template_id=None, snapshot=snap,
        support_link=await _support_link_preview(db, client_id),
    )
    # Заголовок (subject) для TG/VK/MAX уходит первой жирной строкой — показываем
    # это в превью ровно так, как получит подписчик (см. tasks/broadcast.py).
    body_text = content["text"]
    subject_val = (row.get("snapshot_subject") or "").strip()
    preview_text = f"<b>{subject_val}</b>\n\n{body_text}" if subject_val else body_text
    return {
        "subject": subject_val or None,
        "text": preview_text,
        "photo": content["photo"],
        "video": content.get("video"),
        "media_type": content.get("media_type"),
        "buttons": content.get("buttons") or [],
        "template_type": "custom",
    }


@router.get("/schedules/{schedule_id}/log")
async def log(
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    rows = await db.fetch(
        """
        SELECT bl.id AS broadcast_log_id,
               bl.platform_user_id, bl.status, bl.error, bl.sent_at, bl.read_at,
               pu.first_name, pu.last_name, pu.username, pu.platform_user_id as tg_id,
               pu.platform_slug AS user_platform,
               bl.channel_id, ch.handle AS channel_handle, ch.display_name AS channel_name,
               ch.platform_slug AS channel_platform,
               -- email-аналитика (для каналов platform='email' покажется счётчик
               -- открытий и кликов; для прочих платформ останется 0)
               (SELECT COUNT(*) FROM email_open_log eo  WHERE eo.broadcast_log_id = bl.id) AS email_opens,
               (SELECT COUNT(*) FROM email_click_log ec WHERE ec.broadcast_log_id = bl.id) AS email_clicks
        FROM broadcast_log bl
        LEFT JOIN platform_users pu ON pu.id = bl.platform_user_id
        LEFT JOIN channels ch ON ch.id = bl.channel_id
        WHERE bl.schedule_id = $1 AND bl.platform_user_id IS NOT NULL
        ORDER BY bl.sent_at
        """,
        schedule_id
    )
    # Отправки В ЧАТЫ (миграция 220) — отдельным блоком.
    chat_rows = await db.fetch(
        """SELECT status, error, sent_at, chat_kind, chat_platform, chat_ref, chat_title
             FROM broadcast_log
            WHERE schedule_id = $1 AND chat_kind IS NOT NULL
            ORDER BY sent_at""",
        schedule_id,
    )

    from app.services.email_funnel_stats import email_funnel_stats
    return {
        "log": [dict(r) for r in rows],
        "chats": [dict(r) for r in chat_rows],
        "email_stats": await email_funnel_stats(db, schedule_id),
    }


@router.post("/schedules/{schedule_id}/cancel")
async def cancel(
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    await db.execute(
        """UPDATE broadcast_schedules SET status='cancelled', finished_at=COALESCE(finished_at, NOW())
           WHERE id=$1 AND status IN ('pending','draft','running')""",
        schedule_id
    )
    return {"ok": True}


@router.post("/schedules/{schedule_id}/recall")
async def recall(
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Отзыв (удаление у получателей) отправленной рассылки в Telegram.
    Только для сообщений с сохранённым message_id и в пределах 48ч (лимит Telegram)."""
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    from app.services.broadcast_recall import recall_broadcast
    return await recall_broadcast(db, schedule_id)


@router.delete("/schedules/{schedule_id}")
async def delete(
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    await db.execute("DELETE FROM broadcast_schedules WHERE id=$1", schedule_id)
    return {"ok": True}


@router.post("/schedules/{schedule_id}/copy")
async def copy(
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    src = await _check_owner(db, schedule_id, client_id)
    full = await db.fetchrow("SELECT * FROM broadcast_schedules WHERE id=$1", schedule_id)
    # ⚠️ Копия создаётся БЕЗ даты (fire_at=NULL) — чтобы старая дата не утащила
    # рассылку в мгновенную отправку. Клиент обязан указать новую дату при сохранении.
    new = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, client_id, template_id, type, session_id, fire_at, status, is_test,
           audience_include, audience_exclude,
           snapshot_text, snapshot_subject, snapshot_photo, snapshot_buttons, target_channel_ids,
           snapshot_video, snapshot_media_type, send_to_client_chats, send_to_private_chats)
        VALUES (NULL, $1, NULL, 'custom', NULL, NULL, 'draft', $2, 'all_client', 'none',
                $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
        RETURNING id
        """,
        client_id, full["is_test"],
        full["snapshot_text"], full["snapshot_subject"], full["snapshot_photo"],
        full["snapshot_buttons"] if isinstance(full["snapshot_buttons"], str) else _json.dumps(full["snapshot_buttons"] or []),
        full["target_channel_ids"],
        full["snapshot_video"], full["snapshot_media_type"],
        full["send_to_client_chats"], full["send_to_private_chats"],
    )
    return {"ok": True, "id": new["id"]}


@router.post("/schedules/{schedule_id}/publish", summary="Поставить черновик в очередь")
async def publish_schedule(
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Промоут draft → pending. Без правок содержимого. Если рассылка
    запланирована в прошлом — отдаём 400, чтобы клиент выбрал новую дату."""
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    full = await db.fetchrow(
        "SELECT status, fire_at FROM broadcast_schedules WHERE id=$1", schedule_id
    )
    if full["status"] != "draft":
        raise HTTPException(400, "Запустить можно только черновик")
    fire_at = full["fire_at"]
    if fire_at is None:
        raise HTTPException(400, "У рассылки не задана дата отправки — отредактируйте её")
    if fire_at.tzinfo is None:
        fire_at = fire_at.replace(tzinfo=ZoneInfo("UTC"))
    if fire_at <= datetime.utcnow().replace(tzinfo=ZoneInfo("UTC")):
        raise HTTPException(400, "Время уже прошло — отредактируйте дату перед запуском")
    await db.execute(
        "UPDATE broadcast_schedules SET status='pending' WHERE id=$1 AND status='draft'",
        schedule_id
    )
    return {"ok": True}


class FireAtUpdate(BaseModel):
    fire_at: str
    is_test: Optional[bool] = None


class UpdateScheduleRequest(BaseModel):
    fire_at: Optional[str] = None
    is_test: Optional[bool] = None
    text: Optional[str] = None
    subject: Optional[str] = None
    photo_url: Optional[str] = None
    buttons: Optional[List[ButtonItem]] = None
    target_channel_ids: Optional[List[int]] = None
    audience_tags_include: Optional[List[str]] = None
    audience_tags_exclude: Optional[List[str]] = None
    send_to_client_chats: Optional[bool] = None
    send_to_private_chats: Optional[bool] = None


@router.patch("/schedules/{schedule_id}", summary="Обновить содержимое рассылки (draft/pending)")
async def update_schedule(
    schedule_id: int,
    data: UpdateScheduleRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    current_status = await db.fetchval(
        "SELECT status FROM broadcast_schedules WHERE id=$1", schedule_id
    )
    if current_status not in ("draft", "pending"):
        raise HTTPException(400, "Редактировать можно только черновики и запланированные рассылки")

    sets: list[str] = []
    args: list = []
    idx = 1

    if data.fire_at is not None:
        tz = await _client_tz(db, client_id)
        try:
            dt_utc = _parse_fire_at(data.fire_at, tz)
        except Exception:
            raise HTTPException(400, "Неверный формат даты")
        sets.append(f"fire_at=${idx}"); args.append(dt_utc); idx += 1

    if data.is_test is not None:
        sets.append(f"is_test=${idx}"); args.append(data.is_test); idx += 1

    if data.text is not None:
        if not data.text.strip():
            raise HTTPException(400, "Текст не может быть пустым")
        html_errs = validate_telegram_html(data.text)
        if html_errs:
            raise HTTPException(400, "Ошибки в HTML: " + "; ".join(html_errs))
        sets.append(f"snapshot_text=${idx}"); args.append(data.text); idx += 1

    if data.subject is not None:
        sets.append(f"snapshot_subject=${idx}")
        args.append((data.subject or None) if data.subject is not None else None); idx += 1

    if data.photo_url is not None:
        sets.append(f"snapshot_photo=${idx}")
        args.append(data.photo_url or None); idx += 1

    if data.buttons is not None:
        if len(data.buttons) > 3:
            raise HTTPException(400, "Максимум 3 кнопки")
        clean = [{"text": b.text.strip(), "url": b.url.strip()}
                 for b in data.buttons if b.text.strip() and b.url.strip()]
        sets.append(f"snapshot_buttons=${idx}::jsonb"); args.append(_json.dumps(clean)); idx += 1

    if data.target_channel_ids is not None:
        sets.append(f"target_channel_ids=${idx}::int[]")
        args.append(data.target_channel_ids); idx += 1

    # Теги аудитории (миграция 265). Различаем «не прислали» и «прислали пусто»:
    # пустой список = ЯВНАЯ очистка фильтра (иначе снять теги было бы нельзя).
    fs = data.model_fields_set
    if "audience_tags_include" in fs:
        sets.append(f"audience_tags_include=${idx}::text[]")
        args.append(data.audience_tags_include or None); idx += 1
    if "audience_tags_exclude" in fs:
        sets.append(f"audience_tags_exclude=${idx}::text[]")
        args.append(data.audience_tags_exclude or None); idx += 1

    if data.send_to_client_chats is not None:
        sets.append(f"send_to_client_chats=${idx}"); args.append(data.send_to_client_chats); idx += 1

    if data.send_to_private_chats is not None:
        sets.append(f"send_to_private_chats=${idx}"); args.append(data.send_to_private_chats); idx += 1

    if not sets:
        return {"ok": True, "no_change": True}

    # Редактирование переводит в pending (уйдёт по fire_at). Поэтому проверяем,
    # что итоговый fire_at не в прошлом — иначе рассылка ушла бы мгновенно.
    if data.fire_at is not None:
        _assert_fire_at_not_past(dt_utc)  # type: ignore[name-defined]
    else:
        existing_fire = await db.fetchval("SELECT fire_at FROM broadcast_schedules WHERE id=$1", schedule_id)
        if existing_fire is not None:
            _assert_fire_at_not_past(existing_fire)

    # Если редактируется черновик — переводим в pending (как и в set_fire_at).
    sets.append("status='pending'")

    args.append(schedule_id)
    await db.execute(
        f"UPDATE broadcast_schedules SET {', '.join(sets)} WHERE id=${idx} AND status IN ('draft','pending')",
        *args
    )
    return {"ok": True}


@router.put("/schedules/{schedule_id}/fire-at")
async def set_fire_at(
    schedule_id: int,
    data: FireAtUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_owner(db, schedule_id, client_id)
    tz = await _client_tz(db, client_id)
    try:
        dt_utc = _parse_fire_at(data.fire_at, tz)
    except Exception:
        raise HTTPException(400, "Неверный формат даты")
    _assert_fire_at_not_past(dt_utc)
    if data.is_test is not None:
        await db.execute(
            "UPDATE broadcast_schedules SET fire_at=$1, is_test=$2, status='pending' WHERE id=$3 AND status IN ('draft','pending')",
            dt_utc, data.is_test, schedule_id
        )
    else:
        await db.execute(
            "UPDATE broadcast_schedules SET fire_at=$1, status='pending' WHERE id=$2 AND status IN ('draft','pending')",
            dt_utc, schedule_id
        )
    return {"ok": True}
