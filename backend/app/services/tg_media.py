"""Отправка фото в Telegram, которая работает при любом хранилище.

⚠️⚠️ ЗАЧЕМ. Telegram скачивает картинку по ссылке САМ — и хранилище может его
не пустить: наш сервер файл видит, а Telegram получает отказ «failed to get
HTTP URL content». Для человека это выглядит как молчание: ни картинки, ни
текста, ни кнопок.

Так легло всё после переезда хранилища: старые картинки уходили по памяти
Telegram (file_id), а любая новая — уже нет. Лендинги при этом работали:
там картинку грузит браузер человека, ему хранилище отдаёт нормально.

Поэтому: не смог по ссылке — скачиваем сами и отдаём файлом.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

import httpx

log = logging.getLogger(__name__)


async def send_photo(bot_token: str, chat_id, photo_url: str, *,
                     caption: Optional[str] = None,
                     reply_markup: Optional[dict] = None,
                     parse_mode: str = "HTML") -> bool:
    """Отправить фото. Возвращает True при успехе."""
    api = f"https://api.telegram.org/bot{bot_token}/sendPhoto"
    payload: dict = {"chat_id": str(chat_id), "photo": photo_url}
    if caption:
        payload["caption"] = caption
        payload["parse_mode"] = parse_mode
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup

    async with httpx.AsyncClient(timeout=60) as cl:
        try:
            r = await cl.post(api, json=payload)
            data = r.json()
            if data.get("ok"):
                return True
            desc = (data.get("description") or "").lower()
            if "failed to get http url content" not in desc:
                log.warning("sendPhoto отказ: %s", data)
                return False
        except Exception as e:
            log.warning("sendPhoto по ссылке не вышел: %s", e)
            desc = "failed to get http url content"

        # Ссылку Telegram не осилил — скачиваем сами и отдаём файлом.
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as dl:
                fr = await dl.get(photo_url)
            fr.raise_for_status()
            form = {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, dict) else str(v))
                    for k, v in payload.items() if k != "photo"}
            fname = photo_url.rsplit("/", 1)[-1].split("?")[0] or "photo.jpg"
            r2 = await cl.post(
                api, data=form,
                files={"photo": (fname, fr.content,
                                 fr.headers.get("content-type") or "image/jpeg")},
                timeout=180,
            )
            if r2.json().get("ok"):
                log.info("sendPhoto: отправили файлом (ссылку Telegram не осилил)")
                return True
            log.warning("sendPhoto файлом тоже не прошёл: %s", r2.text[:200])
        except Exception as e:
            log.warning("sendPhoto: не смогли скачать и отправить файлом: %s", e)
    return False
