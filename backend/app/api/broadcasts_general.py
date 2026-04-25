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
    photo_url: Optional[str] = None
    buttons: List[ButtonItem] = []
    is_test: bool = False


class BulkItem(BaseModel):
    fire_at: str
    text: str
    photo_url: Optional[str] = None
    buttons: List[ButtonItem] = []


class BulkAddRequest(BaseModel):
    items: List[BulkItem]
    is_test: bool = False
    dry_run: bool = False


# ─── Хелперы ─────────────────────────────────────────────────────────────

def _parse_fire_at(s: str, tz: ZoneInfo) -> datetime:
    dt_naive = datetime.fromisoformat(s)
    if dt_naive.tzinfo is None:
        dt_aware = dt_naive.replace(tzinfo=tz)
    else:
        dt_aware = dt_naive
    return dt_aware.astimezone(ZoneInfo("UTC"))


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
    if u and not _re.match(r"^(https?://|tg://|mailto:|tel:)", u):
        if _re.search(r"<[^>]+>", u) or _re.search(r"\s", u):
            errs.append("в поле ссылки указан текст вместо URL — должно быть https://...")
        else:
            errs.append("ссылка должна начинаться с https:// или http://")
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
               audience_include, audience_exclude, started_at, finished_at,
               error_log, snapshot_text, snapshot_photo, snapshot_buttons,
               CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (finished_at - started_at))::int
                    ELSE NULL END as duration_seconds,
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = broadcast_schedules.id AND bl.status = 'failed') as recipients_failed
        FROM broadcast_schedules
        WHERE client_id=$1 AND event_id IS NULL
        ORDER BY fire_at NULLS LAST
        """,
        client_id
    )
    now_utc = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC"))
    result = []
    for r in rows:
        d = dict(r)
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
    buttons = [{"text": b.text.strip(), "url": b.url.strip()} for b in data.buttons if b.text.strip() and b.url.strip()]
    row = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, client_id, template_id, type, session_id, fire_at, status, is_test,
           audience_include, audience_exclude,
           snapshot_text, snapshot_photo, snapshot_buttons)
        VALUES (NULL, $1, NULL, 'custom', NULL, $2, 'pending', $3, 'all_client', 'none',
                $4, $5, $6::jsonb)
        RETURNING id, fire_at, status
        """,
        client_id, dt_utc, data.is_test, data.text, data.photo_url, _json.dumps(buttons)
    )
    return dict(row)


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
        if errs:
            errors_by_idx.append({"index": idx, "errors": errs})
        parsed.append({
            "dt_utc": dt_utc,
            "text": it.text,
            "photo_url": it.photo_url,
            "buttons": [{"text": b.text.strip(), "url": b.url.strip()} for b in it.buttons if b.text.strip() and b.url.strip()],
        })
    if errors_by_idx:
        return {"ok": False, "errors": errors_by_idx, "total": len(data.items)}
    if data.dry_run:
        return {"ok": True, "errors": [], "total": len(data.items), "dry_run": True}
    created_ids = []
    async with db.transaction():
        for p in parsed:
            row = await db.fetchrow(
                """
                INSERT INTO broadcast_schedules
                  (event_id, client_id, template_id, type, session_id, fire_at, status, is_test,
                   audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_buttons)
                VALUES (NULL, $1, NULL, 'custom', NULL, $2, 'pending', $3, 'all_client', 'none',
                        $4, $5, $6::jsonb)
                RETURNING id
                """,
                client_id, p["dt_utc"], data.is_test, p["text"], p["photo_url"], _json.dumps(p["buttons"])
            )
            created_ids.append(row["id"])
    return {"ok": True, "errors": [], "created": len(created_ids), "ids": created_ids}


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
        "buttons": snap_btns or [],
    }
    tz = await _client_tz(db, client_id)
    content = await build_message_content(
        conn=db, tpl_type="custom", tmpl_text="", photo_url=None,
        btn_text=None, btn_url="", event_id=None, session_id=None,
        fire_at=row["fire_at"], tz=tz, template_id=None, snapshot=snap,
    )
    return {
        "text": content["text"],
        "photo": content["photo"],
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
        SELECT bl.platform_user_id, bl.status, bl.error, bl.sent_at,
               pu.first_name, pu.last_name, pu.username, pu.platform_user_id as tg_id
        FROM broadcast_log bl
        LEFT JOIN platform_users pu ON pu.id = bl.platform_user_id
        WHERE bl.schedule_id = $1
        ORDER BY bl.sent_at
        """,
        schedule_id
    )
    return {"log": [dict(r) for r in rows]}


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
    new = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, client_id, template_id, type, session_id, fire_at, status, is_test,
           audience_include, audience_exclude,
           snapshot_text, snapshot_photo, snapshot_buttons)
        VALUES (NULL, $1, NULL, 'custom', NULL, $2, 'draft', $3, 'all_client', 'none',
                $4, $5, $6::jsonb)
        RETURNING id
        """,
        client_id, full["fire_at"], full["is_test"],
        full["snapshot_text"], full["snapshot_photo"],
        full["snapshot_buttons"] if isinstance(full["snapshot_buttons"], str) else _json.dumps(full["snapshot_buttons"] or [])
    )
    return {"ok": True, "id": new["id"]}


class FireAtUpdate(BaseModel):
    fire_at: str
    is_test: Optional[bool] = None


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
