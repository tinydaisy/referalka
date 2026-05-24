"""
POST /api/v1/vk/event — аналог /api/v1/event для VK Mini App.

Принимает launch params от VK Bridge (vk_user_id, vk_app_id, sign, ...), валидирует
подпись, делает upsert contact+platform_users, шлёт контекстное приветствие
(если событие задано) в личку пользователя от сообщества.

VK Bridge передаёт launch params как query-string при загрузке iframe Mini App.
Mini App копирует все vk_* + sign из своего window.location и шлёт сюда.
"""
from __future__ import annotations

import json
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import settings
from ..database import get_pool
from ..services.contact_merge import upsert_contact_with_identity, resolve_ref_code
from ..services.vk_auth import validate_vk_launch_params
from ..services.vk_api import send_message as vk_send_message, tg_inline_to_vk_keyboard
from ..services.share_links import vk_link as build_vk_link
from ..services.event_welcome import _send_event_organizer_notification

logger = logging.getLogger(__name__)
router = APIRouter()


class VkEventRequest(BaseModel):
    # Все launch params от VK Bridge — vk_user_id, vk_app_id, vk_ts, vk_platform, sign, ...
    launch_params: dict[str, str]
    # Параметры запуска нашей логики (из startapp-аналога в VK — hash после #)
    event_slug: str = ""
    client_id: int = 0
    partner_id: str = ""
    utm_source: str = ""
    initial_tab: str = ""
    first_name: str = ""
    last_name: str = ""
    username: str = ""  # screen_name из VK
    # Контактные данные из VK Bridge — пользователь явно дал согласие диалогом
    email: str = ""    # VKWebAppGetEmail
    phone: str = ""    # VKWebAppGetPhoneNumber


class VkFunnelLandingRequest(BaseModel):
    """Запрос на запуск воронки лид-магнита из VK Mini App.

    Используется когда юзер открыл прямую ссылку `vk.com/app{aid}#m_<slug>` или
    `#p_<slug>`. Mini App парсит hash, шлёт сюда вместе с launch_params.
    Бэк сам создаёт funnel_run + запускает run_started_vk."""
    launch_params: dict[str, str]
    kind: Literal['m', 'p']
    slug: str
    partner_id: str = ""
    utm_source: str = ""


class VkFunnelStartRequest(BaseModel):
    launch_params: dict[str, str]
    run_id: int


@router.post("/vk/funnel-landing", summary="Прямая landing-воронка из VK Mini App (по slug)")
async def vk_funnel_landing(body: VkFunnelLandingRequest):
    """Mini App открыт по `vk.com/app{aid}#m_<slug>` или `#p_<slug>` (без pluson.ru).
    Создаём funnel_run на лету и запускаем воронку."""
    vk_app_id_raw = body.launch_params.get("vk_app_id")
    secure_key: str | None = settings.vk_app_secure_key
    try:
        if vk_app_id_raw and int(vk_app_id_raw) != int(getattr(settings, "vk_app_id", "0") or 0):
            pool = await get_pool()
            if pool:
                async with pool.acquire() as conn:
                    row = await conn.fetchrow(
                        """SELECT platform_meta->>'vk_secure_key' AS sk
                             FROM channels
                            WHERE platform_slug = 'vk'
                              AND (platform_meta->>'vk_app_id')::int = $1
                            LIMIT 1""",
                        int(vk_app_id_raw),
                    )
                    if row and row["sk"]:
                        secure_key = row["sk"]
    except Exception as e:
        logger.warning(f"VK funnel-landing: secure_key lookup failed app_id={vk_app_id_raw}: {e}")

    if not secure_key or not validate_vk_launch_params(body.launch_params, secure_key):
        raise HTTPException(status_code=403, detail="Invalid VK launch params signature")

    vk_user_id_raw = body.launch_params.get("vk_user_id")
    if not vk_user_id_raw:
        raise HTTPException(status_code=400, detail="vk_user_id required")
    try:
        vk_user_id = int(vk_user_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="vk_user_id must be int")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="db not available")

    async with pool.acquire() as conn:
        # Канал клиента по vk_app_id — для отправки сообщений
        chan = await conn.fetchrow(
            """SELECT ch.id AS channel_id, ch.bot_token, cc.client_id,
                      (ch.platform_meta->>'vk_group_id')::int AS vk_group_id
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE ch.platform_slug = 'vk'
                  AND ch.is_system = FALSE
                  AND cc.is_active = TRUE
                  AND (ch.platform_meta->>'vk_app_id')::int = $1
                LIMIT 1""",
            int(vk_app_id_raw or 0),
        )
        if not chan or not chan["bot_token"]:
            raise HTTPException(status_code=404, detail="VK-сообщество клиента не подключено к этому Mini App")

        # Резолвим slug → lead_magnet или package клиента
        if body.kind == 'm':
            row = await conn.fetchrow(
                "SELECT id, client_id FROM lead_magnets WHERE slug = $1", body.slug,
            )
            if not row or row["client_id"] != chan["client_id"]:
                raise HTTPException(status_code=404, detail="Лид-магнит не найден или не принадлежит клиенту сообщества")
            lm_id, pkg_id = row["id"], None
        else:
            row = await conn.fetchrow(
                "SELECT id, client_id FROM lead_magnet_packages WHERE slug = $1", body.slug,
            )
            if not row or row["client_id"] != chan["client_id"]:
                raise HTTPException(status_code=404, detail="Пакет не найден или не принадлежит клиенту сообщества")
            lm_id, pkg_id = None, row["id"]

        client_id = chan["client_id"]

        # Реферер по pid (если передан)
        referrer_id = None
        if body.partner_id:
            referrer_id = await conn.fetchval(
                "SELECT id FROM contacts WHERE client_id = $1 AND ref_code = $2",
                client_id, body.partner_id,
            )

        utm = {"utm_source": body.utm_source} if body.utm_source else {}
        run_id = await conn.fetchval(
            """INSERT INTO funnel_runs
                  (client_id, type, lead_magnet_id, package_id,
                   contact_id, referrer_contact_id, utm, stage, landed_at,
                   platform_slug)
               VALUES ($1, 'lead_magnet', $2, $3, NULL, $4, $5::jsonb, 'landed', NOW(), 'vk')
               RETURNING id""",
            client_id, lm_id, pkg_id, referrer_id, json.dumps(utm),
        )

        user_info = None
        try:
            from app.services.vk_api import get_user_info as vk_get_user_info
            user_info = await vk_get_user_info(vk_user_id)
        except Exception:
            pass

        from app.services.funnel_service import run_started_vk
        await run_started_vk(
            run_id, str(vk_user_id),
            username=(user_info or {}).get("screen_name", "") if user_info else "",
            first_name=(user_info or {}).get("first_name", "") if user_info else "",
            last_name=(user_info or {}).get("last_name", "") if user_info else "",
            db=conn,
            channel_id=chan["channel_id"],
            token=chan["bot_token"],
        )

        group_id = int(body.launch_params.get("vk_group_id") or 0) or int(chan["vk_group_id"] or 0)

    return {"ok": True, "vk_user_id": vk_user_id, "group_id": group_id, "run_id": run_id}


@router.post("/vk/funnel-start", summary="Запуск воронки лид-магнита из VK Mini App")
async def vk_funnel_start(body: VkFunnelStartRequest):
    """Аналог VK message_new+ref для уже подписанных пользователей сообщества.

    Mini App открывается через `vk.com/app{vk_app_id}#fnl_<run_id>` → берёт run_id
    и vk_user_id из launch_params → шлёт сюда. Бэк валидирует подпись и вызывает
    run_started_vk (создаёт contact/platform_user, шлёт Текст 1 в личку).
    """
    vk_app_id_raw = body.launch_params.get("vk_app_id")
    secure_key: str | None = settings.vk_app_secure_key
    try:
        if vk_app_id_raw and int(vk_app_id_raw) != int(getattr(settings, "vk_app_id", "0") or 0):
            pool = await get_pool()
            if pool:
                async with pool.acquire() as conn:
                    row = await conn.fetchrow(
                        """SELECT platform_meta->>'vk_secure_key' AS sk
                             FROM channels
                            WHERE platform_slug = 'vk'
                              AND (platform_meta->>'vk_app_id')::int = $1
                            LIMIT 1""",
                        int(vk_app_id_raw),
                    )
                    if row and row["sk"]:
                        secure_key = row["sk"]
    except Exception as e:
        logger.warning(f"VK funnel-start: secure_key lookup failed app_id={vk_app_id_raw}: {e}")

    if not secure_key or not validate_vk_launch_params(body.launch_params, secure_key):
        raise HTTPException(status_code=403, detail="Invalid VK launch params signature")

    vk_user_id_raw = body.launch_params.get("vk_user_id")
    if not vk_user_id_raw:
        raise HTTPException(status_code=400, detail="vk_user_id required")
    try:
        vk_user_id = int(vk_user_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="vk_user_id must be int")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="db not available")

    async with pool.acquire() as conn:
        # По vk_app_id находим channel клиента — у которого совпадает app_id в platform_meta.
        # Этот channel будет writer'ом для отправки приветствия (Текст 1).
        chan = await conn.fetchrow(
            """SELECT ch.id AS channel_id, ch.bot_token, cc.client_id,
                      (ch.platform_meta->>'vk_group_id')::int AS vk_group_id
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE ch.platform_slug = 'vk'
                  AND ch.is_system = FALSE
                  AND cc.is_active = TRUE
                  AND (ch.platform_meta->>'vk_app_id')::int = $1
                LIMIT 1""",
            int(vk_app_id_raw or 0),
        )
        if not chan or not chan["bot_token"]:
            raise HTTPException(status_code=404, detail="VK-сообщество клиента не подключено к этому Mini App")

        # Проверяем что run принадлежит этому клиенту (защита от подмены run_id)
        run_client_id = await conn.fetchval(
            "SELECT client_id FROM funnel_runs WHERE id = $1", body.run_id,
        )
        if run_client_id != chan["client_id"]:
            raise HTTPException(status_code=403, detail="run_id не принадлежит клиенту этого сообщества")

        user_info = None
        try:
            from app.services.vk_api import get_user_info as vk_get_user_info
            user_info = await vk_get_user_info(vk_user_id)
        except Exception:
            pass

        from app.services.funnel_service import run_started_vk
        await run_started_vk(
            body.run_id, str(vk_user_id),
            username=(user_info or {}).get("screen_name", "") if user_info else "",
            first_name=(user_info or {}).get("first_name", "") if user_info else "",
            last_name=(user_info or {}).get("last_name", "") if user_info else "",
            db=conn,
            channel_id=chan["channel_id"],
            token=chan["bot_token"],
        )

    group_id = int(body.launch_params.get("vk_group_id") or 0) or int(chan["vk_group_id"] or 0)
    return {"ok": True, "vk_user_id": vk_user_id, "group_id": group_id}


class VkSpeakerInviteRequest(BaseModel):
    """Запрос на открытие spkinv-ссылки из VK Mini App.
    Mini App открывается по `vk.com/app{aid}#spkinv_<access_code>`, парсит hash
    и шлёт сюда вместе с launch_params. Бэк находит коллаба по access_code,
    апсертит platform_users (vk), шлёт спикеру сообщение в личку через сообщество
    с кодом доступа и ссылкой на лендинг.
    """
    launch_params: dict[str, str]
    access_code: str


@router.post("/vk/speaker-invite", summary="Открытие spkinv-ссылки из VK Mini App")
async def vk_speaker_invite(body: VkSpeakerInviteRequest):
    """VK-аналог `/start spkinv_<code>` в Telegram. Открывается через Mini App."""
    vk_app_id_raw = body.launch_params.get("vk_app_id")
    secure_key: str | None = settings.vk_app_secure_key
    try:
        if vk_app_id_raw and int(vk_app_id_raw) != int(getattr(settings, "vk_app_id", "0") or 0):
            pool = await get_pool()
            if pool:
                async with pool.acquire() as conn:
                    row = await conn.fetchrow(
                        """SELECT platform_meta->>'vk_secure_key' AS sk
                             FROM channels
                            WHERE platform_slug = 'vk'
                              AND (platform_meta->>'vk_app_id')::int = $1
                            LIMIT 1""",
                        int(vk_app_id_raw),
                    )
                    if row and row["sk"]:
                        secure_key = row["sk"]
    except Exception as e:
        logger.warning(f"VK speaker-invite secure_key lookup failed: {e}")

    if not secure_key or not validate_vk_launch_params(body.launch_params, secure_key):
        raise HTTPException(status_code=403, detail="Invalid VK launch params signature")

    vk_user_id_raw = body.launch_params.get("vk_user_id")
    if not vk_user_id_raw:
        raise HTTPException(status_code=400, detail="vk_user_id required")
    try:
        vk_user_id = int(vk_user_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="vk_user_id must be int")

    access_code = (body.access_code or "").strip()
    if not access_code:
        raise HTTPException(status_code=400, detail="access_code required")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="db not available")

    async with pool.acquire() as conn:
        # Находим клиента-владельца Mini App
        chan = await conn.fetchrow(
            """SELECT ch.id AS channel_id, ch.bot_token, cc.client_id,
                      (ch.platform_meta->>'vk_group_id')::int AS vk_group_id
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE ch.platform_slug = 'vk'
                  AND ch.is_system = FALSE
                  AND cc.is_active = TRUE
                  AND (ch.platform_meta->>'vk_app_id')::int = $1
                LIMIT 1""",
            int(vk_app_id_raw or 0),
        )
        if not chan or not chan["bot_token"]:
            raise HTTPException(status_code=404, detail="VK-сообщество клиента не подключено")

        coll = await conn.fetchrow(
            """SELECT c.id AS collaborator_id, c.name, c.contact_id, c.created_by_client_id
                 FROM collaborators c
                WHERE LOWER(c.access_code) = LOWER($1)""",
            access_code,
        )
        if not coll:
            raise HTTPException(status_code=404, detail="Код доступа не найден")
        if coll["created_by_client_id"] != chan["client_id"]:
            raise HTTPException(status_code=403, detail="Код доступа выдан другому клиенту")

        # Привязываем VK-идентичность спикера к contact (или fall foreign-owner)
        from app.api.collaborators import _upsert_personal_identity
        foreign_owner = False
        if coll["contact_id"] and coll["created_by_client_id"]:
            try:
                res = await _upsert_personal_identity(
                    conn, coll["created_by_client_id"], coll["contact_id"],
                    'vk', str(vk_user_id), None,
                )
                if isinstance(res, dict) and res.get("status") == "foreign_owner":
                    foreign_owner = True
            except Exception as e:
                logger.warning(f"VK speaker-invite upsert identity failed: {e}")

        # Подтягиваем ивент-slug для ссылки на кабинет
        ev = await conn.fetchrow(
            """SELECT e.slug, e.title
                 FROM event_collaborators ec
                 JOIN events e ON e.id = ec.event_id
                WHERE ec.speaker_id = $1
                ORDER BY ec.id DESC LIMIT 1""",
            coll["collaborator_id"],
        )
        event_slug = ev["slug"] if ev else ""
        event_title = ev["title"] if ev else "событие"
        sp_name = (coll["name"] or "").strip() or "спикер"
        cabinet_url = f"https://pluson.ru/speaker/{event_slug}" if event_slug else "https://pluson.ru/speaker/"

        from app.services.vk_api import send_message as vk_send_message, tg_inline_to_vk_keyboard
        if foreign_owner:
            text = (
                f"⚠️ Вы зашли не с того аккаунта.\n\n"
                f"Эта ссылка выдана спикеру «{sp_name}». Ваш VK-аккаунт уже привязан к другому контакту у этого клиента, "
                f"поэтому я не могу записать вас как спикера.\n\n"
                f"Попросите самого спикера открыть ссылку со своего личного VK, либо передайте ссылку его ассистенту."
            )
            await vk_send_message(int(vk_user_id), text, token=chan["bot_token"])
            return {"ok": True, "foreign_owner": True}

        text = (
            f"Здравствуйте, {sp_name}!\n\n"
            f"Вы — спикер «{event_title}». Чтобы заполнить свои данные для участников события, "
            f"откройте свой кабинет:\n{cabinet_url}\n\n"
            f"Код доступа: {access_code}\n\n"
            "На странице выберите свою фамилию из списка и введите этот код. "
            "Сессия живёт 24 часа. Можно передать ссылку и код ассистенту."
        )
        keyboard = None
        if event_slug:
            keyboard = tg_inline_to_vk_keyboard([[
                {"text": "📝 Открыть мой кабинет", "url": cabinet_url},
            ]])
        await vk_send_message(int(vk_user_id), text, keyboard=keyboard, token=chan["bot_token"])

        group_id = int(body.launch_params.get("vk_group_id") or 0) or int(chan["vk_group_id"] or 0)

    return {"ok": True, "vk_user_id": vk_user_id, "group_id": group_id, "cabinet_url": cabinet_url}


class VkPartnerRunStartRequest(BaseModel):
    """Mini App открыт по `vk.com/app{aid}#prt_<run_id>` — стартуем партнёрский flow."""
    launch_params: dict[str, str]
    run_id: int


@router.post("/vk/partner-run-start", summary="Запуск партнёрского run из VK Mini App")
async def vk_partner_run_start(body: VkPartnerRunStartRequest):
    """VK-аналог `/start prt_<run_id>` в Telegram. Для миграции 105 партнёрских ссылок."""
    vk_app_id_raw = body.launch_params.get("vk_app_id")
    secure_key: str | None = settings.vk_app_secure_key
    try:
        if vk_app_id_raw and int(vk_app_id_raw) != int(getattr(settings, "vk_app_id", "0") or 0):
            pool = await get_pool()
            if pool:
                async with pool.acquire() as conn:
                    row = await conn.fetchrow(
                        """SELECT platform_meta->>'vk_secure_key' AS sk
                             FROM channels
                            WHERE platform_slug = 'vk'
                              AND (platform_meta->>'vk_app_id')::int = $1
                            LIMIT 1""",
                        int(vk_app_id_raw),
                    )
                    if row and row["sk"]:
                        secure_key = row["sk"]
    except Exception as e:
        logger.warning(f"VK partner-run-start secure_key lookup failed: {e}")

    if not secure_key or not validate_vk_launch_params(body.launch_params, secure_key):
        raise HTTPException(status_code=403, detail="Invalid VK launch params signature")

    vk_user_id_raw = body.launch_params.get("vk_user_id")
    if not vk_user_id_raw:
        raise HTTPException(status_code=400, detail="vk_user_id required")
    try:
        vk_user_id = int(vk_user_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="vk_user_id must be int")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="db not available")

    async with pool.acquire() as conn:
        chan = await conn.fetchrow(
            """SELECT ch.id AS channel_id, ch.bot_token, cc.client_id,
                      (ch.platform_meta->>'vk_group_id')::int AS vk_group_id
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE ch.platform_slug = 'vk'
                  AND ch.is_system = FALSE
                  AND cc.is_active = TRUE
                  AND (ch.platform_meta->>'vk_app_id')::int = $1
                LIMIT 1""",
            int(vk_app_id_raw or 0),
        )
        if not chan or not chan["bot_token"]:
            raise HTTPException(status_code=404, detail="VK-сообщество клиента не подключено")

        run_client_id = await conn.fetchval(
            "SELECT client_id FROM partner_runs WHERE id = $1", body.run_id,
        )
        if not run_client_id:
            raise HTTPException(status_code=404, detail="partner_run не найден")
        if run_client_id != chan["client_id"]:
            raise HTTPException(status_code=403, detail="run не принадлежит клиенту сообщества")

        user_info = None
        try:
            from app.services.vk_api import get_user_info as vk_get_user_info
            user_info = await vk_get_user_info(vk_user_id)
        except Exception:
            pass

        from app.services.partner_service import run_started_partner_vk
        await run_started_partner_vk(
            body.run_id, str(vk_user_id),
            username=(user_info or {}).get("screen_name", "") if user_info else "",
            first_name=(user_info or {}).get("first_name", "") if user_info else "",
            last_name=(user_info or {}).get("last_name", "") if user_info else "",
            db=conn,
            channel_id=chan["channel_id"],
            token=chan["bot_token"],
        )

    group_id = int(body.launch_params.get("vk_group_id") or 0) or int(chan["vk_group_id"] or 0)
    return {"ok": True, "vk_user_id": vk_user_id, "group_id": group_id}


@router.get("/vk/group-for-app", summary="Резолв vk_app_id → vk_group_id")
async def vk_group_for_app(app_id: int):
    """Возвращает group_id сообщества, к которому привязан VK Mini App.
    Нужен фронту чтобы вызвать VKWebAppAllowMessagesFromGroup с правильным
    group_id, когда Mini App открыт через прямой URL (без vk_group_id в launch params).
    """
    pool = await get_pool()
    if not pool:
        return {"group_id": None}
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT (platform_meta->>'vk_group_id')::int AS group_id
                 FROM channels
                WHERE platform_slug = 'vk'
                  AND (platform_meta->>'vk_app_id')::int = $1
                LIMIT 1""",
            int(app_id),
        )
    return {"group_id": row["group_id"] if row else None}


@router.post("/vk/event")
async def handle_vk_event(body: VkEventRequest):
    """Сигнал от VK Mini App при открытии. Валидирует подпись, регистрирует контакт."""
    # Каждый Mini App в VK имеет СВОЙ secure_key. Если клиент подключил
    # своё Mini App (vk_app_id ≠ системный) — валидируем его ключом из
    # channels.platform_meta, не системным. Иначе signature всегда invalid.
    vk_app_id_raw = body.launch_params.get("vk_app_id")
    secure_key: str | None = settings.vk_app_secure_key
    try:
        if vk_app_id_raw and int(vk_app_id_raw) != int(getattr(settings, "vk_app_id", "0") or 0):
            pool = await get_pool()
            if pool:
                async with pool.acquire() as conn:
                    row = await conn.fetchrow(
                        """SELECT platform_meta->>'vk_secure_key' AS sk
                             FROM channels
                            WHERE platform_slug = 'vk'
                              AND (platform_meta->>'vk_app_id')::int = $1
                            LIMIT 1""",
                        int(vk_app_id_raw),
                    )
                    if row and row["sk"]:
                        secure_key = row["sk"]
    except Exception as e:
        logger.warning(f"VK secure_key lookup failed for app_id={vk_app_id_raw}: {e}")

    # Validate VK Bridge signature нужным ключом (системным или клиентским).
    if not secure_key or not validate_vk_launch_params(body.launch_params, secure_key):
        logger.warning(
            f"VK signature invalid: vk_user_id={body.launch_params.get('vk_user_id')} "
            f"vk_app_id={vk_app_id_raw} used_system_key={secure_key == settings.vk_app_secure_key}"
        )
        raise HTTPException(status_code=403, detail="Invalid VK launch params signature")

    vk_user_id_raw = body.launch_params.get("vk_user_id")
    if not vk_user_id_raw:
        raise HTTPException(status_code=400, detail="vk_user_id required in launch_params")
    try:
        vk_user_id = int(vk_user_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="vk_user_id must be int")

    pool = await get_pool()
    if not pool:
        return {"ok": True, "warning": "db not available", "vk_user_id": vk_user_id}

    # Определяем client_id: 1) явный из startapp 2) из event_slug 3) системный клиент (ПЛЮСОН Сервис)
    async with pool.acquire() as conn:
        client_id = body.client_id
        if not client_id and body.event_slug:
            row = await conn.fetchrow("SELECT client_id FROM events WHERE slug = $1", body.event_slug)
            if row:
                client_id = row["client_id"]
        if not client_id:
            # системный клиент «ПЛЮСОН Сервис» — для трафика без контекста
            row = await conn.fetchrow("SELECT id FROM clients WHERE email = $1", "system@pluson.ru")
            client_id = row["id"] if row else 0
        if not client_id:
            return {"ok": False, "error": "no_client_resolved"}

        contact_id, pu_id, is_new = await upsert_contact_with_identity(
            conn,
            client_id=client_id,
            platform_slug="vk",
            platform_user_id=str(vk_user_id),
            username=body.username or None,
            first_name=body.first_name or None,
            last_name=body.last_name or None,
            email=body.email or None,    # автомердж по email — если в TG-базе уже есть «Марго Форбс с email» → склеит
            phone=body.phone or None,    # то же по phone (8/+7-нормализация на стороне contact_merge)
            utm_source=body.utm_source or None,
        )

        # Реферер — если в startapp передан pid (ref_code партнёра)
        resolved_ref_code = None
        referrer_contact_id = None
        if body.partner_id:
            resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                conn, body.partner_id, client_id=client_id,
            )

        # Создание/обновление event_participants — только если есть event_slug
        event_title = None
        if body.event_slug:
            ev = await conn.fetchrow(
                "SELECT id, title, status FROM events WHERE slug = $1 AND client_id = $2",
                body.event_slug, client_id,
            )
            if ev:
                event_title = ev["title"]
                # Если реферер сам участвует в этом событии — связываем по participant_id.
                referrer_participant_id = None
                if referrer_contact_id:
                    referrer_participant_id = await conn.fetchval(
                        """SELECT id FROM event_participants
                            WHERE contact_id = $1 AND event_id = $2 LIMIT 1""",
                        referrer_contact_id, ev["id"],
                    )
                inserted = await conn.fetchval(
                    """INSERT INTO event_participants
                          (event_id, contact_id, referrer_participant_id, referrer_ref_code)
                       VALUES ($1, $2, $3, $4)
                       ON CONFLICT (event_id, contact_id) DO NOTHING
                       RETURNING id""",
                    ev["id"], contact_id, referrer_participant_id, resolved_ref_code,
                )
                # Event-welcome: шлём от ИМЕНИ КЛИЕНТСКОГО VK-сообщества (если подключено),
                # иначе от системного. Без этого юзер всегда получал бы welcome от системного
                # @ivision_pluson, а не от того сообщества, через которое открыл Mini App.
                # Ссылка в кнопке — на клиентский VK App, тоже из platform_meta.
                if event_title:
                    try:
                        # Достаём токен клиентского VK-канала. is_system=FALSE → пользовательский.
                        client_vk = await conn.fetchrow(
                            """SELECT ch.bot_token, (ch.platform_meta->>'vk_app_id')::int AS vk_app_id
                                 FROM client_channels cc
                                 JOIN channels ch ON ch.id = cc.channel_id
                                WHERE cc.client_id = $1
                                  AND cc.is_active = TRUE
                                  AND ch.platform_slug = 'vk'
                                  AND ch.is_system = FALSE
                                LIMIT 1""",
                            client_id,
                        )
                        client_token = client_vk["bot_token"] if client_vk else None
                        client_vk_app_id = client_vk["vk_app_id"] if client_vk else None
                        msg = (
                            f"👋 Здравствуйте, {body.first_name or 'друг'}!\n\n"
                            f"Вы открыли событие «{event_title}». Жмите кнопку ниже, чтобы вернуться "
                            f"в приложение — там программа, друзья и подарки за приглашения."
                        )
                        keyboard = tg_inline_to_vk_keyboard([[
                            {"text": f"Войти в «{event_title[:30]}»",
                             "url": build_vk_link(body.event_slug, app_id=client_vk_app_id)},
                        ]])
                        # token=None у vk_send_message → fallback на settings.vk_system_group_token.
                        await vk_send_message(vk_user_id, msg, keyboard=keyboard, token=client_token)
                    except Exception as e:
                        logger.warning(f"VK welcome message failed for vk_id={vk_user_id}: {e}")

                # Воронка догрева: запуск (если не зарегистрирован) или останов (если был run).
                try:
                    from app.api.event_nurture import start_nurture_run_if_eligible
                    is_reg = await conn.fetchval(
                        "SELECT is_registered FROM event_participants WHERE event_id=$1 AND contact_id=$2",
                        ev["id"], contact_id,
                    )
                    await start_nurture_run_if_eligible(
                        conn, event_id=ev["id"], contact_id=contact_id,
                        is_registered=bool(is_reg),
                    )
                except Exception as e:
                    logger.warning(f"VK event_nurture start failed: {e}")

                # Уведомление организатору — только при первом INSERT (не плодим спам)
                if inserted and event_title:
                    try:
                        await _send_event_organizer_notification(
                            conn,
                            client_id=client_id,
                            event_id=ev["id"],
                            event_title=event_title,
                            contact_id=contact_id,
                            platform_slug="vk",
                            referrer_contact_id=referrer_contact_id,
                            tg_id=None,
                        )
                    except Exception as e:
                        logger.warning(f"VK organizer notification failed: {e}")

        # Возвращаем фронту флаги — есть ли у этого contact email/phone
        # (после автомерджа: в TG-базе могло уже быть, тогда диалоги VK Bridge не нужны).
        existing = await conn.fetchrow(
            "SELECT COALESCE(email_normalized, '') AS email, COALESCE(phone_normalized, '') AS phone FROM contacts WHERE id = $1",
            contact_id,
        )
        has_email = bool(existing and existing["email"])
        has_phone = bool(existing and existing["phone"])

    return {
        "ok": True,
        "vk_user_id": vk_user_id,
        "contact_id": contact_id,
        "client_id": client_id,
        "is_new_contact": is_new,
        "event_title": event_title,
        "has_email": has_email,
        "has_phone": has_phone,
    }
