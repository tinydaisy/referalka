"""Celery task — отправка шагов воронки догрева ЗАРЕГИСТРИРОВАННЫХ участников.

Зеркало tasks/nurture.py (незарег.), но аудитория — те, кто уже
зарегистрировался. Серия помогает «не потеряться»: вступить в чаты события,
закрепить бота, и т.п.

Запускается раз в N минут (см. beat_schedule). Для каждого активного
`event_nurture_reg_runs` (finished_at IS NULL) находит следующий шаг и шлёт
если прошёл нужный offset_seconds от started_at. После всех шагов или если
событие уже завершилось — помечает run finished.

Дополнительные плейсхолдеры (помимо {event_title}):
  {chats}        — блок ссылок на чаты события (TG/VK/MAX), главный сверху + жирным
  {bot_handle}   — @ник бота, через который ушло сообщение
  {support_link} — контакт службы поддержки клиента (work_tg_username)
  {vip_link}     — events.vip_url
  {gifts_link}   — вкладка «Игра/Подарки» (если включена реф-программа)
  {speakers_link}— вкладка «Спикеры» (для конференций/турниров)
  {program_link} — вкладка «Программа»
Пустой раздел → плейсхолдер заменяется пустотой.
"""
from __future__ import annotations

import asyncio
import logging
from html import escape

import asyncpg
import httpx

from app.celery_app import celery
from app.config import settings
from app.services.channels import get_client_telegram_token

# Переиспользуем готовые хелперы из незарег.-воронки
from app.tasks.nurture import _build_app_url, _html_to_plain, _build_support_contact

logger = logging.getLogger(__name__)


def _get_db_url() -> str:
    return settings.database_url


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ─── Хелперы плейсхолдеров ─────────────────────────────────────────────

# Подписи платформ в блоке {chats}
_PLATFORM_LABEL = {
    "telegram": "Телеграм",
    "vk": "ВК",
    "max": "МАХ",
}


async def build_chats_block(db: asyncpg.Connection, *, event_id: int, html: bool = True) -> str:
    """Собирает блок ссылок на чаты события для плейсхолдера {chats}.

    Главный чат (events.primary_chat_platform) идёт первым и помечается
    «(главный)» жирным. Платформы с пустым URL пропускаются. Если ни одного
    чата нет — возвращает пустую строку.

    html=True  → для Telegram/MAX: «<b>Телеграм (главный)</b> — <a href="...">ссылка</a>»
    html=False → для VK (plain): «Телеграм (главный) — <url>»
    """
    row = await db.fetchrow(
        """SELECT (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS chat_url_tg,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS chat_url_vk,
                  (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS chat_url_max,
                  primary_chat_platform
             FROM events e WHERE e.id = $1""",
        event_id,
    )
    if not row:
        return ""
    urls = {
        "telegram": (row["chat_url_tg"] or "").strip(),
        "vk":       (row["chat_url_vk"] or "").strip(),
        "max":      (row["chat_url_max"] or "").strip(),
    }
    primary = (row["primary_chat_platform"] or "telegram").strip()

    # Порядок: главный первым, далее остальные в фиксированном порядке
    order = [primary] + [p for p in ("telegram", "vk", "max") if p != primary]

    lines: list[str] = []
    for plat in order:
        url = urls.get(plat) or ""
        if not url:
            continue
        label = _PLATFORM_LABEL.get(plat, plat)
        is_primary = (plat == primary)
        if html:
            name = f"<b>{escape(label)} (главный)</b>" if is_primary else escape(label)
            lines.append(f'{name} — <a href="{escape(url, quote=True)}">ссылка</a>')
        else:
            name = f"{label} (главный)" if is_primary else label
            lines.append(f"{name} — {url}")
    return "\n".join(lines)


async def _bot_handle(db: asyncpg.Connection, *, client_id: int, platform: str) -> str:
    """@ник бота, через который реально уходит сообщение клиенту.
    VIP-бот платформы → его handle; иначе системный @pluson_bot (для TG)."""
    if platform == "telegram":
        vip = await db.fetchval(
            """SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1 AND ch.platform_slug = 'telegram'
                  AND ch.is_system = FALSE AND cc.is_active = TRUE
                  AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
                ORDER BY ch.id LIMIT 1""",
            client_id,
        )
        return f"@{vip}" if vip else "@pluson_bot"
    if platform == "vk":
        vip = await db.fetchval(
            """SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1 AND ch.platform_slug = 'vk'
                  AND ch.is_system = FALSE AND cc.is_active = TRUE
                ORDER BY ch.id LIMIT 1""",
            client_id,
        )
        return f"@{vip}" if vip else ""
    return ""


async def build_section_urls(
    db: asyncpg.Connection, *, event_id: int, client_id: int, slug: str,
    ref_code: str | None = None, contact_id: int | None = None,
) -> dict:
    """Собирает ссылки на разделы Mini App + VIP для плейсхолдеров.

    Возвращает {vip_link, gifts_link, speakers_link, program_link}. Если раздела
    у события нет (нет реф-программы / нет спикеров) — соответствующий ключ = "".
    Если задан contact_id — в payload добавляется `_ct{id}` (сквозной маркер
    против дублей контактов при переходе между платформами).

    ⚠️ Вкладку НЕЛЬЗЯ приклеивать строкой (`base + "_tab…"`): в веб/бот-режиме
    базовая ссылка это `?start=ref_pg…`, и дописывание хвоста давало мусор.
    Собираем ссылку целиком билдером — он сам знает режим клиента и площадки.
    """
    from app.services.share_links import (
        get_client_bot_handles, resolve_event_link_mode, telegram_link,
    )

    tg_mode = await resolve_event_link_mode(db, client_id=client_id, platform="telegram")
    tg_handle = (await get_client_bot_handles(db, client_id)).get("telegram")

    def with_tab(tab: str) -> str:
        return telegram_link(slug, bot_handle=tg_handle, partner_id=ref_code,
                             tab=tab, contact_id=contact_id, link_mode=tg_mode)

    # Есть ли реф-программа (подарки)?
    has_gifts = await db.fetchval(
        """SELECT 1 FROM event_referral_settings
            WHERE event_id = $1 AND is_enabled = TRUE LIMIT 1""",
        event_id,
    )
    # Есть ли спикеры? (конференция/турнир + хотя бы один коллаб роли speaker/jury/...)
    module_slug = await db.fetchval("SELECT module_slug FROM events WHERE id = $1", event_id)
    has_speakers = False
    if module_slug in ("conference", "turnir"):
        has_speakers = bool(await db.fetchval(
            """SELECT 1 FROM event_collaborators
                WHERE event_id = $1 LIMIT 1""",
            event_id,
        ))

    # VIP
    vip_url = await db.fetchval(
        "SELECT vip_url FROM events WHERE id = $1 AND vip_url IS NOT NULL AND vip_url <> ''",
        event_id,
    )

    return {
        "vip_link":      (vip_url or "").strip(),
        "gifts_link":    with_tab("game") if has_gifts else "",
        "speakers_link": with_tab("speakers") if has_speakers else "",
        "program_link":  with_tab("program"),
    }


def _format_text(
    text: str,
    *,
    event_title: str,
    chats_block: str,
    bot_handle: str,
    support_link: str,
    section_urls: dict,
    support_link_org: str = "",
    support_link_collabs: str = "",
) -> str:
    """Подставляет плейсхолдеры. replace (не .format) — текст содержит HTML с {…}."""
    out = text or ""
    out = out.replace("{event_title}",   escape(event_title or ""))
    out = out.replace("{chats}",         chats_block or "")
    out = out.replace("{bot_handle}",    escape(bot_handle or ""))
    # ⚠️ {support_link_org} — ТОЛЬКО коллаб-событие: служба заботы организатора, от которого
    # пришёл участник. Заменяем ДО {support_link}, иначе тот съест префикс.
    out = out.replace("{support_link_org}", support_link_org or support_link or "")
    # ⚠️ {support_link_collabs} — КОЛЛАБА: контакты ВСЕХ организаторов блоками
    # «Организатор Имя» + каналы. Вне коллабы падает на обычный support_link.
    out = out.replace("{support_link_collabs}", support_link_collabs or support_link or "")
    out = out.replace("{support_link}",  support_link or "")  # уже HTML <a> или текст
    out = out.replace("{vip_link}",      escape(section_urls.get("vip_link") or "", quote=True))
    out = out.replace("{gifts_link}",    escape(section_urls.get("gifts_link") or "", quote=True))
    out = out.replace("{speakers_link}", escape(section_urls.get("speakers_link") or "", quote=True))
    out = out.replace("{program_link}",  escape(section_urls.get("program_link") or "", quote=True))
    return out


# ─── Низкоуровневая отправка (кнопка опциональна) ──────────────────────

async def _send_via_telegram(bot_token: str, chat_id: str, text: str,
                             button_label: str | None, url: str | None) -> None:
    """sendMessage с опциональной inline-кнопкой. Если button_label пуст —
    сообщение уходит без клавиатуры (для шагов «как дела?» без CTA)."""
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if button_label and url:
        payload["reply_markup"] = {"inline_keyboard": [[{"text": button_label, "url": url}]]}
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"TG sendMessage {r.status_code}: {r.text[:200]}")


async def _send_via_vk(token: str, user_id: int, text: str,
                       button_label: str | None, url: str | None) -> None:
    from app.services.vk_api import send_message as vk_send, tg_inline_to_vk_keyboard
    plain = _html_to_plain(text)
    keyboard = None
    if button_label and url:
        keyboard = tg_inline_to_vk_keyboard([[{"text": button_label, "url": url}]])
    await vk_send(user_id, plain, token=token, keyboard=keyboard)


# ─── Отправка шага ─────────────────────────────────────────────────────

async def _send_step(db: asyncpg.Connection, run_row, step_row) -> bool:
    event_title = run_row["event_title"] or "событие"

    # ⚠️ КОЛЛАБ-СОБЫТИЕ: у каждого организатора свой бот и своя база. Человек читает
    # сообщение в боте ТОГО организатора, который его привёл, — значит через него же
    # и шлём, и его служба заботы попадает в текст/кнопку. Вне коллабы _src=None и
    # client_id остаётся владельцем события (поведение не меняется).
    _src = None
    try:
        from app.services.collab_referrer import resolve_source_organizer
        _src = await resolve_source_organizer(db, run_row["event_id"], run_row["contact_id"])
    except Exception:
        _src = None
    client_id = _src or run_row["client_id"]

    # Контакт поддержки клиента — все 3 канала (ВК/Телеграм/MAX), жирные подписи.
    _wrow = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id = $1", client_id)
    from app.services.support_message import build_support_inline_html
    support_link = build_support_inline_html(
        work_tg=_wrow["work_tg_username"] if _wrow else None,
        work_vk=_wrow["work_vk"] if _wrow else None,
        work_max=_wrow["work_max"] if _wrow else None,
    )

    # {support_link_org} — служба заботы того же организатора (client_id уже он).
    support_link_org = ""
    if _src:
        try:
            from app.services.collab_referrer import support_html_for_client
            support_link_org = await support_html_for_client(db, _src)
        except Exception:
            support_link_org = ""

    # {support_link_collabs} — контакты ВСЕХ организаторов коллабы блоками.
    support_link_collabs = ""
    try:
        from app.services.support_message import support_text_for_event
        if await db.fetchval("SELECT is_collab FROM events WHERE id=$1", run_row["event_id"]):
            support_link_collabs = await support_text_for_event(
                db, run_row["event_id"], html=True,
            )
    except Exception:
        support_link_collabs = ""

    ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", run_row["contact_id"])

    # Получатель: TG и VK идентичности
    identities = await db.fetch(
        """SELECT platform_slug, platform_user_id
             FROM platform_users
            WHERE contact_id = $1 AND platform_slug IN ('telegram','vk')""",
        run_row["contact_id"],
    )

    section_urls = await build_section_urls(
        db, event_id=run_row["event_id"], client_id=client_id, slug=run_row["slug"], ref_code=ref_code,
        contact_id=run_row["contact_id"],
    )
    button_label = (step_row["button_label"] or "").strip()
    button_kind = step_row["button_kind"] if "button_kind" in step_row else "event"
    # ⚠️ Кнопка ведёт в БОТА, а тот отвечает сообщением со ВСЕМИ каналами связи
    # (тот же ответ, что даёт команда поддержки) — deeplink `evsupport_{event_id}`.
    # Раньше кнопка вела прямой ссылкой на ОДИН канал той площадки, где человек
    # читает, и если у клиента там поддержки не заведено — кнопки не было вовсе.
    # Сами контакты в ТЕКСТ догрева не подставляем: они приходят отдельным
    # сообщением по нажатию, чтобы не загромождать письмо.
    support_btn_by_platform: dict[str, str] = {}
    if button_kind == "support":
        from app.services.share_links import (
            get_client_bot_handles, build_support_command_links,
        )
        _handles = await get_client_bot_handles(db, client_id)
        support_btn_by_platform = build_support_command_links(_handles, run_row["event_id"])

    sent = False
    for ident in identities:
        plat = ident["platform_slug"]
        pid = ident["platform_user_id"]
        try:
            is_vk = (plat == "vk")
            chats_block = await build_chats_block(db, event_id=run_row["event_id"], html=not is_vk)
            bot_handle = await _bot_handle(db, client_id=client_id, platform=plat)
            text = _format_text(
                step_row["text"],
                event_title=event_title,
                chats_block=chats_block,
                bot_handle=bot_handle,
                support_link=support_link,
                support_link_collabs=support_link_collabs,
                support_link_org=support_link_org,
                section_urls=section_urls,
            )
            # Кнопка: 'support' → t.me/{поддержка}?text=…; иначе — на программу события
            # (платформо-зависимый URL: для VK — vk.com/app…, для TG — t.me/…).
            if button_kind == "support":
                url = support_btn_by_platform.get(plat, "")
            else:
                # ⚠️ Вкладку передаём В БИЛДЕР (а не клеим строкой к готовому URL):
                # в веб/бот-режиме ссылка это `?start=ref_pg…`, и хвост `_tabprogram`
                # ломал бы её. Билдер сам знает режим клиента на этой площадке.
                url = await _build_app_url(
                    db, platform=plat, client_id=client_id, slug=run_row["slug"], ref_code=ref_code,
                    contact_id=run_row["contact_id"], tab="program",
                )
            if plat == "telegram":
                # Только свой VIP-бот клиента. Системный @pluson_bot как fallback убран —
                # нет своего бота → шаг на TG не отправляем (graceful, без падения).
                tok = await get_client_telegram_token(client_id, db)
                if not tok:
                    continue
                await _send_via_telegram(tok, pid, text, button_label or None, url)
                sent = True
            elif plat == "vk":
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
                await _send_via_vk(vk_token, int(pid), text, button_label or None, url)
                sent = True
        except Exception as e:
            logger.warning("nurture_reg send failed run_id=%s plat=%s pid=%s: %s",
                           run_row["id"], plat, pid, e)
    return sent


async def _tick():
    db = await asyncpg.connect(_get_db_url())
    try:
        rows = await db.fetch(
            """SELECT r.id, r.event_id, r.contact_id, r.started_at, r.last_step_index,
                      e.title AS event_title, e.slug, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, e.status, e.start_at, e.end_at
                 FROM event_nurture_reg_runs r
                 JOIN events e ON e.id = r.event_id
                WHERE r.finished_at IS NULL"""
        )
        import datetime as _dt
        now_utc = _dt.datetime.now(_dt.timezone.utc)
        for r in rows:
            # Останов когда событие завершилось.
            if r["status"] == "ended" or (r["end_at"] is not None and r["end_at"] < now_utc):
                await db.execute(
                    "UPDATE event_nurture_reg_runs SET finished_at=NOW(), finished_reason='event_ended' WHERE id=$1",
                    r["id"],
                )
                continue

            next_step = await db.fetchrow(
                """SELECT id, sort_order, offset_seconds, text, button_label, button_kind
                     FROM event_nurture_reg_steps
                    WHERE event_id = $1 AND is_active = TRUE
                    ORDER BY sort_order, id
                    OFFSET $2 LIMIT 1""",
                r["event_id"], (r["last_step_index"] or -1) + 1,
            )
            if not next_step:
                await db.execute(
                    "UPDATE event_nurture_reg_runs SET finished_at=NOW(), finished_reason='all_sent' WHERE id=$1",
                    r["id"],
                )
                continue

            ready = await db.fetchval(
                "SELECT $1::timestamptz + ($2 * INTERVAL '1 second') <= NOW()",
                r["started_at"], int(next_step["offset_seconds"]),
            )
            if not ready:
                continue

            sent = await _send_step(db, r, next_step)
            if sent:
                await db.execute(
                    """UPDATE event_nurture_reg_runs
                          SET last_step_index = last_step_index + 1,
                              last_step_at = NOW()
                        WHERE id = $1""",
                    r["id"],
                )
            else:
                await db.execute(
                    "UPDATE event_nurture_reg_runs SET finished_at=NOW(), finished_reason='no_channel' WHERE id=$1",
                    r["id"],
                )
    finally:
        try: await db.close()
        except Exception: pass


@celery.task(name="app.tasks.nurture_reg.tick")
def nurture_reg_tick():
    """Periodic Celery task: проверяет активные reg-nurture-runs и шлёт пора-шагам."""
    _run_async(_tick())
