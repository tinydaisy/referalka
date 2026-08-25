"""
Клиент VK API для отправки сообщений и работы с сообществом.

Аналог `bot/main.py` (Telegram), но через HTTP-вызовы VK API. Используется сервисом
event_welcome и tasks/broadcast для рассылок участникам в личку от сообщества.

Документация: https://dev.vk.com/ru/method/messages.send
"""
from __future__ import annotations

import json
import logging
import random
from typing import Any, Iterable

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

VK_API_VERSION = "5.199"
VK_API_BASE = "https://api.vk.com/method"


class VkApiError(RuntimeError):
    """Ошибка VK API с кодом. `code` — error_code из ответа VK (например 901)."""

    def __init__(self, method: str, code: int | None, msg: str | None):
        self.code = code
        self.msg = msg or ""
        super().__init__(f"VK API {method} error {code}: {msg}")


# Коды ошибок messages.send, означающие что писать этому пользователю НЕЛЬЗЯ
# (он не разрешил сообществу ЛС / отозвал разрешение / удалил аккаунт / заблокировал).
# При них получателя надо пометить отписанным, чтобы не мусорил в каждой рассылке.
# https://dev.vk.com/ru/reference/errors
VK_CANT_MESSAGE_CODES = {
    901,  # Can't send messages to this user due to their privacy settings (не разрешил ЛС)
    902,  # Can't send messages to this user due to their privacy settings (приватность)
    7,    # Permission denied
    15,   # Access denied (часто — удалённый/заблокированный аккаунт)
}


async def vk_call(method: str, params: dict[str, Any], *, token: str | None = None) -> dict[str, Any]:
    """Низкоуровневый вызов VK API. Возвращает поле `response`.

    Кидает VkApiError (с полем .code) если VK вернул `error`.
    """
    token = token or settings.vk_system_group_token
    if not token:
        raise RuntimeError("VK_SYSTEM_GROUP_TOKEN not set")
    payload = {**params, "access_token": token, "v": VK_API_VERSION}
    async with httpx.AsyncClient(timeout=15.0) as cli:
        r = await cli.post(f"{VK_API_BASE}/{method}", data=payload)
    data = r.json()
    if "error" in data:
        err = data["error"]
        raise VkApiError(method, err.get("error_code"), err.get("error_msg"))
    return data.get("response", {})


async def send_message(
    user_vk_id: int,
    text: str,
    *,
    token: str | None = None,
    keyboard: dict | None = None,
    attachment: str | None = None,
    return_error: bool = False,
) -> int | None | tuple[int | None, int | None, str]:
    """Отправить личное сообщение от сообщества пользователю с vk_id.

    Если в `text` пришёл HTML/Telegram-форматированный текст (теги `<b>`,
    `<a href>`, `<br>` и т.п.) — конвертируем в чистый текст через
    `html_to_vk_text`. VK API форматирование вообще не поддерживает,
    без конвертации теги уходят дословно.

    :param keyboard: VK keyboard JSON dict (см. https://dev.vk.com/ru/api/bots/development/keyboard)
    :param attachment: строка типа `photo123_456` для прикрепления медиа
    :param return_error: если True — вернуть кортеж (message_id|None, error_code|None, error_msg)
        вместо просто message_id. Нужно рассылкам, чтобы при коде 901 пометить
        получателя отписанным и записать понятную причину.
    :return: message_id или None если упало (либо кортеж при return_error=True)
    """
    from .message_builder import html_to_vk_text
    safe_text = html_to_vk_text(text) if text else ""
    params: dict[str, Any] = {
        "user_id": user_vk_id,
        "message": safe_text,
        "random_id": random.randint(1, 2**31 - 1),
        # ⚠️ ПРЕВЬЮ ССЫЛОК ВЫКЛЮЧЕНО (1 = не разворачивать). В сообщениях со
        # списком каналов и в меню события ВКонтакте разворачивал карточку
        # первой ссылки — она занимала пол-экрана, остальные строки уезжали
        # вниз, и человек не видел, на что ещё надо подписаться.
        "dont_parse_links": 1,
    }
    if keyboard:
        params["keyboard"] = json.dumps(keyboard, ensure_ascii=False)
    if attachment:
        params["attachment"] = attachment
    try:
        resp = await vk_call("messages.send", params, token=token)
        if isinstance(resp, int):
            mid = resp
        else:
            mid = resp.get("message_id") if isinstance(resp, dict) else None
        return (mid, None, "") if return_error else mid
    except VkApiError as e:
        logger.warning(f"VK send_message failed for user={user_vk_id}: {e}")
        return (None, e.code, e.msg) if return_error else None
    except RuntimeError as e:
        logger.warning(f"VK send_message failed for user={user_vk_id}: {e}")
        return (None, None, str(e)) if return_error else None


def tg_inline_to_vk_keyboard(buttons: list[list[dict]]) -> dict:
    """Конвертер Telegram inline-кнопок в VK keyboard.

    Telegram: [[{"text": "X", "url": "https://..."}], ...]  или
              [[{"text": "X", "callback_data": "..."}], ...]
    VK: {"inline": true, "buttons": [[{"action": {"type": "open_link", "link": "...", "label": "X"}}]]}
    """
    vk_rows = []
    for row in buttons:
        vk_row = []
        for btn in row:
            label = btn.get("text", "")
            if "url" in btn:
                vk_row.append({"action": {"type": "open_link", "link": btn["url"], "label": label}})
            elif "callback_data" in btn:
                # Без color: у inline-клавиатуры VK всё равно игнорирует цвет, а
                # явный primary делал callback-кнопки контрастно-синими рядом с
                # белыми url-ссылками. Убрали — все кнопки одинаково нейтральные.
                vk_row.append({
                    "action": {
                        "type": "callback",
                        "payload": json.dumps({"cb": btn["callback_data"]}, ensure_ascii=False),
                        "label": label,
                    },
                })
            else:
                vk_row.append({"action": {"type": "text", "label": label}})
        if vk_row:
            vk_rows.append(vk_row)
    return {"inline": True, "buttons": vk_rows}


async def get_user_info(vk_id: int, fields: Iterable[str] = ("first_name", "last_name", "screen_name")) -> dict[str, Any] | None:
    """Получить базовую инфу о пользователе VK по id."""
    try:
        resp = await vk_call("users.get", {"user_ids": vk_id, "fields": ",".join(fields)})
        if isinstance(resp, list) and resp:
            return resp[0]
    except RuntimeError as e:
        logger.warning(f"VK get_user_info failed for {vk_id}: {e}")
    return None


async def get_users_bulk(vk_ids: list[str], *, token: str | None = None) -> dict[str, str]:
    """Короткие адреса (ники) пачкой: {vk_id: screen_name}.

    ⚠️ ВКонтакте отдаёт до 1000 человек ОДНИМ запросом — в отличие от Telegram,
    где ник спрашивается по одному на каждого. На базе в десять тысяч это
    десяток запросов вместо десяти тысяч.

    Ника может не быть вовсе: у кого не задан короткий адрес, VK возвращает
    `idNNN` — такое не берём, это не ник, а тот же id другими буквами.
    """
    out: dict[str, str] = {}
    for i in range(0, len(vk_ids), 1000):
        chunk = [str(x) for x in vk_ids[i:i + 1000]]
        try:
            resp = await vk_call("users.get",
                                 {"user_ids": ",".join(chunk), "fields": "screen_name"},
                                 token=token)
        except Exception as e:
            logger.warning("VK users.get bulk failed (%s шт): %s", len(chunk), e)
            continue
        for u in (resp or []):
            uid = str(u.get("id") or "")
            nick = (u.get("screen_name") or "").strip()
            if uid and nick and not nick.lower().startswith("id"):
                out[uid] = nick
    return out


async def upload_photo_to_messages(
    image_url: str, *, peer_id: int | None = None, token: str
) -> str | None:
    """Загружает фото из URL в VK и возвращает attachment-строку `photo{owner_id}_{id}`
    для использования в messages.send. Возвращает None если все 3 попытки провалились.

    Делает **3 попытки** с экспоненциальной задержкой (1с, 2с, 4с) для каждого
    из 4 этапов (getMessagesUploadServer, download, upload, saveMessagesPhoto)
    с понятным логированием. Если хотя бы один шаг проваливается на всех 3
    попытках — возвращает None, и caller сам решает что делать (fallback на
    URL в тексте — но это хуже превью). Такое поведение требует правило в
    памяти: «никогда не отвечать что это сетевая флуктуация — добавлять retry».

    Если `peer_id` не задан — фото грузится без привязки к конкретному диалогу,
    один и тот же attachment можно прислать многим получателям (для рассылок).
    """
    import asyncio as _asyncio

    async def _retry(label: str, coro_factory, attempts: int = 3):
        last_err: Exception | None = None
        for i in range(attempts):
            try:
                return await coro_factory()
            except Exception as e:
                last_err = e
                delay = 2 ** i  # 1с, 2с, 4с
                logger.warning(
                    f"VK upload step '{label}' попытка {i+1}/{attempts} failed: {e}. "
                    f"Ждём {delay}с перед повтором."
                )
                if i + 1 < attempts:
                    await _asyncio.sleep(delay)
        if last_err:
            logger.warning(f"VK upload step '{label}' исчерпал все {attempts} попытки: {last_err}")
        return None

    # Шаг 1: получить upload-сервер
    async def _get_server():
        srv_params = {"peer_id": peer_id} if peer_id is not None else {}
        srv = await vk_call("photos.getMessagesUploadServer", srv_params, token=token)
        upload_url = (srv or {}).get("upload_url")
        if not upload_url:
            raise RuntimeError("photos.getMessagesUploadServer вернул пусто (нет upload_url)")
        return upload_url

    upload_url = await _retry("getMessagesUploadServer", _get_server)
    if not upload_url:
        return None

    # Шаг 2: скачать картинку из R2 / любого URL
    async def _download():
        async with httpx.AsyncClient(timeout=30.0) as cli:
            r = await cli.get(image_url)
            r.raise_for_status()
            return r.content, r.headers.get("content-type", "image/jpeg")

    download_res = await _retry("download_image", _download)
    if not download_res:
        return None
    content, content_type = download_res

    # Шаг 3: залить на VK upload-сервер
    async def _upload():
        async with httpx.AsyncClient(timeout=60.0) as cli:
            up = await cli.post(upload_url, files={"photo": ("photo.jpg", content, content_type)})
            up_data = up.json()
        if not up_data.get("photo"):
            raise RuntimeError(f"VK upload вернул пустой photo: {up_data!r}")
        return up_data

    up_data = await _retry("upload_to_vk", _upload)
    if not up_data:
        return None

    # Шаг 4: сохранить → получить attachment-строку
    async def _save():
        saved = await vk_call("photos.saveMessagesPhoto", {
            "server": up_data["server"],
            "photo": up_data["photo"],
            "hash": up_data["hash"],
        }, token=token)
        if not (isinstance(saved, list) and saved):
            raise RuntimeError(f"photos.saveMessagesPhoto вернул не-список: {saved!r}")
        return saved[0]

    saved_photo = await _retry("saveMessagesPhoto", _save)
    if not saved_photo:
        return None

    return f"photo{saved_photo['owner_id']}_{saved_photo['id']}"


async def upload_video_via_user_token(
    video_url: str, *, user_token: str, group_id: int | None = None, name: str = "video",
) -> str | None:
    """Нативная загрузка видео через video.save user-токеном (со scope=video).

    Этот путь даёт настоящий video-attachment с инлайн-плеером в чате VK.
    Community-токен такой возможности не имеет — приходится получать токен от
    админа сообщества через OAuth (см. /api/v1/channels/vk/oauth-url и сохранение
    в channels.platform_meta.vk_admin_user_token).

    Шаги:
    1. video.save({name, group_id?, wallpost=0, is_private=0}) → upload_url + owner_id + video_id
    2. POST файла на upload_url multipart полем `video_file`
    3. attachment = video{owner_id}_{video_id}

    Если задан group_id — видео сохраняется в раздел "Видео" сообщества (от имени
    юзера-админа). Иначе — в личный профиль юзера-владельца токена.
    Возвращает None при любой ошибке (caller сделает fallback на doc).
    """
    try:
        save_params: dict[str, Any] = {"name": name, "wallpost": 0, "is_private": 0}
        if group_id:
            save_params["group_id"] = group_id
        save = await vk_call("video.save", save_params, token=user_token)
        if not isinstance(save, dict):
            return None
        upload_url = save.get("upload_url")
        owner_id = save.get("owner_id")
        video_id = save.get("video_id")
        if not upload_url or owner_id is None or video_id is None:
            return None
        async with httpx.AsyncClient(timeout=120.0) as cli:
            r = await cli.get(video_url)
            r.raise_for_status()
            content = r.content
            content_type = r.headers.get("content-type", "video/mp4")
        filename = "video.mp4"
        if "webm" in content_type:
            filename = "video.webm"
        elif "quicktime" in content_type or "mov" in content_type:
            filename = "video.mov"
        async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as cli:
            up = await cli.post(
                upload_url,
                files={"video_file": (filename, content, content_type)},
                headers={"User-Agent": "Mozilla/5.0 (PlussonBot)"},
            )
            up.raise_for_status()
        return f"video{owner_id}_{video_id}"
    except Exception as e:
        logger.warning(f"VK upload_video_via_user_token failed for {video_url}: {e}")
        return None


async def upload_video_to_messages(
    video_url: str, *, peer_id: int | None = None, token: str,
) -> str | None:
    """Загружает видео из URL в VK как ДОКУМЕНТ (через docs.getMessagesUploadServer)
    и возвращает attachment-строку `doc{owner_id}_{id}`. None при любой ошибке.

    Это fallback для случая когда у клиента нет user-токена админа VK (для
    нативного видео используется upload_video_via_user_token). Сообщество без
    user-токена может грузить только через docs.* — VK показывает MP4-документ
    как файл с иконкой загрузки, а не инлайн-плеер.

    Шаги:
    1. docs.getMessagesUploadServer({peer_id?}) → upload_url
    2. POST файла multipart полем `file` → {file: "..."}
    3. docs.save({file}) → {type, doc: {owner_id, id, ...}}
    4. attachment = doc{owner_id}_{id}

    Если `peer_id` не задан — VK загружает «общий» документ без привязки к диалогу,
    тот же attachment можно слать многим получателям (нужно для broadcast).
    """
    try:
        # docs.getMessagesUploadServer требует peer_id для документов в сообщения.
        # Если peer_id не задан — fallback на docs.getWallUploadServer (общая загрузка).
        srv = None
        if peer_id is not None:
            try:
                srv = await vk_call(
                    "docs.getMessagesUploadServer",
                    {"peer_id": peer_id, "type": "doc"},
                    token=token,
                )
            except Exception as e:
                logger.warning(f"docs.getMessagesUploadServer failed: {e}, trying wall server")
        if not isinstance(srv, dict) or not srv.get("upload_url"):
            # Fallback: загрузка как общий документ (без привязки к диалогу)
            srv = await vk_call("docs.getWallUploadServer", {}, token=token)
            if not isinstance(srv, dict):
                return None
        upload_url = srv.get("upload_url")
        if not upload_url:
            return None
        # Скачиваем видео из R2 / любого URL
        async with httpx.AsyncClient(timeout=120.0) as cli:
            r = await cli.get(video_url)
            r.raise_for_status()
            content = r.content
            content_type = r.headers.get("content-type", "video/mp4")
        # Расширение определяет, что VK покажет инлайн-плеер (.mp4/.webm/.mov)
        filename = "video.mp4"
        if "webm" in content_type:
            filename = "video.webm"
        elif "quicktime" in content_type or "mov" in content_type:
            filename = "video.mov"
        # Загружаем на VK upload-сервер. Видео могут быть большими — timeout 5 мин.
        async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as cli:
            up = await cli.post(
                upload_url,
                files={"file": (filename, content, content_type)},
                headers={"User-Agent": "Mozilla/5.0 (PlussonBot)"},
            )
            up.raise_for_status()
            up_data = up.json()
        file_token = up_data.get("file") if isinstance(up_data, dict) else None
        if not file_token:
            logger.warning(f"VK upload_video: upload returned no `file` field: {up_data}")
            return None
        saved = await vk_call("docs.save", {"file": file_token}, token=token)
        # docs.save возвращает либо dict {type: 'doc', doc: {...}}, либо list (старые API)
        doc = None
        if isinstance(saved, dict):
            doc = saved.get("doc") or saved.get("video") or saved.get("audio_message")
        elif isinstance(saved, list) and saved:
            first = saved[0]
            if isinstance(first, dict):
                doc = first
        if not doc or "owner_id" not in doc or "id" not in doc:
            logger.warning(f"VK upload_video: docs.save returned no owner_id/id: {saved}")
            return None
        return f"doc{doc['owner_id']}_{doc['id']}"
    except Exception as e:
        logger.warning(f"VK upload_video_to_messages failed for {video_url}: {e}")
        return None


async def send_message_with_media(
    user_vk_id: int,
    text: str,
    *,
    media_url: str | None = None,
    media_type: str | None = None,
    token: str | None = None,
    keyboard: dict | None = None,
    user_token: str | None = None,
    user_token_group_id: int | None = None,
) -> int | None:
    """Отправить сообщение с опциональным медиа.

    Для photo — загружаем через photos.getMessagesUploadServer (под peer_id
    получателя) community-токеном.

    Для video — иерархия попыток:
    1. Если задан `user_token` (со scope=video) — нативная загрузка через
       video.save, attachment = video{owner_id}_{video_id}. Плеер в чате.
    2. Иначе — docs.getMessagesUploadServer + docs.save community-токеном.
       Файл .mp4 без инлайн-плеера (юзер видит иконку загрузки).
    3. Если и это упало — URL в текст (Open Graph превью).
    """
    attachment = None
    if media_url and token:
        if media_type == "photo":
            attachment = await upload_photo_to_messages(media_url, peer_id=user_vk_id, token=token)
        elif media_type == "video":
            if user_token:
                attachment = await upload_video_via_user_token(
                    media_url, user_token=user_token, group_id=user_token_group_id
                )
            if not attachment:
                attachment = await upload_video_to_messages(
                    media_url, peer_id=user_vk_id, token=token
                )
    if media_url and not attachment:
        # Загрузка не получилась (или тип неподдерживаемый) — fallback на URL.
        text = f"{text}\n\n{media_url}" if text else media_url
    return await send_message(user_vk_id, text, token=token, keyboard=keyboard, attachment=attachment)


async def is_user_member_of_group(group_id: int, vk_id: int, *, token: str | None = None) -> bool | None:
    """Проверить подписан ли пользователь на сообщество. Аналог Telegram getChatMember."""
    try:
        resp = await vk_call("groups.isMember", {"group_id": group_id, "user_id": vk_id}, token=token)
        # resp = 1 / 0
        return bool(resp) if resp is not None else None
    except RuntimeError as e:
        logger.warning(f"VK isMember failed for group={group_id} user={vk_id}: {e}")
        return None
