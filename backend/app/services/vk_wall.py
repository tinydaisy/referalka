"""Пост на СТЕНУ сообщества ВКонтакте от имени сообщества (26.09.2026).

Зачем. Сообщество ВК добавляют в «Личные каналы» так же, как Telegram-канал, —
а рассылка слала туда `messages.send`, как в беседу. Стена не задействовалась
вовсе. Теперь сообщество из базы чатов получает ПОСТ: анонсы — по галочке
«Личные каналы» в рассылке, как у личных Telegram-каналов.

⚠️ `wall.post` от имени сообщества умеет ТОЛЬКО токен человека-администратора
(`from_group=1`). Токен бота сообщества этот метод не принимает. Токен берём
через общую точку `vk_admin_token.get_vk_admin_token` — она же его и обновляет.
Администратор должен быть админом/редактором ИМЕННО того сообщества, куда
постим, а стена сообщества — включена.

⚠️ У поста нет кнопок: ссылки кнопок вызывающий дописывает в текст.
"""
import logging
from typing import Optional

import httpx

from app.services.vk_api import vk_call, upload_video_via_user_token

logger = logging.getLogger(__name__)

# Понятные причины для журнала рассылки — их видит клиент.
_WALL_ERRORS = {
    5: "Токен администратора ВКонтакте недействителен — переподключите его",
    10: "Токен администратора ВКонтакте недействителен — переподключите его",
    15: "Нет доступа к стене: стена сообщества выключена или вы не администратор",
    214: "Публикация на стене запрещена настройками сообщества",
    219: "Реклама на стене сообщества запрещена",
    220: "Слишком много получателей",
    222: "ВКонтакте не разрешил ссылки в посте",
    224: "Слишком много рекламных постов",
}


async def _upload_wall_photo(image_url: str, *, token: str, group_id: int) -> Optional[str]:
    """Фото для поста: getWallUploadServer → загрузка → saveWallPhoto."""
    try:
        srv = await vk_call("photos.getWallUploadServer", {"group_id": group_id}, token=token)
        upload_url = (srv or {}).get("upload_url")
        if not upload_url:
            return None
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as cli:
            img = await cli.get(image_url)
            img.raise_for_status()
            up = await cli.post(upload_url, files={"photo": ("photo.jpg", img.content, "image/jpeg")})
            up.raise_for_status()
            data = up.json()
        saved = await vk_call("photos.saveWallPhoto", {
            "group_id": group_id,
            "photo": data.get("photo"),
            "server": data.get("server"),
            "hash": data.get("hash"),
        }, token=token)
        if isinstance(saved, list) and saved:
            p = saved[0]
            return f"photo{p['owner_id']}_{p['id']}"
    except Exception as e:
        logger.warning(f"VK wall: фото не загрузилось ({image_url}): {e}")
    return None


async def post_to_wall(
    conn, client_id: int, group_id: int, text: str, *,
    photo_url: Optional[str] = None, video_url: Optional[str] = None,
    media_type: Optional[str] = None,
) -> tuple[bool, Optional[str], Optional[str]]:
    """(успех, причина отказа, id поста). Текст — уже без HTML."""
    from app.services.vk_admin_token import get_vk_admin_token
    token, _bot_group, why = await get_vk_admin_token(conn, client_id)
    if not token:
        return False, why, None

    attachments: list[str] = []
    if media_type == "video" and video_url:
        att = await upload_video_via_user_token(video_url, user_token=token, group_id=group_id)
        if att:
            attachments.append(att)
        else:
            # Не загрузилось — пост не теряем, видео уходит ссылкой.
            text = f"{text}\n\n🎬 Видео: {video_url}" if text else video_url
    elif photo_url:
        att = await _upload_wall_photo(photo_url, token=token, group_id=group_id)
        if att:
            attachments.append(att)

    if not (text or attachments):
        return False, "Пустой пост", None
    params = {"owner_id": -abs(int(group_id)), "from_group": 1, "message": text or ""}
    if attachments:
        params["attachments"] = ",".join(attachments)
    try:
        res = await vk_call("wall.post", params, token=token)
    except Exception as e:
        code = getattr(e, "code", None)
        return False, _WALL_ERRORS.get(code, f"ВКонтакте отказал: {e}"), None
    post_id = (res or {}).get("post_id") if isinstance(res, dict) else None
    return bool(post_id), (None if post_id else "ВКонтакте не вернул номер поста"), (
        str(post_id) if post_id else None)
