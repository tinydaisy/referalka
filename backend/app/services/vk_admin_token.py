"""User-токен АДМИНИСТРАТОРА сообщества ВКонтакте — одна точка выдачи.

Зачем. Токен сообщества (бота) не умеет ни `video.save`, ни `wall.post`:
загрузить видео в раздел «Видео» и опубликовать пост на стене от имени
сообщества можно только токеном ЧЕЛОВЕКА-администратора. Его клиент подключает
в кабинете (VK ID 2.0, `channels.py` → `/vk/oauth-callback`), и он лежит в
`channels.platform_meta.vk_admin_user_token`.

⚠️⚠️ ТОКЕН VK ID ЖИВЁТ ЧАС (`expires_in = 3600`). До 26.09.2026 его никто не
обновлял: у всех пяти подключённых кабинетов токен был просрочен (VK отвечает
ошибкой 10 «could not check access_token»), и нативное видео в рассылках
молча не грузилось. Теперь токен обновляется refresh-токеном за 5 минут до
конца срока.

⚠️ Для обновления VK ID требует `device_id` из колбэка авторизации — раньше
его не сохраняли. Токены, подключённые до этой правки, обновить нельзя:
клиенту нужно переподключить токен (кнопка в настройках канала ВК).

⚠️ Refresh-токен одноразовый: VK выдаёт новый на каждое обновление. Два
процесса, обновившие его одновременно, сломали бы друг другу токен — поэтому
обновление идёт под `SELECT … FOR UPDATE` строки канала.
"""
import json
import logging
import secrets
import time
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Обновляем заранее: рассылка может идти несколько минут.
_REFRESH_MARGIN = 300


def _meta(raw) -> dict:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return {}
    return dict(raw or {})


async def get_vk_admin_token(conn, client_id: int) -> tuple[Optional[str], Optional[int], Optional[str]]:
    """(токен, group_id сообщества бота, причина отказа).

    Токен — действующий: при необходимости обновлён. Нет токена или обновить
    нельзя → (None, group_id, «понятная причина для журнала рассылки»).
    """
    row = await conn.fetchrow(
        """SELECT ch.id, ch.platform_meta
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk' AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id ASC
            LIMIT 1""",
        client_id)
    if not row:
        return None, None, "Нет подключённого сообщества ВКонтакте"
    meta = _meta(row["platform_meta"])
    try:
        group_id = int(meta.get("vk_group_id")) if meta.get("vk_group_id") else None
    except (TypeError, ValueError):
        group_id = None
    token = meta.get("vk_admin_user_token")
    if not token:
        return None, group_id, "Не подключён токен администратора ВКонтакте"

    obtained = int(meta.get("vk_admin_token_obtained_at") or 0)
    expires_in = int(meta.get("vk_admin_token_expires_in") or 0)
    # ⚠️ Подключён до 26.09.2026 (нет времени получения и device_id): токен
    # часовой и давно истёк, обновить его нечем. Отдавать его нельзя — VK
    # ответит невнятной ошибкой 10, а клиенту нужна понятная причина.
    if not obtained and not meta.get("vk_admin_device_id"):
        return None, group_id, ("Токен администратора ВКонтакте устарел — "
                                "переподключите его в настройках канала ВК")
    if not expires_in or time.time() < obtained + expires_in - _REFRESH_MARGIN:
        return token, group_id, None

    return await _refresh(conn, row["id"], group_id)


async def _refresh(conn, channel_id: int, group_id) -> tuple[Optional[str], Optional[int], Optional[str]]:
    async with conn.transaction():
        cur = await conn.fetchval(
            "SELECT platform_meta FROM channels WHERE id = $1 FOR UPDATE", channel_id)
        meta = _meta(cur)
        # Пока ждали блокировку, токен мог обновить другой процесс.
        obtained = int(meta.get("vk_admin_token_obtained_at") or 0)
        expires_in = int(meta.get("vk_admin_token_expires_in") or 0)
        if obtained and expires_in and time.time() < obtained + expires_in - _REFRESH_MARGIN:
            return meta.get("vk_admin_user_token"), group_id, None

        refresh_token = meta.get("vk_admin_refresh_token")
        device_id = meta.get("vk_admin_device_id")
        if not refresh_token or not device_id:
            return None, group_id, ("Токен администратора ВКонтакте просрочен — "
                                    "переподключите его в настройках канала ВК")
        try:
            async with httpx.AsyncClient(timeout=20) as cli:
                r = await cli.post("https://id.vk.com/oauth2/auth", data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": settings.vk_oauth_standalone_app_id,
                    "device_id": device_id,
                    "state": secrets.token_urlsafe(16),
                })
                data = r.json()
        except Exception as e:
            logger.warning(f"VK admin token refresh (channel {channel_id}) упал: {e}")
            return None, group_id, "Не удалось обновить токен администратора ВКонтакте"
        if not data.get("access_token"):
            logger.warning(f"VK admin token refresh (channel {channel_id}) отказ: {data}")
            return None, group_id, ("Токен администратора ВКонтакте просрочен — "
                                    "переподключите его в настройках канала ВК")
        meta["vk_admin_user_token"] = data["access_token"]
        meta["vk_admin_refresh_token"] = data.get("refresh_token") or refresh_token
        meta["vk_admin_token_expires_in"] = int(data.get("expires_in") or 3600)
        meta["vk_admin_token_obtained_at"] = int(time.time())
        await conn.execute(
            "UPDATE channels SET platform_meta = $1::jsonb WHERE id = $2",
            json.dumps(meta), channel_id)
        return data["access_token"], group_id, None
