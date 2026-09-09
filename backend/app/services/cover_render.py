"""Обложка → PNG. Рисует тот же Chromium, что печатает лендинги в PDF.

⚠️⚠️ ПОЧЕМУ БРАУЗЕРОМ, А НЕ PILLOW. Обложка — это вёрстка: фирменный шрифт с
кириллицей, длинный заголовок, который надо перенести по словам и уместить в
область, фото с прозрачностью поверх градиента, логотип. На Pillow всё это
пишется руками (перенос строк, метрики шрифта, подгонка кегля) и всё равно
разойдётся с тем, что клиент видит в предпросмотре на экране. Браузер рисует
ровно то же, что показывает предпросмотр, — расхождения нет по построению.

⚠️ Запуск браузера, поиск бинаря, очередь печати и ожидание шрифтов НЕ
дублируются: всё берётся из `landing_pdf`. Здесь отличается один вызов —
`Page.captureScreenshot` вместо `Page.printToPDF`.

⚠️ Печать идёт ПО ОДНОЙ ЗА РАЗ — тем же семафором, что у PDF. На двух ядрах
второй Chrome не успевает поднять отладочный порт: это уже ловили на проде.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import shutil
import subprocess
import tempfile

import websockets

from app.services.landing_pdf import (
    PdfRenderError,
    _Cdp,
    _free_port,
    _wait_devtools,
    _wait_page_ready,
    _LOAD_TIMEOUT_SEC,
    _PRINT_LOCK,
    _PRINT_TIMEOUT_SEC,
    _QUEUE_WAIT_SEC,
    find_chrome,
)

logger = logging.getLogger(__name__)

# Размер обложки. 1280×720 — формат YouTube (16:9) и он же годится под превью
# в списках. ⚠️ Не менять произвольно: на этот размер рассчитана вёрстка
# шаблона, и другое соотношение сломает раскладку.
COVER_W = 1280
COVER_H = 720

# ⚠️ Рисуем в ДВА раза крупнее и отдаём как есть: на ретине и при загрузке в
# YouTube картинка 1280 шириной выглядит мыльной. Вес PNG при этом остаётся
# приемлемым — обложка это плоская графика, а не фотография.
_SCALE = 2


class CoverRenderError(PdfRenderError):
    """Отдельный тип, чтобы сообщение клиенту говорило про обложку, а не PDF."""


async def render_cover_png(url: str) -> bytes:
    """PNG обложки по адресу страницы предпросмотра.

    `url` — полный адрес страницы, которая рисует ОДНУ обложку во весь экран.
    """
    chrome = find_chrome()
    if not chrome:
        raise CoverRenderError(
            "На сервере не установлен браузер для сборки картинки. Напишите в поддержку."
        )

    try:
        await asyncio.wait_for(_PRINT_LOCK.acquire(), timeout=_QUEUE_WAIT_SEC)
    except asyncio.TimeoutError:
        raise CoverRenderError("Сейчас собирается другой файл — попробуйте через минуту.")
    try:
        return await _shot(chrome, url)
    finally:
        _PRINT_LOCK.release()


async def _shot(chrome: str, url: str) -> bytes:
    port = _free_port()
    profile = tempfile.mkdtemp(prefix="lp-cover-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            "--no-sandbox", "--disable-setuid-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-component-update",
            "--disable-sync", "--metrics-recording-only",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            f"--window-size={COVER_W},{COVER_H}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        ws_url = await _wait_devtools(port, proc)
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = _Cdp(ws)

            target = await cdp.call("Target.createTarget", {"url": "about:blank"})
            attached = await cdp.call(
                "Target.attachToTarget",
                {"targetId": target["targetId"], "flatten": True},
            )
            sid = attached["sessionId"]

            await cdp.call("Page.enable", {}, sid)
            # ⚠️ Размер задаётся ЗДЕСЬ, а не флагом запуска: флаг задаёт окно, а
            # снимок делается по вьюпорту. Та же причина, что у печати PDF.
            await cdp.call("Emulation.setDeviceMetricsOverride", {
                "width": COVER_W, "height": COVER_H,
                "deviceScaleFactor": _SCALE, "mobile": False,
            }, sid)

            await cdp.call("Page.navigate", {"url": url}, sid, timeout=_LOAD_TIMEOUT_SEC)
            # Шрифты и фото — без ожидания в картинку попадёт запасной шрифт и
            # пустое место вместо фотографии.
            await _wait_page_ready(cdp, sid)

            result = await cdp.call("Page.captureScreenshot", {
                "format": "png",
                # ⚠️ Снимаем ЯВНУЮ область, а не «весь экран»: страница могла
                # оказаться на пиксель выше или ниже, и края обрезались бы.
                "clip": {
                    "x": 0, "y": 0,
                    "width": COVER_W, "height": COVER_H,
                    "scale": _SCALE,
                },
                # Фон страницы, а не прозрачность: обложка кладётся на видео и
                # в ленты, дырок в ней быть не должно.
                "captureBeyondViewport": True,
            }, sid, timeout=_PRINT_TIMEOUT_SEC)

            data = base64.b64decode(result.get("data") or "")
            if not data:
                raise CoverRenderError("Пустая картинка — попробуйте ещё раз через минуту.")
            return data

    except PdfRenderError:
        raise
    except asyncio.TimeoutError:
        raise CoverRenderError("Страница слишком долго открывалась — попробуйте ещё раз.")
    except Exception as exc:                                    # noqa: BLE001
        logger.exception("cover_render: снимок не удался (%s)", url)
        raise CoverRenderError("Не получилось собрать обложку. Попробуйте ещё раз.") from exc
    finally:
        proc.kill()
        try:
            proc.wait(timeout=10)
        except Exception:                                       # noqa: BLE001
            pass
        shutil.rmtree(profile, ignore_errors=True)
