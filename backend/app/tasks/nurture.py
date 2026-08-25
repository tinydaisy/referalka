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
import json
import logging
from html import escape

import asyncpg
import httpx

from app.celery_app import celery
from app.config import settings
from app.services.channels import get_client_telegram_token
from app.services.share_links import TG_DOMAIN

logger = logging.getLogger(__name__)


# Celery вызывает task много раз, каждый раз asyncio.run() создаёт новый
# event loop. Глобальный get_pool() из app.database не подходит — он привязан
# к event loop из первого вызова и при следующем выдаёт «Event loop is closed».
# Поэтому подключаемся одиночным asyncpg.connect(), как в tasks/broadcast.py.
def _get_db_url() -> str:
    return settings.database_url


def _run_async(coro):
    """Создаёт новый event loop, выполняет корутину и закрывает loop.
    Безопасно для Celery — каждый task получает свежий loop."""
    # ⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но НЕ делает
    # его текущим. Библиотеки внутри зовут asyncio.get_event_loop() и получают
    # ЗАКРЫТЫЙ цикл предыдущей задачи того же воркера → RuntimeError('Event loop
    # is closed'). Так молча терялись записи вебинаров и Текст 3 воронок.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


def _format_text(
    text: str,
    *,
    event_title: str,
    event_date_short: str,
    owner_telegram: str = "",
    support_link: str = "",
    support_link_org: str = "",
    support_link_collabs: str = "",
    brand_name: str = "",
) -> str:
    """Подставляет плейсхолдеры. Безопасно — формат-строка может содержать
    случайные {...} в HTML; используем replace, а не .format()."""
    out = text or ""
    out = out.replace("{event_title}",      escape(event_title or ""))
    out = out.replace("{event_date_short}", escape(event_date_short or ""))
    out = out.replace("{owner_telegram}",   owner_telegram or "")  # уже HTML-тег <a>
    # ⚠️ {support_link_org} — только для КОЛЛАБ-события: служба заботы ТОГО организатора,
    # от которого пришёл участник (у каждого своя база и свой бот). Если определить не
    # удалось — падаем на общий support_link (служба владельца события).
    out = out.replace("{support_link_org}", support_link_org or support_link or "")
    # ⚠️ {support_link_collabs} — КОЛЛАБА: контакты ВСЕХ организаторов блоками
    # «Организатор Имя» + его каналы. Отличается от {support_link_org} (только
    # тот, кто привёл) и от {support_link} (владелец события). Вне коллабы
    # падает на обычный support_link — плейсхолдер не уедет получателю сырым.
    out = out.replace("{support_link_collabs}", support_link_collabs or support_link or "")
    out = out.replace("{support_link}",     support_link or "")    # уже HTML-тег <a> или текст
    out = out.replace("{brand_name}",       f"«{escape(brand_name)}»" if brand_name else "")
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
    href = f"https://{TG_DOMAIN}/{handle}"
    return f'<a href="{href}">@{escape(handle)}</a>'


def _build_support_contact(work_tg: str | None) -> str:
    """Контакт службы поддержки для {support_link}. HTML-якорь <a> с @username.
    Берётся ТОЛЬКО из clients.work_tg_username (поле «Служба поддержки»).
    Если не задан — нейтральный fallback «в этом боте»."""
    handle = (work_tg or "").lstrip("@").strip()
    if not handle:
        return "в этом боте"
    return f'<a href="https://{TG_DOMAIN}/{escape(handle)}">@{escape(handle)}</a>'


async def _build_app_url(
    db: asyncpg.Connection,
    *,
    platform: str,
    client_id: int | None,
    slug: str,
    ref_code: str | None,
    contact_id: int | None = None,
    tab: str | None = None,
) -> str:
    """URL кнопки «Зарегистрироваться» — С УЧЁТОМ РЕЖИМА ССЫЛОК КЛИЕНТА.

    ⚠️ Раньше тут всегда собирался Mini App (`?startapp=…`), из-за чего клиент с
    настройкой «Веб-версия» («Бот и ссылки») всё равно получал кнопку в Mini App.
    Режим задаётся ОТДЕЛЬНО НА КАЖДУЮ ПЛОЩАДКУ (clients.link_mode_{telegram|vk|max},
    миграция 200). Режима у самого события больше нет (миграция 240),
    поэтому строим ссылку общими билдерами share_links — там режим уже учтён:
      • miniapp → t.me/{бот}?startapp=… / vk.com/app{id}#ref_pg… / max.ru/{h}?startapp=…
      • bot     → t.me/{бот}?start=…    / vk.com/app{id}#evl_…   / max.ru/{h}?start=…
    Нет своего бота/сообщества на площадке → пустая строка (шаг не отправится).
    """
    from app.services.share_links import (
        get_client_bot_handles, get_client_vk_app_id,
        resolve_event_link_mode, telegram_link, vk_link, max_link,
    )

    if not client_id:
        return ""

    # Режим — только из настроек кабинета (у события своего режима больше нет).
    mode = await resolve_event_link_mode(db, client_id=client_id, platform=platform)

    if platform == "telegram":
        handles = await get_client_bot_handles(db, client_id)
        return telegram_link(slug, bot_handle=handles.get("telegram"),
                             partner_id=ref_code, tab=tab, contact_id=contact_id, link_mode=mode)

    if platform == "vk":
        app_id = await get_client_vk_app_id(db, client_id)
        return vk_link(slug, app_id=app_id,
                       partner_id=ref_code, tab=tab, contact_id=contact_id, link_mode=mode)

    if platform == "max":
        handles = await get_client_bot_handles(db, client_id)
        return max_link(slug, bot_handle=handles.get("max"),
                        partner_id=ref_code, tab=tab, contact_id=contact_id, link_mode=mode)

    return ""


async def _send_via_telegram(bot_token: str, chat_id: str, text: str, button_label: str, url: str,
                             extra_buttons: list[tuple[str, str]] | None = None) -> None:
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    # Нет URL (напр. у клиента не настроена поддержка на этой площадке) → шлём
    # БЕЗ кнопки. Кнопка в никуда бесполезна, а Telegram её и не примет.
    rows = []
    if url:
        rows.append([{"text": button_label, "url": url}])
    for _lbl, _u in (extra_buttons or []):
        if _u:
            rows.append([{"text": _lbl, "url": _u}])
    if rows:
        payload["reply_markup"] = {"inline_keyboard": rows}
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"TG sendMessage {r.status_code}: {r.text[:200]}")


def _html_to_plain(html_text: str) -> str:
    """Превращает HTML-форматированный текст (для TG) в plain text для VK.

    VK Bot API не поддерживает HTML/Markdown — теги и entity видны как сырой
    текст в чате. Стрипаем теги, разворачиваем `<a href>` в `label (URL)`
    чтобы пользователь увидел ссылку, и unescape-ируем `&quot;` / `&amp;` / etc.
    """
    import re
    from html import unescape
    # Сначала `<a href="X">label</a>` → `label (X)` (или просто X если label пуст)
    def repl_a(m: re.Match) -> str:
        href = m.group(1)
        label = re.sub(r'<[^>]+>', '', m.group(2)).strip()
        return f"{label} ({href})" if label and label != href else href
    out = re.sub(r'<a\s+href="([^"]+)"[^>]*>(.*?)</a>', repl_a, html_text or "", flags=re.DOTALL | re.IGNORECASE)
    # Остальные теги — стрипаем целиком
    out = re.sub(r'<[^>]+>', '', out)
    # HTML entities: &quot; → " , &amp; → & и т.п.
    out = unescape(out)
    return out


async def _send_via_vk(token: str, user_id: int, text: str, button_label: str, url: str) -> None:
    from app.services.vk_api import send_message as vk_send, tg_inline_to_vk_keyboard
    plain = _html_to_plain(text)
    # Нет URL (нет поддержки на этой площадке) → без кнопки.
    keyboard = tg_inline_to_vk_keyboard([[{"text": button_label, "url": url}]]) if url else None
    await vk_send(user_id, plain, token=token, keyboard=keyboard)


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

    # Контакт организатора — из настроек клиента. Приоритет work_tg_username,
    # fallback — первый TG-канал основателя из массива social_links.telegram_channels
    # (миграция 114). Legacy-ключ social_links->>'telegram' покрывается хелпером
    # get_founder_tg_channels.
    from app.services.social_links import get_founder_tg_channels

    # ⚠️ КОЛЛАБ-СОБЫТИЕ: организаторов несколько, у каждого свой бот и своя база.
    # Человек читает сообщение в боте ТОГО организатора, который его привёл, —
    # значит и служба заботы, и бренд, и кнопка поддержки должны быть ЕГО, а не
    # владельца события (run_row["client_id"] = владелец).
    ctx_client_id = run_row["client_id"]
    src_cid = None
    try:
        from app.services.collab_referrer import resolve_source_organizer
        src_cid = await resolve_source_organizer(db, run_row["event_id"], run_row["contact_id"])
        if src_cid:
            ctx_client_id = src_cid
    except Exception:
        src_cid = None

    contact_row = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max, social_links, brand_name, name FROM clients WHERE id = $1",
        ctx_client_id,
    )
    founder_tg = ""
    if contact_row:
        social = contact_row["social_links"]
        if isinstance(social, str):
            try:
                social = json.loads(social)
            except Exception:
                social = {}
        channels = get_founder_tg_channels(social or {})
        if channels:
            founder_tg = channels[0]["url"]
    work_tg_username = contact_row["work_tg_username"] if contact_row else None
    owner_tg = _build_owner_contact(work_tg_username, founder_tg or None)
    # Служба поддержки для {support_link}: все 3 канала (ВК/Телеграм/MAX),
    # каждый с новой строки, название площадки жирным. В VK HTML конвертится
    # в plain через _html_to_plain.
    from app.services.support_message import build_support_inline_html
    support_link = build_support_inline_html(
        work_tg=work_tg_username,
        work_vk=contact_row["work_vk"] if contact_row else None,
        work_max=contact_row["work_max"] if contact_row else None,
    )
    brand_name = ""
    if contact_row:
        brand_name = (contact_row["brand_name"] or contact_row["name"] or "").strip()

    # {support_link_org} — коллаб-событие: служба заботы ТОГО организатора, от которого
    # пришёл участник (каждый организатор ведёт свою базу через своего бота).
    # src_cid уже разрезолвлен выше — второй раз в БД не ходим.
    support_link_org = ""
    if src_cid:
        try:
            from app.services.collab_referrer import support_html_for_client
            support_link_org = await support_html_for_client(db, src_cid)
        except Exception:
            support_link_org = ""

    # {support_link_collabs} — контакты ВСЕХ организаторов коллабы блоками.
    # Считается только для коллаб-события: у обычного организатор один и
    # плейсхолдер падает на обычный support_link (см. _format_text).
    support_link_collabs = ""
    try:
        from app.services.support_message import support_text_for_event
        if await db.fetchval("SELECT is_collab FROM events WHERE id=$1", run_row["event_id"]):
            support_link_collabs = await support_text_for_event(
                db, run_row["event_id"], html=True,
            )
    except Exception:
        support_link_collabs = ""

    text = _format_text(
        step_row["text"],
        event_title=event_title,
        event_date_short=event_date_short,
        owner_telegram=owner_tg,
        support_link=support_link,
        support_link_org=support_link_org,
        support_link_collabs=support_link_collabs,
        brand_name=brand_name,
    )
    button_label = step_row["button_label"] or "Зарегистрироваться"
    button_kind = step_row["button_kind"] if "button_kind" in step_row else "event"
    # ⚠️ Кнопка ведёт в БОТА, а тот отвечает сообщением со ВСЕМИ каналами связи
    # (тот же ответ, что даёт команда поддержки) — deeplink `evsupport_{event_id}`.
    # Раньше кнопка вела прямой ссылкой на ОДИН канал той площадки, где человек
    # читает, и если у клиента там поддержки не заведено — кнопки не было вовсе.
    # Теперь человек в любом случае получает все контакты сразу.
    support_btn_by_platform: dict[str, str] = {}
    if button_kind == "support":
        from app.services.share_links import (
            get_client_bot_handles, build_support_command_links,
        )
        _handles = await get_client_bot_handles(db, ctx_client_id)
        support_btn_by_platform = build_support_command_links(_handles, run_row["event_id"])

    # Получатель: ищем идентичности контакта в TG и VK
    identities = await db.fetch(
        """SELECT platform_slug, platform_user_id
             FROM platform_users
            WHERE contact_id = $1 AND platform_slug IN ('telegram','vk')""",
        run_row["contact_id"],
    )

    ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", run_row["contact_id"])
    sent = False
    # ⚠️ В КОЛЛАБЕ шлём через бота ТОГО организатора, который привёл человека
    # (ctx_client_id), а не владельца события: у каждого свой бот и своя база,
    # и человек подписан именно на бота своего организатора. Вне коллабы
    # ctx_client_id == владелец, поведение не меняется.
    client_id = ctx_client_id

    for ident in identities:
        plat = ident["platform_slug"]
        pid = ident["platform_user_id"]
        try:
            # ⚠️ Кнопка «Зарегистрироваться» — ПЕРВОЙ и у ВСЕХ шагов, включая
            # шаг поддержки: цель догрева — довести до регистрации, и человек
            # не должен искать, куда нажать. Ведёт по настройкам события
            # (форма / наш лендинг / сторонний сайт) и клиента (Mini App / веб)
            # — их разбирает уже сама ссылка на событие.
            # «Написать в тех.поддержку» идёт ВТОРОЙ строкой.
            reg_url = await _build_app_url(
                db, platform=plat, client_id=client_id, slug=run_row["slug"],
                ref_code=ref_code, contact_id=run_row["contact_id"])
            extra: list[tuple[str, str]] = []
            if button_kind == "support":
                url = reg_url
                label = "Зарегистрироваться"
                _sup = support_btn_by_platform.get(plat, "")
                if _sup:
                    extra.append((button_label or "Написать в тех.поддержку", _sup))
            else:
                url = reg_url
                label = button_label
            if plat == "telegram":
                # Только свой VIP-бот клиента. Системный @pluson_bot как fallback убран —
                # нет своего бота → шаг на TG не отправляем (graceful, без падения).
                tok = await get_client_telegram_token(client_id, db)
                if not tok:
                    continue
                await _send_via_telegram(tok, pid, text, label, url, extra_buttons=extra)
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
                # VK: кнопка одна — ставим регистрацию (главное действие).
                # Поддержка во ВК приходит текстом сообщения бота по /support.
                await _send_via_vk(vk_token, int(pid), text, label, url)
                sent = True
        except Exception as e:
            logger.warning("nurture send failed run_id=%s plat=%s pid=%s: %s",
                           run_row["id"], plat, pid, e)
    return sent


async def _tick():
    db = await asyncpg.connect(_get_db_url())
    try:
        # Все активные runs + текущее состояние
        rows = await db.fetch(
            """SELECT r.id, r.event_id, r.contact_id, r.started_at, r.last_step_index,
                      e.title AS event_title, e.slug, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, e.status, e.start_at, e.end_at
                 FROM event_nurture_runs r
                 JOIN events e ON e.id = r.event_id
                WHERE r.finished_at IS NULL"""
        )
        import datetime as _dt
        now_utc = _dt.datetime.now(_dt.timezone.utc)
        for r in rows:
            # Останов ТОЛЬКО когда событие ЗАВЕРШИЛОСЬ — регистрироваться поздно.
            # Само начало события не повод останавливать догрев: человек может
            # регаться и во время эфира (многодневные конференции, события в записи,
            # длинные премии). Если start_at прошёл, но end_at в будущем — шаги
            # продолжают идти.
            if r["status"] == "ended" or (r["end_at"] is not None and r["end_at"] < now_utc):
                await db.execute(
                    "UPDATE event_nurture_runs SET finished_at=NOW(), finished_reason='event_ended' WHERE id=$1",
                    r["id"],
                )
                continue

            # Берём следующий активный шаг по индексу last_step_index + 1
            next_step = await db.fetchrow(
                """SELECT id, sort_order, offset_seconds, text, button_label, button_kind
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
    finally:
        try: await db.close()
        except Exception: pass


@celery.task(name="app.tasks.nurture.tick")
def nurture_tick():
    """Periodic Celery task: проверяет все активные nurture-runs и шлёт пора-шагам."""
    _run_async(_tick())
