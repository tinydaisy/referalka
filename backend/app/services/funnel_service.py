"""
Сервис воронок выдачи лид-магнитов и пакетов через бот.

Высокоуровневые операции:
  - run_started(run_id, ...): фиксирует stage=started, шлёт уведомление организатору,
    отправляет Текст 1 + кнопку. Вызывается из бот-handler /start fnl_<run_id>.
  - run_check_subscription(run_id, ...): проверяет подписку через getChatMember,
    при успехе → stage=delivered, шлёт Текст 2 со списком ссылок, ставит таймер на Текст 3.
  - send_text_3(run_id): вызывается из Celery через 30 минут. Выбирает нужную версию
    (delivered/stuck) по текущему stage.

Все взаимодействия с Telegram — через httpx (без aiogram), чтобы вызывать из любого
контекста (FastAPI/Celery/aiogram-handler).
"""
from typing import Optional, Tuple
import httpx
import json
import logging
from app.services.channels import get_client_telegram_token
from app.config import settings

log = logging.getLogger(__name__)

PLUSSON_TOKEN = lambda: settings.telegram_bot_token  # noqa: E731


async def _get_template(client_id: int, db) -> Optional[dict]:
    return await db.fetchrow(
        """SELECT text_1, button_label, text_2, text_3_delivered, text_3_stuck
             FROM funnel_templates WHERE client_id = $1 AND type = 'lead_magnet'""",
        client_id
    )


async def _get_brand_context(client_id: int, db) -> dict:
    """Подтягивает плейсхолдеры визитки клиента."""
    row = await db.fetchrow(
        """SELECT
              COALESCE(NULLIF(brand_name, ''), name) AS brand_name,
              owner_name,
              owner_achievements,
              social_links
             FROM clients WHERE id = $1""",
        client_id
    )
    if not row:
        return {}
    social = row["social_links"] or {}
    if isinstance(social, str):
        try:
            social = json.loads(social)
        except Exception:
            social = {}
    tg_link = (social or {}).get("telegram") or ""
    # Достаём @username из URL канала, если задан
    sub_channel = ""
    if tg_link:
        s = tg_link.replace("https://t.me/", "").replace("http://t.me/", "").strip("/ @")
        if s:
            sub_channel = "@" + s
    achievements = row["owner_achievements"] or []
    if isinstance(achievements, str):
        try:
            achievements = json.loads(achievements)
        except Exception:
            achievements = []
    achievements_text = ""
    if achievements:
        parts = []
        for a in achievements:
            label = (a.get("label") or "").strip()
            value = (a.get("value") or "").strip()
            if label and value:
                parts.append(f"• {label}: {value}")
            elif value:
                parts.append(f"• {value}")
        achievements_text = "\n".join(parts)
    return {
        "brand_name": row["brand_name"] or "",
        "owner_name": row["owner_name"] or "",
        "owner_achievements": achievements_text,
        "subscription_channel": sub_channel,
        "owner_telegram": sub_channel,  # на случай если text_3 хочет «напишите мне»
    }


async def _materials_for_run(run: dict, db) -> list[dict]:
    """Возвращает список материалов воронки: [{name, url}, ...].
    Для одиночного лид-магнита — список из одного. Для пакета — все вложенные."""
    if run["lead_magnet_id"]:
        rows = await db.fetch(
            "SELECT name, url FROM lead_magnets WHERE id = $1",
            run["lead_magnet_id"]
        )
    else:
        rows = await db.fetch(
            """SELECT lm.name, lm.url
                 FROM lead_magnet_package_items pi
                 JOIN lead_magnets lm ON lm.id = pi.lead_magnet_id
                WHERE pi.package_id = $1
             ORDER BY pi.sort_order, lm.name""",
            run["package_id"]
        )
    return [dict(r) for r in rows]


def _format_text(template: str, ctx: dict, materials: list[dict]) -> str:
    materials_list = "\n".join(
        f"{i + 1}. {m['name']}" for i, m in enumerate(materials)
    )
    materials_with_links = "\n".join(
        f"{i + 1}. {m['name']} — {m['url']}" for i, m in enumerate(materials)
    )
    placeholders = {
        "materials_list": materials_list,
        "materials_with_links": materials_with_links,
        "client_brand_name": ctx.get("brand_name", ""),
        "client_owner_name": ctx.get("owner_name", ""),
        "client_owner_achievements": ctx.get("owner_achievements", ""),
        "subscription_channel": ctx.get("subscription_channel", ""),
        "owner_telegram": ctx.get("owner_telegram", ""),
    }
    out = template
    for k, v in placeholders.items():
        out = out.replace("{" + k + "}", v or "")
    return out


async def _bot_token_for_client(client_id: int, db) -> Optional[str]:
    """Какой бот шлёт сообщения участнику воронки.
    Если у клиента активна фича 'channels' и есть свой бот → его токен.
    Иначе → общий @pluson_bot (settings.telegram_bot_token)."""
    from app.services.features import client_has_feature
    if await client_has_feature(db, client_id, "channels"):
        token = await get_client_telegram_token(client_id, db)
        if token:
            return token
    return settings.telegram_bot_token or None


async def _send_message(token: str, chat_id, text: str, reply_markup: Optional[dict] = None) -> Optional[int]:
    """Возвращает message_id или None при ошибке."""
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json=payload
            )
            data = r.json()
            if data.get("ok"):
                return data["result"].get("message_id")
            log.warning("sendMessage failed: %s", data)
    except Exception as e:
        log.warning("sendMessage error: %s", e)
    return None


async def _check_subscription(token: str, channel: str, user_id: str) -> bool:
    """Проверяет подписку user_id на channel (например '@brand_channel') через getChatMember.
    Возвращает True если статус member/administrator/creator."""
    if not channel:
        return True  # канал не настроен — пропускаем
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel, "user_id": user_id}
            )
            data = r.json()
            if data.get("ok"):
                status = data["result"].get("status", "")
                return status in ("member", "administrator", "creator")
            log.info("getChatMember not ok: %s", data)
    except Exception as e:
        log.warning("getChatMember error: %s", e)
    return False


async def _send_organizer_notification(client_id: int, run_id: int, db) -> None:
    """Шлёт уведомление в TG-канал организатора (если настроен) о новом интересе."""
    chat_id = await db.fetchval(
        "SELECT notifications_telegram_chat_id FROM clients WHERE id = $1",
        client_id
    )
    if not chat_id:
        return

    run = await db.fetchrow(
        """SELECT fr.id, fr.platform_slug, fr.platform_user_id, fr.utm,
                  fr.lead_magnet_id, fr.package_id, fr.contact_id, fr.referrer_contact_id,
                  fr.landed_at,
                  COALESCE(lm.name, pkg.name) AS source_name,
                  c.name AS contact_name,
                  pu.username AS contact_username,
                  rc.name AS referrer_name,
                  rpu.username AS referrer_username
             FROM funnel_runs fr
        LEFT JOIN lead_magnets lm        ON lm.id = fr.lead_magnet_id
        LEFT JOIN lead_magnet_packages pkg ON pkg.id = fr.package_id
        LEFT JOIN contacts c             ON c.id = fr.contact_id
        LEFT JOIN platform_users pu      ON pu.contact_id = fr.contact_id AND pu.platform_slug = fr.platform_slug
        LEFT JOIN contacts rc            ON rc.id = fr.referrer_contact_id
        LEFT JOIN platform_users rpu     ON rpu.contact_id = fr.referrer_contact_id AND rpu.platform_slug = fr.platform_slug
            WHERE fr.id = $1""",
        run_id
    )
    if not run:
        return

    utm = run["utm"] or {}
    if isinstance(utm, str):
        try:
            utm = json.loads(utm)
        except Exception:
            utm = {}

    when = run["landed_at"]
    when_str = when.strftime("%d.%m.%Y %H:%M") if when else ""

    parts = [
        f"🆕 <b>Новый интерес: {run['source_name']}</b>",
        when_str,
        "",
        "<b>Кто пришёл:</b>",
    ]
    user_line_bits = []
    if run["contact_username"]:
        user_line_bits.append(f"@{run['contact_username']}")
    if run["contact_id"]:
        user_line_bits.append(f"#{run['contact_id']}")
    if user_line_bits:
        parts.append(" · ".join(user_line_bits))
    if run["contact_name"]:
        parts.append(run["contact_name"])
    if run["platform_slug"]:
        parts.append(run["platform_slug"].title())
    src = utm.get("utm_source") if isinstance(utm, dict) else None
    if src:
        parts.append(f"utm_source: {src}")
    # все остальные UTM
    if isinstance(utm, dict):
        extras = [f"{k}: {v}" for k, v in utm.items() if k != "utm_source"]
        if extras:
            parts.append(" · ".join(extras))
    if run["contact_id"]:
        parts.append(f"👉 {settings.frontend_url}/dashboard/clients?contact={run['contact_id']}")

    if run["referrer_contact_id"]:
        parts.append("")
        parts.append("<b>Кто привёл:</b>")
        ref_bits = []
        if run["referrer_username"]:
            ref_bits.append(f"@{run['referrer_username']}")
        ref_bits.append(f"#{run['referrer_contact_id']}")
        parts.append(" · ".join(ref_bits))
        if run["referrer_name"]:
            parts.append(run["referrer_name"])
        parts.append(f"👉 {settings.frontend_url}/dashboard/clients?contact={run['referrer_contact_id']}")

    text = "\n".join(parts)
    token = settings.telegram_bot_token  # уведомления всегда от @pluson_bot
    if token:
        await _send_message(token, chat_id, text)


async def run_started(run_id: int, tg_id: str, username: Optional[str],
                      first_name: Optional[str], last_name: Optional[str],
                      db) -> None:
    """Бот получил /start fnl_<run_id>. Идемпотентно:
    - привязывает забег к platform_user (создаёт contact если нужно),
    - проставляет stage=started,
    - шлёт уведомление организатору (один раз),
    - отправляет Текст 1 + кнопку «ГОТОВО»."""
    run = await db.fetchrow(
        """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                  contact_id, platform_slug, platform_user_id, started_at
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run:
        log.info("run_started: run %s not found", run_id)
        return

    client_id = run["client_id"]
    skeleton_contact_id = run["contact_id"]  # создан на landing, может быть None для старых забегов

    # Если у человека уже был забег по этому же магниту/пакету (он повторно кликнул
    # ссылку) — переключаемся на существующий забег вместо создания дубликата.
    # Уникальный индекс funnel_runs_unique_per_lm/per_pkg иначе словил бы коллизию.
    existing_run = await db.fetchrow(
        """SELECT id, stage, contact_id
             FROM funnel_runs
            WHERE client_id = $1
              AND platform_slug = 'telegram'
              AND platform_user_id = $2
              AND COALESCE(lead_magnet_id, 0) = COALESCE($3, 0)
              AND COALESCE(package_id, 0)     = COALESCE($4, 0)
              AND id <> $5
            ORDER BY id ASC LIMIT 1""",
        client_id, str(tg_id),
        run["lead_magnet_id"], run["package_id"], run_id
    )
    if existing_run:
        # Подбираем уже известный забег. Удаляем новый skeleton, чтобы не плодить дубли,
        # и осиротевший skeleton-контакт (если ничем не занят).
        if skeleton_contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
        else:
            await db.execute("DELETE FROM funnel_runs WHERE id = $1", run_id)
        # Перезаписываем run на существующий — все дальнейшие апдейты идут в него
        run_id = existing_run["id"]
        run = await db.fetchrow(
            """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                      contact_id, platform_slug, platform_user_id, started_at
                 FROM funnel_runs WHERE id = $1""",
            run_id
        )
        skeleton_contact_id = None  # уже не skeleton, а реальный контакт

    # Привязка к контакту через platform_users (telegram per-client)
    pu = await db.fetchrow(
        """SELECT pu.id, pu.contact_id
             FROM platform_users pu
            WHERE pu.client_id = $1 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $2""",
        client_id, str(tg_id)
    )
    contact_id: Optional[int] = None
    if pu:
        # У человека уже есть запись в этом клиенте — используем её,
        # скелет от landing становится orphan (если ничем больше не занят — удаляем)
        contact_id = pu["contact_id"]
        await db.execute(
            """UPDATE platform_users
                  SET username = COALESCE(NULLIF($1,''), username),
                      first_name = COALESCE(NULLIF($2,''), first_name),
                      last_name = COALESCE(NULLIF($3,''), last_name)
                WHERE id = $4""",
            username or "", first_name or "", last_name or "", pu["id"]
        )
        if skeleton_contact_id and skeleton_contact_id != contact_id:
            used_elsewhere = await db.fetchval(
                """SELECT EXISTS (
                       SELECT 1 FROM funnel_runs WHERE contact_id = $1 AND id <> $2
                       UNION ALL SELECT 1 FROM event_participants WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM platform_users  WHERE contact_id = $1
                       UNION ALL SELECT 1 FROM collaborators    WHERE contact_id = $1
                   )""",
                skeleton_contact_id, run_id
            )
            if not used_elsewhere:
                await db.execute("DELETE FROM contacts WHERE id = $1", skeleton_contact_id)
    else:
        # Берём skeleton contact, который создали на landing.
        # Если его нет (легаси-забег без contact_id) — создаём новый.
        if skeleton_contact_id:
            contact_id = skeleton_contact_id
            full_name = ((first_name or "") + " " + (last_name or "")).strip() or (username or "")
            await db.execute(
                """UPDATE contacts
                      SET name = COALESCE(name, NULLIF($1, '')),
                          last_contact_at = NOW()
                    WHERE id = $2""",
                full_name, contact_id
            )
        else:
            from app.services.contact_merge import _generate_unique_ref_code
            ref_code = await _generate_unique_ref_code(db)
            contact_id = await db.fetchval(
                """INSERT INTO contacts (client_id, name, ref_code, last_contact_at)
                   VALUES ($1, $2, $3, NOW()) RETURNING id""",
                client_id,
                ((first_name or "") + " " + (last_name or "")).strip() or (username or ""),
                ref_code
            )
        await db.execute(
            """INSERT INTO platform_users
                  (client_id, contact_id, platform_slug, platform_user_id,
                   username, first_name, last_name)
               VALUES ($1, $2, 'telegram', $3, $4, $5, $6)
               ON CONFLICT (client_id, platform_slug, platform_user_id) DO NOTHING""",
            client_id, contact_id, str(tg_id),
            username, first_name, last_name
        )

    is_new_started = run["stage"] == "landed"
    await db.execute(
        """UPDATE funnel_runs
              SET contact_id = COALESCE(contact_id, $1),
                  platform_slug = 'telegram',
                  platform_user_id = $2,
                  stage = CASE WHEN stage = 'landed' THEN 'started' ELSE stage END,
                  started_at = COALESCE(started_at, NOW())
            WHERE id = $3""",
        contact_id, str(tg_id), run_id
    )

    # Уведомление организатору — только при первом переходе landed → started
    if is_new_started:
        await _send_organizer_notification(client_id, run_id, db)

    # Шлём Текст 1 с кнопкой
    template = await _get_template(client_id, db)
    if not template:
        # автосоздание дефолтным
        from app.api.funnels import _get_or_create_template
        template = await _get_or_create_template(client_id, "lead_magnet", db)
        template = dict(template)

    ctx = await _get_brand_context(client_id, db)
    materials = await _materials_for_run(dict(run), db)
    text_1 = _format_text(template["text_1"], ctx, materials)

    button_label = template["button_label"] or "ГОТОВО"
    reply_markup = {
        "inline_keyboard": [[{
            "text": button_label,
            "callback_data": f"fnl_check_{run_id}"
        }]]
    }
    token = await _bot_token_for_client(client_id, db)
    if not token:
        log.warning("run_started: no bot token for client %s", client_id)
        return
    msg_id = await _send_message(token, tg_id, text_1, reply_markup)
    if msg_id:
        await db.execute(
            "UPDATE funnel_runs SET last_message_id = $1 WHERE id = $2",
            msg_id, run_id
        )


async def run_check_subscription(run_id: int, tg_id: str, db) -> Tuple[str, bool]:
    """Проверка подписки. Возвращает (status, already_delivered):
       'subscribed'             — выдали (или повторно говорим что уже выдавали)
       'not_subscribed'         — не подписан на канал клиента
       'channel_not_configured' — у клиента не настроен канал подписки в визитке
       'no_token'               — у клиента нет TG-бота для отправки
       'not_found'              — забег не найден
    """
    run = await db.fetchrow(
        """SELECT id, client_id, stage, lead_magnet_id, package_id
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run:
        return "not_found", False
    if run["stage"] == "delivered":
        return "subscribed", True

    client_id = run["client_id"]
    ctx = await _get_brand_context(client_id, db)
    channel = ctx.get("subscription_channel", "")
    token = await _bot_token_for_client(client_id, db)
    if not token:
        return "no_token", False

    if not channel:
        # Канал не настроен — не выдаём, чтобы у клиента был стимул его настроить.
        # В UI лид-магнитов будет соответствующее предупреждение.
        return "channel_not_configured", False

    ok = await _check_subscription(token, channel, str(tg_id))
    if not ok:
        return "not_subscribed", False
    # подписан → выдаём
    await db.execute(
        """UPDATE funnel_runs
              SET stage = 'delivered',
                  subscribed_at = COALESCE(subscribed_at, NOW()),
                  delivered_at = COALESCE(delivered_at, NOW())
            WHERE id = $1""",
        run_id
    )

    template = await _get_template(client_id, db)
    if not template:
        from app.api.funnels import _get_or_create_template
        template = await _get_or_create_template(client_id, "lead_magnet", db)
        template = dict(template)

    materials = await _materials_for_run(dict(run), db)
    text_2 = _format_text(template["text_2"], ctx, materials)
    await _send_message(token, tg_id, text_2)

    # Запускаем Celery-таймер на 30 минут
    try:
        from app.tasks.funnel import send_text_3
        send_text_3.apply_async(args=[run_id], countdown=30 * 60)
    except Exception as e:
        log.warning("Failed to schedule text_3 for run %s: %s", run_id, e)

    return "subscribed", False


async def send_text_3(run_id: int, db) -> None:
    """Отправляет Текст 3. Версия выбирается по текущему stage:
       delivered → text_3_delivered ; started/subscribed → text_3_stuck.
       landed → не шлём (человек так и не дошёл до бота)."""
    run = await db.fetchrow(
        """SELECT id, client_id, stage, lead_magnet_id, package_id,
                  platform_user_id, text3_sent_at
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run or run["text3_sent_at"]:
        return
    if run["stage"] == "landed" or not run["platform_user_id"]:
        return

    client_id = run["client_id"]
    template = await _get_template(client_id, db)
    if not template:
        return
    ctx = await _get_brand_context(client_id, db)
    materials = await _materials_for_run(dict(run), db)

    if run["stage"] == "delivered":
        text = _format_text(template["text_3_delivered"], ctx, materials)
        kind = "delivered"
    else:
        text = _format_text(template["text_3_stuck"], ctx, materials)
        kind = "stuck"

    token = await _bot_token_for_client(client_id, db)
    if not token:
        return
    await _send_message(token, run["platform_user_id"], text)
    await db.execute(
        "UPDATE funnel_runs SET text3_sent_at = NOW(), text3_kind = $1 WHERE id = $2",
        kind, run_id
    )
