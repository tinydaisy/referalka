"""API личных переписок (Диалоги) — клиент видит историю ЛС и отвечает людям.

Все эндпоинты под /api/v1 и требуют JWT клиента (get_current_client).
Источник данных — таблица direct_messages (миграция 160).

Отправка/правка/удаление ответов идёт через бот клиента на нужной платформе:
  • Telegram — Bot API sendMessage / editMessageText / deleteMessage;
  • VK       — messages.send / messages.edit / messages.delete (community token);
  • MAX      — POST/PUT/DELETE /messages (bot token).

Токен платформы берём из channels.bot_token соответствующего канала клиента.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.dialog_archive import archive_direct_message
from app.services.assistant_access import (
    assistant_can_reply_in_dialogs,
    leads_only_grant_id,
)


def _leads_sql(gid: int | None, next_param: int, alias: str = "contact_id") -> str:
    """Кусок WHERE «только закреплённые за менеджером лидов» (миграция 484).

    ⚠️ Переписка — это тоже показ людей: без фильтра менеджер лидов читал бы
    в общем списке диалогов чужих людей и их сообщения.
    """
    if not gid:
        return ""
    return (
        f" AND EXISTS (SELECT 1 FROM contact_assignments ca"
        f"              WHERE ca.contact_id = {alias} AND ca.grant_id = ${next_param})"
    )
# ⚠️ Тем же условием список контактов прячет полностью отписавшихся. Берём его
# оттуда, а не переписываем рядом: разойдутся — цифра в меню снова перестанет
# сходиться со списком, ровно с этого расхождения и началось.
from app.api.contacts import UNSUB_EXISTS_SQL

log = logging.getLogger(__name__)
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# Резолв токена и собеседника
# ─────────────────────────────────────────────────────────────────────────────

async def _resolve_channel_token(db, client_id: int, platform: str,
                                 channel_id: Optional[int]) -> tuple[Optional[int], Optional[str]]:
    """(channel_id, bot_token) канала клиента на платформе для отправки ответа.

    Если channel_id задан — берём его (с проверкой принадлежности клиенту).
    Иначе — главный канал клиента на платформе.
    """
    if channel_id:
        row = await db.fetchrow(
            """SELECT ch.id, ch.bot_token FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1 AND ch.id = $2 AND ch.platform_slug = $3
                LIMIT 1""",
            client_id, channel_id, platform,
        )
    else:
        row = await db.fetchrow(
            """SELECT ch.id, ch.bot_token FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1 AND ch.platform_slug = $2
                ORDER BY cc.is_active DESC, cc.id ASC LIMIT 1""",
            client_id, platform,
        )
    if not row:
        return None, None
    return int(row["id"]), row["bot_token"]


# ─────────────────────────────────────────────────────────────────────────────
# Платформенная отправка / правка / удаление
# ─────────────────────────────────────────────────────────────────────────────

async def _tg_send(token: str, chat_id: str, text: str) -> tuple[Optional[str], Optional[str]]:
    """→ (message_id, error). chat_id = tg_id собеседника."""
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
            )
        data = r.json()
        if data.get("ok"):
            return str(data["result"]["message_id"]), None
        return None, data.get("description") or "Telegram отклонил отправку"
    except Exception as e:  # noqa: BLE001
        return None, str(e)


async def _tg_edit(token: str, chat_id: str, message_id: str, text: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/editMessageText",
                json={"chat_id": chat_id, "message_id": int(message_id), "text": text},
            )
        data = r.json()
        return None if data.get("ok") else (data.get("description") or "не удалось изменить")
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _tg_delete(token: str, chat_id: str, message_id: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/deleteMessage",
                json={"chat_id": chat_id, "message_id": int(message_id)},
            )
        data = r.json()
        return None if data.get("ok") else (data.get("description") or "не удалось удалить")
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _vk_send(token: str, user_id: str, text: str) -> tuple[Optional[str], Optional[str]]:
    from app.services.vk_api import send_message as vk_send
    res = await vk_send(int(user_id), text, token=token, return_error=True)
    mid, code, msg = res if isinstance(res, tuple) else (res, None, "")
    if mid:
        return str(mid), None
    try:
        from app.tasks.broadcast import _vk_error_human  # человекочитаемая причина
        human = _vk_error_human(code, msg or "")
    except Exception:  # noqa: BLE001
        human = msg or "VK отклонил отправку"
    return None, human


async def _vk_edit(token: str, user_id: str, message_id: str, text: str) -> Optional[str]:
    from app.services.vk_api import vk_call
    try:
        await vk_call("messages.edit", {
            "peer_id": int(user_id), "message_id": int(message_id),
            "message": text, "keep_forward_messages": 1, "keep_snippets": 1,
        }, token=token)
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _vk_delete(token: str, user_id: str, message_id: str) -> Optional[str]:
    from app.services.vk_api import vk_call
    try:
        await vk_call("messages.delete", {
            "message_ids": int(message_id), "delete_for_all": 1,
        }, token=token)
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _max_send(token: str, user_id: str, text: str) -> tuple[Optional[str], Optional[str]]:
    from app.services.max_api import send_message as max_send
    try:
        resp = await max_send(int(user_id), text, token=token, recipient_kind="user")
        mid = None
        if isinstance(resp, dict):
            mid = ((resp.get("message") or {}).get("body") or {}).get("mid")
        return (str(mid) if mid else None), (None if mid else "MAX не подтвердил доставку")
    except Exception as e:  # noqa: BLE001
        return None, str(e)


async def _max_edit(token: str, message_id: str, text: str) -> Optional[str]:
    from app.services.max_api import max_call
    try:
        await max_call("PUT", "/messages", token=token,
                       params={"message_id": message_id}, json_body={"text": text})
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _max_delete(token: str, message_id: str) -> Optional[str]:
    from app.services.max_api import max_call
    try:
        await max_call("DELETE", "/messages", token=token,
                       params={"message_id": message_id})
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


# ─────────────────────────────────────────────────────────────────────────────
# GET список диалогов клиента
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/dialogs/unread-count")
async def dialogs_unread_count(
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Сколько непрочитанных сообщений от людей — цифра для пункта меню.

    ⚠️ Отдельный лёгкий эндпоинт, а не поле в /auth/me: меню обновляет эту
    цифру периодически, и тянуть ради неё весь профиль клиента с фичами и
    подпиской было бы расточительно.

    ⚠️ Считаем только direction='in' и только у сообщений, привязанных к
    контакту: непривязанные (contact_id IS NULL) не показываются и в разделе
    «Диалоги», так что цифра в меню обязана сходиться с тем, что человек
    реально сможет открыть.

    ⚠️ Цифра РАЗБИТА НА ДВЕ: сколько непрочитанных у подписанных (их видно в
    списке контактов сразу) и сколько у полностью отписавшихся (список по
    умолчанию их прячет — нужен тумблер «показать отписавшихся»). Одним числом
    получалось расхождение, на которое пожаловался владелец: в меню висит «4»,
    а в списке ни одного непрочитанного — все четверо оказались отписавшимися.
    Прятать их из счётчика нельзя (человек написал — про это надо знать), и
    показывать в списке вопреки фильтру тоже: фильтр выбрал сам клиент.

    ⚠️ Контакт джойним с проверкой владельца и is_active: считать то, что
    нельзя открыть, — это снова расхождение цифры со списком.
    """
    client_id = int(client["sub"])
    # ⚠️ Менеджеру лидов считаем только ЕГО людей: иначе в меню висела бы
    # цифра непрочитанных от тех, кого он не может открыть.
    leads_gid = await leads_only_grant_id(client)
    row = await db.fetchrow(
        f"""SELECT
              COUNT(*) FILTER (WHERE NOT {UNSUB_EXISTS_SQL}) AS visible,
              COUNT(*) FILTER (WHERE {UNSUB_EXISTS_SQL})     AS hidden
            FROM direct_messages dm
            JOIN contacts c ON c.id = dm.contact_id
                           AND c.client_id = dm.client_id
                           AND c.is_active = TRUE
           WHERE dm.client_id = $1
             AND dm.direction = 'in' AND NOT dm.is_read
             {_leads_sql(leads_gid, 2, 'dm.contact_id')}""",
        client_id, *( [leads_gid] if leads_gid else [] ),
    )
    visible = int((row and row["visible"]) or 0)
    hidden = int((row and row["hidden"]) or 0)
    # `unread` — суммарная цифра, оставлена для старых вкладок кабинета: там в
    # браузере ещё крутится прежняя сборка, которая знает только это поле.
    return {"unread": visible + hidden, "unread_visible": visible, "unread_hidden": hidden}


@router.get("/dialogs")
async def list_dialogs(
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=60, le=200),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Список диалогов: по одному на контакт, с последним сообщением и счётчиком
    непрочитанных. Сортировка — по времени последнего сообщения (свежие сверху)."""
    client_id = int(client["sub"])
    leads_gid = await leads_only_grant_id(client)
    rows = await db.fetch(
        f"""
        WITH last AS (
            SELECT DISTINCT ON (contact_id, platform)
                   contact_id, platform, text, media_kind, direction, sent_at
              FROM direct_messages
             WHERE client_id = $1 AND contact_id IS NOT NULL
             ORDER BY contact_id, platform, sent_at DESC
        ),
        agg AS (
            SELECT contact_id,
                   MAX(sent_at) AS last_at,
                   array_agg(DISTINCT platform) AS platforms,
                   SUM(CASE WHEN direction='in' AND NOT is_read THEN 1 ELSE 0 END) AS unread
              FROM direct_messages
             WHERE client_id = $1 AND contact_id IS NOT NULL
             GROUP BY contact_id
        )
        SELECT a.contact_id, a.last_at, a.platforms, a.unread,
               c.name, c.ref_code,
               (SELECT text FROM direct_messages dm
                  WHERE dm.client_id=$1 AND dm.contact_id=a.contact_id
                  ORDER BY dm.sent_at DESC LIMIT 1) AS last_text,
               (SELECT media_kind FROM direct_messages dm
                  WHERE dm.client_id=$1 AND dm.contact_id=a.contact_id
                  ORDER BY dm.sent_at DESC LIMIT 1) AS last_media_kind,
               (SELECT direction FROM direct_messages dm
                  WHERE dm.client_id=$1 AND dm.contact_id=a.contact_id
                  ORDER BY dm.sent_at DESC LIMIT 1) AS last_direction
          FROM agg a
          JOIN contacts c ON c.id = a.contact_id
         WHERE ($2::text IS NULL OR c.name ILIKE '%'||$2||'%')
           {_leads_sql(leads_gid, 4, 'a.contact_id')}
         ORDER BY a.last_at DESC
         LIMIT $3
        """,
        client_id, search, limit, *( [leads_gid] if leads_gid else [] ),
    )
    return {"dialogs": [dict(r) for r in rows]}


# ─────────────────────────────────────────────────────────────────────────────
# GET лента переписки по контакту
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/contacts/{contact_id}/messages")
async def contact_messages(
    contact_id: int,
    platform: Optional[str] = Query(default=None),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Полная лента личной переписки с контактом (опц. фильтр по платформе).
    Также помечает входящие прочитанными."""
    client_id = int(client["sub"])
    # Чужую переписку менеджер лидов не читает даже по прямому номеру контакта.
    from app.api.contacts import assert_leads_access
    await assert_leads_access(db, contact_id, client)
    rows = await db.fetch(
        """SELECT id, platform, channel_id, platform_user_id, direction, author_kind,
                  text, media_url, media_kind, platform_message_id, email_subject,
                  is_deleted, error, sent_at, edited_at
             FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2
              AND ($3::text IS NULL OR platform = $3)
            ORDER BY sent_at ASC, id ASC""",
        client_id, contact_id, platform,
    )
    # Какие площадки есть в переписке (вкладки TG/VK/MAX) + сколько на каждой
    # непрочитанных.
    # ⚠️ Считаем ДО пометки прочитанным — иначе счётчики всегда были бы нулями.
    plats = await db.fetch(
        """SELECT platform,
                  COUNT(*) FILTER (WHERE direction='in' AND NOT is_read) AS unread
             FROM direct_messages
            WHERE client_id=$1 AND contact_id=$2
            GROUP BY platform""",
        client_id, contact_id,
    )
    # ⚠️ Помечаем прочитанной ТОЛЬКО просматриваемую площадку. Раньше открытие
    # любой вкладки гасило непрочитанные разом во всех — человек заходил в
    # Telegram, а счётчик MAX обнулялся, хотя тех сообщений никто не видел.
    # Вкладка «Все» (platform=None) по-прежнему гасит всё: там и правда всё
    # показано.
    await db.execute(
        """UPDATE direct_messages SET is_read = TRUE
            WHERE client_id=$1 AND contact_id=$2 AND direction='in' AND NOT is_read
              AND ($3::text IS NULL OR platform = $3)""",
        client_id, contact_id, platform,
    )
    return {
        "messages": [dict(r) for r in rows],
        "platforms": [r["platform"] for r in plats],
        # {'telegram': 2, 'max': 1} — сколько непрочитанных на каждой площадке
        "unread_by_platform": {
            r["platform"]: int(r["unread"] or 0) for r in plats if r["unread"]
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# POST ответ от имени клиента
# ─────────────────────────────────────────────────────────────────────────────

class ReplyBody(BaseModel):
    platform: str          # telegram | vk | max
    text: str
    channel_id: Optional[int] = None


@router.post("/contacts/{contact_id}/reply")
async def reply_to_contact(
    contact_id: int,
    body: ReplyBody,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Отправить сообщение человеку через бот клиента и записать его в ленту."""
    if not await assistant_can_reply_in_dialogs(client):
        raise HTTPException(403, "У вас нет доступа к отправке сообщений.")
    # Писать — только своим закреплённым.
    from app.api.contacts import assert_leads_access
    await assert_leads_access(db, contact_id, client)
    client_id = int(client["sub"])
    platform = body.platform.strip().lower()
    if platform not in ("telegram", "vk", "max", "instagram", "email"):
        raise HTTPException(400, "Неизвестная платформа")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустое сообщение")
    if platform == "email":
        return await _reply_by_email(db, client_id, contact_id, text)

    # platform_user_id собеседника по контакту на этой платформе
    pu = await db.fetchval(
        """SELECT pu.platform_user_id FROM platform_users pu
            JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE pu.contact_id=$1 AND c_own.client_id=$2 AND pu.platform_slug=$3 LIMIT 1""",
        contact_id, client_id, platform,
    )
    if not pu:
        raise HTTPException(404, "У контакта нет аккаунта на этой платформе")

    channel_id, token = await _resolve_channel_token(db, client_id, platform, body.channel_id)
    if not token:
        raise HTTPException(400, "У вас не подключён бот/сообщество на этой платформе")

    if platform == "telegram":
        mid, err = await _tg_send(token, str(pu), text)
    elif platform == "vk":
        mid, err = await _vk_send(token, str(pu), text)
    elif platform == "instagram":
        mid, err = await _ig_send(db, channel_id, str(pu), text)
    else:
        mid, err = await _max_send(token, str(pu), text)

    row_id = await archive_direct_message(
        client_id=client_id, platform=platform, channel_id=channel_id,
        platform_user_id=str(pu), direction="out", author_kind="operator",
        text=text, platform_message_id=mid, contact_id=contact_id, error=err,
    )
    if err:
        # Сообщение записали с пометкой ошибки, но честно сообщаем клиенту.
        raise HTTPException(502, f"Не доставлено: {err}")
    return {"ok": True, "id": row_id, "platform_message_id": mid}


async def _reply_by_email(db, client_id: int, contact_id: int, text: str) -> dict:
    """Ответ письмом от support@pluson.ru (миграция 521).

    ⚠️⚠️ ТОЛЬКО В СЕРВИСНОМ КАБИНЕТЕ. Входящие принимаются лишь на
    support@pluson.ru, значит и отвечать почтой имеет смысл только оттуда: у
    обычного клиента ответ его участника ушёл бы на noreply@ и пропал —
    переписка выглядела бы живой, а была бы односторонней.
    """
    import asyncio

    from app.services.email_sender import (
        EmailSender, EmailSendError, PLUSON_SUPPORT_EMAIL,
    )

    if not await db.fetchval(
            "SELECT is_system_service FROM clients WHERE id = $1", client_id):
        raise HTTPException(400, "Ответ письмом есть только в переписке ПЛЮСОНа")

    to_email = await db.fetchval(
        """SELECT pu.platform_user_id FROM platform_users pu
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE pu.contact_id = $1 AND c_own.client_id = $2
              AND pu.platform_slug = 'email'
            ORDER BY pu.id LIMIT 1""", contact_id, client_id)
    if not to_email:
        raise HTTPException(404, "У контакта нет почты")

    ch = await db.fetchrow(
        """SELECT ch.id, ch.email_from_local, ch.email_subdomain, ch.email_from_name
             FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND ch.platform_slug = 'email'
            ORDER BY cc.is_active DESC, cc.id LIMIT 1""", client_id)
    channel = dict(ch) if ch else {}
    channel["email_from_name"] = "iViSiON: ПЛЮСОН"

    # Отвечаем в ту же цепочку писем: тема «Re: …» и ссылка на последнее
    # входящее письмо этого человека.
    last = await db.fetchrow(
        """SELECT email_subject, platform_message_id FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2 AND platform = 'email'
              AND direction = 'in' AND COALESCE(platform_message_id, '') NOT LIKE '%#att%'
            ORDER BY sent_at DESC LIMIT 1""", client_id, contact_id)
    subj = (last["email_subject"] if last else None) or ""
    if subj and not subj.lower().startswith("re:"):
        subj = f"Re: {subj}"
    subj = subj or "Сообщение от ПЛЮСОНа"

    mid = err = None
    try:
        mid = await asyncio.to_thread(
            EmailSender().send,
            channel=channel, client_brand_name="iViSiON: ПЛЮСОН",
            to_email=to_email, subject=subj, body_text=text,
            unsubscribe_token="",  # личное письмо, не рассылка — без подвала отписки
            from_address_override=PLUSON_SUPPORT_EMAIL,
            reply_to=PLUSON_SUPPORT_EMAIL,
            in_reply_to=(last["platform_message_id"] if last else None),
        )
    except EmailSendError as e:
        err = str(e)[:300]

    row_id = await archive_direct_message(
        client_id=client_id, platform="email", channel_id=channel.get("id"),
        platform_user_id=str(to_email), direction="out", author_kind="operator",
        text=text, platform_message_id=mid, contact_id=contact_id, error=err,
    )
    if row_id:
        await db.execute("UPDATE direct_messages SET email_subject = $1 WHERE id = $2",
                         subj, row_id)
    if err:
        raise HTTPException(502, f"Не доставлено: {err}")
    return {"ok": True, "id": row_id, "platform_message_id": mid}


async def _ig_send(db, channel_id: Optional[int], igsid: str, text: str):
    """Отправить сообщение в директ Instagram.

    ⚠️⚠️ ПИСАТЬ МОЖНО ТОЛЬКО 24 ЧАСА после последнего сообщения человека —
    это правило Meta, обойти его нельзя. Вне окна она отвечает ошибкой, и мы
    переводим её на человеческий язык: иначе клиент видит «(#10) Сообщение
    отправлено за пределами допустимого окна» и решает, что сломалась
    платформа.

    ⚠️ Отправка идёт на id СТРАНИЦЫ Facebook, а не аккаунта Instagram: через
    ig_user_id Meta отвечает «(#3) Application does not have the capability».
    """
    import json as _json
    from app.services import instagram_api as ig

    row = await db.fetchrow(
        "SELECT bot_token, platform_meta FROM channels WHERE id=$1", channel_id)
    if not row:
        return None, "Аккаунт Instagram не найден"
    meta = row["platform_meta"] or {}
    if isinstance(meta, str):
        meta = _json.loads(meta)
    page_id = str(meta.get("page_id") or "")
    if not page_id:
        return None, "У аккаунта не заполнена страница Facebook — переподключите его"

    try:
        res = await ig.send_message(page_id, igsid, text, row["bot_token"] or "")
        return str(res.get("message_id") or "") or None, None
    except ig.InstagramApiError as e:
        # Код 10 / подкод 2534022 — это как раз выход за 24-часовое окно.
        if e.code == 10:
            return None, ("Instagram разрешает писать только 24 часа после "
                          "сообщения человека. Дождитесь, когда он напишет снова.")
        return None, e.user_message


# ─────────────────────────────────────────────────────────────────────────────
# PATCH правка своего сообщения
# ─────────────────────────────────────────────────────────────────────────────

class EditBody(BaseModel):
    text: str


@router.patch("/dialog-messages/{message_id}")
async def edit_message(
    message_id: int,
    body: EditBody,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    # Кому можно писать — тому можно и исправить свою опечатку. Чужое всё равно
    # не тронет: ниже стоит проверка author_kind='operator'.
    if not await assistant_can_reply_in_dialogs(client):
        raise HTTPException(403, "У вас нет доступа к правке сообщений.")
    client_id = int(client["sub"])
    msg = await db.fetchrow(
        """SELECT platform, platform_user_id, platform_message_id, author_kind
             FROM direct_messages WHERE id=$1 AND client_id=$2""",
        message_id, client_id,
    )
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    if msg["author_kind"] != "operator":
        raise HTTPException(400, "Можно править только свои отправленные сообщения")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустой текст")

    channel_id, token = await _resolve_channel_token(db, client_id, msg["platform"], None)
    err = None
    if token and msg["platform_message_id"]:
        if msg["platform"] == "telegram":
            err = await _tg_edit(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]), text)
        elif msg["platform"] == "vk":
            err = await _vk_edit(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]), text)
        else:
            err = await _max_edit(token, str(msg["platform_message_id"]), text)
    if err:
        raise HTTPException(502, f"Не удалось изменить у получателя: {err}")
    await db.execute(
        "UPDATE direct_messages SET text=$1, edited_at=now() WHERE id=$2",
        text, message_id,
    )
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# DELETE удаление своего сообщения
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/dialog-messages/{message_id}")
async def delete_message(
    message_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    if not await assistant_can_reply_in_dialogs(client):
        raise HTTPException(403, "У вас нет доступа к удалению сообщений.")
    client_id = int(client["sub"])
    msg = await db.fetchrow(
        """SELECT platform, platform_user_id, platform_message_id, author_kind
             FROM direct_messages WHERE id=$1 AND client_id=$2""",
        message_id, client_id,
    )
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    if msg["author_kind"] != "operator":
        raise HTTPException(400, "Можно удалять только свои отправленные сообщения")

    channel_id, token = await _resolve_channel_token(db, client_id, msg["platform"], None)
    if token and msg["platform_message_id"]:
        if msg["platform"] == "telegram":
            await _tg_delete(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]))
        elif msg["platform"] == "vk":
            await _vk_delete(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]))
        else:
            await _max_delete(token, str(msg["platform_message_id"]))
    # В ленте помечаем удалённым (не стираем строку — история остаётся у клиента).
    await db.execute(
        "UPDATE direct_messages SET is_deleted=TRUE, text=NULL WHERE id=$1",
        message_id,
    )
    return {"ok": True}
