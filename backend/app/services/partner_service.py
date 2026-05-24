"""
Сервис «Регистрация партнёра» — бот-флоу для миграции 105.

Параллельный аналог funnel_service.run_started / run_started_vk, только проще:
не нужна проверка подписки, нет Текст 2/3 и Celery-таймера. Бот отправляет одно
из двух сообщений:

· контакт ЕЩЁ НЕ зарегистрирован партнёром (external_ref_param пуст) →
  «Вы регистрируетесь Партнёром у {owner} ({brand})» + web_app кнопка на
  Mini App → авто-редирект на сторонний лендинг клиента.

· контакт УЖЕ зарегистрирован партнёром (external_ref_param непустой) →
  «Вы уже зарегистрированы партнёром у {brand}. Ваш код: XXX. По вопросам
  отслеживания состояния партнёрского кабинета — @work_tg». Без кнопки.

После сабмита формы человек возвращается через /r/partner/{run_id} в Mini App,
там — экран успеха (poll на external_ref_param контакта).
"""
from typing import Optional
import httpx
import json
import logging
from app.services.channels import get_client_telegram_token
from app.config import settings

log = logging.getLogger(__name__)


async def _bot_token_for_client(client_id: int, db) -> Optional[str]:
    """Какой бот шлёт сообщения. Свой бот VIP-клиента (если фича channels) или @pluson_bot."""
    from app.services.features import client_has_feature
    if await client_has_feature(db, client_id, "channels"):
        token = await get_client_telegram_token(client_id, db)
        if token:
            return token
    return settings.telegram_bot_token or None


async def _has_vip_bot(client_id: int, db) -> bool:
    """У клиента есть свой подключённый TG-бот (для построения /c/{N}/tg/ URL)."""
    return bool(await db.fetchval(
        """SELECT 1 FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            LIMIT 1""",
        client_id,
    ))


async def _get_brand_owner(client_id: int, db) -> dict:
    """Подтягивает имя бренда + имя основателя + work_tg для сообщения бота."""
    row = await db.fetchrow(
        """SELECT
              COALESCE(NULLIF(brand_name, ''), name) AS brand_name,
              name AS owner_name,
              work_tg_username
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not row:
        return {"brand_name": "", "owner_name": "", "work_tg": ""}
    return {
        "brand_name": (row["brand_name"] or "").strip(),
        "owner_name": (row["owner_name"] or "").strip(),
        "work_tg": (row["work_tg_username"] or "").lstrip("@").strip(),
    }


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _build_already_partner_text(brand: str, code: str, work_tg: str) -> str:
    brand_disp = _esc(brand) or "клиента"
    parts = [
        f"Вы уже зарегистрированы партнёром у <b>{brand_disp}</b>.",
        "",
        f"Ваш код: <code>{_esc(code)}</code>",
    ]
    if work_tg:
        parts += [
            "",
            "По вопросам отслеживания состояния партнёрского кабинета — "
            f'<a href="https://t.me/{_esc(work_tg)}">@{_esc(work_tg)}</a>.',
        ]
    return "\n".join(parts)


def _build_register_text(brand: str, owner: str) -> str:
    brand_disp = _esc(brand) or "клиента"
    owner_disp = _esc(owner)
    if owner_disp and owner_disp != brand_disp:
        return (
            f"Вы регистрируетесь Партнёром у <b>{owner_disp}</b> "
            f"({brand_disp}) 🎉\n\n"
            "Нажмите кнопку ниже — откроется форма регистрации."
        )
    return (
        f"Вы регистрируетесь Партнёром у <b>{brand_disp}</b> 🎉\n\n"
        "Нажмите кнопку ниже — откроется форма регистрации."
    )


async def run_started_partner(run_id: int, tg_id: str, username: Optional[str],
                              first_name: Optional[str], last_name: Optional[str],
                              db, bot_id: Optional[int] = None) -> None:
    """Бот получил /start prt_<run_id>. Идемпотентно.

    1. Создаёт/находит контакт у клиента (через upsert_contact_with_identity).
    2. Привязывает contact_id к partner_runs.
    3. Регистрирует подписку на канал бота в контексте клиента.
    4. Шлёт сообщение «уже партнёр / регистрируетесь партнёром».
    """
    run = await db.fetchrow(
        """SELECT id, client_id, platform_slug, contact_id, stage
             FROM partner_runs WHERE id = $1""",
        run_id,
    )
    if not run:
        log.info("run_started_partner: run %s not found", run_id)
        return

    client_id = run["client_id"]

    # Идентификация контакта через platform_users (TG per-client)
    from app.services.contact_merge import upsert_contact_with_identity
    contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
        db,
        client_id=client_id,
        platform_slug="telegram",
        platform_user_id=str(tg_id),
        username=username or "",
        first_name=first_name or "",
        last_name=last_name or "",
    )

    # Регистрируем подписку на канал бота в контексте клиента
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
            log.warning("run_started_partner: register subscription failed: %s", e)

    # Привязываем contact_id к забегу + помечаем opened_in_bot
    await db.execute(
        """UPDATE partner_runs
              SET contact_id = COALESCE(contact_id, $1),
                  stage = CASE WHEN stage = 'landed' THEN 'opened_in_bot' ELSE stage END,
                  opened_in_bot_at = COALESCE(opened_in_bot_at, NOW())
            WHERE id = $2""",
        contact_id, run_id,
    )

    # Проверяем — у контакта уже есть external_ref_param?
    existing_code = await db.fetchval(
        "SELECT external_ref_param FROM contacts WHERE id = $1", contact_id,
    )
    existing_code = (existing_code or "").strip()

    brand_info = await _get_brand_owner(client_id, db)
    token = await _bot_token_for_client(client_id, db)
    if not token:
        log.warning("run_started_partner: no bot token for client %s", client_id)
        return

    if existing_code:
        # Ветка «уже партнёр» — без кнопки
        text = _build_already_partner_text(
            brand_info["brand_name"], existing_code, brand_info["work_tg"],
        )
        reply_markup = None
    else:
        # Ветка «регистрируетесь партнёром» — web_app кнопка
        text = _build_register_text(brand_info["brand_name"], brand_info["owner_name"])
        is_vip = await _has_vip_bot(client_id, db)
        host = (settings.frontend_url or "https://pluson.ru").rstrip("/")
        mini_app_url = (
            f"{host}/c/{client_id}/tg/partner/{run_id}"
            if is_vip else
            f"{host}/tg/partner/{run_id}"
        )
        reply_markup = {
            "inline_keyboard": [[{
                "text": "Открыть форму регистрации",
                "web_app": {"url": mini_app_url},
            }]]
        }

    payload = {
        "chat_id": tg_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup is not None:
        payload["reply_markup"] = json.dumps(reply_markup)

    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json=payload,
            )
            if r.status_code != 200:
                log.warning("run_started_partner sendMessage failed: %s %s", r.status_code, r.text[:200])
    except Exception as e:
        log.warning("run_started_partner sendMessage failed: %s", e)


async def run_started_partner_vk(run_id: int, vk_id: str, username: Optional[str],
                                 first_name: Optional[str], last_name: Optional[str],
                                 db, channel_id: int, token: str) -> None:
    """Аналог run_started_partner для VK. Шлёт сообщение через сообщество клиента."""
    from app.services.vk_api import send_message as vk_send_message, tg_inline_to_vk_keyboard

    run = await db.fetchrow(
        """SELECT id, client_id, platform_slug, contact_id, stage
             FROM partner_runs WHERE id = $1""",
        run_id,
    )
    if not run:
        log.info("run_started_partner_vk: run %s not found", run_id)
        return

    client_id = run["client_id"]

    # Идентификация контакта (VK per-client)
    from app.services.contact_merge import upsert_contact_with_identity
    contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
        db,
        client_id=client_id,
        platform_slug="vk",
        platform_user_id=str(vk_id),
        username=username or "",
        first_name=first_name or "",
        last_name=last_name or "",
    )

    # Подписка на этот канал клиента (через client_channels)
    cc_id = await db.fetchval(
        """SELECT cc.id FROM client_channels cc
            WHERE cc.client_id = $1 AND cc.channel_id = $2 LIMIT 1""",
        client_id, channel_id,
    )
    if cc_id:
        pu_id = await db.fetchval(
            """SELECT id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'vk' AND platform_user_id = $2""",
            client_id, str(vk_id),
        )
        if pu_id:
            await db.execute(
                """INSERT INTO platform_user_channels (platform_user_id, client_channel_id,
                                                       is_unsubscribed, subscribed_at)
                   VALUES ($1, $2, FALSE, NOW())
                   ON CONFLICT (platform_user_id, client_channel_id)
                   DO UPDATE SET is_unsubscribed=FALSE, subscribed_at=NOW(), unsubscribed_at=NULL""",
                pu_id, cc_id,
            )

    # Привязываем contact_id к забегу
    await db.execute(
        """UPDATE partner_runs
              SET contact_id = COALESCE(contact_id, $1),
                  stage = CASE WHEN stage = 'landed' THEN 'opened_in_bot' ELSE stage END,
                  opened_in_bot_at = COALESCE(opened_in_bot_at, NOW())
            WHERE id = $2""",
        contact_id, run_id,
    )

    existing_code = await db.fetchval(
        "SELECT external_ref_param FROM contacts WHERE id = $1", contact_id,
    )
    existing_code = (existing_code or "").strip()
    brand_info = await _get_brand_owner(client_id, db)

    # VK не парсит HTML. Используем чистый текст.
    if existing_code:
        text_parts = [
            f"Вы уже зарегистрированы партнёром у {brand_info['brand_name'] or 'клиента'}.",
            "",
            f"Ваш код: {existing_code}",
        ]
        if brand_info["work_tg"]:
            text_parts += [
                "",
                "По вопросам отслеживания состояния партнёрского кабинета — "
                f"https://t.me/{brand_info['work_tg']}",
            ]
        text = "\n".join(text_parts)
        keyboard = None
    else:
        brand = brand_info["brand_name"] or "клиента"
        owner = brand_info["owner_name"]
        if owner and owner != brand:
            head = f"Вы регистрируетесь Партнёром у {owner} ({brand}) 🎉"
        else:
            head = f"Вы регистрируетесь Партнёром у {brand} 🎉"
        text = head + "\n\nНажмите кнопку ниже — откроется форма регистрации."

        # VK Mini App клиента — берём vk_app_id из platform_meta
        vk_app_id = await db.fetchval(
            """SELECT (ch.platform_meta->>'vk_app_id')::int
                 FROM channels ch WHERE ch.id = $1""",
            channel_id,
        )
        if vk_app_id:
            url = f"https://vk.com/app{int(vk_app_id)}#prt_{run_id}"
            keyboard = tg_inline_to_vk_keyboard([[
                {"text": "Открыть форму регистрации", "url": url},
            ]])
        else:
            keyboard = None

    try:
        await vk_send_message(int(vk_id), text, keyboard=keyboard, token=token)
    except Exception as e:
        log.warning("run_started_partner_vk send failed: %s", e)
