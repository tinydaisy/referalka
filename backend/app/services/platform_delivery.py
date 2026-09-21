"""ЕДИНАЯ подготовка и отправка сообщения на площадку — для БОЯ и для ТЕСТА.

⚠️⚠️ ГЛАВНОЕ ПРАВИЛО. Тестовая отправка и боевая рассылка обязаны собирать
сообщение ОДНИМ кодом. Различаться должен только список получателей.

**Почему.** Раньше это были две независимые реализации (200 строк в тесте,
343 в бою), и они разъехались по всем пунктам сразу:

| | боевая рассылка | тест (до 2026-08-24) |
|---|---|---|
| фото в MAX | грузилось вложением | шло ГОЛОЙ ССЫЛКОЙ в тексте |
| HTML в MAX | конвертировался | уходил тегами дословно |
| адресат MAX | `recipient_kind='user'` | забыт → `chat.not.found`, тест не доходил НИКОГДА |
| фото в VK | грузилось вложением | шло ссылкой |
| токен VK | сообщества клиента | не передан → уходило от СИСТЕМНОГО сообщества |
| кнопки | все | бралась одна |

Каждый раз чинили одну половину, вторая продолжала врать. Тест перестал
показывать то, что реально приходит людям, то есть перестал быть проверкой.

Здесь живёт то, что ОБЩЕЕ: подготовка вложения (одно на всю рассылку),
клавиатура, конвертация текста под площадку, сама отправка одному человеку.

Снаружи остаётся то, что общим быть не может: выборка аудитории, чёрный
список, фильтры по тегам и оплатам, запись в `broadcast_log`, пометка
отписавшихся.
"""
import logging
import os
import re
import tempfile
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


# ─── Вложение: готовим ОДИН раз на всю отправку ──────────────────────────────

async def prepare_max_photo(photo_url: Optional[str], *, token: str,
                            media_type: Optional[str] = None) -> Optional[dict]:
    """Скачать фото и загрузить в MAX. Возвращает attachment или None.

    ⚠️ Фото в MAX только ВЛОЖЕНИЕМ. Ссылку в текст не вставляем: человек видит
    голый адрес R2 рядом с картинкой — выглядит как спам (и именно так тест
    и слал до 2026-08-24).

    Не удалось загрузить → None, сообщение уйдёт без фото. Терять всё письмо
    из-за картинки нельзя.
    """
    if not photo_url or media_type == "video" or not token:
        return None
    try:
        from app.services.max_api import upload_media as max_upload_media
        async with httpx.AsyncClient(timeout=60.0) as cli:
            img = await cli.get(photo_url)
        if img.status_code != 200 or not img.content:
            logger.warning("MAX: фото не скачалось (%s) — шлём без фото", photo_url[:80])
            return None
        ext = ".jpg"
        low = photo_url.lower()
        for e in (".png", ".jpeg", ".jpg", ".webp"):
            if e in low:
                ext = e
                break
        tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
        try:
            tmp.write(img.content)
            tmp.flush()
            tmp.close()
            return await max_upload_media(tmp.name, token=token, kind="image")
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
    except Exception as e:
        logger.warning("MAX: загрузка фото не удалась (%s): %s", photo_url[:80], e)
        return None


async def prepare_vk_photo(photo_url: Optional[str], *, token: str,
                           media_type: Optional[str] = None) -> Optional[str]:
    """Загрузить фото в VK. Возвращает attachment-строку `photo{owner}_{id}`.

    ⚠️ Тем же токеном, которым потом шлём: иначе owner_id фото чужой и VK
    откажет. Не удалось — None, шлём без фото (голую R2-ссылку в текст НЕ
    вставляем, это выглядит как спам).
    """
    if not photo_url or media_type == "video" or not token:
        return None
    try:
        from app.services.vk_api import upload_photo_to_messages as vk_upload_photo
        return await vk_upload_photo(photo_url, token=token)
    except Exception as e:
        logger.warning("VK: загрузка фото не удалась (%s): %s", photo_url[:80], e)
        return None


# ─── Кнопки ──────────────────────────────────────────────────────────────────

# Нераскрытый плейсхолдер в адресе кнопки: «{signup_link}», «{vip_url}» и т.п.
_UNRESOLVED_PLACEHOLDER = re.compile(r"\{[a-zA-Z_]+\}")


def button_pairs(buttons: Optional[list], button_text: Optional[str],
                 button_url: Optional[str]) -> list[tuple[str, str]]:
    """Собрать ВСЕ кнопки: из списка `buttons` либо одиночную пару.

    ⚠️ Именно все. Тест раньше брал только `button_text`/`button_url` и молча
    терял остальные: в шаблоне их две («Через Телеграм», «Через MAX»), а
    человеку приходила одна.

    ⚠️⚠️ КНОПКА С НЕРАСКРЫТЫМ ПЛЕЙСХОЛДЕРОМ В АДРЕСЕ ВЫБРАСЫВАЕТСЯ
    (21.09.2026, прод). Telegram и ВКонтакте отвергают такую кнопку вместе со
    ВСЕМ сообщением:
        TG — «inline keyboard button URL is invalid»
        VK — «error 911: Keyboard format is invalid: button [0][0] has invalid link»
    Рассылка 2775: в ВК в личку ушло 0 сообщений, в TG отклонено у каждого
    получателя — в адрес кнопки уехал сырой «{signup_link}». Потерять кнопку
    у одной рассылки не страшно, потерять всё сообщение у всей базы — страшно.

    ⚠️ Проверка живёт ЗДЕСЬ, а не в боевой отправке, потому что через эту
    функцию идут ОБА пути — и тест, и бой, и событийные рассылки, и общие.
    В боевой ветке она ловила бы то, что тест продолжал бы показывать
    нормальным: ровно так и вышло — «вчера тестировали, было норм».
    """
    out: list[tuple[str, str]] = []
    if buttons:
        for b in buttons:
            lbl = b.get("text") or b.get("label") or "Открыть"
            url = b.get("url") or ""
            if url:
                out.append((lbl, url))
    elif button_text and button_url:
        out.append((button_text, button_url))
    safe: list[tuple[str, str]] = []
    for lbl, url in out:
        if _UNRESOLVED_PLACEHOLDER.search(url or ""):
            logger.warning(
                f"Кнопка «{lbl}» выброшена: в адресе остался нераскрытый "
                f"плейсхолдер ({url}). Сообщение отправляем без неё — иначе "
                f"Telegram и ВК отклонили бы его целиком.")
            continue
        safe.append((lbl, url))
    return safe


def vk_keyboard(pairs: list[tuple[str, str]]) -> Optional[dict]:
    """VK-клавиатура из пар (текст, ссылка).

    ⚠️ Внешние ссылки (pluson.ru / t.me) идут ОБЫЧНЫМИ кнопками. Раньше их
    писали строкой в текст — считалось, что VK молча отбрасывает такие
    open_link. Проверено живой отправкой 2026-08-24: VK принимает и
    показывает их кнопками, и одну, и несколько.
    """
    if not pairs:
        return None
    from app.services.vk_api import tg_inline_to_vk_keyboard
    return tg_inline_to_vk_keyboard([[{"text": lbl, "url": url}] for lbl, url in pairs])


def max_keyboard(pairs: list[tuple[str, str]]) -> Optional[Any]:
    """MAX-клавиатура из пар (текст, ссылка)."""
    if not pairs:
        return None
    from app.services.max_api import tg_inline_to_max_keyboard
    return tg_inline_to_max_keyboard([[{"text": lbl, "url": url}] for lbl, url in pairs])


# ─── Текст под площадку ──────────────────────────────────────────────────────

def max_text(text: Optional[str], *, video_url: Optional[str] = None,
             media_type: Optional[str] = None) -> str:
    """Текст для MAX.

    ⚠️ MAX понимает inline-HTML (`<b>`/`<i>`/`<a>`) только при
    `parse_mode='html'`, и то не блочный: `<p>`/`<br>`/`<ul>` надо снять
    заранее через html_to_telegram. Без этого теги приходят ДОСЛОВНО — так
    и было в тесте до 2026-08-24.

    Видео в MAX — ссылкой: нативной загрузки из URL там нет.
    """
    from app.services.message_builder import html_to_telegram
    out = html_to_telegram(text or "")
    if media_type == "video" and video_url:
        out = f"{out}\n\n🎬 Видео: {video_url}".strip() if out else video_url
    return out


def vk_text(text: Optional[str], *, video_url: Optional[str] = None,
            media_type: Optional[str] = None, link_fallback: bool = False) -> str:
    """Текст для VK. HTML снимает сам vk_api.send_message (html_to_vk_text).

    Видео добавляем ссылкой, только если нативная загрузка не удалась.
    """
    out = text or ""
    if media_type == "video" and video_url and link_fallback:
        out = f"{out}\n\n🎬 Видео: {video_url}".strip() if out else video_url
    return out


# ─── Отправка ОДНОМУ получателю ──────────────────────────────────────────────

async def send_max(user_id: int, text: str, *, token: str,
                   buttons: Optional[Any] = None,
                   attachment: Optional[dict] = None) -> Optional[dict]:
    """Отправить в MAX одному человеку.

    ⚠️ `recipient_kind='user'` ОБЯЗАТЕЛЕН: у нас на руках id ПРОФИЛЯ, а не
    беседы. По умолчанию функция шлёт через chat_id, и MAX на id профиля
    отвечает 200 + `chat.not.found` — сообщение молча не доходит. Именно
    поэтому тест в MAX не доходил никогда.
    """
    from app.services.max_api import send_message as max_send
    return await max_send(
        user_id, text, token=token, buttons=buttons,
        recipient_kind="user", parse_mode="html",
        attachments=[attachment] if attachment else None,
    )


async def send_vk(user_id: int, text: str, *, token: str,
                  keyboard: Optional[dict] = None,
                  attachment: Optional[str] = None,
                  return_error: bool = False):
    """Отправить во ВКонтакте одному человеку.

    ⚠️ `token` обязателен: без него vk_call подставляет СИСТЕМНОЕ сообщество
    ПЛЮСОНа, и сообщение уходит от чужого имени (а тем, кто на него не
    подписан, — не уходит вовсе). Так вёл себя тест до 2026-08-24.
    """
    from app.services.vk_api import send_message as vk_send
    return await vk_send(user_id, text, token=token, keyboard=keyboard,
                         attachment=attachment, return_error=return_error)
