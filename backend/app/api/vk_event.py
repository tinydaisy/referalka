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
from ..services.vk_api import (
    send_message as vk_send_message,
    tg_inline_to_vk_keyboard,
    upload_photo_to_messages,
    get_user_info,
)
from ..services.share_links import vk_link as build_vk_link
from ..services.event_welcome import _send_event_organizer_notification
from ..services.entry_link_log import log_entry_link

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
    contact_id: int = 0  # сквозной contact_id (из startapp ct<N>) — против дублей
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


class VkEventLandingRequest(BaseModel):
    """Лёгкая заглушка открытия СОБЫТИЯ в VK (альтернатива полному Mini App).

    Открывается по `vk.com/app{aid}#evl_<slug>[_pid<ref>][_src<utm>][_ct<id>]`.
    Mini App показывает лёгкий экран «подробности в чате», вызывает write_access +
    join_group и шлёт сюда. Бэк регистрирует контакт/подписку/рефовода/участие и
    отправляет в ЛС сообщества ПОЛНЫЙ порт TG-воронки события (приветствие с афишей
    и кнопками для незарег. / меню кабинета для зарег.). Старый `#ref_pg<slug>`
    (полный Mini App через /vk/event) продолжает работать без изменений."""
    launch_params: dict[str, str]
    slug: str
    partner_id: str = ""
    utm_source: str = ""
    contact_id: int = 0  # сквозной contact_id (из startapp ct<N>) — против дублей
    first_name: str = ""
    last_name: str = ""
    username: str = ""


async def _run_started_vk_bg(run_id: int, vk_user_id: int, channel_id: int, token: str) -> None:
    """Фоновый запуск воронки лид-магнита: отправка Текста 1 (с возможным видео/
    фото — медленный upload на VK) В ФОНЕ, чтобы фронт не ждал. Берёт свой коннект."""
    pool = await get_pool()
    if not pool:
        return
    try:
        user_info = None
        try:
            from app.services.vk_api import get_user_info as vk_get_user_info
            user_info = await vk_get_user_info(vk_user_id)
        except Exception:
            pass
        from app.services.funnel_service import run_started_vk
        async with pool.acquire() as conn:
            await run_started_vk(
                run_id, str(vk_user_id),
                username=(user_info or {}).get("screen_name", "") if user_info else "",
                first_name=(user_info or {}).get("first_name", "") if user_info else "",
                last_name=(user_info or {}).get("last_name", "") if user_info else "",
                db=conn,
                channel_id=channel_id,
                token=token,
            )
    except Exception as e:
        logger.warning(f"VK funnel-landing background failed (run={run_id}, vk={vk_user_id}): {e}")


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
            """SELECT ch.id AS channel_id, ch.bot_token, cc.client_id, ch.handle,
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

        # Резолвим slug → lead_magnet или package клиента (funnel-landing)
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

        group_id = int(body.launch_params.get("vk_group_id") or 0) or int(chan["vk_group_id"] or 0)
        group_screen = (chan["handle"] or "").lstrip("@")
        bg_channel_id = chan["channel_id"]
        bg_token = chan["bot_token"]

    # Отправку Текста 1 (с медленным upload видео/фото на VK) — в ФОН, фронту
    # отвечаем сразу, чтобы экран открывался мгновенно, а не ждал загрузку медиа.
    import asyncio
    asyncio.create_task(_run_started_vk_bg(run_id, vk_user_id, bg_channel_id, bg_token))

    return {"ok": True, "vk_user_id": vk_user_id, "group_id": group_id,
            "group_screen": group_screen, "run_id": run_id}


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
    # Опциональный суффикс `_e<event_id>` — жёсткая привязка к событию,
    # чтобы кабинет не открывался на «последнем по ec.id» (копии-черновике).
    invite_event_id: int | None = None
    if "_e" in access_code:
        base, _, ev_part = access_code.rpartition("_e")
        if ev_part.isdigit():
            access_code = base.strip()
            invite_event_id = int(ev_part)
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

        # Подтягиваем ивент-slug для ссылки на кабинет:
        # строго из payload (если был `_e<id>`), иначе published → ended → draft.
        ev = None
        if invite_event_id:
            ev = await conn.fetchrow(
                """SELECT e.slug, e.title
                     FROM event_collaborators ec
                     JOIN events e ON e.id = ec.event_id
                    WHERE ec.speaker_id = $1 AND ec.event_id = $2
                    LIMIT 1""",
                coll["collaborator_id"], invite_event_id,
            )
        if not ev:
            ev = await conn.fetchrow(
                """SELECT e.slug, e.title
                     FROM event_collaborators ec
                     JOIN events e ON e.id = ec.event_id
                    WHERE ec.speaker_id = $1
                    ORDER BY CASE e.status
                               WHEN 'published' THEN 0
                               WHEN 'ended'     THEN 1
                               ELSE 2
                             END, ec.id DESC
                    LIMIT 1""",
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


class VkSpeakerSelfRegisterRequest(BaseModel):
    """Mini App открыт по `vk.com/app{vk_app_id}#spkreg_<event_id>`."""
    launch_params: dict[str, str]
    event_id: int


@router.post("/vk/speaker-self-register", summary="Саморегистрация спикером из VK Mini App")
async def vk_speaker_self_register(body: VkSpeakerSelfRegisterRequest):
    """VK-аналог `/start spkreg_<event_id>` в Telegram. Открывается через
    Mini App клиента. Если контакт уже спикер этого события — шлём ссылку
    на кабинет. Если нет — создаём коллаб + cse и шлём ту же ссылку."""
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
        logger.warning(f"VK spkreg secure_key lookup failed: {e}")

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

        from app.services.speaker_self_register import (
            get_event_for_self_register, find_existing_speaker, complete_speaker_self_register,
        )
        from app.services.contact_merge import upsert_contact_with_identity

        ev = await get_event_for_self_register(conn, body.event_id)
        if not ev or ev["client_id"] != chan["client_id"]:
            raise HTTPException(status_code=404, detail="Событие не найдено")

        contact_id, _pu, _is_new = await upsert_contact_with_identity(
            conn,
            client_id=ev["client_id"],
            platform_slug='vk',
            platform_user_id=str(vk_user_id),
            username="",
            first_name="",
            last_name="",
        )

        # Уже в списке? → шлём ссылку на кабинет, ничего не создаём.
        existing = await find_existing_speaker(
            conn, event_id=body.event_id,
            client_id=ev["client_id"], contact_id=contact_id,
        )
        if existing:
            coll_id = existing["collaborator_id"]
            access_code = existing["access_code"]
            slug = existing["event_slug"]
            sp_name = (existing["name"] or "").strip() or "спикер"
            cabinet_url = f"https://pluson.ru/speaker/{slug}"
            text = (
                f"Здравствуйте, {sp_name}!\n\n"
                f"Вы — спикер «{ev['title']}». Откройте свой кабинет, чтобы заполнить или обновить данные:\n"
                f"{cabinet_url}\n\nКод доступа: {access_code}\n\n"
                "На странице выберите свою фамилию и введите код. Сессия живёт 24 часа. "
                "Код можно передать ассистенту."
            )
        else:
            # Создаём нового коллаба + cse.
            contact_name = await conn.fetchval(
                "SELECT name FROM contacts WHERE id = $1", contact_id,
            )
            coll_id, access_code, slug, _ = await complete_speaker_self_register(
                conn,
                event_id=body.event_id,
                client_id=ev["client_id"],
                contact_id=contact_id,
                contact_name=contact_name or "Спикер",
            )
            cabinet_url = f"https://pluson.ru/speaker/{slug}"
            text = (
                f"Готово! Вы включены в спикеры «{ev['title']}».\n\n"
                f"Откройте свой кабинет и заполните данные:\n{cabinet_url}\n\n"
                f"Код доступа: {access_code}\n\n"
                "Код можно передать ассистенту — он заполнит за вас."
            )

        from app.services.vk_api import send_message as vk_send_message, tg_inline_to_vk_keyboard
        keyboard = tg_inline_to_vk_keyboard([[
            {"text": "📝 Открыть кабинет спикера", "url": cabinet_url},
        ]])
        try:
            await vk_send_message(int(vk_user_id), text, keyboard=keyboard, token=chan["bot_token"])
        except Exception as e:
            logger.warning(f"VK spkreg messages.send failed: {e}")

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


class VkPartnerInviteRequest(BaseModel):
    """Mini App открыт по `vk.com/app{aid}#prtc_<client_id>` или `#prtp_<contact_id>`.

    Аналог `/start prtc_X` / `/start prtp_X` в TG — резолвит entry через
    `resolve_partner_entry`, создаёт partner_run, запускает run_started_partner_vk,
    который шлёт партнёру в личку сообщество приветствие + url-кнопку на лендинг.
    """
    launch_params: dict[str, str]
    start_arg: str


@router.post("/vk/partner-invite", summary="Открытие prtc_/prtp_ ссылки из VK Mini App")
async def vk_partner_invite(body: VkPartnerInviteRequest):
    """VK-аналог `/start prtc_<client_id>` / `prtp_<contact_id>` в TG.

    Открывается через Mini App клиента (vk.com/app{aid}#prtc_X или #prtp_X).
    Бэк находит клиента по vk_app_id, парсит start_arg, создаёт partner_run
    и шлёт партнёру в личку приветствие + кнопку на лендинг."""
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
        logger.warning(f"VK partner-invite secure_key lookup failed: {e}")

    if not secure_key or not validate_vk_launch_params(body.launch_params, secure_key):
        raise HTTPException(status_code=403, detail="Invalid VK launch params signature")

    vk_user_id_raw = body.launch_params.get("vk_user_id")
    if not vk_user_id_raw:
        raise HTTPException(status_code=400, detail="vk_user_id required")
    try:
        vk_user_id = int(vk_user_id_raw)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="vk_user_id must be int")

    start_arg = (body.start_arg or "").strip()
    if not start_arg or not (start_arg.startswith("prtc_") or start_arg.startswith("prtp_")):
        raise HTTPException(status_code=400, detail="start_arg must be prtc_<id> or prtp_<id>")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="db not available")

    async with pool.acquire() as conn:
        # Канал клиента по vk_app_id Mini App — через него шлём сообщение в личку.
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

        # Парсим start_arg → (client_id, referrer_contact_id, referrer_query)
        from app.services.partner_service import (
            resolve_partner_entry, create_partner_run, run_started_partner_vk,
        )
        resolved = await resolve_partner_entry(start_arg, "vk", conn)
        if not resolved:
            raise HTTPException(status_code=404, detail="Партнёрская ссылка не найдена")
        client_id, referrer_contact_id, referrer_query = resolved

        # Защита от подмены: client_id из start_arg должен совпасть с владельцем VK Mini App
        if client_id != chan["client_id"]:
            raise HTTPException(status_code=403, detail="Ссылка выдана другим клиентом")

        run_id = await create_partner_run(
            client_id, "vk", referrer_contact_id, referrer_query, conn,
        )

        # Подтягиваем ФИО партнёра по vk_user_id (опционально)
        user_info = None
        try:
            from app.services.vk_api import get_user_info as vk_get_user_info
            user_info = await vk_get_user_info(vk_user_id)
        except Exception:
            pass

        await run_started_partner_vk(
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

    # ЛОГ ССЫЛКИ ПЕРЕХОДА — пишем сырьё ПЕРВЫМ делом, до создания контакта/участия.
    # Видно по факту: довёз ли VK slug/pid (event_slug/partner_id) или потерял hash.
    try:
        async with pool.acquire() as _logc:
            await log_entry_link(
                _logc,
                platform="vk",
                platform_user_id=vk_user_id,
                raw_param=(body.event_slug or "") + (f"_pid{body.partner_id}" if body.partner_id else ""),
                launch_params=body.launch_params,
                parsed_slug=body.event_slug or None,
                parsed_pid=body.partner_id or None,
            )
    except Exception:
        pass

    # Определяем client_id: 1) явный из startapp 2) из event_slug
    #   3) ПО vk_app_id — владелец Mini App (КЛЮЧЕВОЕ против дублей: даже при
    #      потерянном hash приложение открыто в КОНКРЕТНОМ сообществе клиента,
    #      его app_id VK передаёт всегда; берём client_id владельца этого app_id,
    #      а не системного — тогда контакт сядет на правильного клиента и
    #      совпадёт со старой vk-идентичностью по UNIQUE, дубль не плодится)
    #   4) системный клиент (ПЛЮСОН Сервис) — только если app_id системный/неизвестен.
    async with pool.acquire() as conn:
        client_id = body.client_id
        if not client_id and body.event_slug:
            row = await conn.fetchrow("SELECT (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id FROM events WHERE slug = $1", body.event_slug)
            if row:
                client_id = row["client_id"]
        # «Слепое» открытие: VK не пробросил hash (#evl_/#ref_pg…) в iframe → фронт
        # ушёл в /vk/event без slug и без client_id. Фиксируем ФАКТ потери hash
        # ДО резолва по app_id (для уведомления об ошибке привязки к СОБЫТИЮ —
        # клиент-то теперь определится, а вот какое событие открыть — нет).
        blind_open = (not client_id) and (not body.event_slug)
        # Резолв по vk_app_id — владелец клиентского (НЕ системного) Mini App.
        if not client_id and vk_app_id_raw:
            try:
                if int(vk_app_id_raw) != int(getattr(settings, "vk_app_id", "0") or 0):
                    row = await conn.fetchrow(
                        """SELECT cc.client_id
                             FROM channels ch
                             JOIN client_channels cc ON cc.channel_id = ch.id
                            WHERE ch.platform_slug = 'vk'
                              AND ch.is_system = FALSE
                              AND (ch.platform_meta->>'vk_app_id')::int = $1
                            LIMIT 1""",
                        int(vk_app_id_raw),
                    )
                    if row and row["client_id"]:
                        client_id = row["client_id"]
            except Exception as e:
                logger.warning(f"VK /vk/event client_id by app_id failed (app={vk_app_id_raw}): {e}")
        if not client_id:
            # системный клиент «ПЛЮСОН Сервис» — для трафика без контекста
            row = await conn.fetchrow("SELECT id FROM clients WHERE is_system_service=TRUE LIMIT 1")
            client_id = row["id"] if row else 0
        if not client_id:
            return {"ok": False, "error": "no_client_resolved"}

        # Имя/ник могли НЕ прийти с фронта (VKWebAppGetUserInfo не успел отработать
        # при холодном открытии) → контакт сохранялся «Без имени» без ника, хотя в
        # VK у человека имя и screen_name есть. Дотягиваем их по vk_id через VK API
        # (тот же get_user_info, что использует group_join). Иначе в списке
        # участников появляется мусорное «Без имени».
        vk_first = body.first_name or None
        vk_last = body.last_name or None
        vk_username = body.username or None
        if not (vk_first or vk_username):
            try:
                ui = await get_user_info(int(vk_user_id))
                if ui:
                    vk_first = vk_first or ui.get("first_name") or None
                    vk_last = vk_last or ui.get("last_name") or None
                    vk_username = vk_username or ui.get("screen_name") or None
            except Exception as e:
                logger.warning(f"VK /vk/event get_user_info failed (vk={vk_user_id}): {e}")

        contact_id, pu_id, is_new = await upsert_contact_with_identity(
            conn,
            client_id=client_id,
            platform_slug="vk",
            platform_user_id=str(vk_user_id),
            username=vk_username,
            first_name=vk_first,
            last_name=vk_last,
            email=body.email or None,    # автомердж по email — если в TG-базе уже есть «Марго Форбс с email» → склеит
            phone=body.phone or None,    # то же по phone (8/+7-нормализация на стороне contact_merge)
            utm_source=body.utm_source or None,
            known_contact_id=body.contact_id or None,
        )

        # Подписка на главный VK-канал клиента — чтобы человек попал в подписчики
        # и в рассылку (TG это делает через register_telegram_subscription; для VK
        # этого шага раньше не было → VK-база рассылок не наполнялась).
        try:
            from app.services.channels import register_platform_channel_subscription
            await register_platform_channel_subscription(client_id, "vk", pu_id, conn)
        except Exception as e:
            logger.warning(f"VK register channel subscription failed (pu={pu_id}): {e}")

        # Слепое открытие + признак реальной регистрации (email/phone) → шлём
        # уведомление об ошибке привязки. Канал — notifications_telegram_chat_id
        # клиента VK-сообщества, через которое открыли (резолвим по vk_app_id),
        # иначе системному некуда слать.
        if blind_open and (body.email or body.phone):
            logger.warning(
                f"VK /vk/event BLIND OPEN: no slug/client, vk_user={vk_user_id} "
                f"email={'yes' if body.email else 'no'} phone={'yes' if body.phone else 'no'} "
                f"contact={contact_id} → сел на системного client={client_id}, участие НЕ создано"
            )
            try:
                vk_app_id_for_chat = body.launch_params.get("vk_app_id")
                err_chat_id = None
                if vk_app_id_for_chat:
                    err_chat_id = await conn.fetchval(
                        """SELECT cl.notifications_telegram_chat_id
                             FROM channels ch
                             JOIN client_channels cc ON cc.channel_id = ch.id
                             JOIN clients cl ON cl.id = cc.client_id
                            WHERE ch.platform_slug = 'vk'
                              AND (ch.platform_meta->>'vk_app_id')::int = $1
                              AND cl.notifications_telegram_chat_id IS NOT NULL
                            LIMIT 1""",
                        int(vk_app_id_for_chat),
                    )
                if err_chat_id:
                    from app.services.event_welcome import send_event_binding_error_notification
                    from app.services.profile_links import nick_html, link_html
                    full_name = " ".join(
                        x for x in [vk_first or "", vk_last or ""] if x
                    ).strip()
                    _details = {
                        "Что случилось": "VK не передал ссылку события (#evl_/#ref_pg) — человек открыл приложение, ввёл данные, но участие на событие НЕ создалось",
                        "Кто": full_name or "—",
                        "Никнейм": nick_html("vk", user_id=vk_user_id, username=vk_username),
                        "VK ID": vk_user_id,
                    }
                    _vk_link = link_html("vk", user_id=vk_user_id, username=vk_username)
                    if _vk_link:
                        _details["Ссылка"] = _vk_link
                    await send_event_binding_error_notification(
                        conn,
                        chat_id=err_chat_id,
                        title="VK Mini App открылся без привязки к событию",
                        details={
                            **_details,
                            "Email": body.email or "—",
                            "Телефон": body.phone or "—",
                            "ID контакта": f"#{contact_id}",
                            "Карточка": f"{settings.frontend_url}/dashboard/clients?contact={contact_id}",
                            "Что делать": "Проверьте ссылку и при необходимости зарегистрируйте вручную на нужное событие с реферером",
                        },
                    )
            except Exception as e:
                logger.warning(f"VK blind-open notify failed (vk={vk_user_id}): {e}")

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
                "SELECT id, title, status FROM events WHERE slug = $1 AND id IN (SELECT event_id FROM event_owners WHERE client_id = $2 AND status='accepted')",
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
            """SELECT COALESCE((SELECT pe.platform_user_id FROM platform_users pe
                                 WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                                 ORDER BY pe.id LIMIT 1), '') AS email,
                      COALESCE(c.phone_normalized, '') AS phone
                 FROM contacts c WHERE c.id = $1""",
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


# ─────────────────────────────────────────────────────────────────────────────
# VK event-landing: лёгкая заглушка открытия события (альтернатива Mini App).
# Маркер `evl_<slug>`. Бэк регистрирует контакт/подписку/участие и шлёт в ЛС
# ПОЛНЫЙ порт TG-воронки события (start.py:_handle_ref_event_bot_flow / send_event_menu).
# ─────────────────────────────────────────────────────────────────────────────

# Поля события, нужные для порта ЛС-воронки (зеркало SELECT'ов в TG-боте).
_EVENT_FUNNEL_FIELDS = """
    e.id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, e.slug, e.title, e.module_slug, e.status,
    e.landing_url, e.vip_url, e.vip_button_label,
    (SELECT chat_url FROM client_broadcast_chats WHERE id = e.tg_chat_ref) AS chat_url_tg,
    (SELECT chat_url FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS chat_url_vk,
    (SELECT chat_url FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS chat_url_max,
    (SELECT url FROM event_posters
       WHERE event_id = e.id
       ORDER BY CASE orientation
                  WHEN 'horizontal' THEN 1
                  WHEN 'square'     THEN 2
                  WHEN 'vertical'   THEN 3
                  ELSE 4
                END, sort, id
       LIMIT 1) AS poster_url
"""


async def _resolve_vk_secure_key(conn, vk_app_id_raw) -> str | None:
    """Возвращает secure_key для валидации launch_params: клиентский (из
    channels.platform_meta) если vk_app_id ≠ системного, иначе системный.
    Повторяет логику /vk/event и /vk/funnel-landing — вынесено, чтобы не дублировать."""
    secure_key: str | None = settings.vk_app_secure_key
    try:
        if vk_app_id_raw and int(vk_app_id_raw) != int(getattr(settings, "vk_app_id", "0") or 0):
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
    return secure_key


async def send_vk_event_funnel(
    conn,
    *,
    vk_user_id: int,
    token: str | None,
    client_vk_app_id: int | None,
    event_row,
    contact_id: int,
    is_registered: bool,
    pid: str = "",
    utm_source: str = "",
    first_name: str = "",
) -> None:
    """Порт TG-воронки события (start.py) в VK ЛС 1:1.

    НЕ зарегистрирован → приветствие с афишей + 2 кнопки (Мини-Апп / Веб-версия).
    Зарегистрирован → меню кабинета (VIP / Чат / Кабинет / Эфир / Программа).
    Чат и Эфир — callback-кнопки (evchat_/evlive_), их ловит vk_main.py.
    """
    from ..services.external_landing import (
        get_contact_landing_params,
        resolve_referrer_external_ref_param,
        build_external_landing_url,
        enrich_external_url,
    )

    slug = event_row["slug"]
    event_id = event_row["id"]
    client_id = event_row["client_id"]
    title = event_row["title"] or ""
    poster_url = (event_row["poster_url"] or "").strip()
    cid_q = f"?c={contact_id}" if contact_id else ""

    # Афишу грузим один раз → attachment (graceful: нет/упало → без фото).
    attachment = None
    if poster_url and token:
        try:
            attachment = await upload_photo_to_messages(poster_url, peer_id=vk_user_id, token=token)
        except Exception as e:
            logger.warning(f"VK event-funnel poster upload failed ({poster_url}): {e}")

    # ── Зарегистрирован → меню кабинета (порт send_event_menu) ────────────────
    if is_registered:
        text = (
            f"Вы зарегистрированы на событие:\n«{title}»\n\n"
            "Это ваше меню — выбирайте, что нужно 👇"
        )
        rows: list[list[dict]] = []

        # 1. VIP — только если задан vip_url.
        vip_url = (event_row["vip_url"] or "").strip()
        if vip_url:
            contact_params = await get_contact_landing_params(conn, contact_id) if contact_id else {}
            erp = await resolve_referrer_external_ref_param(conn, client_id, contact_id=contact_id)
            vip_target = enrich_external_url(
                vip_url,
                pluson_contact_id=contact_id,
                event_slug=slug,
                external_ref_param=erp,
                **contact_params,
            )
            vip_label = (event_row["vip_button_label"] or "").strip() or "Выбрать формат участия"
            rows.append([{"text": vip_label, "url": vip_target}])

        # 2. Вступить в Чат — callback (если есть хоть одна chat-ссылка).
        has_chat = bool((event_row["chat_url_tg"] or "").strip()
                        or (event_row["chat_url_vk"] or "").strip()
                        or (event_row["chat_url_max"] or "").strip())
        if has_chat:
            rows.append([{"text": "📝 Вступить в Чат", "callback_data": f"evchat_{event_id}"}])

        # 3. Кабинет и подарки → веб-страница, вкладка кабинета.
        rows.append([{"text": "🎁 Кабинет и подарки",
                      "url": f"https://pluson.ru/event/{slug}{cid_q}#cabinet"}])

        # 4. Ссылка на эфир — callback.
        rows.append([{"text": "📺 Ссылка на эфир", "callback_data": f"evlive_{event_id}"}])

        # 5. Программа (+ спикеры для конф/турниров).
        prog_label = ("Программа и Спикеры"
                      if event_row["module_slug"] in ("conference", "turnir")
                      else "Программа")
        rows.append([{"text": prog_label,
                      "url": f"https://pluson.ru/event/{slug}{cid_q}#program"}])

        # 6. Тех. поддержка — единое сообщение с каналами связи клиента.
        rows.append([{"text": "🆘 Тех. поддержка", "callback_data": f"evsupport_{event_id}"}])

        keyboard = tg_inline_to_vk_keyboard(rows)
        mid = await vk_send_message(vk_user_id, text, keyboard=keyboard, token=token, attachment=attachment)
        return bool(mid)

    # ── НЕ зарегистрирован → приветствие + 2 кнопки (порт _handle_ref_event_bot_flow) ──
    text = (
        "Добрейшего-богатейшего! 🤝\n\n"
        "Здесь вы можете зарегистрироваться на наше событие:\n"
        f"«{title}»\n\n"
        "Нажмите кнопку ниже, чтобы зарегистрироваться.\n\n"
        "Если проблемы с регистрацией — нажмите кнопку «🆘 Тех. поддержка»."
    )

    # Одна кнопка «Зарегистрироваться» → сторонний лендинг (если задан и
    # опубликован) ЛИБО встроенный веб pluson.ru/event/{slug} — с передачей
    # contact_id, pid, utm, external_ref_param рефовода и полей контакта.
    internal_web = (f"https://pluson.ru/event/{slug}?c={contact_id}"
                    if contact_id else f"https://pluson.ru/event/{slug}")
    landing_url = (event_row["landing_url"] or "").strip()
    if landing_url and event_row["status"] == "published":
        contact_params = await get_contact_landing_params(conn, contact_id) if contact_id else {}
        erp = await resolve_referrer_external_ref_param(conn, client_id, pid=pid or None, contact_id=contact_id)
        # participant_id ОБЯЗАТЕЛЕН в URL: GetCourse/Tilda кладут его в скрытое
        # поле формы и присылают обратно в webhook (getcourse/register по
        # participant_id). Без него лендинг регистрирует «вслепую» и наш webhook
        # не привязывает регистрацию к участию — is_registered не проставляется.
        participant_id = await conn.fetchval(
            "SELECT id FROM event_participants WHERE event_id = $1 AND contact_id = $2 LIMIT 1",
            event_id, contact_id,
        ) if contact_id else None
        web_url = build_external_landing_url(
            landing_url,
            event_slug=slug,
            contact_id=contact_id,
            participant_id=participant_id,
            pid=pid or None,
            utm_source=utm_source or None,
            external_ref_param=erp,
            **contact_params,
        )
    else:
        web_url = internal_web

    keyboard = tg_inline_to_vk_keyboard([
        [{"text": "ЗАРЕГИСТРИРОВАТЬСЯ", "url": web_url}],
        [{"text": "🆘 Тех. поддержка", "callback_data": f"evsupport_{event_id}"}],
    ])
    mid = await vk_send_message(vk_user_id, text, keyboard=keyboard, token=token, attachment=attachment)
    return bool(mid)


async def _vk_event_landing_background(body: VkEventLandingRequest, vk_user_id: int) -> None:
    """Тяжёлая часть event-landing В ФОНЕ (после ответа фронту): upsert контакта,
    подписка, рефовод, participant, отправка ЛС с афишей (upload на VK), nurture,
    уведомление организатору. Берёт СВОЙ коннект из пула — коннект запроса уже
    вернулся в пул к моменту запуска фона."""
    pool = await get_pool()
    if not pool:
        return
    try:
        async with pool.acquire() as conn:
            ev = await conn.fetchrow(
                f"SELECT {_EVENT_FUNNEL_FIELDS} FROM events e WHERE e.slug = $1 LIMIT 1",
                body.slug,
            )
            if not ev:
                return
            client_id = ev["client_id"]

            chan = await conn.fetchrow(
                """SELECT ch.bot_token,
                          (ch.platform_meta->>'vk_app_id')::int AS vk_app_id
                     FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id = $1 AND cc.is_active = TRUE
                      AND ch.platform_slug = 'vk' AND ch.is_system = FALSE
                    LIMIT 1""",
                client_id,
            )
            client_token = chan["bot_token"] if chan else None
            client_vk_app_id = chan["vk_app_id"] if chan else None

            contact_id, pu_id, is_new = await upsert_contact_with_identity(
                conn,
                client_id=client_id,
                platform_slug="vk",
                platform_user_id=str(vk_user_id),
                username=body.username or None,
                first_name=body.first_name or None,
                last_name=body.last_name or None,
                utm_source=body.utm_source or None,
                known_contact_id=body.contact_id or None,
            )

            try:
                from app.services.channels import register_platform_channel_subscription
                await register_platform_channel_subscription(client_id, "vk", pu_id, conn)
            except Exception as e:
                logger.warning(f"VK event-landing channel subscription failed (pu={pu_id}): {e}")

            resolved_ref_code = None
            referrer_contact_id = None
            if body.partner_id:
                resolved_ref_code, referrer_contact_id = await resolve_ref_code(
                    conn, body.partner_id, client_id=client_id,
                )

            referrer_participant_id = None
            if referrer_contact_id:
                referrer_participant_id = await conn.fetchval(
                    "SELECT id FROM event_participants WHERE contact_id = $1 AND event_id = $2 LIMIT 1",
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
            is_registered = bool(await conn.fetchval(
                "SELECT is_registered FROM event_participants WHERE event_id=$1 AND contact_id=$2",
                ev["id"], contact_id,
            ))

            # Маркер «недавно открыл событие через evl_» — по нему handle_message_new
            # в vk_main.py досылает воронку, если человек сам написал боту (когда
            # разрешение на ЛС появилось только после его сообщения).
            await conn.execute(
                "UPDATE event_participants SET last_open_msg_at = NOW() WHERE event_id=$1 AND contact_id=$2",
                ev["id"], contact_id,
            )

            # Отправка ЛС-воронки с RETRY на «нет разрешения» (VK error 901).
            # Свежеподписавшийся: VK проставляет разрешение на ЛС с задержкой —
            # первая попытка (сразу) может упасть 901 (и текст, и upload афиши).
            # Ждём и повторяем, пока разрешение не проставится. Регистрация
            # (контакт/участие) уже сделана выше — повтор досылает только сообщение.
            import asyncio as _asyncio
            delays = [0, 3, 6, 12]  # сразу, затем +3/+6/+12с
            for attempt, delay in enumerate(delays):
                if delay:
                    await _asyncio.sleep(delay)
                try:
                    sent = await send_vk_event_funnel(
                        conn,
                        vk_user_id=vk_user_id,
                        token=client_token,
                        client_vk_app_id=client_vk_app_id,
                        event_row=ev,
                        contact_id=contact_id,
                        is_registered=is_registered,
                        pid=body.partner_id,
                        utm_source=body.utm_source,
                        first_name=body.first_name,
                    )
                    if sent:
                        break
                    logger.info(
                        f"VK event-landing send not delivered (vk={vk_user_id}), "
                        f"попытка {attempt+1}/{len(delays)} — ждём разрешение на ЛС"
                    )
                except Exception as e:
                    logger.warning(f"VK event-landing funnel message failed (vk={vk_user_id}): {e}")

            try:
                from app.api.event_nurture import start_nurture_run_if_eligible
                await start_nurture_run_if_eligible(
                    conn, event_id=ev["id"], contact_id=contact_id, is_registered=is_registered,
                )
            except Exception as e:
                logger.warning(f"VK event-landing nurture failed: {e}")

            if inserted:
                try:
                    await _send_event_organizer_notification(
                        conn,
                        client_id=client_id,
                        event_id=ev["id"],
                        event_title=ev["title"],
                        contact_id=contact_id,
                        platform_slug="vk",
                        referrer_contact_id=referrer_contact_id,
                        tg_id=None,
                    )
                except Exception as e:
                    logger.warning(f"VK event-landing organizer notification failed: {e}")
    except Exception as e:
        logger.warning(f"VK event-landing background failed (vk={vk_user_id}): {e}")


@router.post("/vk/event-landing", summary="Лёгкая заглушка открытия события в VK (evl_)")
async def vk_event_landing(body: VkEventLandingRequest):
    """Открыта альтернативная VK-ссылка события `vk.com/app{aid}#evl_<slug>`.

    Отвечаем фронту МГНОВЕННО (group_id + афиша + title для лёгкого экрана), а всю
    тяжёлую работу (регистрация контакта/подписки/участия + отправка ЛС с upload
    афиши на VK + nurture + уведомление) выполняем В ФОНЕ. Раньше фронт ждал весь
    этот блок (~до 30с из-за upload афиши) — отсюда долгое открытие экрана.
    Старый полный Mini App (`#ref_pg`, /vk/event) не затрагивается."""
    import asyncio
    vk_app_id_raw = body.launch_params.get("vk_app_id")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=503, detail="db not available")

    async with pool.acquire() as conn:
        # Валидация подписи нужным ключом (клиентский Mini App имеет свой secure_key).
        secure_key = await _resolve_vk_secure_key(conn, vk_app_id_raw)
        if not secure_key or not validate_vk_launch_params(body.launch_params, secure_key):
            raise HTTPException(status_code=403, detail="Invalid VK launch params signature")

        vk_user_id_raw = body.launch_params.get("vk_user_id")
        if not vk_user_id_raw:
            raise HTTPException(status_code=400, detail="vk_user_id required")
        try:
            vk_user_id = int(vk_user_id_raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="vk_user_id must be int")

        # ЛОГ ССЫЛКИ ПЕРЕХОДА — сюда попадают люди по ссылкам жюри (#evl_<slug>_pid...).
        try:
            await log_entry_link(
                conn,
                platform="vk",
                platform_user_id=vk_user_id,
                raw_param=(body.slug or "") + (f"_pid{body.partner_id}" if body.partner_id else ""),
                launch_params=body.launch_params,
                parsed_slug=body.slug or None,
                parsed_pid=body.partner_id or None,
            )
        except Exception:
            pass

        # Быстрый резолв для ОТВЕТА: событие + group_id + афиша (без тяжёлой работы).
        ev = await conn.fetchrow(
            """SELECT e.id, e.title,
                      (SELECT url FROM event_posters
                         WHERE event_id = e.id
                         ORDER BY CASE orientation
                                    WHEN 'horizontal' THEN 1 WHEN 'square' THEN 2
                                    WHEN 'vertical' THEN 3 ELSE 4 END, sort, id
                         LIMIT 1) AS poster_url,
                      (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id
                 FROM events e WHERE e.slug = $1 LIMIT 1""",
            body.slug,
        )
        if not ev:
            raise HTTPException(status_code=404, detail="Событие не найдено")
        chan = await conn.fetchrow(
            """SELECT (ch.platform_meta->>'vk_group_id')::int AS group_id, ch.handle
                 FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1 AND cc.is_active = TRUE
                  AND ch.platform_slug = 'vk' AND ch.is_system = FALSE
                LIMIT 1""",
            ev["client_id"],
        )
        group_id = (chan["group_id"] if chan else 0) or 0
        group_screen = ((chan["handle"] if chan else "") or "").lstrip("@")

    # Тяжёлую часть — в фон, фронту отвечаем сразу.
    asyncio.create_task(_vk_event_landing_background(body, vk_user_id))

    return {
        "ok": True,
        "group_id": group_id,
        "group_screen": group_screen,
        "poster_url": (ev["poster_url"] or "").strip(),
        "event_title": ev["title"],
    }
