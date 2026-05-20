"""Celery task — отправка шагов воронки догрева событий.

Запускается раз в N минут (см. beat_schedule). Для каждого активного
`event_nurture_runs` (где finished_at IS NULL) находит следующий шаг и шлёт
если прошёл нужный offset_minutes от started_at. После всех шагов или
если событие уже стартовало — помечает run как finished.

Каналы отправки:
  - TG: бот клиента (если у него есть) или системный @pluson_bot;
  - VK: главный VK-канал клиента (если есть);
  - оба отправляются если у контакта есть и TG и VK identity.
"""
from __future__ import annotations

import asyncio
import logging
from html import escape

import asyncpg
import httpx

from app.celery_app import celery
from app.config import settings
from app.database import get_pool
from app.services.channels import get_client_telegram_token

logger = logging.getLogger(__name__)


def _format_text(
    text: str,
    *,
    event_title: str,
    event_date_short: str,
    owner_telegram: str = "",
) -> str:
    """Подставляет плейсхолдеры. Безопасно — формат-строка может содержать
    случайные {...} в HTML; используем replace, а не .format()."""
    out = text or ""
    out = out.replace("{event_title}",      escape(event_title or ""))
    out = out.replace("{event_date_short}", escape(event_date_short or ""))
    out = out.replace("{owner_telegram}",   owner_telegram or "")  # уже HTML-тег <a>
    return out


def _build_owner_contact(work_tg: str | None, social_telegram: str | None) -> str:
    """Контакт организатора для подстановки в {owner_telegram}.

    Приоритет: clients.work_tg_username → clients.social_links.telegram. Возвращаем
    HTML-якорь <a href="t.me/..."> с лейблом @username. Если ничего нет —
    fallback на текст про Экосистему приложения."""
    handle = (work_tg or "").lstrip("@").strip()
    if not handle and social_telegram:
        # social_telegram уже нормализован к https://t.me/... (см. services/social_links.py)
        # Достаём из него username для лейбла.
        s = social_telegram.strip()
        if "t.me/" in s:
            handle = s.split("t.me/", 1)[1].split("/", 1)[0].split("?", 1)[0]
    if not handle:
        # Без контакта в настройках — нейтральный fallback
        return "откройте приложение → вкладка «Экосистема» — там контакты"
    href = f"https://t.me/{handle}"
    return f'<a href="{href}">@{escape(handle)}</a>'


async def _build_app_url(
    db: asyncpg.Connection,
    *,
    platform: str,
    client_id: int | None,
    slug: str,
    ref_code: str | None,
) -> str:
    """Mini App URL для кнопки «Зарегистрироваться». Учитывает VIP-канал клиента
    если он есть на этой платформе.

    TG:
      - VIP: `t.me/{его_бот_handle}/pluson?startapp=ref_pg{slug}_pid{ref}`
      - системный: `t.me/pluson_bot/pluson?startapp=ref_pg{slug}_pid{ref}_cid{client_id}`
        (cid нужен чтобы общий Mini App знал в каком контексте регистрировать)
    VK:
      - VIP: `vk.com/app{его_vk_app_id}#ref_pg{slug}_pid{ref}`
      - системный: `vk.com/app{settings.vk_app_id}#ref_pg{slug}_pid{ref}`
    """
    pid_part = f"_pid{ref_code}" if ref_code else ""

    if platform == "telegram":
        vip_handle = None
        if client_id:
            vip_handle = await db.fetchval(
                """SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                     FROM channels ch
                     JOIN client_channels cc ON cc.channel_id = ch.id
                    WHERE cc.client_id = $1
                      AND ch.platform_slug = 'telegram'
                      AND ch.is_system = FALSE
                      AND cc.is_active = TRUE
                      AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
                    ORDER BY ch.id LIMIT 1""",
                client_id,
            )
        if vip_handle:
            return f"https://t.me/{vip_handle}/pluson?startapp=ref_pg{slug}{pid_part}"
        # Системный бот: нужен cid чтобы Mini App знал контекст клиента
        cid_part = f"_cid{client_id}" if client_id else ""
        return f"https://t.me/pluson_bot/pluson?startapp=ref_pg{slug}{pid_part}{cid_part}"

    if platform == "vk":
        vip_app_id = None
        if client_id:
            vip_app_id = await db.fetchval(
                """SELECT (ch.platform_meta->>'vk_app_id')::int
                     FROM channels ch
                     JOIN client_channels cc ON cc.channel_id = ch.id
                    WHERE cc.client_id = $1
                      AND ch.platform_slug = 'vk'
                      AND ch.is_system = FALSE
                      AND cc.is_active = TRUE
                      AND ch.platform_meta->>'vk_app_id' IS NOT NULL
                    ORDER BY ch.id LIMIT 1""",
                client_id,
            )
        app_id = vip_app_id or settings.vk_app_id
        return f"https://vk.com/app{app_id}#ref_pg{slug}{pid_part}"

    # Прочие платформы — пока нет VIP, fallback на pluson_bot
    return f"https://t.me/pluson_bot/pluson?startapp=ref_pg{slug}{pid_part}"


async def _send_via_telegram(bot_token: str, chat_id: str, text: str, button_label: str, url: str) -> None:
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_markup": {"inline_keyboard": [[{"text": button_label, "url": url}]]},
    }
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"TG sendMessage {r.status_code}: {r.text[:200]}")


async def _send_via_vk(token: str, user_id: int, text: str, button_label: str, url: str) -> None:
    from app.services.vk_api import send_message as vk_send, tg_inline_to_vk_keyboard
    keyboard = tg_inline_to_vk_keyboard([[{"text": button_label, "url": url}]])
    await vk_send(user_id, text, token=token, keyboard=keyboard)


async def _send_step(db: asyncpg.Connection, run_row, step_row) -> bool:
    """Отправляет шаг получателю по всем доступным каналам. Возвращает True если
    хоть один канал успешно отправил."""
    event_title = run_row["event_title"] or "событие"
    event_date_short = ""
    if run_row["start_at"]:
        # 28 мая 2026 в 11:00 МСК
        try:
            from zoneinfo import ZoneInfo
            dt_msk = run_row["start_at"].astimezone(ZoneInfo("Europe/Moscow"))
            months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"]
            event_date_short = f"{dt_msk.day} {months[dt_msk.month-1]} в {dt_msk.strftime('%H:%M')} МСК"
        except Exception:
            event_date_short = ""

    # Контакт организатора — из настроек клиента
    contact_row = await db.fetchrow(
        "SELECT work_tg_username, social_links->>'telegram' AS social_tg FROM clients WHERE id = $1",
        run_row["client_id"],
    )
    owner_tg = _build_owner_contact(
        (contact_row["work_tg_username"] if contact_row else None),
        (contact_row["social_tg"] if contact_row else None),
    )

    text = _format_text(
        step_row["text"],
        event_title=event_title,
        event_date_short=event_date_short,
        owner_telegram=owner_tg,
    )
    button_label = step_row["button_label"] or "Зарегистрироваться"

    # Получатель: ищем идентичности контакта в TG и VK
    identities = await db.fetch(
        """SELECT platform_slug, platform_user_id
             FROM platform_users
            WHERE contact_id = $1 AND platform_slug IN ('telegram','vk')""",
        run_row["contact_id"],
    )

    ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", run_row["contact_id"])
    sent = False
    client_id = run_row["client_id"]

    for ident in identities:
        plat = ident["platform_slug"]
        pid = ident["platform_user_id"]
        try:
            url = await _build_app_url(db, platform=plat, client_id=client_id, slug=run_row["slug"], ref_code=ref_code)
            if plat == "telegram":
                tok = await get_client_telegram_token(client_id, db) or settings.telegram_bot_token
                if not tok:
                    continue
                await _send_via_telegram(tok, pid, text, button_label, url)
                sent = True
            elif plat == "vk":
                # Токен главного VK-канала клиента
                vk_token = await db.fetchval(
                    """SELECT ch.bot_token
                         FROM channels ch
                         JOIN client_channels cc ON cc.channel_id = ch.id
                        WHERE cc.client_id = $1 AND ch.platform_slug = 'vk'
                          AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
                        ORDER BY cc.is_active DESC, ch.is_system ASC, ch.id ASC
                        LIMIT 1""",
                    client_id,
                )
                if not vk_token:
                    continue
                await _send_via_vk(vk_token, int(pid), text, button_label, url)
                sent = True
        except Exception as e:
            logger.warning("nurture send failed run_id=%s plat=%s pid=%s: %s",
                           run_row["id"], plat, pid, e)
    return sent


async def _tick():
    pool = await get_pool()
    if not pool:
        logger.info("nurture.tick: pool not ready, skip")
        return
    async with pool.acquire() as db:
        # Все активные runs + текущее состояние
        rows = await db.fetch(
            """SELECT r.id, r.event_id, r.contact_id, r.started_at, r.last_step_index,
                      e.title AS event_title, e.slug, e.client_id, e.status, e.start_at, e.end_at
                 FROM event_nurture_runs r
                 JOIN events e ON e.id = r.event_id
                WHERE r.finished_at IS NULL"""
        )
        for r in rows:
            # Останов если событие началось/завершилось
            if r["status"] == "ended" or (r["end_at"] is not None and r["end_at"] < r["started_at"]):
                await db.execute(
                    "UPDATE event_nurture_runs SET finished_at=NOW(), finished_reason='event_started' WHERE id=$1",
                    r["id"],
                )
                continue
            if r["start_at"] is not None:
                # Если событие УЖЕ идёт или прошло на момент тика — стоп
                import datetime as _dt
                now_utc = _dt.datetime.now(_dt.timezone.utc)
                if r["start_at"] <= now_utc:
                    await db.execute(
                        "UPDATE event_nurture_runs SET finished_at=NOW(), finished_reason='event_started' WHERE id=$1",
                        r["id"],
                    )
                    continue

            # Берём следующий активный шаг по индексу last_step_index + 1
            next_step = await db.fetchrow(
                """SELECT id, sort_order, offset_seconds, text, button_label
                     FROM event_nurture_steps
                    WHERE event_id = $1 AND is_active = TRUE
                    ORDER BY sort_order, id
                    OFFSET $2 LIMIT 1""",
                r["event_id"], (r["last_step_index"] or -1) + 1,
            )
            if not next_step:
                # Все шаги отправлены
                await db.execute(
                    "UPDATE event_nurture_runs SET finished_at=NOW(), finished_reason='all_sent' WHERE id=$1",
                    r["id"],
                )
                continue

            # Пора ли слать?
            ready = await db.fetchval(
                "SELECT $1::timestamptz + ($2 * INTERVAL '1 second') <= NOW()",
                r["started_at"], int(next_step["offset_seconds"]),
            )
            if not ready:
                continue

            sent = await _send_step(db, r, next_step)
            if sent:
                await db.execute(
                    """UPDATE event_nurture_runs
                          SET last_step_index = last_step_index + 1,
                              last_step_at = NOW()
                        WHERE id = $1""",
                    r["id"],
                )
            else:
                # Нечем отправить (нет каналов / нет токенов) — закрываем чтобы не зависал
                await db.execute(
                    "UPDATE event_nurture_runs SET finished_at=NOW(), finished_reason='no_channel' WHERE id=$1",
                    r["id"],
                )


@celery.task(name="app.tasks.nurture.tick")
def nurture_tick():
    """Periodic Celery task: проверяет все активные nurture-runs и шлёт пора-шагам."""
    asyncio.run(_tick())
