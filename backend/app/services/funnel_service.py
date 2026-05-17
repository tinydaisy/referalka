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
from app.services.social_links import normalize_telegram_link, telegram_api_id
from app.config import settings

log = logging.getLogger(__name__)

PLUSSON_TOKEN = lambda: settings.telegram_bot_token  # noqa: E731


async def _get_template(client_id: int, db) -> Optional[dict]:
    return await db.fetchrow(
        """SELECT id, text_1, button_label, text_2, text_3_delivered, text_3_stuck,
                  text_1_media_url, text_1_media_type, text_1_media_file_id,
                  text_2_media_url, text_2_media_type, text_2_media_file_id
             FROM funnel_templates WHERE client_id = $1 AND type = 'lead_magnet'""",
        client_id
    )


async def _get_brand_context(client_id: int, db) -> dict:
    """Подтягивает плейсхолдеры визитки клиента."""
    row = await db.fetchrow(
        """SELECT
              COALESCE(NULLIF(brand_name, ''), name) AS brand_name,
              name AS owner_name,
              bio,
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
    # В тексте — https-ссылка (работает и для открытых, и для закрытых каналов с инвайт-кодом).
    # @-префикс не годится: для `+abc...` даёт мусор `@+abc...`.
    tg_link = (social or {}).get("telegram") or ""
    sub_channel = normalize_telegram_link(tg_link)
    sub_channel_api = telegram_api_id(tg_link)  # @username для getChatMember (открытый канал)
    # Числовой chat_id канала — самое надёжное для getChatMember, работает и для
    # закрытых каналов (если бот в канале админ). Сохраняется кнопкой «Получить ID»
    # в /dashboard/mini-app или вручную через инструкцию в /dashboard/settings.
    sub_channel_chat_id = ""
    raw_chat_id = (social or {}).get("telegram_chat_id")
    if raw_chat_id is not None and str(raw_chat_id).strip():
        try:
            sub_channel_chat_id = str(int(raw_chat_id))
        except (TypeError, ValueError):
            sub_channel_chat_id = ""
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
        "owner_bio": row["bio"] or "",
        "owner_achievements": achievements_text,
        "subscription_channel": sub_channel,                   # https-ссылка для текста
        "subscription_channel_api": sub_channel_api,           # @username для Bot API
        "subscription_channel_chat_id": sub_channel_chat_id,   # числовой id (приоритет)
        "owner_telegram": sub_channel,
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
    materials_list = "\n\n".join(
        f"{i + 1}. {m['name']}" for i, m in enumerate(materials)
    )
    materials_with_links = "\n\n".join(
        f"{i + 1}. {m['name']} — {m['url']}" for i, m in enumerate(materials)
    )
    placeholders = {
        "materials_list": materials_list,
        "materials_with_links": materials_with_links,
        "client_brand_name": ctx.get("brand_name", ""),
        "client_owner_name": ctx.get("owner_name", ""),
        "client_owner_bio": ctx.get("owner_bio", ""),
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


# Лимит Telegram на caption под фото/видео = 1024 символа. На обычное
# сообщение = 4096. Если итоговый текст влезает в caption — шлём одним
# сообщением (sendPhoto/sendVideo с подписью и inline-кнопкой). Если нет —
# сначала медиа отдельно (без caption), потом текст с кнопкой.
TG_CAPTION_LIMIT = 1024


def _extract_file_id(result: dict, media_type: str) -> Optional[str]:
    """Из ответа sendPhoto/sendVideo извлекаем file_id для кеша."""
    if media_type == "video":
        return (result.get("video") or {}).get("file_id")
    photos = result.get("photo") or []
    return photos[-1]["file_id"] if photos else None


async def _send_media(token: str, chat_id, media_payload: str, media_type: str,
                      caption: Optional[str] = None,
                      reply_markup: Optional[dict] = None) -> tuple[Optional[int], Optional[str]]:
    """sendPhoto или sendVideo. media_payload — file_id (кеш TG) или https-URL.
    Возвращает (message_id, file_id_из_ответа) или (None, None) при ошибке."""
    method = "sendVideo" if media_type == "video" else "sendPhoto"
    field = "video" if media_type == "video" else "photo"
    payload = {"chat_id": chat_id, field: media_payload}
    if caption:
        payload["caption"] = caption
        payload["parse_mode"] = "HTML"
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    try:
        async with httpx.AsyncClient(timeout=120) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/{method}",
                json=payload
            )
            data = r.json()
            if data.get("ok"):
                result = data["result"]
                return result.get("message_id"), _extract_file_id(result, media_type)
            log.warning("%s failed: %s", method, data)
    except Exception as e:
        log.warning("%s error: %s", method, e)
    return None, None


async def _send_text_with_media(token: str, chat_id, text: str,
                                media_url: Optional[str],
                                media_type: Optional[str],
                                file_id: Optional[str] = None,
                                reply_markup: Optional[dict] = None
                                ) -> tuple[Optional[int], Optional[str]]:
    """Универсальная отправка текста с опциональным медиа.

    Возвращает (message_id, fresh_file_id). fresh_file_id — то что TG прислал
    в ответе при отправке URL'а первый раз; нужно сохранить в БД, чтобы
    следующие отправки шли через file_id моментально (без скачивания с R2).

    Если file_id передан — сначала пробуем его (мгновенно). При ошибке (например
    file_id протух при смене бота) — повторяем с URL и обновляем кеш.

    Логика caption:
      - нет медиа → sendMessage.
      - есть медиа и len(text) ≤ 1024 → одно sendPhoto/sendVideo с caption + кнопкой.
      - есть медиа и len(text) > 1024 → sendPhoto/sendVideo без caption + sendMessage с кнопкой.
    """
    if not media_url or media_type not in ("photo", "video"):
        return await _send_message(token, chat_id, text, reply_markup), None

    primary  = file_id or media_url
    fallback = media_url if file_id else None

    if len(text) <= TG_CAPTION_LIMIT:
        msg_id, new_fid = await _send_media(token, chat_id, primary, media_type, caption=text, reply_markup=reply_markup)
        if msg_id is None and fallback:
            # file_id протух — fallback на URL
            msg_id, new_fid = await _send_media(token, chat_id, fallback, media_type, caption=text, reply_markup=reply_markup)
        return msg_id, new_fid

    # Текст не влезает в caption — медиа отдельно, потом текст с кнопкой.
    _, new_fid = await _send_media(token, chat_id, primary, media_type, caption=None, reply_markup=None)
    if new_fid is None and fallback:
        _, new_fid = await _send_media(token, chat_id, fallback, media_type, caption=None, reply_markup=None)
    msg_id = await _send_message(token, chat_id, text, reply_markup)
    return msg_id, new_fid


async def _maybe_cache_file_id(template: dict, slot: str, new_fid: Optional[str], db) -> None:
    """Если шаблон ещё не имел file_id и TG только что отдал свежий — сохраняем.
    slot = 'text_1' | 'text_2'."""
    if not new_fid:
        return
    field = f"{slot}_media_file_id"
    if template.get(field):
        return  # уже закеширован
    template_id = template.get("id")
    if not template_id:
        return
    try:
        await db.execute(
            f"UPDATE funnel_templates SET {field} = $1 WHERE id = $2",
            new_fid, template_id
        )
    except Exception as e:
        log.warning("cache file_id failed: %s", e)


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

    # Какой бот «обслужил» этого человека — показываем клиенту в уведомлении.
    bot_handle = None
    if run["platform_user_id"] and (run["platform_slug"] or "telegram") == "telegram":
        from app.services.channels import get_bot_handle_for_user
        bot_handle = await get_bot_handle_for_user(client_id, str(run["platform_user_id"]), db)

    parts = [
        "🆕 <b>Новый интерес</b>",
        "",
        f"<b>Лид-магнит:</b> {run['source_name'] or '—'}",
        f"<b>Бот:</b> {bot_handle or '—'}",
        f"<b>Когда:</b> {when_str or '—'}",
        "",
        "<b>Кто пришёл</b>",
        f"<b>Никнейм:</b> {('@' + run['contact_username']) if run['contact_username'] else '—'}",
        f"<b>Имя:</b> {run['contact_name'] or '—'}",
        f"<b>ID контакта:</b> {('#' + str(run['contact_id'])) if run['contact_id'] else '—'}",
        f"<b>Платформа:</b> {(run['platform_slug'] or '—').title()}",
    ]

    src = utm.get("utm_source") if isinstance(utm, dict) else None
    parts.append(f"<b>Источник (utm_source):</b> {src or '—'}")
    if isinstance(utm, dict):
        for k, v in utm.items():
            if k == "utm_source":
                continue
            parts.append(f"<b>{k}:</b> {v}")

    if run["contact_id"]:
        parts.append(f"<b>Карточка:</b> {settings.frontend_url}/dashboard/clients?contact={run['contact_id']}")

    parts.append("")
    if run["referrer_contact_id"]:
        parts.append("<b>Кто привёл</b>")
        parts.append(f"<b>Никнейм:</b> {('@' + run['referrer_username']) if run['referrer_username'] else '—'}")
        parts.append(f"<b>Имя:</b> {run['referrer_name'] or '—'}")
        parts.append(f"<b>ID контакта:</b> #{run['referrer_contact_id']}")
        parts.append(f"<b>Карточка:</b> {settings.frontend_url}/dashboard/clients?contact={run['referrer_contact_id']}")
    else:
        parts.append("<b>Кто привёл:</b> —")

    text = "\n".join(parts)
    token = settings.telegram_bot_token  # уведомления всегда от @pluson_bot
    if token:
        await _send_message(token, chat_id, text)


async def run_started(run_id: int, tg_id: str, username: Optional[str],
                      first_name: Optional[str], last_name: Optional[str],
                      db, bot_id: Optional[int] = None) -> None:
    """Бот получил /start fnl_<run_id>. Идемпотентно:
    - привязывает забег к platform_user (создаёт contact если нужно),
    - регистрирует подписку на канал воронки в контексте клиента воронки,
    - проставляет stage=started,
    - шлёт уведомление организатору (один раз),
    - отправляет Текст 1 + кнопку «ГОТОВО»."""
    run = await db.fetchrow(
        """SELECT id, client_id, type, lead_magnet_id, package_id, stage,
                  contact_id, platform_slug, platform_user_id, started_at,
                  utm, referrer_contact_id
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run:
        log.info("run_started: run %s not found", run_id)
        return

    client_id = run["client_id"]
    skeleton_contact_id = run["contact_id"]  # legacy: создан на landing у старых забегов; для новых = NULL

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
                      contact_id, platform_slug, platform_user_id, started_at,
                      utm, referrer_contact_id
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
        # Берём skeleton contact, если он есть (легаси: до отказа от скелетов в _landing).
        # Иначе создаём контакт сейчас, копируя UTM/реферера прямо из funnel_runs.
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
            # Извлекаем utm_source из JSONB-блока utm на забеге
            run_utm = run["utm"]
            if isinstance(run_utm, str):
                try:
                    run_utm = json.loads(run_utm)
                except Exception:
                    run_utm = {}
            utm_source = (run_utm or {}).get("utm_source")
            contact_id = await db.fetchval(
                """INSERT INTO contacts
                      (client_id, name, ref_code, utm_source,
                       first_referrer_contact_id, last_contact_at)
                   VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id""",
                client_id,
                ((first_name or "") + " " + (last_name or "")).strip() or (username or ""),
                ref_code,
                utm_source,
                run["referrer_contact_id"],
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

    # Регистрируем подписку в контексте клиента воронки на тот бот, через который
    # пришёл /start. Без этого подписчик не появится у клиента — он будет только
    # у системного клиента (через _record_subscription в bot/handlers/start.py).
    if bot_id:
        try:
            from app.services.channels import find_channel_by_bot_id, register_telegram_subscription
            ch = await find_channel_by_bot_id(int(bot_id), db)
            if ch:
                await register_telegram_subscription(
                    client_id, ch["id"], str(tg_id),
                    username=username or "",
                    first_name=first_name or "",
                    last_name=last_name or "",
                    db=db,
                )
        except Exception as e:
            log.warning("run_started: register subscription failed: %s", e)

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
    msg_id, fresh_fid = await _send_text_with_media(
        token, tg_id, text_1,
        template.get("text_1_media_url"),
        template.get("text_1_media_type"),
        file_id=template.get("text_1_media_file_id"),
        reply_markup=reply_markup,
    )
    await _maybe_cache_file_id(template, "text_1", fresh_fid, db)
    if msg_id:
        await db.execute(
            "UPDATE funnel_runs SET last_message_id = $1 WHERE id = $2",
            msg_id, run_id
        )


async def run_check_subscription(run_id: int, tg_id: str, db) -> str:
    """Проверка подписки. Возвращает status:
       'subscribed'             — материалы отправлены (повторный клик = повторная отправка)
       'not_subscribed'         — не подписан на канал клиента
       'no_token'               — у клиента нет TG-бота для отправки
       'not_found'              — забег не найден
    """
    run = await db.fetchrow(
        """SELECT id, client_id, stage, lead_magnet_id, package_id
             FROM funnel_runs WHERE id = $1""",
        run_id
    )
    if not run:
        return "not_found"

    client_id = run["client_id"]
    ctx = await _get_brand_context(client_id, db)
    channel = ctx.get("subscription_channel", "")
    channel_api = ctx.get("subscription_channel_api", "")
    channel_chat_id = ctx.get("subscription_channel_chat_id", "")
    token = await _bot_token_for_client(client_id, db)
    if not token:
        return "no_token"

    # Приоритет: числовой chat_id (надёжнее, работает и для закрытых каналов
    # если бот добавлен админом) → @username (только открытый канал) → выдаём
    # без проверки (закрытый канал без сохранённого chat_id — Bot API не умеет
    # резолвить инвайт-код, доверяем юзеру).
    if channel_chat_id:
        ok = await _check_subscription(token, channel_chat_id, str(tg_id))
        if not ok:
            return "not_subscribed"
    elif channel_api:
        ok = await _check_subscription(token, channel_api, str(tg_id))
        if not ok:
            return "not_subscribed"
    elif channel:
        # закрытый канал, chat_id не задан — пропускаем проверку
        pass
    # else: канал не настроен — тоже пропускаем (выдаём)

    # подписан → выдаём (или выдаём повторно при повторном нажатии «ГОТОВО»)
    is_first_delivery = run["stage"] != "delivered"
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
    _, fresh_fid = await _send_text_with_media(
        token, tg_id, text_2,
        template.get("text_2_media_url"),
        template.get("text_2_media_type"),
        file_id=template.get("text_2_media_file_id"),
        reply_markup=None,
    )
    await _maybe_cache_file_id(template, "text_2", fresh_fid, db)

    # Таймер «как там, всё открылось?» — только при первой выдаче, чтобы
    # повторные клики не плодили follow-up'ы.
    if is_first_delivery:
        try:
            from app.tasks.funnel import send_text_3
            send_text_3.apply_async(args=[run_id], countdown=30 * 60)
        except Exception as e:
            log.warning("Failed to schedule text_3 for run %s: %s", run_id, e)

    return "subscribed"


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
