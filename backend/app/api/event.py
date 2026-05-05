"""
POST /api/v1/event

Вызывается из Telegram Mini App при открытии события (event_start).
В зависимости от состояния участника отправляет ему через бот клиента
(или fallback @pluson_bot) одно из 4 сообщений:

  register_cta      — не зареган, событие активно
  referral_reminder — зареган, событие не завершилось
  next_event_cta    — событие завершилось, есть successor
  ecosystem_thanks  — событие завершилось, успешник не задан

Дедуп — через event_participants.last_open_msg_kind/at + проверка
broadcast_log: повторяем только если статус сменился ИЛИ между нашим
прошлым сообщением и сейчас прилетели рассылки от бота клиента (наше
сообщение «уехало вверх»).

Вызывается из mini-app/src/App.tsx функцией sendTgEvent().
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from datetime import datetime
from zoneinfo import ZoneInfo
import httpx
import logging
from ..config import settings
from ..database import get_pool
from ..services.channels import get_client_telegram_token
from ..services.contact_merge import upsert_contact_with_identity, resolve_ref_code
from ..services.message_builder import RU_MONTHS

router = APIRouter()
logger = logging.getLogger(__name__)


def _fmt_event_dt(dt) -> str:
    """«9 мая 14:00 МСК», либо «9 мая» если время не задано (00:00 — fallback)."""
    if not dt:
        return ""
    dm = dt.astimezone(ZoneInfo("Europe/Moscow")) if dt.tzinfo else dt
    base = f"{dm.day} {RU_MONTHS[dm.month - 1]}"
    if dm.hour == 0 and dm.minute == 0:
        return base
    return f"{base} {dm.hour:02d}:{dm.minute:02d} МСК"


class TgEventRequest(BaseModel):
    user_id: str           # ID пользователя на платформе (tg_id / vk_id / max_id)
    event: str             # Тип события: 'event_start'
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    partner_id: str = ""   # промо-партнёр (из startapp pid)
    event_slug: str = ""   # slug события (из startapp pg<slug>) — для определения клиента
    client_id: int = 0     # client_id (из startapp cid<id>) — приоритетнее event_slug
    platform: str = "telegram"  # telegram | vk | max — Mini App может крепиться к разным


@router.post("/event")
async def handle_tg_event(body: TgEventRequest):
    """Получает сигнал от Mini App при открытии события. Шлёт контекстное сообщение через бот клиента."""
    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id required")

    try:
        tg_id = int(body.user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="user_id must be int")

    if body.event != "event_start":
        return {"ok": True}

    # Пока умеем слать только в Telegram. VK/MAX — когда появится диспетчер.
    if body.platform != "telegram":
        return {"ok": True, "platform": body.platform, "skipped": "no dispatcher"}

    pool = await get_pool()
    if not pool:
        return {"ok": True, "warning": "db not available"}

    # Без slug события слать нечего (в селекторе хаба event_start не вызывается)
    if not body.event_slug:
        return {"ok": True, "skipped": "no event_slug"}

    try:
        async with pool.acquire() as conn:
            ev = await conn.fetchrow(
                """
                SELECT e.id, e.slug, e.title, e.module_slug, e.status,
                       e.successor_event_id, e.client_id,
                       CASE WHEN e.module_slug = 'conference' THEN
                         (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                  AT TIME ZONE 'Europe/Moscow'
                            FROM conf_days d
                           WHERE d.event_id = e.id
                           ORDER BY d.day_number ASC LIMIT 1)
                         ELSE e.start_at
                       END AS effective_start_at,
                       CASE WHEN e.module_slug = 'conference' THEN
                         (SELECT (d.day_date + COALESCE(NULLIF(d.close_time,'')::time, '23:59'::time))
                                  AT TIME ZONE 'Europe/Moscow'
                            FROM conf_days d
                           WHERE d.event_id = e.id
                           ORDER BY d.day_number DESC LIMIT 1)
                         ELSE e.end_at
                       END AS effective_end_at
                  FROM events e
                 WHERE e.slug = $1
                """,
                body.event_slug,
            )
            if not ev:
                return {"ok": True, "skipped": "event not found"}

            event_id = ev["id"]
            client_id = body.client_id or ev["client_id"]

            # Контакт + identity + запись «интересовался» (если ещё нет).
            # Реферер из pid резолвится через merged_ref_codes — pid может быть legacy.
            async with conn.transaction():
                contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                    conn,
                    client_id=client_id,
                    platform_slug='telegram',
                    platform_user_id=str(tg_id),
                    username=body.username or None,
                    first_name=body.first_name or None,
                    last_name=body.last_name or None,
                )

                resolved_ref_code = None
                referrer_contact_id = None
                if body.partner_id:
                    resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                        conn, body.partner_id, client_id=client_id
                    )

                referrer_participant_id = None
                if referrer_contact_id:
                    referrer_participant_id = await conn.fetchval(
                        """SELECT id FROM event_participants
                            WHERE contact_id = $1 AND event_id = $2 LIMIT 1""",
                        referrer_contact_id, event_id,
                    )

                inserted = await conn.fetchval(
                    """INSERT INTO event_participants
                          (event_id, contact_id, is_registered, referrer_ref_code, referrer_participant_id)
                        VALUES ($1, $2, FALSE, $3, $4)
                       ON CONFLICT DO NOTHING
                     RETURNING id""",
                    event_id, contact_id, resolved_ref_code, referrer_participant_id,
                )
                if inserted is None and resolved_ref_code:
                    await conn.execute(
                        """UPDATE event_participants
                              SET referrer_ref_code = $3,
                                  referrer_participant_id = COALESCE(referrer_participant_id, $4)
                            WHERE event_id = $1 AND contact_id = $2
                              AND referrer_ref_code IS NULL""",
                        event_id, contact_id, resolved_ref_code, referrer_participant_id,
                    )

            part = await conn.fetchrow(
                """SELECT id, is_registered, last_open_msg_kind, last_open_msg_at
                     FROM event_participants
                    WHERE event_id = $1 AND contact_id = $2""",
                event_id, contact_id,
            )
            if not part:
                return {"ok": True, "skipped": "no participant after upsert"}

            ref_code = await conn.fetchval(
                "SELECT ref_code FROM contacts WHERE id = $1", contact_id
            )

            # Успешник для kind=next_event_cta — берём только опубликованный/завершённый
            successor_ev = None
            if ev["successor_event_id"]:
                successor_ev = await conn.fetchrow(
                    """
                    SELECT e.id, e.slug, e.title, e.status,
                           CASE WHEN e.module_slug = 'conference' THEN
                             (SELECT (d.day_date + COALESCE(NULLIF(d.open_time,'')::time, '00:00'::time))
                                      AT TIME ZONE 'Europe/Moscow'
                                FROM conf_days d
                               WHERE d.event_id = e.id
                               ORDER BY d.day_number ASC LIMIT 1)
                             ELSE e.start_at
                           END AS effective_start_at
                      FROM events e
                     WHERE e.id = $1
                    """,
                    ev["successor_event_id"],
                )
                if successor_ev and successor_ev["status"] == "draft":
                    successor_ev = None

            # Завершилось? — явный статус ИЛИ дата окончания в прошлом
            now_msk = datetime.now(ZoneInfo("Europe/Moscow"))
            is_ended = (ev["status"] == "ended") or (
                ev["effective_end_at"] is not None and ev["effective_end_at"] < now_msk
            )

            if not part["is_registered"]:
                kind = "register_cta"
            elif is_ended:
                kind = "next_event_cta" if successor_ev else "ecosystem_thanks"
            else:
                kind = "referral_reminder"

            # Дедуп: тот же kind + после нашего прошлого сообщения никаких рассылок не было → молчим
            if part["last_open_msg_kind"] == kind and part["last_open_msg_at"]:
                had_broadcast = await conn.fetchval(
                    """SELECT 1 FROM broadcast_log bl
                         JOIN platform_users pu ON pu.id = bl.platform_user_id
                        WHERE pu.contact_id = $1 AND pu.platform_slug = 'telegram'
                          AND bl.sent_at > $2 AND bl.status = 'sent'
                        LIMIT 1""",
                    contact_id, part["last_open_msg_at"],
                )
                if not had_broadcast:
                    return {"ok": True, "deduped": True, "kind": kind}

            bot_token = await get_client_telegram_token(client_id, conn)
            bot_handle = await conn.fetchval(
                """SELECT REGEXP_REPLACE(handle, '^@', '')
                     FROM channels
                    WHERE client_id=$1 AND platform_slug='telegram'
                      AND is_active=true AND bot_token IS NOT NULL
                    LIMIT 1""",
                client_id,
            )
    except Exception as e:
        logger.warning(f"event_start prep failed for tg_id={tg_id} slug={body.event_slug}: {e}")
        return {"ok": True, "warning": "prep failed"}

    if not bot_token:
        bot_token = settings.telegram_bot_token
    if not bot_token:
        return {"ok": True, "warning": "no bot token configured"}

    # URL Mini App: бот клиента (VIP) — без short-name, общий — с /pluson
    bot_url_base = f"https://t.me/{bot_handle}" if bot_handle else "https://t.me/pluson_bot/pluson"
    name = body.first_name or "друг"
    ev_title = ev["title"] or "событие"

    if kind == "register_cta":
        date_str = _fmt_event_dt(ev["effective_start_at"])
        text = f"Привет, {name}! 👋\n\nДобро пожаловать на «{ev_title}» 🎉"
        if date_str:
            text += f"\n🗓 {date_str}"
        text += "\n\nДля регистрации нажмите на кнопку."
        btn_text = "Зарегистрироваться"
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}"
    elif kind == "referral_reminder":
        text = (
            f"Привет, {name}! 👋\n\n"
            f"Вы записаны на «{ev_title}». Вы ещё успеваете пригласить друзей "
            f"по своей партнёрской ссылке и получить подарки 🎁"
        )
        btn_text = "Получить подарки"
        pid_part = f"_pid{ref_code}" if ref_code else ""
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}_tabgame{pid_part}"
    elif kind == "next_event_cta":
        succ_title = (successor_ev["title"] if successor_ev else "") or "следующее событие"
        succ_date = _fmt_event_dt(successor_ev["effective_start_at"]) if successor_ev else ""
        text = (
            f"Привет, {name}! 👋\n\n"
            f"Событие «{ev_title}» завершилось — спасибо за ваш интерес!\n\n"
            f"Следующее: «{succ_title}»"
        )
        if succ_date:
            text += f" {succ_date}"
        text += " 🎯"
        btn_text = "Записаться на следующее"
        btn_url = f"{bot_url_base}?startapp=ref_pg{successor_ev['slug']}"
    else:  # ecosystem_thanks
        text = (
            f"Привет, {name}! 👋\n\n"
            f"Событие «{ev_title}» завершилось — спасибо за ваш интерес!\n\n"
            f"Пока ждём следующее — заходите в Экосистему организатора, "
            f"там полезные материалы."
        )
        btn_text = "Открыть Экосистему"
        btn_url = f"{bot_url_base}?startapp=ref_pg{ev['slug']}_tabecosystem"

    sent_ok = False
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={
                    "chat_id": tg_id,
                    "text": text,
                    "disable_web_page_preview": True,
                    "reply_markup": {
                        "inline_keyboard": [[{"text": btn_text, "url": btn_url}]]
                    },
                },
            )
            sent_ok = r.status_code == 200
            if not sent_ok:
                logger.warning(f"sendMessage {r.status_code} for {tg_id} kind={kind}: {r.text[:200]}")
    except Exception as e:
        logger.warning(f"sendMessage failed for {tg_id} kind={kind}: {e}")

    if sent_ok:
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE event_participants SET last_open_msg_kind=$1, last_open_msg_at=NOW() WHERE id=$2",
                    kind, part["id"],
                )
        except Exception as e:
            logger.warning(f"update last_open_msg failed for participant={part['id']}: {e}")

    return {"ok": True, "client_id": client_id, "kind": kind, "sent": sent_ok}


class ShareToBotRequest(BaseModel):
    tg_id: int
    event_slug: str
    text: str | None = None         # legacy: один текст
    texts: list[str] | None = None  # массив текстов (приоритет)


@router.post("/event/share-to-bot")
async def share_to_bot(body: ShareToBotRequest):
    """Mini App → отправить участнику в его бот афиши и готовый текст для шеринга друзьям.

    Шлёт сначала все афиши события (из `event_referral_materials`) — каждую
    отдельным sendPhoto, чтобы человек мог форвардить любую по одной. Потом
    текстом отдельным сообщением. После успешной отправки фронт закрывает
    Mini App (`Telegram.WebApp.close()`).
    """
    # Собираем тексты: приоритет texts[], fallback на text. Игнорим пустые.
    raw_texts: list[str] = list(body.texts or [])
    if not raw_texts and body.text:
        raw_texts = [body.text]
    texts = [t for t in (s.strip() if isinstance(s, str) else "" for s in raw_texts) if t]
    if not texts:
        raise HTTPException(status_code=400, detail="text required")
    if not body.event_slug:
        raise HTTPException(status_code=400, detail="event_slug required")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="db not available")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, client_id FROM events WHERE slug = $1 LIMIT 1",
            body.event_slug,
        )
    if not row:
        raise HTTPException(status_code=404, detail="event not found")
    event_id = row["id"]
    client_id = row["client_id"]

    # Афиши для шеринга (event_referral_materials)
    async with pool.acquire() as conn:
        material_rows = await conn.fetch(
            """SELECT image_url FROM event_referral_materials
                WHERE event_id = $1 AND image_url IS NOT NULL AND image_url <> ''
                ORDER BY sort, id""",
            event_id,
        )
    image_urls = [r["image_url"] for r in material_rows]

    bot_token = None
    try:
        async with pool.acquire() as conn:
            bot_token = await get_client_telegram_token(client_id, conn)
    except Exception as e:
        logger.warning(f"get_client_telegram_token failed: {e}")
    if not bot_token:
        bot_token = settings.telegram_bot_token
    if not bot_token:
        raise HTTPException(status_code=500, detail="no bot token configured")

    base = f"https://api.telegram.org/bot{bot_token}"

    try:
        async with httpx.AsyncClient(timeout=15) as http:
            # 1) Афиши — каждая отдельным sendPhoto (по очереди).
            #    Если одна не отправилась — логируем, но идём дальше к тексту.
            for url in image_urls:
                try:
                    r = await http.post(
                        f"{base}/sendPhoto",
                        json={"chat_id": body.tg_id, "photo": url},
                    )
                    if r.status_code != 200:
                        logger.warning(
                            f"share-to-bot photo failed for tg_id={body.tg_id} event={body.event_slug} "
                            f"url={url}: {r.status_code} {r.text[:200]}"
                        )
                except httpx.HTTPError as e:
                    logger.warning(f"share-to-bot photo http error url={url}: {e}")

            # 2) Тексты — каждый отдельным sendMessage, друг за другом, после афиш.
            last_status = 200
            for t in texts:
                r = await http.post(
                    f"{base}/sendMessage",
                    json={
                        "chat_id": body.tg_id,
                        "text": t,
                        "disable_web_page_preview": True,
                    },
                )
                if r.status_code != 200:
                    logger.warning(
                        f"share-to-bot text failed for tg_id={body.tg_id} event={body.event_slug}: "
                        f"{r.status_code} {r.text[:200]}"
                    )
                    last_status = r.status_code
            if last_status != 200:
                raise HTTPException(status_code=502, detail="telegram send failed")
    except httpx.HTTPError as e:
        logger.warning(f"share-to-bot http error for tg_id={body.tg_id}: {e}")
        raise HTTPException(status_code=502, detail="telegram send failed")

    return {"ok": True, "posters_sent": len(image_urls), "texts_sent": len(texts)}
