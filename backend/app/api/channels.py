"""
API каналов доставки клиента (миграция 036, дополнение 045).

Клиент может иметь несколько каналов: TG-боты, VK-группы, MAX-каналы.
В UI — раздел сайдбара «Каналы» в группе БАЗА.

Право подключать свой Telegram-бот контролируется фича-флагом тарифа
`tariffs.allow_custom_bot` (миграция 045). Дешёвые тарифы (например `beta`)
не могут сохранять `bot_token` — выдаётся 403. На фронте — read-only с апсейл-блоком.
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.config import settings
from app.database import get_db
from app.services.channel_import import import_csv_to_channel

router = APIRouter(prefix="/channels", tags=["Каналы"])


async def _assert_can_use_custom_bot(db, client_id: int):
    """Проверка фича-флага тарифа. 403 если тариф не разрешает свой бот."""
    allow = await db.fetchval(
        """SELECT COALESCE(t.allow_custom_bot, false)
             FROM clients c
             LEFT JOIN tariffs t ON t.slug = c.tariff_slug
            WHERE c.id = $1""",
        client_id,
    )
    if not allow:
        raise HTTPException(
            status_code=403,
            detail="Подключение своего бота доступно на тарифе VIP. Перейдите на VIP в настройках профиля.",
        )


def _mini_app_url_for_client(client_id: int) -> str:
    """URL Mini App клиента для зашивания в BotFather (`/newapp`) и `setChatMenuButton`."""
    base = settings.frontend_url.rstrip("/")
    return f"{base}/c/{client_id}/tg/"


async def _tg_call(token: str, method: str, payload: dict | None = None) -> dict:
    """Вызов Telegram Bot API. Возвращает поле result. Бросает HTTPException при ошибке."""
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


class ChannelCreate(BaseModel):
    platform_slug: str          # 'telegram' | 'vk' | 'max'
    display_name: str
    handle: Optional[str] = None     # @bot_username / vk_group_id / max_channel_id
    bot_token: Optional[str] = None  # секрет канала
    is_active: bool = True


class ChannelUpdate(BaseModel):
    display_name: Optional[str] = None
    handle: Optional[str] = None
    bot_token: Optional[str] = None
    is_active: Optional[bool] = None


@router.get("")
async def list_channels(client=Depends(get_current_client), db=Depends(get_db)):
    """Список каналов клиента. bot_token наружу не отдаём — только при редактировании одного канала."""
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT
              ch.id, ch.platform_slug, ch.display_name, ch.handle, ch.is_active,
              ch.created_at, ch.updated_at,
              p.display_name AS platform_display_name,
              p.icon_url AS platform_icon_url,
              p.color_hex AS platform_color_hex,
              (SELECT COUNT(*) FROM platform_user_channels puc
                WHERE puc.channel_id = ch.id AND puc.is_unsubscribed = FALSE) AS subscribers,
              (SELECT COUNT(*) FROM platform_user_channels puc
                WHERE puc.channel_id = ch.id AND puc.is_unsubscribed = TRUE) AS unsubscribed
             FROM channels ch
             JOIN platforms p ON p.slug = ch.platform_slug
            WHERE ch.client_id = $1
            ORDER BY p.sort_order, ch.id""",
        client_id
    )
    return {"items": [dict(r) for r in rows]}


@router.get("/{channel_id}")
async def get_channel(channel_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT ch.id, ch.platform_slug, ch.display_name, ch.handle, ch.bot_token,
                  ch.is_active, ch.created_at, ch.updated_at
             FROM channels ch
            WHERE ch.id = $1 AND ch.client_id = $2""",
        channel_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Канал не найден")
    return dict(row)


@router.post("")
async def create_channel(
    data: ChannelCreate,
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    client_id = int(client["sub"])
    # Проверяем что платформа существует
    platform_exists = await db.fetchval(
        "SELECT 1 FROM platforms WHERE slug = $1 AND is_active = TRUE", data.platform_slug
    )
    if not platform_exists:
        raise HTTPException(status_code=400, detail="Неизвестная платформа")

    # Сохранение Telegram-бота со своим токеном — только на тарифе с allow_custom_bot
    if data.platform_slug == "telegram" and data.bot_token:
        await _assert_can_use_custom_bot(db, client_id)

    # Если новый канал создаём главным — снимаем флаг у текущего главного
    # на той же платформе (иначе INSERT упадёт на UNIQUE-индексе).
    async with db.transaction():
        if data.is_active:
            await db.execute(
                """UPDATE channels
                      SET is_active = FALSE, updated_at = NOW()
                    WHERE client_id = $1
                      AND platform_slug = $2
                      AND is_active = TRUE""",
                client_id, data.platform_slug
            )
        channel_id = await db.fetchval(
            """INSERT INTO channels (client_id, platform_slug, display_name, handle, bot_token, is_active)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id""",
            client_id, data.platform_slug, data.display_name, data.handle, data.bot_token, data.is_active
        )
    return {"id": channel_id, "ok": True}


@router.patch("/{channel_id}")
async def update_channel(
    channel_id: int,
    data: ChannelUpdate,
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    client_id = int(client["sub"])
    existing = await db.fetchval(
        "SELECT id FROM channels WHERE id = $1 AND client_id = $2", channel_id, client_id
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Канал не найден")

    updates = []
    params = []
    if data.display_name is not None:
        params.append(data.display_name); updates.append(f"display_name = ${len(params)}")
    if data.handle is not None:
        params.append(data.handle); updates.append(f"handle = ${len(params)}")
    if data.bot_token is not None:
        # Передача нового токена для telegram → проверяем тариф
        if data.bot_token:
            ch_platform = await db.fetchval(
                "SELECT platform_slug FROM channels WHERE id = $1 AND client_id = $2",
                channel_id, client_id
            )
            if ch_platform == "telegram":
                await _assert_can_use_custom_bot(db, client_id)
        params.append(data.bot_token); updates.append(f"bot_token = ${len(params)}")
    if data.is_active is not None:
        params.append(data.is_active); updates.append(f"is_active = ${len(params)}")

    if not updates:
        return {"ok": True}

    # Если включаем канал главным (is_active=true) — сначала снимаем флаг
    # у текущего главного на этой платформе (UNIQUE-индекс не даёт двух активных).
    # Делаем в транзакции: сперва UPDATE старого главного → потом UPDATE нашего.
    async with db.transaction():
        if data.is_active is True:
            ch_platform = await db.fetchval(
                "SELECT platform_slug FROM channels WHERE id = $1 AND client_id = $2",
                channel_id, client_id
            )
            if ch_platform:
                await db.execute(
                    """UPDATE channels
                          SET is_active = FALSE, updated_at = NOW()
                        WHERE client_id = $1
                          AND platform_slug = $2
                          AND is_active = TRUE
                          AND id <> $3""",
                    client_id, ch_platform, channel_id
                )

        params.append(channel_id)
        await db.execute(
            f"UPDATE channels SET {', '.join(updates)}, updated_at = NOW() WHERE id = ${len(params)}",
            *params
        )
    return {"ok": True}


class ConnectTelegramBotRequest(BaseModel):
    bot_token: str


@router.post("/connect-telegram-bot", summary="VIP-онбординг: подключить свой Telegram-бот")
async def connect_telegram_bot(
    data: ConnectTelegramBotRequest,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """
    Wizard для VIP-клиента: вставил токен → бэк делает всё остальное.
      1. Проверяет тариф (allow_custom_bot)
      2. Валидирует токен через `getMe` (узнаёт username, имя бота)
      3. Сохраняет / обновляет запись в `channels` (UNIQUE по client_id+platform=telegram)
      4. Вешает Mini App кнопку через `setChatMenuButton` с URL `/c/{N}/tg/`

    Клиенту останется только зайти в @BotFather → /newapp и привязать тот же URL
    к своему боту (одноразовый шаг, через API нельзя).
    """
    client_id = int(client["sub"])

    await _assert_can_use_custom_bot(db, client_id)

    token = data.bot_token.strip()
    if not token or ":" not in token:
        raise HTTPException(status_code=400, detail="Неверный формат токена")

    # 1. getMe → проверка валидности + имя бота
    me = await _tg_call(token, "getMe")
    bot_username = me.get("username") or ""
    bot_name = me.get("first_name") or bot_username
    if not bot_username:
        raise HTTPException(status_code=400, detail="Telegram вернул пустой username бота")

    # 2. setChatMenuButton — кнопка «Открыть кабинет» в боте клиента
    mini_app_url = _mini_app_url_for_client(client_id)
    await _tg_call(token, "setChatMenuButton", {
        "menu_button": {
            "type": "web_app",
            "text": "Открыть кабинет",
            "web_app": {"url": mini_app_url},
        }
    })

    # 3. Upsert в channels — один активный telegram-канал per клиент
    existing = await db.fetchval(
        "SELECT id FROM channels WHERE client_id = $1 AND platform_slug = 'telegram' AND is_active = TRUE LIMIT 1",
        client_id,
    )
    if existing:
        await db.execute(
            """UPDATE channels
                  SET bot_token = $1, display_name = $2, handle = $3, updated_at = NOW()
                WHERE id = $4""",
            token, f"Бот {bot_name}", f"@{bot_username}", existing,
        )
        channel_id = existing
    else:
        channel_id = await db.fetchval(
            """INSERT INTO channels (client_id, platform_slug, display_name, handle, bot_token, is_active)
               VALUES ($1, 'telegram', $2, $3, $4, TRUE) RETURNING id""",
            client_id, f"Бот {bot_name}", f"@{bot_username}", token,
        )

    return {
        "ok": True,
        "channel_id": channel_id,
        "bot_username": bot_username,
        "bot_name": bot_name,
        "mini_app_url": mini_app_url,
    }


@router.delete("/{channel_id}")
async def delete_channel(channel_id: int, client=Depends(get_current_client), db=Depends(get_db)):
    """Удаляет канал. Все подписки (platform_user_channels) каскадно удалятся."""
    client_id = int(client["sub"])
    deleted = await db.execute(
        "DELETE FROM channels WHERE id = $1 AND client_id = $2",
        channel_id, client_id
    )
    if deleted == "DELETE 0":
        raise HTTPException(status_code=404, detail="Канал не найден")
    return {"ok": True}


@router.post("/{channel_id}/import-csv", summary="Импорт пользователей в канал из CSV")
async def import_channel_csv(
    channel_id: int,
    file: UploadFile = File(...),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Загружает CSV с пользователями (telegram_id, name, telegram_username, email, phone, subscribed)
    и подписывает их на канал. Существующие контакты — мерджит по tg_id или email/phone.
    Поля БД не перетираются — нестыковки идут в текстовый отчёт."""
    client_id = int(client["sub"])

    # Лимит 10 МБ
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
