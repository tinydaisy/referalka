from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
import asyncpg

from app.database import get_db
from app.auth import get_current_client

router = APIRouter(prefix="/events/{event_id}/broadcasts", tags=["Рассылки"])


# ─────────────────────────────────────────
# ШАБЛОНЫ
# ─────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    type: str                        # 'pre_start' | 'gift'
    text: Optional[str] = None
    photo_url: Optional[str] = None
    button_text: Optional[str] = None
    button_url: Optional[str] = None


class TemplateUpdate(TemplateCreate):
    pass


DEFAULT_TEMPLATES = [
    {
        "name": "Анонс спикера (за 5 мин до старта)",
        "type": "pre_start",
        "text": (
            "Через 5 минут выступает {speaker_name}\n\n"
            "Тема: «{speaker_topic}»\n\n"
            "Заходи в эфир, получай полезный контент и находи секретный код для розыгрыша!\n"
            "👇👇👇\n"
            "{stream_url}"
        ),
        "photo_url": None,
        "button_text": "Войти в эфир",
        "button_url": "{stream_url}",
    },
    {
        "name": "Подарок спикера (за 10 мин до конца)",
        "type": "gift",
        "text": (
            "🎁 {speaker_name}: Подарки после эфира\n\n"
            "{gift_title}\n"
            "{gift_url}"
        ),
        "photo_url": None,
        "button_text": None,
        "button_url": None,
    },
    {
        "name": "Знакомство со спикером",
        "type": "speaker_intro",
        "text": (
            "{speaker_name}\n\n"
            "{speaker_tg}\n\n"
            "Тема лекции:\n\n"
            "{speaker_topic}\n\n"
            "{speaker_achievements}\n\n"
            "🎁 На эфире подарит: {gift_after_speech_title}\n\n"
            "🏆 Подарок для большого розыгрыша: {gift_raffle_title}"
        ),
        "photo_url": None,
        "button_text": None,
        "button_url": None,
    },
    {
        "name": "День конференции (за 30 мин до старта)",
        "type": "day_start_30min",
        "text": (
            "Через 30 минут стартует День {day_number} конференции «{conf_title}»\n\n"
            "Сегодня в программе:\n\n"
            "{day_date}\n\n"
            "{day_program}\n\n"
            "Нажимай на кнопку «Войти на конференцию», чтобы попасть в вебинарную комнату.\n\n"
            "При возникновении технических трудностей пишите — @forbs_service2"
        ),
        "photo_url": None,
        "button_text": "Войти в эфир",
        "button_url": "{stream_url}",
    },
    {
        "name": "День конференции (старт эфира)",
        "type": "day_live",
        "text": (
            "Мы начинаем День {day_number} масштабной онлайн-конференции «{conf_title}»\n\n"
            "Подключайтесь в Zoom\n"
            "👇🏻👇🏻👇🏻\n"
            "{stream_url}"
        ),
        "photo_url": None,
        "button_text": "Войти в эфир",
        "button_url": "{stream_url}",
    },
    {
        "name": "День конференции (итоги дня + подарки)",
        "type": "day_end",
        "text": (
            "Благодарим вас за участие в {day_ordinal} дне конференции «{conf_title}»\n\n"
            "Самое время ввести собранные КОДОВЫЕ СЛОВА и получить за них дополнительные билеты для розыгрыша:\n"
            "{raffle_url}\n\n"
            "Встречаемся завтра в {next_day_start_time} на День {next_day_number}.\n\n"
            "—\n\n"
            "А сейчас ловите подарки от спикеров {day_ordinal} дня:\n\n"
            "{day_speakers_gifts}"
        ),
        "photo_url": None,
        "button_text": None,
        "button_url": None,
    },
]


@router.get("/templates", summary="Список шаблонов рассылок")
async def list_templates(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await db.fetch(
        """
        SELECT id, name, type, text, photo_url, button_text, button_url, created_at
        FROM broadcast_templates
        WHERE event_id = $1
        ORDER BY type, created_at
        """,
        event_id
    )

    if not rows:
        for tpl in DEFAULT_TEMPLATES:
            await db.execute(
                """
                INSERT INTO broadcast_templates
                  (client_id, event_id, name, type, text, photo_url, button_text, button_url)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                client_id, event_id, tpl["name"], tpl["type"],
                tpl["text"], tpl["photo_url"], tpl["button_text"], tpl["button_url"],
            )
        rows = await db.fetch(
            """
            SELECT id, name, type, text, photo_url, button_text, button_url, created_at
            FROM broadcast_templates
            WHERE event_id = $1
            ORDER BY type, created_at
            """,
            event_id
        )

    return {"templates": [dict(r) for r in rows]}


@router.post("/templates", summary="Создать шаблон")
async def create_template(
    event_id: int,
    data: TemplateCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates (client_id, event_id, name, type, text, photo_url, button_text, button_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, name, type, text, photo_url, button_text, button_url, created_at
        """,
        client_id, event_id, data.name, data.type,
        data.text, data.photo_url, data.button_text, data.button_url
    )
    return dict(row)


@router.put("/templates/{template_id}", summary="Редактировать шаблон")
async def update_template(
    event_id: int,
    template_id: int,
    data: TemplateUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    row = await db.fetchrow(
        """
        UPDATE broadcast_templates SET
            name = $1, type = $2, text = $3,
            photo_url = $4, button_text = $5, button_url = $6,
            updated_at = NOW()
        WHERE id = $7 AND event_id = $8
        RETURNING id, name, type, text, photo_url, button_text, button_url
        """,
        data.name, data.type, data.text,
        data.photo_url, data.button_text, data.button_url,
        template_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    return dict(row)


@router.delete("/templates/{template_id}", summary="Удалить шаблон")
async def delete_template(
    event_id: int,
    template_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    await db.execute(
        "DELETE FROM broadcast_templates WHERE id = $1 AND event_id = $2",
        template_id, event_id
    )
    return {"ok": True}


# ─────────────────────────────────────────
# РАСПИСАНИЕ РАССЫЛОК
# ─────────────────────────────────────────

@router.get("/schedules", summary="Очередь рассылок")
async def list_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await db.fetch(
        """
        SELECT bs.id, bs.type, bs.fire_at, bs.status,
               bs.recipients_sent, bs.is_test,
               bt.name as template_name,
               cs.title as session_title,
               cs.start_datetime, cs.end_datetime,
               c.name as speaker_name
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        LEFT JOIN conf_sessions cs ON cs.id = bs.session_id
        LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
        LEFT JOIN collaborators c ON c.id = cse.speaker_id
        WHERE bs.event_id = $1
        ORDER BY bs.fire_at
        """,
        event_id
    )

    now = datetime.utcnow()
    result = []
    for r in rows:
        d = dict(r)
        # Считаем секунды до отправки
        if r["fire_at"] and r["status"] == "pending":
            diff = (r["fire_at"].replace(tzinfo=None) - now).total_seconds()
            d["seconds_until"] = max(0, int(diff))
        else:
            d["seconds_until"] = None
        result.append(d)

    return {"schedules": result}


@router.post("/schedules/generate", summary="Создать расписание из программы конференции")
async def generate_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Создаёт записи broadcast_schedules для всех сессий конференции:
    - pre_start: за 5 минут до start_datetime
    - gift: за 10 минут до end_datetime
    Пропускает сессии без спикера или без времени.
    Не создаёт дубли — если рассылка уже есть, пропускает.
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    # Берём шаблоны для этого события
    tmpl_pre = await db.fetchrow(
        "SELECT id FROM broadcast_templates WHERE event_id=$1 AND type='pre_start' LIMIT 1", event_id
    )
    tmpl_gift = await db.fetchrow(
        "SELECT id FROM broadcast_templates WHERE event_id=$1 AND type='gift' LIMIT 1", event_id
    )

    if not tmpl_pre and not tmpl_gift:
        raise HTTPException(status_code=400, detail="Сначала создайте шаблоны рассылок")

    # Берём все сессии с временем и спикером
    sessions = await db.fetch(
        """
        SELECT cs.id, cs.start_datetime, cs.end_datetime, cs.title
        FROM conf_sessions cs
        WHERE cs.event_id = $1
          AND cs.speaker_id IS NOT NULL
          AND cs.start_datetime IS NOT NULL
        ORDER BY cs.start_datetime
        """,
        event_id
    )

    created = 0
    skipped = 0

    for s in sessions:
        # pre_start — за 5 минут до начала
        if tmpl_pre and s["start_datetime"]:
            fire_at = s["start_datetime"] - timedelta(minutes=5)
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND session_id=$2 AND type='pre_start'",
                event_id, s["id"]
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules (event_id, session_id, template_id, type, fire_at, status)
                    VALUES ($1, $2, $3, 'pre_start', $4, 'pending')
                    """,
                    event_id, s["id"], tmpl_pre["id"], fire_at
                )
                created += 1
            else:
                skipped += 1

        # gift — за 10 минут до конца
        if tmpl_gift and s["end_datetime"]:
            fire_at = s["end_datetime"] - timedelta(minutes=10)
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND session_id=$2 AND type='gift'",
                event_id, s["id"]
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules (event_id, session_id, template_id, type, fire_at, status)
                    VALUES ($1, $2, $3, 'gift', $4, 'pending')
                    """,
                    event_id, s["id"], tmpl_gift["id"], fire_at
                )
                created += 1
            else:
                skipped += 1

    return {"ok": True, "created": created, "skipped": skipped}


@router.post("/schedules/{schedule_id}/cancel", summary="Отменить рассылку")
async def cancel_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    await db.execute(
        "UPDATE broadcast_schedules SET status='cancelled' WHERE id=$1 AND event_id=$2 AND status='pending'",
        schedule_id, event_id
    )
    return {"ok": True}


@router.post("/schedules/cancel-all", summary="Отменить все pending рассылки")
async def cancel_all_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    count = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='pending'", event_id
    )
    await db.execute(
        "UPDATE broadcast_schedules SET status='cancelled' WHERE event_id=$1 AND status='pending'", event_id
    )
    return {"ok": True, "cancelled": count}


# ─────────────────────────────────────────
# ТЕСТОВАЯ РАССЫЛКА
# ─────────────────────────────────────────

@router.post("/templates/{template_id}/test", summary="Тестовая рассылка шаблона")
async def test_template(
    event_id: int,
    template_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Для шаблона gift — отправляет сообщение о подарке для каждого спикера дня 1
    по порядку программы на тестовые Telegram ID клиента.
    Для остальных шаблонов — пока возвращает not_implemented.
    """
    import httpx, re

    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    tpl = await db.fetchrow(
        "SELECT * FROM broadcast_templates WHERE id=$1 AND event_id=$2", template_id, event_id
    )
    if not tpl:
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    if tpl["type"] != "gift":
        return {"ok": False, "reason": "not_implemented", "message": "Тестовая отправка пока реализована только для шаблона «Подарок спикера»"}

    # Тестовые ID и bot_token клиента
    client_row = await db.fetchrow(
        "SELECT bot_token, test_telegram_ids FROM clients WHERE id=$1", client_id
    )
    bot_token = (client_row["bot_token"] or "").strip() if client_row else ""
    if not bot_token:
        raise HTTPException(status_code=400, detail="Токен бота не задан в настройках")
    test_ids = client_row["test_telegram_ids"] or []
    if not test_ids:
        raise HTTPException(status_code=400, detail="Тестовые Telegram ID не заданы в настройках")

    # Спикеры дня 1 по порядку программы (только с привязанным спикером)
    sessions = await db.fetch(
        """
        SELECT cs.sort_order, c.name as speaker_name,
               c.personal_tg_username,
               cse.gift_after_speech_title as gift_title,
               cse.gift_after_speech_url as gift_url
        FROM conf_sessions cs
        JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
        JOIN collaborators c ON c.id = cse.speaker_id
        WHERE cs.event_id = $1 AND cs.day = 1 AND cs.speaker_id IS NOT NULL
        ORDER BY cs.sort_order
        """,
        event_id
    )

    def build_gift_message(speaker_name, personal_tg, gift_title, gift_url):
        tg_raw = (personal_tg or "").strip()
        tg_mention = ("@" + tg_raw.lstrip("@")) if tg_raw else ""
        title = (gift_title or "").strip()
        url = (gift_url or "").strip()
        header = f"🎁 {speaker_name}: Подарки после эфира"
        if not title:
            body = f"🎁 Чтобы забрать материалы — пишите в личку {tg_mention}" if tg_mention else "🎁 Чтобы забрать материалы — напишите спикеру в личку"
        elif not url:
            body = f"{title}\nПишите в личку {tg_mention}" if tg_mention else title
        else:
            body = f"{title}\n{url}"
        return f"{header}\n\n{body}"

    results = []
    async with httpx.AsyncClient(timeout=15) as http:
        for s in sessions:
            text = build_gift_message(s["speaker_name"], s["personal_tg_username"], s["gift_title"], s["gift_url"])
            speaker_results = []
            for chat_id in test_ids:
                resp = await http.post(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
                )
                r = resp.json()
                speaker_results.append({"chat_id": chat_id, "ok": r.get("ok"), "error": r.get("description")})
            results.append({"speaker": s["speaker_name"], "results": speaker_results})

    return {"ok": True, "sent": len(sessions), "details": results}


# ─────────────────────────────────────────
# Хелпер
# ─────────────────────────────────────────
async def _check_event(db, event_id: int, client_id: int):
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id=$1 AND client_id=$2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
