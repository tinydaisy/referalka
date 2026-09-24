"""
Картинка для КАРТОЧКИ ССЫЛКИ в мессенджере — `/api/v1/share-image/event/{slug}`.

Мессенджер, увидев ссылку `pluson.ru/e/{slug}`, идёт за картинкой по адресу из
`og:image`. Раньше туда шла ссылка на сам файл афиши в хранилище — и карточка
оставалась без картинки, если афиша тяжёлая: у Telegram предел превью 5 МБ и
1280 px по стороне, у WhatsApp около 600 КБ. У реального события афиша была
4320×2430 и 4,2 МБ — в чате показывался логотип при полностью верном `og:image`.

⚠️⚠️ ПОЧЕМУ ОТДЕЛЬНЫЙ ЭНДПОИНТ, А НЕ СЖАТИЕ ПРИ СОХРАНЕНИИ (24.09.2026).
Сжимать на входе — правильно, и это сделано (см. `_shot` в event_posters_gen.py).
Но одного этого мало:
  • афиши, уже лежащие в хранилище, так и остаются тяжёлыми — а их не
    перезальёшь за клиента, и просить его «пересобрать» каждую нельзя;
  • мест, где афиша попадает в базу, ПЯТЬ (генератор — три, загрузка через
    /uploads, копирование события), плюс путь `web/src/app/api/upload-poster`,
    который кладёт файл в хранилище вообще без обработки. Залатать все и
    не пропустить следующий — не выйдет.
Поэтому картинка чинится в ОДНОЙ точке — там, где её забирает мессенджер.
Клиенту не нужно ничего пересобирать: работает с любой афишей, откуда бы она
ни взялась и когда бы ни была загружена.

Лёгкий файл (меньше `_PASSTHROUGH_BYTES` и не шире `_MAX_SIDE`) отдаётся
редиректом на хранилище — лишний раз гонять байты через наш сервер незачем.
"""
import io
import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import RedirectResponse
import asyncpg

from app.database import get_db

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/share-image", tags=["Картинка карточки ссылки"])

# Предел стороны у Telegram — 1280 px; берём его же.
_MAX_SIDE = 1280
# Файл легче этого и не шире _MAX_SIDE отдаём как есть, редиректом.
# 600 КБ — ограничение WhatsApp, самое жёсткое из массовых.
_PASSTHROUGH_BYTES = 600 * 1024
# Больше этого не качаем вовсе: превью такой картинки всё равно не будет ни у
# кого, а тянуть десятки мегабайт на каждый запрос мессенджера — нет.
_MAX_SOURCE_BYTES = 30 * 1024 * 1024
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)

# Мессенджер приходит за картинкой при КАЖДОЙ отправке ссылки, а исходная афиша
# меняется редко — час кеша снимает почти всю нагрузку.
_CACHE = "public, max-age=3600, s-maxage=3600"


def _resize(data: bytes) -> Optional[tuple[bytes, str]]:
    """Ужать под предел мессенджера → (байты, content_type). None — не картинка."""
    try:
        from PIL import Image, ImageOps
    except Exception:                                    # pragma: no cover
        log.warning("share-image: Pillow недоступен, отдаём оригинал")
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if max(img.size) > _MAX_SIDE:
            img.thumbnail((_MAX_SIDE, _MAX_SIDE), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        # ⚠️ Всегда JPEG, даже если исходник — PNG с прозрачностью. В карточке
        # прозрачности нет: мессенджер подложит свой фон, чаще всего белый, и
        # PNG здесь только утяжеляет файл. Прозрачное подкладываем на белое
        # сами — иначе оно станет чёрным при конвертации.
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        else:
            img = img.convert("RGB")
        img.save(out, format="JPEG", quality=85, optimize=True, progressive=True)
        return out.getvalue(), "image/jpeg"
    except Exception as e:
        log.warning("share-image: не смогли обработать картинку: %s", e)
        return None


@router.get("/event/{slug}", summary="Картинка карточки ссылки события")
async def event_share_image(slug: str, db: asyncpg.Connection = Depends(get_db)):
    """Афиша события, ужатая под превью мессенджера.

    Афиши нет → 404, и страница `/e/{slug}` в этом случае вообще не ставит
    `og:image` на нас: там остаётся логотип клиента прямой ссылкой.
    """
    # ⚠️ Порядок ориентаций — как в лендинге и в `_SHARE_POSTER_SUBQ`:
    # карточка широкая, горизонтальная афиша ложится в неё без обрезки.
    url = await db.fetchval(
        """SELECT url FROM event_posters
            WHERE event_id = (SELECT id FROM events WHERE slug = $1)
              AND day IS NULL
            ORDER BY CASE orientation
                       WHEN 'horizontal' THEN 1
                       WHEN 'square'     THEN 2
                       WHEN 'vertical'   THEN 3
                       ELSE 4 END, sort, id
            LIMIT 1""",
        slug,
    )
    if not url:
        raise HTTPException(404, detail="У события нет афиши")

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as cl:
            head = await cl.head(url)
            size = int(head.headers.get("content-length") or 0)
            # Лёгкий файл — пусть мессенджер забирает его прямо из хранилища.
            # ⚠️ Размер в пикселях по заголовкам неизвестен, поэтому «лёгкий»
            # считаем только по весу: очень широкую, но лёгкую картинку
            # мессенджер ужмёт сам, а вот тяжёлую — бросит.
            if 0 < size <= _PASSTHROUGH_BYTES:
                return RedirectResponse(url, status_code=302,
                                        headers={"Cache-Control": _CACHE})
            if size > _MAX_SOURCE_BYTES:
                log.warning("share-image: афиша %s слишком велика (%s байт)", slug, size)
                raise HTTPException(404, detail="Афиша слишком велика для превью")

            r = await cl.get(url)
            if r.status_code != 200:
                raise HTTPException(404, detail="Афиша недоступна")
            data = r.content
    except HTTPException:
        raise
    except Exception as e:
        log.warning("share-image: не смогли забрать афишу %s: %s", slug, e)
        raise HTTPException(404, detail="Афиша недоступна")

    processed = _resize(data)
    if not processed:
        # Не смогли обработать — отдаём оригинал редиректом. Мессенджер, может,
        # и не покажет его, но это не хуже, чем отдать ошибку.
        return RedirectResponse(url, status_code=302, headers={"Cache-Control": _CACHE})

    body, ctype = processed
    return Response(content=body, media_type=ctype, headers={"Cache-Control": _CACHE})
