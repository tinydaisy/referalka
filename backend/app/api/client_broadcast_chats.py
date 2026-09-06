"""
База внешних чатов/групп/каналов клиента для рассылок (миграция 170).

Выносит «доп. чаты для отправки» с уровня события на уровень КЛИЕНТА: единая
база, в которую дополнительно льются рассылки (общие и событийные). Гейт по
фиче `broadcast_chats` — она есть у trial, pro, vip и admin, число чатов не
ограничено (сверено с прод-базой 06.09.2026).

Endpoints (/api/v1/clients/me/broadcast-chats):
  GET    /                — список чатов клиента
  POST   /                — добавить чат (после резолва или вручную)
  PATCH  /{id}            — переименовать / активировать
  DELETE /{id}            — удалить
  POST   /resolve         — определить chat_id + название по ссылке (TG/VK), MAX — вручную
"""
from __future__ import annotations

import httpx
import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.config import settings
from app.database import get_db
from app.services.features import client_has_feature
from app.services.social_links import telegram_api_id, vk_screen_name_from_link

router = APIRouter(prefix="/clients/me/broadcast-chats", tags=["Чаты для рассылок"])


# ── Гейт по фиче ──
#   broadcast_chats — доступ к разделу, число чатов НЕ ограничено.
#
# ⚠️ Второго уровня «по одному чату на площадку» (фича `broadcast_chats_one`)
# больше нет — удалён миграцией 353. Задумывался как «Профи по одному, Экстра
# безлимит», но по факту ОБЕ фичи были привязаны к trial+pro+vip, а безлимит
# проверялся первым: уровень 'one' не срабатывал ни у кого, зато в карточке
# тарифа висела строка «Чаты для рассылок (по одному)», противоречившая
# соседней «Чаты и группы для рассылок». Вернуть ограничение = завести фичу
# заново И убрать безлимит у нужных тарифов, иначе повторится то же самое.
async def _access_level(db, client_id: int) -> Optional[str]:
    """'unlimited' — доступ есть (без ограничения по числу), None — нет доступа."""
    if await client_has_feature(db, client_id, "broadcast_chats"):
        return "unlimited"
    return None


async def _assert_feature(db, client_id: int) -> str:
    """Проверить доступ к разделу. 403 если фичи нет."""
    level = await _access_level(db, client_id)
    if level is None:
        raise HTTPException(
            status_code=403,
            detail="Чаты для рассылок доступны на платном тарифе. "
                   "Перейдите на него в разделе «Подписка».",
        )
    return level


class ChatIn(BaseModel):
    platform: str                       # telegram | vk | max
    chat_id: str
    title: Optional[str] = None
    chat_url: Optional[str] = None
    is_public: Optional[bool] = False
    added_via: Optional[str] = "manual"  # link | manual


class ChatPatch(BaseModel):
    title: Optional[str] = None
    # Ссылка-приглашение в чат. Ключ есть в JSON (хоть null/"") → применяем,
    # пустая строка очищает до NULL. Ключа нет → поле не трогаем.
    chat_url: Optional[str] = None
    is_active: Optional[bool] = None
    use_for_broadcasts: Optional[bool] = None  # галочка «использовать для рассылок»
    is_private: Optional[bool] = None          # личный канал (миграция 196)


class ResolveIn(BaseModel):
    platform: str                       # telegram | vk | max
    url: Optional[str] = None           # ссылка на группу/канал
    username: Optional[str] = None      # @foo / foo


@router.get("/", summary="Список чатов клиента для рассылок")
async def list_chats(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT id, platform, chat_id, title, chat_url, is_public, added_via, is_active, use_for_broadcasts, is_private, created_at
             FROM client_broadcast_chats
            WHERE client_id = $1
            ORDER BY platform, id""",
        client_id,
    )
    # access_level: 'unlimited' (доступ есть, число чатов не ограничено) | null (нет доступа).
    # Фронт по нему решает, какие площадки залочить замком в модалке «Добавить чат».
    level = await _access_level(db, client_id)
    return {"chats": [dict(r) for r in rows], "access_level": level}


@router.post("/resolve", summary="Определить chat_id + название по ссылке")
async def resolve_chat(
    data: ResolveIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Публичный TG → getChat (chat_id + title). Публичный VK → resolveScreenName
    (group_id + name). MAX — публичного метода нет, клиент вписывает вручную."""
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    platform = (data.platform or "").lower()

    if platform == "telegram":
        api_id = ""
        if data.username and data.username.strip():
            u = data.username.strip().lstrip("@").split("/")[-1]
            if u:
                api_id = f"@{u}"
        elif data.url and data.url.strip():
            api_id = telegram_api_id(data.url)
        if not api_id:
            raise HTTPException(
                status_code=400,
                detail="У канала нет публичного @username (закрытый по инвайт-ссылке). Введите ID и название вручную.",
            )
        token = settings.telegram_bot_token
        if not token:
            raise HTTPException(status_code=500, detail="Bot token не настроен")
        try:
            async with httpx.AsyncClient(timeout=10) as http:
                r = await http.get(
                    f"https://api.telegram.org/bot{token}/getChat",
                    params={"chat_id": api_id},
                )
                d = r.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Не дозвонились до Telegram: {e}")
        if not d.get("ok"):
            raise HTTPException(status_code=400, detail=f"Telegram отказал: {d.get('description', 'unknown')}")
        res = d["result"]
        cid = res.get("id")
        if not cid:
            raise HTTPException(status_code=502, detail="getChat не вернул id")
        return {"platform": "telegram", "chat_id": str(cid),
                "title": res.get("title") or res.get("username") or "",
                "is_public": True, "added_via": "link"}

    if platform == "vk":
        screen = None
        if data.username and data.username.strip():
            screen = data.username.strip().lstrip("@").split("/")[-1]
        elif data.url and data.url.strip():
            screen = vk_screen_name_from_link(data.url)
        if not screen:
            raise HTTPException(status_code=400, detail="Не удалось разобрать ссылку VK. Введите ID и название вручную.")
        try:
            from app.services.vk_api import vk_call
            resp = await vk_call("utils.resolveScreenName", {"screen_name": screen})
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VK API недоступен: {e}")
        if not (isinstance(resp, dict) and resp.get("object_id")):
            raise HTTPException(status_code=400, detail="VK не нашёл такое сообщество. Введите ID и название вручную.")
        gid = int(resp["object_id"])
        title = ""
        try:
            from app.services.vk_api import vk_call as _vc
            g = await _vc("groups.getById", {"group_id": gid})
            if isinstance(g, list) and g:
                title = g[0].get("name") or ""
            elif isinstance(g, dict) and g.get("groups"):
                title = g["groups"][0].get("name") or ""
        except Exception:
            pass
        return {"platform": "vk", "chat_id": str(gid), "title": title,
                "is_public": True, "added_via": "link"}

    # MAX — публичного резолва нет
    raise HTTPException(
        status_code=400,
        detail="У MAX нет автоопределения ID. Введите ID чата и название вручную.",
    )


@router.post("/", summary="Добавить чат")
async def add_chat(
    data: ChatIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    platform = (data.platform or "").lower()
    if platform not in ("telegram", "vk", "max", "whatsapp"):
        raise HTTPException(status_code=400, detail="platform должен быть telegram | vk | max | whatsapp")
    chat_id = (data.chat_id or "").strip()
    if not chat_id:
        raise HTTPException(status_code=400, detail="Укажите ID чата")
    title = (data.title or "").strip() or None
    chat_url = (data.chat_url or "").strip() or None

    # ⚠️⚠️ БЕЗ ССЫЛКИ ЧАТ БЕСПОЛЕЗЕН. Везде, где человеку предлагают войти в чат
    # (меню бота, письмо о регистрации, воронка догрева, плейсхолдер {chats}),
    # показывается именно ССЫЛКА. Номер чата человеку не поможет — по нему
    # никуда не перейти, и площадка просто ИСЧЕЗАЕТ из списка.
    #
    # Так и вышло у коллаб-события 92: Telegram-чат завели по номеру, ссылку не
    # указали — люди видели только MAX и не понимали, куда делся Telegram.
    #
    # ⚠️ WhatsApp — исключение: там чат не добавляют вручную, его ВЫБИРАЮТ из
    # списка чатов подключённого аккаунта, и ссылки-приглашения у него нет в
    # принципе. Требовать её значило бы запретить добавление вовсе.
    if not chat_url and platform != "whatsapp":
        raise HTTPException(
            status_code=400,
            detail="Добавьте ссылку-приглашение в чат. Без неё людям некуда переходить — "
                   "чат не появится ни в меню бота, ни в письмах, ни в рассылках.",
        )

    # ⚠️ Ограничения «один чат на площадку» больше нет (миграция 353) — оно не
    # действовало ни у одного клиента, см. комментарий у `_access_level`.
    try:
        row = await db.fetchrow(
            """INSERT INTO client_broadcast_chats
                   (client_id, platform, chat_id, title, chat_url, is_public, added_via)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (client_id, platform, chat_id)
               DO UPDATE SET title = COALESCE(EXCLUDED.title, client_broadcast_chats.title),
                             chat_url = COALESCE(EXCLUDED.chat_url, client_broadcast_chats.chat_url),
                             is_public = EXCLUDED.is_public,
                             is_active = TRUE,
                             updated_at = now()
               RETURNING id, platform, chat_id, title, chat_url, is_public, added_via, is_active, use_for_broadcasts, is_private, created_at""",
            client_id, platform, chat_id, title, chat_url,
            bool(data.is_public), (data.added_via or "manual"),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Не удалось добавить: {e}")
    return dict(row)


@router.patch("/{chat_id}", summary="Переименовать / активировать чат")
async def patch_chat(
    chat_id: int,
    data: ChatPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    # Площадка нужна, чтобы не требовать ссылку у WhatsApp (у его чатов её нет).
    row_platform = await db.fetchval(
        "SELECT platform FROM client_broadcast_chats WHERE id = $1 AND client_id = $2",
        chat_id, client_id,
    )
    if row_platform is None:
        raise HTTPException(status_code=404, detail="Чат не найден")
    sets, args = [], []
    if data.title is not None:
        args.append(data.title.strip() or None); sets.append(f"title = ${len(args)}")
    # Ссылка на чат: смотрим наличие ключа в JSON, а не `is not None` — иначе
    # очистить ссылку (прислать "" / null) было бы нельзя.
    if "chat_url" in data.model_fields_set:
        # ⚠️ Стереть ссылку нельзя по той же причине, по какой её требуют при
        # создании: чат без ссылки пропадает из меню бота и рассылок.
        new_url = (data.chat_url or "").strip() or None
        # ⚠️ WhatsApp исключён по той же причине, что и при создании: у его
        # чатов ссылки-приглашения нет в принципе.
        if not new_url and (row_platform or "") != "whatsapp":
            raise HTTPException(
                status_code=400,
                detail="Ссылку на чат убрать нельзя — без неё людям некуда переходить.",
            )
        args.append(new_url); sets.append(f"chat_url = ${len(args)}")
    if data.is_active is not None:
        args.append(bool(data.is_active)); sets.append(f"is_active = ${len(args)}")
    if data.use_for_broadcasts is not None:
        args.append(bool(data.use_for_broadcasts)); sets.append(f"use_for_broadcasts = ${len(args)}")
    if data.is_private is not None:
        args.append(bool(data.is_private)); sets.append(f"is_private = ${len(args)}")
    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")
    args.extend([chat_id, client_id])
    row = await db.fetchrow(
        f"""UPDATE client_broadcast_chats SET {', '.join(sets)}, updated_at = now()
             WHERE id = ${len(args)-1} AND client_id = ${len(args)}
         RETURNING id, platform, chat_id, title, chat_url, is_public, added_via, is_active, use_for_broadcasts, is_private, created_at""",
        *args,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Чат не найден")
    return dict(row)


@router.delete("/{chat_id}", summary="Удалить чат")
async def delete_chat(
    chat_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    res = await db.execute(
        "DELETE FROM client_broadcast_chats WHERE id = $1 AND client_id = $2",
        chat_id, client_id,
    )
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="Чат не найден")
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# Проверка: наш бот в чате и админ ли он
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ ТОЛЬКО TELEGRAM. У VK/MAX нет метода, который отдал бы боту состав ЧУЖОЙ
# беседы (groups.isMember проверяет подписку на СООБЩЕСТВО, а не членство в
# беседе; у MAX публичного API для этого нет). Поэтому для vk/max возвращаем
# supported=False, и UI не показывает плашку.
@router.post("/{chat_id}/check-bot", summary="Проверить, что бот в чате (и админ)")
async def check_bot_in_chat(
    chat_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает {supported, in_chat, is_admin, can_post, error}.

    Зачем: без бота в чате рассылка в этот чат не уйдёт вовсе, а чтобы бот мог
    слушать чат (кодовые слова, баллы) и удалять сообщения по гейту — он должен
    быть АДМИНОМ. UI подсвечивает красным «Добавьте бота в админы».
    """
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)

    row = await db.fetchrow(
        """SELECT id, platform, chat_id, title FROM client_broadcast_chats
            WHERE id = $1 AND client_id = $2""",
        chat_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Чат не найден")

    if row["platform"] != "telegram":
        return {"supported": False, "in_chat": None, "is_admin": None,
                "can_post": None, "error": None}

    from app.services.channels import get_client_telegram_token
    token = await get_client_telegram_token(client_id, db)
    if not token:
        return {"supported": True, "in_chat": False, "is_admin": False,
                "can_post": False, "error": "no_bot",
                "message": "У вас не подключён свой Telegram-бот — подключите его в разделе «Каналы»."}

    async with httpx.AsyncClient(timeout=10) as http:
        me = (await http.get(f"https://api.telegram.org/bot{token}/getMe")).json()
        if not me.get("ok"):
            raise HTTPException(status_code=502, detail="Не удалось обратиться к Telegram")
        bot_id = me["result"]["id"]

        r = (await http.get(
            f"https://api.telegram.org/bot{token}/getChatMember",
            params={"chat_id": row["chat_id"], "user_id": bot_id},
        )).json()
        # Тип чата (group/supergroup vs channel) — от него зависит логика прав.
        gc = (await http.get(
            f"https://api.telegram.org/bot{token}/getChat",
            params={"chat_id": row["chat_id"]},
        )).json()

    # Тип чата: 'channel' — вещание (у бота-админа есть тумблер «Публикация сообщений»);
    # 'group'/'supergroup' — обычный чат (админ пишет всегда, тумблера нет).
    chat_type = (gc.get("result", {}).get("type") if gc.get("ok") else None)
    is_channel = chat_type == "channel"

    if not r.get("ok"):
        desc = (r.get("description") or "").lower()
        err = "bot_not_in_chat"
        if "chat not found" in desc:
            err = "chat_not_found"
        return {"supported": True, "in_chat": False, "is_admin": False,
                "can_post": False, "chat_type": chat_type, "is_channel": is_channel,
                "error": err,
                "message": "Бот не найден в этом чате. Добавьте его в чат и сделайте администратором."}

    res = r["result"]
    status = res.get("status", "")
    in_chat = status in ("administrator", "creator", "member", "restricted")
    is_admin = status in ("administrator", "creator")

    # Может ли бот реально ПОСТИТЬ:
    # - канал: только админ с включённым правом «Публикация сообщений» (can_post_messages).
    #   У создателя (creator) право есть всегда. can_post_messages может отсутствовать в
    #   ответе (None) — тогда считаем, что права нет (безопасный дефолт).
    # - группа/супергруппа: тумблера нет — админ пишет всегда. Для надёжности рассылок
    #   считаем «готово» именно у админа (не-админ → красное предупреждение на фронте).
    if is_channel:
        can_post = (status == "creator") or (is_admin and bool(res.get("can_post_messages")))
    else:
        can_post = is_admin

    message = None
    error = None
    if not in_chat:
        error = "not_in_chat"
        message = "Бот не в чате. Добавьте его и сделайте администратором."
    elif not is_admin:
        error = "not_admin"
        message = ("Бот в канале, но НЕ администратор. Сделайте его администратором."
                   if is_channel else
                   "Бот в чате, но НЕ администратор. Сделайте его администратором.")
    elif is_channel and not can_post:
        error = "no_post_rights"
        message = ("Бот — админ канала, но у него выключено право «Публикация сообщений». "
                   "Включите его боту в настройках канала — иначе рассылка в канал не уйдёт.")

    return {"supported": True, "in_chat": in_chat, "is_admin": is_admin,
            "can_post": can_post, "chat_type": chat_type, "is_channel": is_channel,
            "error": error, "message": message}
