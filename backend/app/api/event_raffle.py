"""
Розыгрыш на событии — настройки, призы, кодовые слова.

Используется в дашборде клиента (карточка события → вкладка Розыгрыш)
и в Mini App (общая вкладка 🎟 Розыгрыш).

API:
  Settings:
    GET   /api/v1/events/{event_id}/raffle/settings
    PUT   /api/v1/events/{event_id}/raffle/settings
  Prizes:
    GET   /api/v1/events/{event_id}/raffle/prizes
    POST  /api/v1/events/{event_id}/raffle/prizes
    PATCH /api/v1/events/{event_id}/raffle/prizes/{prize_id}
    DELETE /api/v1/events/{event_id}/raffle/prizes/{prize_id}
  Keywords:
    GET   /api/v1/events/{event_id}/raffle/keywords
    POST  /api/v1/events/{event_id}/raffle/keywords
    PATCH /api/v1/events/{event_id}/raffle/keywords/{kw_id}
    DELETE /api/v1/events/{event_id}/raffle/keywords/{kw_id}

Создано миграцией 042 (event_raffle_settings, event_raffle_prizes, event_raffle_keywords).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime
import asyncpg
import httpx
import logging

from app.database import get_db
from app.auth import get_current_client
from app.services.channels import get_client_telegram_token
from app.config import settings as app_settings

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/events/{event_id}/raffle", tags=["Розыгрыш события"])


async def _check_event_access(db, client_id: int, event_id: int):
    row = await db.fetchrow("SELECT id FROM events WHERE id = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')", event_id, client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


# ─────── SETTINGS ───────
class RaffleSettingsIn(BaseModel):
    is_enabled: bool = False
    draw_at: Optional[datetime] = None
    subscription_grants_starter_ticket: bool = True
    intro_text: Optional[str] = None


@router.get("/settings", summary="Настройки розыгрыша на событии")
async def get_settings(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    row = await db.fetchrow(
        "SELECT is_enabled, draw_at, subscription_grants_starter_ticket, intro_text FROM event_raffle_settings WHERE event_id = $1",
        event_id,
    )
    if not row:
        return {"is_enabled": False, "draw_at": None, "subscription_grants_starter_ticket": True, "intro_text": None}
    return dict(row)


@router.put("/settings", summary="Сохранить настройки розыгрыша")
async def upsert_settings(
    event_id: int,
    data: RaffleSettingsIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    row = await db.fetchrow(
        """INSERT INTO event_raffle_settings (event_id, is_enabled, draw_at, subscription_grants_starter_ticket, intro_text)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (event_id) DO UPDATE SET
              is_enabled = EXCLUDED.is_enabled,
              draw_at = EXCLUDED.draw_at,
              subscription_grants_starter_ticket = EXCLUDED.subscription_grants_starter_ticket,
              intro_text = EXCLUDED.intro_text,
              updated_at = NOW()
           RETURNING is_enabled, draw_at, subscription_grants_starter_ticket, intro_text""",
        event_id, data.is_enabled, data.draw_at, data.subscription_grants_starter_ticket, data.intro_text,
    )
    return dict(row)


# ─────── PRIZES ───────
class PrizeIn(BaseModel):
    title: str
    description: Optional[str] = None
    icon_emoji: Optional[str] = None
    icon_url: Optional[str] = None
    places_count: int = 1
    value_label: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True


class PrizePatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    icon_emoji: Optional[str] = None
    icon_url: Optional[str] = None
    places_count: Optional[int] = None
    value_label: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


@router.get("/prizes", summary="Призы розыгрыша")
async def list_prizes(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """SELECT id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active
             FROM event_raffle_prizes WHERE event_id = $1 ORDER BY sort_order, id""",
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/prizes", summary="Создать приз")
async def create_prize(
    event_id: int,
    data: PrizeIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    row = await db.fetchrow(
        """INSERT INTO event_raffle_prizes
           (event_id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active""",
        event_id, data.title, data.description, data.icon_emoji, data.icon_url,
        data.places_count, data.value_label, data.sort_order, data.is_active,
    )
    return dict(row)


@router.patch("/prizes/{prize_id}", summary="Обновить приз")
async def update_prize(
    event_id: int,
    prize_id: int,
    data: PrizePatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    sets, args = [], []
    for f in ("title","description","icon_emoji","icon_url","places_count","value_label","sort_order","is_active"):
        v = getattr(data, f)
        if v is not None:
            sets.append(f"{f} = ${len(args)+1}")
            args.append(v)
    if not sets:
        raise HTTPException(400, "Нечего обновлять")
    args.extend([prize_id, event_id])
    row = await db.fetchrow(
        f"""UPDATE event_raffle_prizes SET {', '.join(sets)}, updated_at = NOW()
            WHERE id = ${len(args)-1} AND event_id = ${len(args)}
            RETURNING id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active""",
        *args,
    )
    if not row:
        raise HTTPException(404, "Приз не найден")
    return dict(row)


@router.delete("/prizes/{prize_id}", summary="Удалить приз")
async def delete_prize(event_id: int, prize_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    res = await db.execute("DELETE FROM event_raffle_prizes WHERE id = $1 AND event_id = $2", prize_id, event_id)
    if res.endswith(" 0"):
        raise HTTPException(404, "Приз не найден")
    return {"ok": True}


# ─────── KEYWORDS ───────
class KeywordIn(BaseModel):
    keyword: str
    sort_order: int = 0
    is_active: bool = True


class KeywordPatch(BaseModel):
    keyword: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


@router.get("/keywords", summary="Кодовые слова розыгрыша")
async def list_keywords(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """SELECT id, keyword, sort_order, is_active
             FROM event_raffle_keywords WHERE event_id = $1 ORDER BY sort_order, id""",
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/keywords", summary="Создать кодовое слово")
async def create_keyword(
    event_id: int,
    data: KeywordIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    kw = data.keyword.strip()
    if not kw:
        raise HTTPException(400, "keyword обязателен")
    try:
        row = await db.fetchrow(
            """INSERT INTO event_raffle_keywords
               (event_id, keyword, keyword_lower, sort_order, is_active)
               VALUES ($1,$2,$3,$4,$5)
               RETURNING id, keyword, sort_order, is_active""",
            event_id, kw, kw.lower(), data.sort_order, data.is_active,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "Это кодовое слово уже добавлено")
    return dict(row)


@router.patch("/keywords/{kw_id}", summary="Обновить кодовое слово")
async def update_keyword(
    event_id: int,
    kw_id: int,
    data: KeywordPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    sets, args = [], []
    for f in ("sort_order","is_active"):
        v = getattr(data, f)
        if v is not None:
            sets.append(f"{f} = ${len(args)+1}")
            args.append(v)
    if data.keyword is not None:
        kw = data.keyword.strip()
        sets.append(f"keyword = ${len(args)+1}");        args.append(kw)
        sets.append(f"keyword_lower = ${len(args)+1}");  args.append(kw.lower())
    if not sets:
        raise HTTPException(400, "Нечего обновлять")
    args.extend([kw_id, event_id])
    row = await db.fetchrow(
        f"""UPDATE event_raffle_keywords SET {', '.join(sets)}
            WHERE id = ${len(args)-1} AND event_id = ${len(args)}
            RETURNING id, keyword, sort_order, is_active""",
        *args,
    )
    if not row:
        raise HTTPException(404, "Кодовое слово не найдено")
    return dict(row)


@router.delete("/keywords/{kw_id}", summary="Удалить кодовое слово")
async def delete_keyword(event_id: int, kw_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    res = await db.execute("DELETE FROM event_raffle_keywords WHERE id = $1 AND event_id = $2", kw_id, event_id)
    if res.endswith(" 0"):
        raise HTTPException(404, "Кодовое слово не найдено")
    return {"ok": True}


# ─────── PARTICIPANTS / TICKETS / WINNERS / DRAW (дашборд) ───────
# Окно «в эфире» — 120 минут (миграция 056, см. memory/project_raffle_model.md).
LIVE_WINDOW = "120 minutes"


@router.get("/participants", summary="Участники розыгрыша (с билетами и словами)")
async def list_participants(
    event_id: int,
    only_live: bool = False,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список людей, у которых есть хотя бы один билет в этом событии.

    Поля:
      - contact_id, name, username (из platform_users.telegram, для ссылки на контакт)
      - tickets[] — массив id-шников билетов
      - code_words[] — массив введённых слов (без 'Free' если хотим только реальные;
        пока возвращаем все, фронт сам отфильтрует если надо)
      - is_live — true если live_at попадает в окно 120 мин
    """
    await _check_event_access(db, int(client["sub"]), event_id)
    where_live = f"AND ep.live_at > now() - interval '{LIVE_WINDOW}'" if only_live else ""
    rows = await db.fetch(
        f"""
        SELECT
            c.id AS contact_id,
            c.name,
            (SELECT pu.username FROM platform_users pu
              WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
              ORDER BY pu.id LIMIT 1) AS username,
            (ep.live_at IS NOT NULL AND ep.live_at > now() - interval '{LIVE_WINDOW}') AS is_live,
            ep.live_at,
            COALESCE(
              (SELECT array_agg(t.id ORDER BY t.id)
                 FROM event_raffle_tickets t
                WHERE t.event_id = $1 AND t.contact_id = c.id),
              ARRAY[]::int[]
            ) AS ticket_ids,
            COALESCE(
              (SELECT array_agg(t.code_word ORDER BY t.id)
                 FROM event_raffle_tickets t
                WHERE t.event_id = $1 AND t.contact_id = c.id),
              ARRAY[]::text[]
            ) AS code_words
          FROM contacts c
          JOIN event_participants ep ON ep.contact_id = c.id AND ep.event_id = $1
         WHERE EXISTS (
                  SELECT 1 FROM event_raffle_tickets t
                   WHERE t.event_id = $1 AND t.contact_id = c.id
               ) {where_live}
         ORDER BY c.id
        """,
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.get("/tickets", summary="Билеты розыгрыша")
async def list_tickets(
    event_id: int,
    only_live: bool = False,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список всех билетов события. Каждая строка — отдельный билет.

    code_word — текст слова или 'Free' для стартового билета.
    """
    await _check_event_access(db, int(client["sub"]), event_id)
    where_live = f"AND ep.live_at > now() - interval '{LIVE_WINDOW}'" if only_live else ""
    rows = await db.fetch(
        f"""
        SELECT
            t.id              AS ticket_id,
            t.code_word,
            t.created_at,
            c.id              AS contact_id,
            c.name,
            (SELECT pu.username FROM platform_users pu
              WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
              ORDER BY pu.id LIMIT 1) AS username,
            (ep.live_at IS NOT NULL AND ep.live_at > now() - interval '{LIVE_WINDOW}') AS is_live
          FROM event_raffle_tickets t
          JOIN contacts c ON c.id = t.contact_id
          LEFT JOIN event_participants ep
            ON ep.event_id = t.event_id AND ep.contact_id = t.contact_id
         WHERE t.event_id = $1 {where_live}
         ORDER BY t.id
        """,
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.get("/winners", summary="Победители розыгрыша")
async def list_winners(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Список победителей события. По строке на каждый розыгранный приз."""
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """
        SELECT
            w.id                       AS winner_id,
            w.speaker_event_id,
            w.ticket_id,
            w.won_at,
            t.code_word,
            cse.gift_raffle_title,
            cse.gift_raffle_url,
            col.name                   AS speaker_name,
            (SELECT pu.username FROM platform_users pu
              WHERE pu.contact_id = col.contact_id AND pu.platform_slug = 'telegram'
              ORDER BY pu.id LIMIT 1) AS speaker_tg_username,
            c.id                       AS contact_id,
            c.name                     AS winner_name,
            (SELECT pu.username FROM platform_users pu
              WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
              ORDER BY pu.id LIMIT 1) AS winner_username
          FROM event_raffle_winners w
          JOIN event_raffle_tickets t ON t.id = w.ticket_id
          JOIN event_collaborators cse ON cse.id = w.speaker_event_id
          JOIN collaborators col ON col.id = cse.speaker_id
          JOIN contacts c ON c.id = t.contact_id
         WHERE t.event_id = $1
         ORDER BY w.won_at
        """,
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


class DrawIn(BaseModel):
    speaker_event_id: int
    only_live: bool = True


@router.post("/draw", summary="Выбрать победителя для приза спикера")
async def draw_winner(
    event_id: int,
    data: DrawIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Случайным образом выбирает билет среди билетов события.

    Исключает уже выигравшие билеты (один билет = один выигрыш).
    Если only_live=true (дефолт) — учитываются только билеты участников
    с live_at в окне 120 минут.

    После выбора пишет в event_raffle_winners. Сообщение победителю в ЛС
    шлётся отдельным механизмом (вне этого эндпоинта; здесь только запись
    в БД, чтобы UI обновился; ЛС добавим следующим коммитом).
    """
    await _check_event_access(db, int(client["sub"]), event_id)

    # Проверяем что приз принадлежит этому событию.
    cse = await db.fetchrow(
        """SELECT id, event_id, gift_raffle_title FROM event_collaborators
            WHERE id = $1 AND event_id = $2""",
        data.speaker_event_id, event_id,
    )
    if not cse:
        raise HTTPException(404, "Приз спикера не найден в этом событии")

    where_live = f"AND ep.live_at > now() - interval '{LIVE_WINDOW}'" if data.only_live else ""
    ticket = await db.fetchrow(
        f"""
        SELECT t.id, t.contact_id
          FROM event_raffle_tickets t
          LEFT JOIN event_participants ep
            ON ep.event_id = t.event_id AND ep.contact_id = t.contact_id
         WHERE t.event_id = $1
           AND NOT EXISTS (
                 SELECT 1 FROM event_raffle_winners w WHERE w.ticket_id = t.id
               )
           {where_live}
         ORDER BY random()
         LIMIT 1
        """,
        event_id,
    )
    if not ticket:
        raise HTTPException(409, "Нет подходящих билетов для розыгрыша")

    winner_id = await db.fetchval(
        """INSERT INTO event_raffle_winners (speaker_event_id, ticket_id)
           VALUES ($1, $2) RETURNING id""",
        data.speaker_event_id, ticket["id"],
    )

    # Возвращаем расширенную инфу о победителе + всё нужное для отправки ЛС.
    row = await db.fetchrow(
        """
        SELECT
            w.id   AS winner_id,
            w.won_at,
            t.id   AS ticket_id,
            t.code_word,
            c.id   AS contact_id,
            c.name AS winner_name,
            (SELECT pu.username      FROM platform_users pu
              WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
              ORDER BY pu.id LIMIT 1) AS winner_username,
            (SELECT pu.platform_user_id FROM platform_users pu
              WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
              ORDER BY pu.id LIMIT 1) AS winner_tg_id,
            cse.gift_raffle_title,
            cse.gift_raffle_url,
            col.name                  AS speaker_name,
            (SELECT pu.username FROM platform_users pu
              WHERE pu.contact_id = col.contact_id AND pu.platform_slug = 'telegram'
              ORDER BY pu.id LIMIT 1) AS speaker_tg_username,
            (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
          FROM event_raffle_winners w
          JOIN event_raffle_tickets t ON t.id = w.ticket_id
          JOIN contacts c ON c.id = t.contact_id
          JOIN event_collaborators cse ON cse.id = w.speaker_event_id
          JOIN collaborators col ON col.id = cse.speaker_id
          JOIN events e ON e.id = t.event_id
         WHERE w.id = $1
        """,
        winner_id,
    )

    # Шлём ЛС победителю через бот клиента (fallback на общего @pluson_bot).
    # Падение отправки не должно ломать запись в БД — победитель уже сохранён.
    try:
        await _send_winner_dm(db, row)
    except Exception as e:
        logger.warning(f"DM to winner failed (winner_id={winner_id}): {e}")

    return dict(row)


async def _send_winner_dm(db, row) -> None:
    """Шлёт сообщение в ЛС победителю через бот клиента.

    Текст по шаблону:
      🎉 Поздравляем! Вы выиграли *{приз}* от *{спикер}*.
      Чтобы забрать — {ссылка / напишите спикеру}.
    """
    tg_id = row["winner_tg_id"]
    if not tg_id:
        return  # без tg_id отправлять некуда

    bot_token = await get_client_telegram_token(int(row["client_id"]), db)
    if not bot_token:
        bot_token = app_settings.telegram_bot_token
    if not bot_token:
        return

    prize = (row["gift_raffle_title"] or "приз").strip()
    speaker = (row["speaker_name"] or "спикера").strip()
    url = (row["gift_raffle_url"] or "").strip()
    speaker_username = (row["speaker_tg_username"] or "").lstrip('@').strip()

    if url:
        action = f"Забрать подарок: {url}"
    elif speaker_username:
        action = f"Чтобы забрать — напишите спикеру: @{speaker_username}"
    else:
        action = "Чтобы забрать подарок — свяжитесь с организатором события."

    text = (
        f"🎉 Поздравляем! Вы выиграли *{_md_escape(prize)}* "
        f"от *{_md_escape(speaker)}*.\n\n"
        f"{action}"
    )

    async with httpx.AsyncClient(timeout=5) as http:
        await http.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={
                "chat_id": int(tg_id),
                "text": text,
                "parse_mode": "Markdown",
                "disable_web_page_preview": False,
            },
        )


def _md_escape(s: str) -> str:
    """Экранирует спецсимволы для legacy Markdown (parse_mode=Markdown)."""
    return s.replace('_', '\\_').replace('*', '\\*').replace('`', '\\`').replace('[', '\\[')


@router.delete("/winners/{winner_id}", summary="Сбросить выигрыш (для переразыгрывания)")
async def delete_winner(
    event_id: int,
    winner_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Удаляет запись о победителе. Билет снова становится доступным
    для участия в розыгрышах. Используется когда организатор хочет
    «переразыграть» приз спикера."""
    await _check_event_access(db, int(client["sub"]), event_id)
    res = await db.execute(
        """DELETE FROM event_raffle_winners w
            USING event_raffle_tickets t
            WHERE w.id = $1 AND w.ticket_id = t.id AND t.event_id = $2""",
        winner_id, event_id,
    )
    if res.endswith(" 0"):
        raise HTTPException(404, "Победитель не найден в этом событии")
    return {"ok": True}
