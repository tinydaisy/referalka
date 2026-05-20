"""
POST /api/v1/vk/event — аналог /api/v1/event для VK Mini App.

Принимает launch params от VK Bridge (vk_user_id, vk_app_id, sign, ...), валидирует
подпись, делает upsert contact+platform_users, шлёт контекстное приветствие
(если событие задано) в личку пользователя от сообщества.

VK Bridge передаёт launch params как query-string при загрузке iframe Mini App.
Mini App копирует все vk_* + sign из своего window.location и шлёт сюда.
"""
from __future__ import annotations

import logging

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


@router.post("/vk/event")
async def handle_vk_event(body: VkEventRequest):
    """Сигнал от VK Mini App при открытии. Валидирует подпись, регистрирует контакт."""
    # Validate VK Bridge signature
    if not validate_vk_launch_params(body.launch_params, settings.vk_app_secure_key):
        logger.warning(f"VK signature invalid: {body.launch_params.get('vk_user_id')}")
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
        referrer_contact_id = None
        if body.partner_id:
            _, referrer_contact_id = await resolve_ref_code(conn, body.partner_id, client_id=client_id)

        # Создание/обновление event_participants — только если есть event_slug
        event_title = None
        if body.event_slug:
            ev = await conn.fetchrow(
                "SELECT id, title, status FROM events WHERE slug = $1 AND client_id = $2",
                body.event_slug, client_id,
            )
            if ev:
                event_title = ev["title"]
                inserted = await conn.fetchval(
                    """INSERT INTO event_participants (event_id, contact_id, referrer_contact_id)
                       VALUES ($1, $2, $3)
                       ON CONFLICT (event_id, contact_id) DO NOTHING
                       RETURNING id""",
                    ev["id"], contact_id, referrer_contact_id,
                )
                # Event-welcome: шлём пользователю всегда при открытии события через VK Mini App
                # (не только при первом INSERT). Без этого юзер при повторном открытии теряет контекст
                # и получает generic-welcome от Long Poll handler.
                if event_title:
                    try:
                        msg = (
                            f"👋 Здравствуйте, {body.first_name or 'друг'}!\n\n"
                            f"Вы открыли событие «{event_title}». Жмите кнопку ниже, чтобы вернуться "
                            f"в приложение — там программа, друзья и подарки за приглашения."
                        )
                        keyboard = tg_inline_to_vk_keyboard([[
                            {"text": f"Войти в «{event_title[:30]}»", "url": build_vk_link(body.event_slug)},
                        ]])
                        await vk_send_message(vk_user_id, msg, keyboard=keyboard)
                    except Exception as e:
                        logger.warning(f"VK welcome message failed for vk_id={vk_user_id}: {e}")

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

    return {
        "ok": True,
        "vk_user_id": vk_user_id,
        "contact_id": contact_id,
        "client_id": client_id,
        "is_new_contact": is_new,
        "event_title": event_title,
    }
