"""
Сервис «Регистрация партнёра» — бот-флоу для миграции 105.

Простой флоу без Mini App:
1. /start prt_<run_id> в боте → создаём контакт, шлём сообщение с url-кнопкой
   на сторонний лендинг (URL уже полностью собран на сервере: pluson_cid + хвост
   рефовода). Юзер кликает → лендинг открывается в браузере.
2. Юзер заполнил форму → партнёрский сервис редиректит на t.me/{bot}?start=
   partner_done_<client_id> (или vk.me/..., max.ru/...).
3. /start partner_done_<client_id> в боте → ищем контакт у клиента по tg_id,
   проверяем contacts.external_ref_param. Если есть → «Вы зарегистрированы,
   ваш код XXX, по вопросам @work_tg». Если пуст → «Упс, что-то пошло не так,
   напишите @work_tg».

Параллельно GetCourse шлёт webhook /integrations/salebot/register с
pluson_cid+external_ref_param — он и есть тот самый код, который контакт
увидит в боте.
"""
from typing import Optional
from urllib.parse import urlencode
import httpx
import json
import logging
from app.services.channels import get_client_telegram_token
from app.config import settings

log = logging.getLogger(__name__)


async def _bot_token_for_client(client_id: int, db) -> Optional[str]:
    """Какой бот шлёт сообщения — только свой бот VIP-клиента (если фича channels).
    Системный @pluson_bot как fallback убран: нет своего бота → партнёрский
    TG-флоу на этой платформе не работает (None, без падения)."""
    from app.services.features import client_has_feature
    if await client_has_feature(db, client_id, "channels"):
        token = await get_client_telegram_token(client_id, db)
        if token:
            return token
    return None


async def _get_brand_owner(client_id: int, db) -> dict:
    """Подтягивает имя бренда + имя основателя + work_tg для сообщения бота."""
    row = await db.fetchrow(
        """SELECT
              COALESCE(NULLIF(brand_name, ''), name) AS brand_name,
              name AS owner_name,
              work_tg_username,
              partner_landing_url
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not row:
        return {"brand_name": "", "owner_name": "", "work_tg": "", "landing_url": ""}
    return {
        "brand_name": (row["brand_name"] or "").strip(),
        "owner_name": (row["owner_name"] or "").strip(),
        "work_tg": (row["work_tg_username"] or "").lstrip("@").strip(),
        "landing_url": (row["partner_landing_url"] or "").strip(),
    }


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


async def _build_partner_landing_url(landing_url: str, contact_id: int,
                                     referrer_query: str, db) -> str:
    """К URL партнёрского лендинга приклеивает полный набор GET-параметров
    нового контакта (pluson_contact_id + tg_id/email/phone/name/tg_nickname/vk_id)
    + хвост рефовода (external_ref_param партнёра).

    Стандарт миграции 105+ — единый список параметров со всеми внешними URL.
    """
    from app.services.external_landing import (
        enrich_external_url, get_contact_landing_params,
    )
    contact_params = await get_contact_landing_params(db, contact_id)
    # На партнёрский лендинг шлём external_ref_param РЕФОВОДА (это referrer_query —
    # код того, по чьей ссылке пришёл новый контакт).

    return enrich_external_url(
        landing_url,
        pluson_contact_id=contact_id,
        external_ref_param=referrer_query if referrer_query else None,
        **contact_params,
    )


def _display_partner_code(raw: Optional[str]) -> str:
    """Чистое значение партнёрского кода для показа пользователю.

    contacts.external_ref_param хранит полную пару key=value
    (например "gcpc=34035"), но в сообщении партнёру нужно показать только
    само значение справа от последнего "=". Также страхует от мусора вида
    "A.gcpc=1c9ac.B" (остатки старых DEBUG-тестов): берём хвост после
    последнего "=" и до первого пробела/точки/символа.
    """
    s = (raw or '').strip()
    if not s:
        return ''
    if '=' in s:
        s = s.rsplit('=', 1)[-1].strip()
    # Срезаем возможный завершающий мусор (точка-маркер, пробел)
    for stop in ('.', ' ', '&', '?'):
        if stop in s:
            s = s.split(stop, 1)[0]
    return s.strip()


def _build_already_partner_text(brand: str, code: str, work_tg: str) -> str:
    brand_disp = _esc(brand) or "клиента"
    parts = [
        f"Вы уже зарегистрированы партнёром у <b>{brand_disp}</b>.",
        "",
        f"Ваш партнёрский код: <code>{_esc(code)}</code>",
    ]
    parts += [
        "",
        "По вопросам отслеживания состояния партнёрского кабинета — "
        "напишите команду /support.",
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


def _build_done_success_text(brand: str, code: str, work_tg: str) -> str:
    brand_disp = _esc(brand) or "клиента"
    parts = [
        f"✅ Вы зарегистрированы партнёром у <b>{brand_disp}</b>.",
        "",
        f"Ваш партнёрский код: <code>{_esc(code)}</code>",
    ]
    parts += [
        "",
        "Чтобы отслеживать состояние вашего партнёрского кабинета — "
        "напишите команду /support.",
    ]
    return "\n".join(parts)


def _build_done_fail_text(work_tg: str) -> str:
    parts = [
        "😕 Упс, что-то пошло не так. Наша система не получила ваш партнёрский код.",
        "",
        "Напишите команду /support для решения вопроса и пришлите скрин.",
    ]
    return "\n".join(parts)


async def _tg_send(token: str, chat_id, text: str,
                   reply_markup: Optional[dict] = None) -> None:
    payload = {
        "chat_id": chat_id,
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
                log.warning("partner _tg_send failed: %s %s", r.status_code, r.text[:200])
    except Exception as e:
        log.warning("partner _tg_send failed: %s", e)


# ─── Outgoing flow ──────────────────────────────────────────────────────────

async def resolve_partner_entry(start_arg: str, platform_slug: str, db
                                ) -> Optional[tuple[int, Optional[int], str]]:
    """Разбирает start-параметр прямой партнёрской ссылки.

    Форматы:
      `prtc_<client_id>` — корневая ссылка клиента (без рефовода).
      `prtp_<contact_id>` — личная ссылка партнёра (рефовод по contact_id).

    Возвращает `(client_id, referrer_contact_id_or_None, referrer_query)`
    либо None если start_arg невалиден.

    Создаёт новый `partner_runs` забег как побочный эффект — нужен для
    аналитики и для общей точки входа `run_started_partner(run_id)`.
    """
    if start_arg.startswith("prtc_"):
        try:
            client_id = int(start_arg.removeprefix("prtc_"))
        except ValueError:
            return None
        referrer_contact_id: Optional[int] = None
        referrer_query = ""
    elif start_arg.startswith("prtp_"):
        try:
            referrer_contact_id_val = int(start_arg.removeprefix("prtp_"))
        except ValueError:
            return None
        row = await db.fetchrow(
            "SELECT id, client_id, external_ref_param FROM contacts WHERE id = $1 AND is_active = TRUE",
            referrer_contact_id_val,
        )
        if not row:
            return None
        client_id = row["client_id"]
        referrer_contact_id = row["id"]
        erp = (row["external_ref_param"] or "").strip()
        referrer_query = erp if erp else ""
    else:
        return None

    return client_id, referrer_contact_id, referrer_query


async def create_partner_run(client_id: int, platform_slug: str,
                             referrer_contact_id: Optional[int],
                             referrer_query: str, db) -> int:
    """Создаёт partner_runs запись. Возвращает run_id."""
    return await db.fetchval(
        """INSERT INTO partner_runs
              (client_id, platform_slug, referrer_contact_id, referrer_query, stage)
           VALUES ($1, $2, $3, $4, 'landed')
           RETURNING id""",
        client_id, platform_slug, referrer_contact_id, referrer_query,
    )


async def start_partner_flow(start_arg: str, tg_id: str, username: Optional[str],
                             first_name: Optional[str], last_name: Optional[str],
                             db, bot_id: Optional[int] = None) -> bool:
    """Полный флоу для TG: парсит prtc_/prtp_ → создаёт run → запускает run_started_partner.

    Возвращает True если start_arg распознан и обработан (включая ошибки внутри),
    False если start_arg не партнёрский (передать дальше другим обработчикам).
    """
    resolved = await resolve_partner_entry(start_arg, "telegram", db)
    if not resolved:
        return False
    client_id, referrer_contact_id, referrer_query = resolved
    run_id = await create_partner_run(
        client_id, "telegram", referrer_contact_id, referrer_query, db,
    )
    await run_started_partner(
        run_id, tg_id, username, first_name, last_name, db, bot_id=bot_id,
    )
    return True


async def run_started_partner(run_id: int, tg_id: str, username: Optional[str],
                              first_name: Optional[str], last_name: Optional[str],
                              db, bot_id: Optional[int] = None) -> None:
    """Внутренний вызов: contact + сообщение в TG. Используется из start_partner_flow."""
    run = await db.fetchrow(
        """SELECT id, client_id, platform_slug, contact_id, stage, referrer_query
             FROM partner_runs WHERE id = $1""",
        run_id,
    )
    if not run:
        log.info("run_started_partner: run %s not found", run_id)
        return

    client_id = run["client_id"]
    referrer_query = run["referrer_query"] or ""

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
    existing_code = _display_partner_code(existing_code)

    brand_info = await _get_brand_owner(client_id, db)
    token = await _bot_token_for_client(client_id, db)
    if not token:
        log.warning("run_started_partner: no bot token for client %s", client_id)
        return

    if existing_code:
        text = _build_already_partner_text(
            brand_info["brand_name"], existing_code, brand_info["work_tg"],
        )
        reply_markup = None
    else:
        text = _build_register_text(brand_info["brand_name"], brand_info["owner_name"])
        landing_url = brand_info["landing_url"]
        if not landing_url:
            log.warning("run_started_partner: client %s has no partner_landing_url", client_id)
            await _tg_send(token, tg_id, "Что-то пошло не так. Попробуйте позже.")
            return
        button_url = await _build_partner_landing_url(landing_url, contact_id, referrer_query, db)
        reply_markup = {
            "inline_keyboard": [[{
                "text": "Открыть форму регистрации",
                "url": button_url,
            }]]
        }

    await _tg_send(token, tg_id, text, reply_markup)


async def start_partner_flow_vk(start_arg: str, vk_id: str, username: Optional[str],
                                first_name: Optional[str], last_name: Optional[str],
                                db, channel_id: int, token: str) -> bool:
    """VK-аналог start_partner_flow. Возвращает True если start_arg партнёрский и обработан."""
    resolved = await resolve_partner_entry(start_arg, "vk", db)
    if not resolved:
        return False
    client_id, referrer_contact_id, referrer_query = resolved
    run_id = await create_partner_run(
        client_id, "vk", referrer_contact_id, referrer_query, db,
    )
    await run_started_partner_vk(
        run_id, vk_id, username, first_name, last_name, db,
        channel_id=channel_id, token=token,
    )
    return True


async def run_started_partner_vk(run_id: int, vk_id: str, username: Optional[str],
                                 first_name: Optional[str], last_name: Optional[str],
                                 db, channel_id: int, token: str) -> None:
    """VK-аналог. Шлёт сообщение через VK-сообщество клиента, кнопка-URL ведёт
    на сторонний лендинг."""
    from app.services.vk_api import send_message as vk_send_message, tg_inline_to_vk_keyboard

    run = await db.fetchrow(
        """SELECT id, client_id, platform_slug, contact_id, stage, referrer_query
             FROM partner_runs WHERE id = $1""",
        run_id,
    )
    if not run:
        log.info("run_started_partner_vk: run %s not found", run_id)
        return

    client_id = run["client_id"]
    referrer_query = run["referrer_query"] or ""

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
    existing_code = _display_partner_code(existing_code)
    brand_info = await _get_brand_owner(client_id, db)

    if existing_code:
        text_parts = [
            f"Вы уже зарегистрированы партнёром у {brand_info['brand_name'] or 'клиента'}.",
            "",
            f"Ваш партнёрский код: {existing_code}",
        ]
        if brand_info["work_tg"]:
            text_parts += ["", f"По вопросам — https://t.me/{brand_info['work_tg']}"]
        text = "\n".join(text_parts)
        keyboard = None
    else:
        brand = brand_info["brand_name"] or "клиента"
        owner = brand_info["owner_name"]
        head = (
            f"Вы регистрируетесь Партнёром у {owner} ({brand}) 🎉"
            if owner and owner != brand
            else f"Вы регистрируетесь Партнёром у {brand} 🎉"
        )
        text = head + "\n\nНажмите кнопку ниже — откроется форма регистрации."
        landing_url = brand_info["landing_url"]
        if not landing_url:
            log.warning("run_started_partner_vk: client %s has no partner_landing_url", client_id)
            try:
                await vk_send_message(int(vk_id), "Что-то пошло не так. Попробуйте позже.", token=token)
            except Exception:
                pass
            return
        button_url = await _build_partner_landing_url(landing_url, contact_id, referrer_query, db)
        keyboard = tg_inline_to_vk_keyboard([[
            {"text": "Открыть форму регистрации", "url": button_url},
        ]])

    try:
        await vk_send_message(int(vk_id), text, keyboard=keyboard, token=token)
    except Exception as e:
        log.warning("run_started_partner_vk send failed: %s", e)


# ─── Return flow (/start partner_done_<client_id>) ──────────────────────────

async def send_partner_done_tg(client_id: int, tg_id: str, db,
                               bot_id: Optional[int] = None) -> None:
    """Возврат после сабмита формы (TG).

    Ищем contact у этого клиента по tg_id → проверяем external_ref_param →
    шлём success/fail сообщение. Webhook от партнёрского сервиса должен был уже
    обновить external_ref_param (часто доходит до того как юзер вернётся в бот).
    """
    contact_id = await db.fetchval(
        """SELECT pu.contact_id
             FROM platform_users pu
            WHERE pu.client_id = $1
              AND pu.platform_slug = 'telegram'
              AND pu.platform_user_id = $2
            LIMIT 1""",
        client_id, str(tg_id),
    )

    code = ""
    if contact_id:
        code_raw = await db.fetchval(
            "SELECT external_ref_param FROM contacts WHERE id = $1", contact_id,
        )
        code = _display_partner_code(code_raw)
        # Помечаем все pending-забеги этого контакта как completed
        await db.execute(
            """UPDATE partner_runs
                  SET stage = 'completed', completed_at = NOW()
                WHERE contact_id = $1 AND client_id = $2 AND stage <> 'completed'""",
            contact_id, client_id,
        )

    brand_info = await _get_brand_owner(client_id, db)
    token = await _bot_token_for_client(client_id, db)
    if not token:
        log.warning("send_partner_done_tg: no bot token for client %s", client_id)
        return

    if code:
        text = _build_done_success_text(brand_info["brand_name"], code, brand_info["work_tg"])
    else:
        text = _build_done_fail_text(brand_info["work_tg"])

    await _tg_send(token, tg_id, text)


async def send_partner_done_vk(client_id: int, vk_id: str, db, token: str) -> None:
    """Возврат после сабмита формы (VK)."""
    from app.services.vk_api import send_message as vk_send_message

    contact_id = await db.fetchval(
        """SELECT pu.contact_id
             FROM platform_users pu
            WHERE pu.client_id = $1
              AND pu.platform_slug = 'vk'
              AND pu.platform_user_id = $2
            LIMIT 1""",
        client_id, str(vk_id),
    )

    code = ""
    if contact_id:
        code_raw = await db.fetchval(
            "SELECT external_ref_param FROM contacts WHERE id = $1", contact_id,
        )
        code = _display_partner_code(code_raw)
        await db.execute(
            """UPDATE partner_runs
                  SET stage = 'completed', completed_at = NOW()
                WHERE contact_id = $1 AND client_id = $2 AND stage <> 'completed'""",
            contact_id, client_id,
        )

    brand_info = await _get_brand_owner(client_id, db)
    brand = brand_info["brand_name"] or "клиента"
    work_tg = brand_info["work_tg"]

    if code:
        parts = [
            f"✅ Вы зарегистрированы партнёром у {brand}.",
            "",
            f"Ваш партнёрский код: {code}",
        ]
        if work_tg:
            parts += ["", f"Чтобы отслеживать состояние партнёрского кабинета — https://t.me/{work_tg}"]
        text = "\n".join(parts)
    else:
        parts = ["😕 Упс, что-то пошло не так. Наша система не получила ваш партнёрский код."]
        if work_tg:
            parts += ["", f"Напишите Основателю и пришлите скрин: https://t.me/{work_tg}"]
        text = "\n".join(parts)

    try:
        await vk_send_message(int(vk_id), text, token=token)
    except Exception as e:
        log.warning("send_partner_done_vk failed: %s", e)
