"""
Импорт медиа по внешней облачной ссылке в наш R2.

Зачем: в пакетной загрузке рассылок клиент даёт ссылку на фото в любом
облаке (Google Drive, Я.Диск, Dropbox, прямой URL). Telegram/VK/MAX не
открывают «страницу просмотра» (например Google Drive /view), поэтому мы
сами скачиваем файл и перезаливаем в R2 — в рассылку идёт уже наш прямой URL.

Точка входа: import_remote_image_to_r2(client_id, url, kind='broadcast_photo').
Возвращает наш R2-URL. Если ссылка уже на наш R2 — возвращает как есть.
Если скачать не удалось — поднимает ValueError с человекочитаемым текстом.
"""
import re
import httpx
from typing import Optional

from app.config import settings
from app.services.r2_storage import build_key, upload_bytes, key_from_url


_CT_EXT = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}

# Максимальный размер фото, которое тянем по ссылке (защита от гигантских файлов).
_MAX_BYTES = 20 * 1024 * 1024  # 20 МБ


def normalize_cloud_url(url: str) -> str:
    """Превращает «страницу просмотра» облака в прямую ссылку на файл.

    Поддержано:
    - Google Drive: .../file/d/<ID>/view  → uc?export=download&id=<ID>
                    open?id=<ID>          → uc?export=download&id=<ID>
    - Яндекс.Диск / Dropbox / прямые URL — возвращаются как есть
      (Я.Диск публичные ссылки на download надо давать сразу прямыми).
    """
    u = (url or "").strip()
    if not u:
        return u

    # Google Drive
    m = re.search(r"drive\.google\.com/file/d/([a-zA-Z0-9_-]+)", u)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    m = re.search(r"drive\.google\.com/open\?id=([a-zA-Z0-9_-]+)", u)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    m = re.search(r"drive\.google\.com/uc\?(?:.*&)?id=([a-zA-Z0-9_-]+)", u)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"

    # Dropbox: ?dl=0 → ?dl=1 (прямая отдача)
    if "dropbox.com" in u:
        if "dl=0" in u:
            return u.replace("dl=0", "dl=1")
        if "dl=1" not in u and "raw=1" not in u:
            sep = "&" if "?" in u else "?"
            return f"{u}{sep}dl=1"

    return u


def _is_our_r2(url: str) -> bool:
    pub = (settings.cf_r2_public_url or "").rstrip("/")
    return bool(pub) and url.strip().startswith(pub + "/")


async def import_remote_image_to_r2(
    client_id: int,
    url: str,
    *,
    kind: str = "broadcast_photo",
) -> str:
    """Скачивает изображение по внешней ссылке и кладёт в R2. Возвращает наш URL.

    - Уже наш R2-URL → возвращаем без изменений.
    - Пусто → пусто.
    - Ошибка скачивания / не картинка → ValueError с понятным текстом.
    """
    u = (url or "").strip()
    if not u:
        return u
    if _is_our_r2(u):
        return u

    direct = normalize_cloud_url(u)
    try:
        async with httpx.AsyncClient(timeout=40, follow_redirects=True) as http:
            r = await http.get(direct, headers={"User-Agent": "Mozilla/5.0 (PlusonBot)"})
            r.raise_for_status()
            data = r.content
            content_type = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
    except Exception as e:
        raise ValueError(f"не удалось скачать фото по ссылке ({e.__class__.__name__})")

    if not data:
        raise ValueError("по ссылке пустой файл")
    if len(data) > _MAX_BYTES:
        raise ValueError(f"фото больше {_MAX_BYTES // (1024*1024)} МБ")

    # Google Drive на больших файлах отдаёт HTML-страницу подтверждения, а не файл.
    if content_type.startswith("text/html") or data[:15].lstrip().lower().startswith(b"<!doctype html") or data[:6].lower() == b"<html>":
        raise ValueError("ссылка ведёт на страницу, а не на файл — дайте прямую ссылку на картинку или откройте доступ «всем по ссылке»")

    ext = _CT_EXT.get(content_type)
    if not ext:
        # пробуем по расширению в URL
        tail = direct.split("?")[0].rsplit(".", 1)[-1].lower()
        if tail in ("jpg", "jpeg", "png", "webp", "gif"):
            ext = "jpg" if tail == "jpeg" else tail
            content_type = f"image/{'jpeg' if ext == 'jpg' else ext}"
        else:
            raise ValueError("файл по ссылке не похож на картинку (jpg/png/webp)")

    key = build_key(client_id, kind, ext)
    return await upload_bytes(key, data, content_type or "image/jpeg")
