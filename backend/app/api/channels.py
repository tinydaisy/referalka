"""
API каналов доставки клиента (миграция 036, дополнение 045, архитектура G миграция 066).

Архитектура G:
  - channels — самостоятельная сущность БЕЗ client_id. Включает VIP-боты клиентов
    и общие системные каналы (@pluson_bot, MAX, VK).
  - channels.is_system=TRUE — это общий сервисный канал (один на сервис).
  - channels.is_test=TRUE — системный канал в тестовом режиме (не выдан клиентам).
  - client_channels(client_id, channel_id, is_active) — junction. Один клиент может
    быть привязан к нескольким каналам (свои VIP + системные общие). is_active=TRUE
    помечает «главный канал клиента на этой платформе».
  - platform_user_channels.client_channel_id — подписка в КОНКРЕТНОМ контексте.

Из дашборда клиент видит SELECT channels JOIN client_channels WHERE client_id=me.
Системные каналы (@pluson_bot и т.п.) — read-only: bot_token не показывается, не редактируется,
удалить нельзя, импорт CSV запрещён (см. is_system проверки в эндпоинтах).
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.config import settings
from app.database import get_db
from app.services.bot_reload import reload_bot_polling
from app.services.channel_import import import_csv_to_channel

router = APIRouter(prefix="/channels", tags=["Каналы"])


async def _assert_can_use_custom_bot(db, client_id: int):
    """403 если фича 'channels' выключена в активной подписке клиента."""
    from app.services.features import client_has_feature
    if not await client_has_feature(db, client_id, "channels"):
        raise HTTPException(
            status_code=403,
            detail="Подключение своего бота доступно на тарифе VIP. Перейдите на VIP в настройках профиля.",
        )


def _mini_app_url_for_client(client_id: int) -> str:
    base = settings.frontend_url.rstrip("/")
    return f"{base}/c/{client_id}/tg/"


async def _tg_call(token: str, method: str, payload: dict | None = None) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.post(url, json=payload or {})
        except httpx.RequestError:
            raise HTTPException(status_code=502, detail="Не удалось связаться с Telegram")
    data = r.json()
    if not data.get("ok"):
        desc = data.get("description") or "Telegram API error"
        raise HTTPException(status_code=400, detail=f"Telegram: {desc}")
    return data.get("result") or {}


async def _ensure_polling_ready(token: str) -> None:
    """deleteWebhook у бота — иначе getUpdates падает с Conflict."""
    import logging
    log = logging.getLogger(__name__)
    url = f"https://api.telegram.org/bot{token}/deleteWebhook"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(url, json={"drop_pending_updates": True})
        d = r.json()
        if d.get("ok"):
            log.info("deleteWebhook OK для бота: %s", d.get("description") or "ok")
        else:
            log.warning("deleteWebhook вернул not-ok: %s", d.get("description"))
    except Exception as e:
        log.warning("deleteWebhook не удался: %s", e)


# ─── Pydantic ─────────────────────────────────────────────────────────

class ChannelCreate(BaseModel):
    platform_slug: str
    display_name: str
    handle: Optional[str] = None
    bot_token: Optional[str] = None
    is_active: bool = True


class ChannelUpdate(BaseModel):
    display_name: Optional[str] = None
    handle: Optional[str] = None
    bot_token: Optional[str] = None
    is_active: Optional[bool] = None


# ─── GET список каналов клиента ───────────────────────────────────────

@router.get("")
async def list_channels(client=Depends(get_current_client), db=Depends(get_db)):
    """Список каналов клиента. Включает свои VIP-боты + общие системные.

    Счётчики подписчиков считаются в КОНТЕКСТЕ клиента (только его подписчики),
    через JOIN на client_channels.id (не глобально по channel_id).
    bot_token наружу не отдаём.
    """
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT
              ch.id, ch.platform_slug, ch.display_name, ch.handle,
              ch.is_system, ch.is_test,
              cc.is_active, cc.id AS client_channel_id,
              ch.created_at, ch.updated_at,
              p.display_name AS platform_display_name,
              p.icon_url AS platform_icon_url,
              p.color_hex AS platform_color_hex,
              (SELECT COUNT(*) FROM platform_user_channels puc
                WHERE puc.client_channel_id = cc.id AND puc.is_unsubscribed = FALSE) AS subscribers,
              (SELECT COUNT(*) FROM platform_user_channels puc
                WHERE puc.client_channel_id = cc.id AND puc.is_unsubscribed = TRUE) AS unsubscribed
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
             JOIN platforms p ON p.slug = ch.platform_slug
            WHERE cc.client_id = $1
            ORDER BY p.sort_order, ch.is_system, ch.id""",
        client_id
    )
    return {"items": [dict(r) for r in rows]}


@router.get("/{channel_id}")
async def get_channel(channel_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    """Детали одного канала. bot_token отдаём только для своих VIP-каналов
    (не is_system) — для системных канальный токен не показываем."""
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ch.id, ch.platform_slug, ch.display_name, ch.handle,
                  ch.is_system, ch.is_test,
                  CASE WHEN ch.is_system THEN NULL ELSE ch.bot_token END AS bot_token,
                  cc.is_active, cc.id AS client_channel_id,
                  ch.created_at, ch.updated_at
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE ch.id = $1 AND cc.client_id = $2""",
        channel_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Канал не найден")
    return dict(row)


# ─── POST создание канала клиентом ────────────────────────────────────

@router.post("")
async def create_channel(
    data: ChannelCreate,
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    """Создаёт ПОЛЬЗОВАТЕЛЬСКИЙ (не системный) канал клиента и связку в client_channels.
    Системные каналы создаются только админом отдельным эндпоинтом."""
    client_id = int(client["sub"])
    platform_exists = await db.fetchval(
        "SELECT 1 FROM platforms WHERE slug = $1 AND is_active = TRUE", data.platform_slug
    )
    if not platform_exists:
        raise HTTPException(status_code=400, detail="Неизвестная платформа")

    if data.platform_slug == "telegram" and data.bot_token:
        await _assert_can_use_custom_bot(db, client_id)

    async with db.transaction():
        # Если новый канал делаем главным — снимаем флаг у текущего главного у этого клиента на платформе
        if data.is_active:
            await db.execute(
                """UPDATE client_channels cc
                      SET is_active = FALSE
                     FROM channels ch
                    WHERE cc.channel_id = ch.id
                      AND cc.client_id = $1
                      AND ch.platform_slug = $2
                      AND cc.is_active = TRUE""",
                client_id, data.platform_slug
            )
        new_channel_id = await db.fetchval(
            """INSERT INTO channels (platform_slug, display_name, handle, bot_token, is_system, is_test)
               VALUES ($1, $2, $3, $4, FALSE, FALSE) RETURNING id""",
            data.platform_slug, data.display_name, data.handle, data.bot_token
        )
        await db.execute(
            "INSERT INTO client_channels (client_id, channel_id, is_active) VALUES ($1, $2, $3)",
            client_id, new_channel_id, data.is_active
        )

    if data.platform_slug == "telegram" and data.is_active and data.bot_token:
        await _ensure_polling_ready(data.bot_token)
        await reload_bot_polling()

    return {"id": new_channel_id, "ok": True}


# ─── PATCH обновление канала ──────────────────────────────────────────

@router.patch("/{channel_id}")
async def update_channel(
    channel_id: int,
    data: ChannelUpdate,
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    """Обновление полей канала.

    Запреты:
      - bot_token нельзя менять для is_system (системный токен в .env)
      - is_active живёт в client_channels (для пары клиент×канал), а не в channels
    """
    client_id = int(client["sub"])
    current = await db.fetchrow(
        """SELECT ch.id, ch.platform_slug, ch.is_system, ch.bot_token,
                  cc.id AS cc_id, cc.is_active
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE ch.id = $1 AND cc.client_id = $2""",
        channel_id, client_id
    )
    if not current:
        raise HTTPException(status_code=404, detail="Канал не найден")

    # Запреты для системных
    if current["is_system"]:
        if data.bot_token is not None:
            raise HTTPException(
                status_code=403,
                detail="Системный канал — токен менять нельзя (он общий для всех клиентов)."
            )
        if data.display_name is not None or data.handle is not None:
            raise HTTPException(
                status_code=403,
                detail="Системный канал — название и handle менять нельзя."
            )

    # Поля channels (display_name, handle, bot_token)
    ch_updates: list[str] = []
    ch_params: list = []
    if data.display_name is not None:
        ch_params.append(data.display_name); ch_updates.append(f"display_name = ${len(ch_params)}")
    if data.handle is not None:
        ch_params.append(data.handle); ch_updates.append(f"handle = ${len(ch_params)}")
    if data.bot_token is not None:
        if data.bot_token and current["platform_slug"] == "telegram":
            await _assert_can_use_custom_bot(db, client_id)
        ch_params.append(data.bot_token); ch_updates.append(f"bot_token = ${len(ch_params)}")

    async with db.transaction():
        if ch_updates:
            ch_params.append(channel_id)
            await db.execute(
                f"UPDATE channels SET {', '.join(ch_updates)}, updated_at = NOW() WHERE id = ${len(ch_params)}",
                *ch_params
            )

        # is_active — на client_channels
        if data.is_active is True:
            # Снять флаг у других главных клиента на этой платформе
            await db.execute(
                """UPDATE client_channels cc
                      SET is_active = FALSE
                     FROM channels ch
                    WHERE cc.channel_id = ch.id
                      AND cc.client_id = $1
                      AND ch.platform_slug = $2
                      AND cc.is_active = TRUE
                      AND cc.id <> $3""",
                client_id, current["platform_slug"], current["cc_id"]
            )
            await db.execute(
                "UPDATE client_channels SET is_active = TRUE WHERE id = $1", current["cc_id"]
            )
        elif data.is_active is False:
            await db.execute(
                "UPDATE client_channels SET is_active = FALSE WHERE id = $1", current["cc_id"]
            )

    # Перезапуск polling если меняется состав активных TG-ботов или их токенов
    if current["platform_slug"] == "telegram":
        activeness_changed = data.is_active is not None and data.is_active != current["is_active"]
        token_changed_on_active = (
            data.bot_token is not None
            and data.bot_token != (current["bot_token"] or "")
            and (current["is_active"] or data.is_active is True)
        )
        if activeness_changed or token_changed_on_active:
            now_active = data.is_active if data.is_active is not None else current["is_active"]
            if now_active:
                token_for_polling = data.bot_token if data.bot_token is not None else (current["bot_token"] or "")
                if token_for_polling:
                    await _ensure_polling_ready(token_for_polling)
            await reload_bot_polling()

    return {"ok": True}


# ─── POST /connect-telegram-bot ──────────────────────────────────────

class ConnectTelegramBotRequest(BaseModel):
    bot_token: str


@router.post("/connect-telegram-bot", summary="VIP-онбординг: подключить свой Telegram-бот")
async def connect_telegram_bot(
    data: ConnectTelegramBotRequest,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """VIP-онбординг: вставил токен → бэк делает getMe → INSERT channels + client_channels →
    setChatMenuButton → deleteWebhook → reload polling."""
    client_id = int(client["sub"])
    await _assert_can_use_custom_bot(db, client_id)

    token = data.bot_token.strip()
    if not token or ":" not in token:
        raise HTTPException(status_code=400, detail="Неверный формат токена")

    me = await _tg_call(token, "getMe")
    bot_username = me.get("username") or ""
    bot_name = me.get("first_name") or bot_username
    if not bot_username:
        raise HTTPException(status_code=400, detail="Telegram вернул пустой username бота")

    mini_app_url = _mini_app_url_for_client(client_id)
    await _tg_call(token, "setChatMenuButton", {
        "menu_button": {
            "type": "web_app",
            "text": "Открыть кабинет",
            "web_app": {"url": mini_app_url},
        }
    })

    # Upsert: если у клиента уже есть НЕ-системный telegram-канал — обновить, иначе создать
    existing = await db.fetchrow(
        """SELECT ch.id, cc.id AS cc_id
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
            ORDER BY cc.is_active DESC, ch.id ASC LIMIT 1""",
        client_id,
    )
    async with db.transaction():
        if existing:
            await db.execute(
                """UPDATE channels
                      SET bot_token = $1, display_name = $2, handle = $3, updated_at = NOW()
                    WHERE id = $4""",
                token, f"Бот {bot_name}", f"@{bot_username}", existing["id"],
            )
            channel_id = existing["id"]
            # Сделаем активным (если не был) — снимем флаг у других
            await db.execute(
                """UPDATE client_channels cc
                      SET is_active = FALSE
                     FROM channels ch
                    WHERE cc.channel_id = ch.id
                      AND cc.client_id = $1 AND ch.platform_slug = 'telegram'
                      AND cc.is_active = TRUE AND cc.id <> $2""",
                client_id, existing["cc_id"]
            )
            await db.execute(
                "UPDATE client_channels SET is_active = TRUE WHERE id = $1", existing["cc_id"]
            )
        else:
            channel_id = await db.fetchval(
                """INSERT INTO channels (platform_slug, display_name, handle, bot_token, is_system, is_test)
                   VALUES ('telegram', $1, $2, $3, FALSE, FALSE) RETURNING id""",
                f"Бот {bot_name}", f"@{bot_username}", token,
            )
            # Снять флаг главного у других telegram-каналов клиента (системный @pluson_bot и т.п.)
            await db.execute(
                """UPDATE client_channels cc
                      SET is_active = FALSE
                     FROM channels ch
                    WHERE cc.channel_id = ch.id
                      AND cc.client_id = $1 AND ch.platform_slug = 'telegram'
                      AND cc.is_active = TRUE""",
                client_id
            )
            await db.execute(
                "INSERT INTO client_channels (client_id, channel_id, is_active) VALUES ($1, $2, TRUE)",
                client_id, channel_id,
            )

    await _ensure_polling_ready(token)
    await reload_bot_polling()

    return {
        "ok": True,
        "channel_id": channel_id,
        "bot_username": bot_username,
        "bot_name": bot_name,
        "mini_app_url": mini_app_url,
    }


# ─── DELETE удаление канала ───────────────────────────────────────────

@router.delete("/{channel_id}")
async def delete_channel(channel_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    """Удаляет канал клиента.

    Запреты:
      - is_system — нельзя удалить (общий сервисный канал, управляется админом).
      - канал с подписчиками — 409 (предупреждение, чтобы не потерять базу).

    Логика:
      - Удаляем запись из client_channels (привязка клиент-канал).
      - Если на channel больше нет ссылок из client_channels — это orphan, чистим channels тоже.
    """
    client_id = int(client["sub"])
    info = await db.fetchrow(
        """SELECT ch.id, ch.platform_slug, ch.is_system, ch.bot_token,
                  cc.id AS cc_id, cc.is_active
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE ch.id = $1 AND cc.client_id = $2""",
        channel_id, client_id
    )
    if not info:
        raise HTTPException(status_code=404, detail="Канал не найден")

    if info["is_system"]:
        raise HTTPException(
            status_code=403,
            detail="Системный канал нельзя удалить из дашборда — это общий канал сервиса."
        )

    # Проверка: у канала клиента есть подписчики? Предупреждаем (нельзя удалить молча).
    subs = await db.fetchval(
        """SELECT COUNT(*) FROM platform_user_channels puc
            WHERE puc.client_channel_id = $1""",
        info["cc_id"]
    )
    if subs and subs > 0:
        raise HTTPException(
            status_code=409,
            detail=f"У канала {subs} подписчиков. Удаление запрещено — иначе потеряется база. "
                   "Деактивируйте канал (выключите воронку) вместо удаления."
        )

    async with db.transaction():
        await db.execute("DELETE FROM client_channels WHERE id = $1", info["cc_id"])
        # Если на channel больше нет ссылок — удаляем сам канал (он был только у этого клиента)
        other_refs = await db.fetchval(
            "SELECT COUNT(*) FROM client_channels WHERE channel_id = $1", channel_id
        )
        if other_refs == 0:
            await db.execute("DELETE FROM channels WHERE id = $1", channel_id)

    if info["platform_slug"] == "telegram" and info["is_active"] and info["bot_token"]:
        await reload_bot_polling()

    return {"ok": True}


# ─── POST /import-csv ─────────────────────────────────────────────────

@router.post("/{channel_id}/import-csv", summary="Импорт пользователей в канал из CSV")
async def import_channel_csv(
    channel_id: int,
    file: UploadFile = File(...),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """CSV-импорт. Запрещён для системных каналов (там через @pluson_bot не импортируется
    извне — люди приходят сами через /start или Mini App)."""
    client_id = int(client["sub"])

    # Проверка: канал доступен клиенту?
    info = await db.fetchrow(
        """SELECT ch.is_system, cc.id AS cc_id
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE ch.id = $1 AND cc.client_id = $2""",
        channel_id, client_id
    )
    if not info:
        raise HTTPException(status_code=404, detail="Канал не найден")
    if info["is_system"]:
        raise HTTPException(
            status_code=403,
            detail="Импорт CSV в системный канал запрещён — подписчики приходят сами через /start или Mini App."
        )

    MAX_SIZE = 10 * 1024 * 1024
    file_bytes = await file.read()
    if len(file_bytes) > MAX_SIZE:
        raise HTTPException(status_code=413, detail="Файл больше 10 МБ. Разбейте на несколько частей.")
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Файл пустой")

    try:
        result = await import_csv_to_channel(
            db, client_id=client_id, channel_id=channel_id, file_bytes=file_bytes
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return result
