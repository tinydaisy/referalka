"""Сборка тела письма рассылки — одна точка на боевую отправку и на тест.

Зачем отдельный модуль. Тестовая отправка письма («Отправить тест») собирала
тело сама и очень примитивно: `text.replace("\\n", "<br>")`. В результате в
тестовое письмо НЕ попадали ни фото, ни обложка видео, ни кнопка — клиент
видел «в Telegram картинка пришла, а на почту нет» и не мог проверить вёрстку
до боевой рассылки (жалоба 2026-08-14). Боевая рассылка всё это умела, но её
код жил внутри цикла отправки в Celery, и переиспользовать его было нечем.

⚠️ Фото встраивается INLINE по Content-ID, а не ссылкой на R2:
    1) письмо автономно — файл в R2 может быть удалён, картинка останется;
    2) Gmail не блокирует inline-картинки так, как remote;
    3) Outlook/Apple Mail показывают их без «Show images».
Поэтому функция возвращает не только HTML, но и `inline_images` — его
обязательно передать в `EmailSender.send(inline_images=...)`, иначе
`<img src="cid:...">` останется битой ссылкой.

⚠️ Видео в письме не проигрывается (почтовики режут <video>) — вместо него
кликабельная обложка (первый кадр) со ссылкой на видео.
"""

from __future__ import annotations

import logging
import re as _re
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)

# Content-ID inline-вложений. Именно на них ссылается собранный HTML.
IMAGE_CID = "broadcast_image"
VIDEO_COVER_CID = "broadcast_video_cover"

# ⚠️ Gmail ОБРЕЗАЕТ письмо тяжелее ~102 КБ: хвост прячется под «Показать
# полное сообщение», а в ящике это выглядит как разорванное на куски письмо
# с пустыми плашками и «•••» (жалоба 2026-08-14, рассылка #2571 весила 131 КБ).
#
# ⚠️ Картинка внутри письма занимает НЕ свой вес с диска: MIME кодирует её
# base64, и она распухает примерно на треть (+~37% с учётом переносов строк).
# Прежний порог 90 КБ считал вес файла и потому не спасал: 87,6 КБ на диске
# превращались в ~120 КБ в письме, и Gmail всё равно резал.
#
# Поэтому целимся в ИТОГОВЫЙ вес письма и от него считаем назад:
#   65 КБ файла × 1.37 ≈ 89 КБ в письме + HTML/подвал ≈ 95 КБ < 102 КБ.
BASE64_OVERHEAD = 1.37
MAX_EMAIL_BYTES = 102_000          # порог обрезки у Gmail
MAX_IMAGE_FILE_BYTES = 65_000      # столько картинка весит НА ДИСКЕ
MAX_IMAGE_DIMENSION = 1000         # больше для письма смысла не имеет


@dataclass
class EmailBody:
    """Готовое тело письма: HTML, plain-fallback и inline-вложения."""

    html: str
    text: str
    inline_images: list[dict] = field(default_factory=list)


def strip_html(s: str) -> str:
    """HTML-теги → пусто, с минимальной заменой HTML-entities."""
    s = _re.sub(r"<br\s*/?>", "\n", s or "", flags=_re.IGNORECASE)
    s = _re.sub(r"</p\s*>", "\n\n", s, flags=_re.IGNORECASE)
    s = _re.sub(r"</li\s*>", "\n", s, flags=_re.IGNORECASE)
    s = _re.sub(r"<[^>]+>", "", s)
    return (s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
             .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))


def _linkify(t: str) -> str:
    """Голый URL → <a href>. Только там, где рядом нет разметки."""
    return _re.sub(
        r"(?<![\"'>=])(https?://[^\s<]+)",
        r'<a href="\1" style="color:#3D8CB6;text-decoration:underline;">\1</a>',
        t,
    )


def _html_button(label: str, url: str) -> str:
    safe_label = (label or "Открыть").replace("<", "&lt;").replace(">", "&gt;")
    safe_url = (url or "#").replace('"', "")
    return (
        f'<div style="margin:28px 0;">'
        f'<a href="{safe_url}" target="_blank" rel="noopener" '
        f'style="display:inline-block;background-color:#FFCFA4;color:#25455D !important;'
        f'padding:14px 36px;border-radius:12px;text-decoration:none;'
        f'font-family:Roboto,-apple-system,sans-serif;font-size:16px;font-weight:700;'
        f'line-height:1;">{safe_label}</a>'
        f'</div>'
    )


async def fetch_inline_photo(photo_url: str) -> tuple[bytes | None, str]:
    """Скачивает фото и при необходимости ужимает его для inline-вложения.

    ⚠️ Сжимаем до `MAX_IMAGE_FILE_BYTES` — с оглядкой на base64 (см. константы
    выше): в письме картинка весит на треть больше, чем на диске, а письмо
    тяжелее ~102 КБ Gmail обрезает и показывает кусками.

    ⚠️ PNG/GIF пережимаем в JPEG, только если они не влезают: их base64 так же
    раздувается, а прозрачность в письме на светлой плашке не нужна. Раньше их
    не трогали вовсе — тяжёлый PNG гарантированно рвал письмо.
    """
    try:
        async with httpx.AsyncClient(timeout=15.0) as fetcher:
            resp = await fetcher.get(photo_url)
    except Exception as e:
        logger.warning("Email: не смог скачать фото %s: %s", photo_url, e)
        return None, "jpeg"

    if resp.status_code != 200:
        logger.warning(
            "Email: фото %s вернуло HTTP %s — вложить не выйдет, оставим ссылкой",
            photo_url, resp.status_code,
        )
        return None, "jpeg"

    data = resp.content
    ct = (resp.headers.get("content-type") or "").lower()
    if "png" in ct:
        subtype = "png"
    elif "gif" in ct:
        subtype = "gif"
    elif "webp" in ct:
        subtype = "webp"
    else:
        subtype = "jpeg"

    if len(data) > MAX_IMAGE_FILE_BYTES:
        try:
            import io as _io

            from PIL import Image

            with Image.open(_io.BytesIO(data)) as im:
                im = im.convert("RGB")
                w, h = im.size
                if max(w, h) > MAX_IMAGE_DIMENSION:
                    scale = MAX_IMAGE_DIMENSION / max(w, h)
                    im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

                # ⚠️ Уменьшаем не только качество, но и РАЗМЕР. Раньше падало
                # только качество (до q=55) — у крупной картинки этого не
                # хватало, она оставалась за порогом и рвала письмо.
                best: bytes | None = None
                for scale in (1.0, 0.8, 0.65, 0.5):
                    frame = im
                    if scale < 1.0:
                        frame = im.resize(
                            (max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                            Image.LANCZOS,
                        )
                    for q in (78, 70, 62, 55):
                        buf = _io.BytesIO()
                        frame.save(buf, format="JPEG", quality=q, optimize=True, progressive=True)
                        best = buf.getvalue()
                        if len(best) <= MAX_IMAGE_FILE_BYTES:
                            break
                    if best and len(best) <= MAX_IMAGE_FILE_BYTES:
                        break

                if best:
                    data = best
                    subtype = "jpeg"
                    logger.info(
                        "Email: фото сжато до %s байт (~%s КБ в письме)",
                        len(data), int(len(data) * BASE64_OVERHEAD / 1024),
                    )
        except Exception as e:
            logger.warning("Email: ресайз фото не удался (%s) — шлём как есть", e)

    # Даже после сжатия картинка может не влезть (например, PIL недоступен).
    # Вкладывать её тогда нельзя: письмо порвёт Gmail. Отдаём None — вызывающий
    # покажет картинку прямой ссылкой, письмо останется целым.
    if len(data) * BASE64_OVERHEAD > MAX_EMAIL_BYTES - 12_000:
        logger.warning(
            "Email: фото %s весит %s байт даже после сжатия — вкладывать нельзя "
            "(письмо порвёт Gmail), оставляем ссылкой",
            photo_url, len(data),
        )
        return None, subtype

    return data, subtype


async def fetch_video_cover(video_url: str) -> bytes | None:
    """Первый кадр видео как обложка письма (ffmpeg через video_meta)."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as vf:
            vresp = await vf.get(video_url)
        if vresp.status_code == 200:
            from app.services.video_meta import extract_thumbnail

            return await extract_thumbnail(vresp.content)
    except Exception as e:
        logger.warning("Email: не смог получить обложку видео %s: %s", video_url, e)
    return None


async def build_email_body(
    *,
    text: str,
    photo_url: str | None = None,
    video_url: str | None = None,
    media_type: str | None = None,
    button_text: str | None = None,
    button_url: str | None = None,
    buttons: list | None = None,
) -> EmailBody:
    """Собирает HTML-письмо (фото + обложка видео + текст + кнопки) и plain-fallback.

    Возвращает `EmailBody`; `inline_images` передавать в `EmailSender.send`.
    """
    raw_text = text or ""
    is_video_email = bool(media_type == "video" and video_url)

    # ── Текст ──
    if _re.search(r"<[a-zA-Z][^>]*>", raw_text):
        html_inner = _linkify(raw_text.replace("\n", "<br>\n"))
    else:
        escaped = (raw_text
                   .replace("&", "&amp;")
                   .replace("<", "&lt;")
                   .replace(">", "&gt;")
                   .replace("\n", "<br>\n"))
        html_inner = _linkify(escaped)

    inline_images: list[dict] = []

    # ── Фото ──
    html_image = ""
    if photo_url:
        data, subtype = await fetch_inline_photo(photo_url)
        if data:
            inline_images.append({"content_id": IMAGE_CID, "data": data, "subtype": subtype})
            src = f"cid:{IMAGE_CID}"
        else:
            # Скачать не вышло — остаётся прямая ссылка (может не показаться
            # без «загрузить картинки», но лучше, чем пустое место).
            src = photo_url
        html_image = (
            f'<div style="margin-bottom:20px;">'
            f'<img src="{src}" alt="" '
            f'style="display:block;max-width:100%;width:600px;height:auto;'
            f'border-radius:12px;border:0;outline:none;"/>'
            f'</div>'
        )

    # ── Видео: кликабельная обложка ──
    html_video_cover = ""
    if is_video_email:
        cover = await fetch_video_cover(video_url)
        if cover:
            inline_images.append({"content_id": VIDEO_COVER_CID, "data": cover, "subtype": "jpeg"})
            html_video_cover = (
                f'<a href="{video_url}" target="_blank" rel="noopener" '
                f'style="display:block;position:relative;margin-bottom:20px;text-decoration:none;">'
                f'<img src="cid:{VIDEO_COVER_CID}" alt="Смотреть видео" '
                f'style="display:block;max-width:100%;width:600px;height:auto;'
                f'border-radius:12px;border:0;outline:none;"/>'
                f'<span style="position:absolute;top:50%;left:50%;'
                f'transform:translate(-50%,-50%);background:rgba(37,69,93,0.85);'
                f'color:#FFCFA4;width:64px;height:64px;border-radius:50%;'
                f'font-size:28px;line-height:64px;text-align:center;">&#9658;</span>'
                f'</a>'
                f'<div style="margin:-8px 0 20px;">'
                f'<a href="{video_url}" target="_blank" rel="noopener" '
                f'style="color:#3D8CB6;text-decoration:underline;font-size:14px;">▶ Смотреть видео</a>'
                f'</div>'
            )
        else:
            html_video_cover = (
                f'<div style="margin-bottom:20px;">'
                f'<a href="{video_url}" target="_blank" rel="noopener" '
                f'style="display:inline-block;background-color:#25455D;color:#FFCFA4 !important;'
                f'padding:14px 28px;border-radius:12px;text-decoration:none;'
                f'font-family:Roboto,sans-serif;font-size:16px;font-weight:700;">▶ Смотреть видео</a>'
                f'</div>'
            )

    # ── Кнопки ──
    html_button = ""
    if button_text and button_url:
        html_button = _html_button(button_text, button_url)
    elif buttons:
        html_button = "".join(
            _html_button((b.get("text") or b.get("label") or "Открыть"), b.get("url", ""))
            for b in buttons
        )

    # Голубая плашка #E8F2FA — фирменный стиль писем ПЛЮСОНа.
    #
    # ⚠️ «Три точки» в Gmail она НЕ вызывает — это проверено 2026-08-14 отдельным
    # письмом без плашки: точки остались и без неё. Настоящая причина была в
    # ПОВТОРАХ: несколько писем подряд с одинаковой темой и телом Gmail склеивает
    # в цепочку и прячет совпадающий кусок под «показать цитируемый текст».
    # У боевых рассылок тема и текст всегда разные — там этого не происходит.
    #
    # ⚠️ А вот что письмо рвёт по-настоящему — ВЕС: тяжелее ~102 КБ Gmail
    # обрезает. За этим следят константы выше (MAX_EMAIL_BYTES и сжатие фото).
    html = (
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '</head><body style="margin:0;padding:20px;background:#ffffff;">'
        f'<div style="font-family:Roboto,-apple-system,BlinkMacSystemFont,sans-serif;'
        f'font-size:15px;line-height:1.55;color:#25455D;max-width:640px;margin:0 auto;">'
        f'<div style="background:#E8F2FA;padding:30px 24px;border-radius:16px;">'
        f'{html_image}'
        f'{html_video_cover}'
        f'<div>{html_inner}</div>'
        f'{html_button}'
        f'</div>'
        f'</div></body></html>'
    )

    # Plain-часть — для клиентов без HTML.
    body_text = strip_html(raw_text)
    if is_video_email:
        body_text = body_text.rstrip() + f"\n\n▶ Смотреть видео: {video_url}"
    if button_text and button_url:
        body_text = body_text.rstrip() + f"\n\n{button_text}: {button_url}"
    elif buttons:
        body_text = body_text.rstrip() + "\n\n" + "\n".join(
            f"{(b.get('text') or b.get('label') or 'Открыть')}: {b.get('url','')}"
            for b in buttons
        )

    return EmailBody(html=html, text=body_text, inline_images=inline_images)
