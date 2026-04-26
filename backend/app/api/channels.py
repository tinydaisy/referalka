"""
API каналов доставки клиента (миграция 036).

Клиент может иметь несколько каналов: TG-боты, VK-группы, MAX-каналы.
В UI — раздел сайдбара «Каналы» в группе БАЗА.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.database import get_db

router = APIRouter(prefix="/channels", tags=["Каналы"])


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
    """Список каналов клиента с количеством подписчиков. Токен возвращаем — клиент видит свои секреты."""
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT
              ch.id, ch.platform_slug, ch.display_name, ch.handle, ch.bot_token, ch.is_active,
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
        params.append(data.bot_token); updates.append(f"bot_token = ${len(params)}")
    if data.is_active is not None:
        params.append(data.is_active); updates.append(f"is_active = ${len(params)}")

    if not updates:
        return {"ok": True}

    params.append(channel_id)
    await db.execute(
        f"UPDATE channels SET {', '.join(updates)}, updated_at = NOW() WHERE id = ${len(params)}",
        *params
    )
    return {"ok": True}


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
