"""
Публичный API розыгрыша для Mini App (вкладка 🎟 Розыгрыш).

Эндпоинты идентифицируют пользователя по tg_id (передаётся в теле POST или
query GET). Это тот же паттерн, что в backend/app/api/event.py — без подписи
initData. Ужесточение к подписи initData запланировано отдельной задачей
для всего Mini App API сразу.

Все эндпоинты per-event-slug.

Эндпоинты:
  POST  /api/v1/events/{slug}/live              — live-метка (по live-ссылке из дашборда)
  POST  /api/v1/events/{slug}/raffle/free-ticket — выдать Free-билет за подтверждённую подписку
  POST  /api/v1/events/{slug}/raffle/keyword     — ввести кодовое слово, выдать билет
  GET   /api/v1/events/{slug}/raffle/me          — мои билеты и введённые слова

Создано 2026-05-01 в рамках MVP-розыгрыша (миграция 056).
См. memory/project_raffle_model.md.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg
import logging

from app.database import get_pool
from app.services.contact_merge import upsert_contact_with_identity

router = APIRouter(prefix="/events/{slug}/raffle", tags=["Розыгрыш — Mini App"])

# Корневой роутер на префикс /events/{slug} для эндпоинта /live
# (он живёт рядом с raffle, но по смыслу не только о розыгрыше — это
# отметка «человек сейчас в эфире события»). Технически используется
# только розыгрышем, но всё равно держим вне префикса /raffle/.
event_root_router = APIRouter(prefix="/events/{slug}", tags=["Live-метка участника"])

logger = logging.getLogger(__name__)


# ─────── Helpers ───────

class _UserCtx(BaseModel):
    tg_id: int
    first_name: str = ""
    last_name: str = ""
    username: str = ""


async def _resolve_event_and_contact(conn: asyncpg.Connection, slug: str, user: _UserCtx):
    """Находит event_id и client_id по slug, upsert-ит contact для tg_id у этого клиента.

    Возвращает (event_id, client_id, contact_id).
    """
    ev = await conn.fetchrow(
        "SELECT id, client_id, module_slug FROM events WHERE slug = $1",
        slug,
    )
    if not ev:
        raise HTTPException(404, "Событие не найдено")
    if ev["module_slug"] != "conference":
        # На MVP розыгрыш доступен только в конференциях.
        # /live для не-конференций тоже не имеет смысла (live-механика —
        # часть розыгрыша). Если в будущем расширим — снимем проверку.
        raise HTTPException(400, "Розыгрыш доступен только в конференциях")

    contact_id, _pu_id, _new = await upsert_contact_with_identity(
        conn,
        client_id=ev["client_id"],
        platform_slug='telegram',
        platform_user_id=str(user.tg_id),
        username=(user.username.lstrip('@') if user.username else None),
        first_name=user.first_name or None,
        last_name=user.last_name or None,
    )
    return ev["id"], ev["client_id"], contact_id


async def _ensure_participant(conn: asyncpg.Connection, event_id: int, contact_id: int):
    """Гарантирует наличие записи event_participants. Создаёт со статусом
    is_registered=false если её ещё нет. live_at не трогает."""
    await conn.execute(
        """INSERT INTO event_participants (event_id, contact_id, is_registered)
           VALUES ($1, $2, FALSE)
           ON CONFLICT (event_id, contact_id) DO NOTHING""",
        event_id, contact_id,
    )


async def _raffle_settings(conn: asyncpg.Connection, event_id: int) -> dict:
    row = await conn.fetchrow(
        """SELECT is_enabled, subscription_grants_starter_ticket, intro_text
             FROM event_raffle_settings WHERE event_id = $1""",
        event_id,
    )
    return dict(row) if row else {
        "is_enabled": False,
        "subscription_grants_starter_ticket": True,
        "intro_text": None,
    }


# ─────── POST /live (отметка «в эфире») ───────

class LiveIn(_UserCtx):
    pass


@event_root_router.post("/live", summary="Поставить live_at — пользователь в эфире")
async def mark_live(slug: str, body: LiveIn):
    """Вызывается Mini App-ом, когда пользователь открывает событие через
    публичную live-ссылку (`?app=tg&live=1` → startapp `_live`-suffix).

    Делает upsert event_participants с live_at=now(). Если записи нет —
    создаёт с is_registered=false (interested) и сразу помечает «в эфире».
    Статус регистрации существующих записей не трогаем.
    """
    pool = await get_pool()
    if not pool:
        raise HTTPException(500, "DB pool unavailable")

    async with pool.acquire() as conn:
        async with conn.transaction():
            event_id, _client_id, contact_id = await _resolve_event_and_contact(conn, slug, body)
            await conn.execute(
                """INSERT INTO event_participants (event_id, contact_id, is_registered, live_at)
                   VALUES ($1, $2, FALSE, now())
                   ON CONFLICT (event_id, contact_id)
                   DO UPDATE SET live_at = EXCLUDED.live_at""",
                event_id, contact_id,
            )
    return {"ok": True}


# ─────── POST /raffle/free-ticket (Free-билет за подписку) ───────

class FreeTicketIn(_UserCtx):
    pass


@router.post("/free-ticket", summary="Выдать Free-билет за выполненную подписку")
async def issue_free_ticket(slug: str, body: FreeTicketIn):
    """Вызывается Mini App-ом, когда пользователь подтвердил все требуемые
    подписки на каналы и теперь должен получить стартовый Free-билет.

    Проверка фактической подписки (через TG API getChatMember) делается
    Mini App-ом до вызова этого эндпоинта. Здесь — только выдача билета.

    Дубли защищены UNIQUE(event_id, contact_id, code_word='Free').
    Повторный вызов вернёт существующий билет.
    """
    pool = await get_pool()
    if not pool:
        raise HTTPException(500, "DB pool unavailable")

    async with pool.acquire() as conn:
        async with conn.transaction():
            event_id, _client_id, contact_id = await _resolve_event_and_contact(conn, slug, body)
            await _ensure_participant(conn, event_id, contact_id)

            settings = await _raffle_settings(conn, event_id)
            if not settings["subscription_grants_starter_ticket"]:
                raise HTTPException(400, "На этом событии Free-билет не выдаётся за подписку")

            ticket_id = await conn.fetchval(
                """INSERT INTO event_raffle_tickets (event_id, contact_id, code_word)
                   VALUES ($1, $2, 'Free')
                   ON CONFLICT (event_id, contact_id, code_word) DO NOTHING
                   RETURNING id""",
                event_id, contact_id,
            )
            if ticket_id is None:
                # Уже был выдан — найдём id для ответа
                ticket_id = await conn.fetchval(
                    """SELECT id FROM event_raffle_tickets
                        WHERE event_id = $1 AND contact_id = $2 AND code_word = 'Free'""",
                    event_id, contact_id,
                )
                return {"ticket_id": ticket_id, "code_word": "Free", "already_issued": True}

    return {"ticket_id": ticket_id, "code_word": "Free", "already_issued": False}


# ─────── POST /raffle/keyword (ввести кодовое слово) ───────

class KeywordIn(_UserCtx):
    keyword: str


@router.post("/keyword", summary="Ввести кодовое слово — выдать билет")
async def submit_keyword(slug: str, body: KeywordIn):
    """Вход — слово участника. Сравнение регистронезависимое (lower+trim),
    точное совпадение букв. Если слово существует и активно — выдаём билет.

    Ошибки:
      404 keyword_not_found — нет такого слова на событии (после lower+trim)
      409 already_used      — этот участник уже вводил это слово
    """
    kw_input = (body.keyword or "").strip().lower()
    if not kw_input:
        raise HTTPException(400, "Введите кодовое слово")

    pool = await get_pool()
    if not pool:
        raise HTTPException(500, "DB pool unavailable")

    async with pool.acquire() as conn:
        async with conn.transaction():
            event_id, _client_id, contact_id = await _resolve_event_and_contact(conn, slug, body)
            await _ensure_participant(conn, event_id, contact_id)

            kw_row = await conn.fetchrow(
                """SELECT id, keyword FROM event_raffle_keywords
                    WHERE event_id = $1 AND keyword_lower = $2 AND is_active = TRUE""",
                event_id, kw_input,
            )
            if not kw_row:
                raise HTTPException(404, "Такого кодового слова нет, проверьте написание")

            # Проверим что этот человек ещё не вводил это слово
            existing = await conn.fetchval(
                """SELECT id FROM event_raffle_tickets
                    WHERE event_id = $1 AND contact_id = $2 AND code_word = $3""",
                event_id, contact_id, kw_row["keyword"],
            )
            if existing:
                raise HTTPException(409, "Вы уже использовали это слово")

            ticket_id = await conn.fetchval(
                """INSERT INTO event_raffle_tickets (event_id, contact_id, code_word)
                   VALUES ($1, $2, $3) RETURNING id""",
                event_id, contact_id, kw_row["keyword"],
            )

    return {"ticket_id": ticket_id, "code_word": kw_row["keyword"]}


# ─────── GET /raffle/me (мои билеты + введённые слова) ───────

@router.get("/me", summary="Мои билеты и введённые слова в розыгрыше")
async def get_my_raffle(slug: str, tg_id: int):
    """tg_id передаётся как query-параметр (Mini App знает свой tg_id из initData).

    Возвращает:
      - tickets: [{id, code_word, created_at}]
      - keywords_used: [code_word, ...] (текстовые слова без 'Free')
      - won_prizes: [{prize_title, prize_url, speaker_name, speaker_tg_username, won_at}]
        — призы, которые выиграл этот участник в этом событии
    """
    pool = await get_pool()
    if not pool:
        raise HTTPException(500, "DB pool unavailable")

    async with pool.acquire() as conn:
        ev = await conn.fetchrow(
            "SELECT id, client_id FROM events WHERE slug = $1",
            slug,
        )
        if not ev:
            raise HTTPException(404, "Событие не найдено")

        contact_id = await conn.fetchval(
            """SELECT pu.contact_id FROM platform_users pu
                WHERE pu.client_id = $1 AND pu.platform_slug = 'telegram'
                  AND pu.platform_user_id = $2 LIMIT 1""",
            ev["client_id"], str(tg_id),
        )
        if not contact_id:
            return {"tickets": [], "keywords_used": [], "won_prizes": []}

        tickets = await conn.fetch(
            """SELECT id, code_word, created_at FROM event_raffle_tickets
                WHERE event_id = $1 AND contact_id = $2 ORDER BY id""",
            ev["id"], contact_id,
        )

        won = await conn.fetch(
            """
            SELECT
                cse.gift_raffle_title       AS prize_title,
                cse.gift_raffle_url         AS prize_url,
                col.name                    AS speaker_name,
                (SELECT pu.username FROM platform_users pu
                  WHERE pu.contact_id = col.contact_id AND pu.platform_slug = 'telegram'
                  ORDER BY pu.id LIMIT 1) AS speaker_tg_username,
                w.won_at,
                t.id                        AS ticket_id
              FROM event_raffle_winners w
              JOIN event_raffle_tickets t ON t.id = w.ticket_id
              JOIN event_collaborators cse ON cse.id = w.speaker_event_id
              JOIN collaborators col ON col.id = cse.speaker_id
             WHERE t.event_id = $1 AND t.contact_id = $2
             ORDER BY w.won_at
            """,
            ev["id"], contact_id,
        )

    tickets_list = [dict(r) for r in tickets]
    return {
        "tickets": tickets_list,
        "keywords_used": [t["code_word"] for t in tickets_list if t["code_word"] != "Free"],
        "won_prizes": [dict(r) for r in won],
    }
