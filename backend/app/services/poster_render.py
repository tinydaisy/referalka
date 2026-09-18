"""Афиша → PNG. Снимает тот же Chromium, что печатает лендинги и обложки.

⚠️⚠️ ПОЧЕМУ БРАУЗЕРОМ, А НЕ PILLOW И НЕ CANVAS. Афиша — это вёрстка, причём
тяжелее обложки: два десятка фамилий, которые переносятся по словам и обязаны
встать на одном уровне, фирменный шрифт с кириллицей, фото с прозрачностью в
масках, металлический перелив заголовка. На Pillow или canvas всё это пишется
руками (перенос строк, метрики шрифта, подгонка кегля) и ВСЁ РАВНО разойдётся с
тем, что клиент видит в предпросмотре: он правил одно, а скачал другое. Браузер
рисует ровно ту же страницу, что показывает предпросмотр, — расхождения нет по
построению. Тот же довод записан в `cover_render.py`.

⚠️ Запуск браузера, поиск бинаря, очередь печати и ожидание шрифтов НЕ
дублируются: всё берётся из `landing_pdf`, как и в обложках.

⚠️ Печать идёт ПО ОДНОЙ ЗА РАЗ — общим семафором с PDF и обложками. На двух
ядрах второй Chrome не успевает поднять отладочный порт: это уже ловили на проде.

⚠️ Размер полотна ПРИХОДИТ АРГУМЕНТОМ, а не константой (в отличие от обложки):
афиш три вида — горизонтальная, вертикальная и квадратная.
"""

from __future__ import annotations

import asyncio
import base64
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

# Размеры полотна по ориентации. ⚠️ Должны совпадать с `POSTER_SIZE` в
# `web/src/components/posters/PosterCanvas.tsx`: разъедутся — снимок обрежет
# афишу по краю или оставит пустую полосу.
POSTER_SIZES = {
    "horizontal": (1920, 1080),
    "vertical": (1080, 1920),
    "square": (1440, 1440),
}

# ⚠️ Снимаем в ПОЛТОРА раза крупнее заданного полотна: афишу печатают и кладут
# в сторис, где картинку растягивают. Двойной масштаб при 1920×1080 дал бы
# 3840×2160 — это уже десятки мегабайт на фотографиях, и Telegram такое сожмёт
# сам. Полтора — компромисс, проверенный на обложках.
_SCALE = 1.5


class PosterRenderError(PdfRenderError):
    """Отдельный тип, чтобы сообщение клиенту говорило про афишу."""


async def render_poster_png(url: str, orientation: str) -> bytes:
    """PNG афиши по адресу страницы отрисовки."""
    size = POSTER_SIZES.get(orientation)
    if not size:
        raise PosterRenderError(f"Неизвестный вид афиши: {orientation}")

    chrome = find_chrome()
    if not chrome:
        raise PosterRenderError(
            "На сервере не установлен браузер для сборки картинки. Напишите в поддержку."
        )

    try:
        await asyncio.wait_for(_PRINT_LOCK.acquire(), timeout=_QUEUE_WAIT_SEC)
    except asyncio.TimeoutError:
        raise PosterRenderError("Сейчас собирается другой файл — попробуйте через минуту.")
    try:
        return await _shot(chrome, url, *size)
    finally:
        _PRINT_LOCK.release()


async def _shot(chrome: str, url: str, w: int, h: int) -> bytes:
    port = _free_port()
    profile = tempfile.mkdtemp(prefix="lp-poster-")
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
            f"--window-size={w},{h}",
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
                "width": w, "height": h,
                "deviceScaleFactor": _SCALE, "mobile": False,
            }, sid)

            await cdp.call("Page.navigate", {"url": url}, sid, timeout=_LOAD_TIMEOUT_SEC)
            # ⚠️ Ждём шрифты И картинки: на афише фотографий два десятка, и без
            # ожидания в снимок попадут пустые рамки вместо лиц.
            await _wait_page_ready(cdp, sid)

            result = await cdp.call("Page.captureScreenshot", {
                "format": "png",
                # Снимаем ЯВНУЮ область: страница могла оказаться на пиксель
                # выше или ниже, и края обрезались бы.
                "clip": {"x": 0, "y": 0, "width": w, "height": h, "scale": _SCALE},
                "captureBeyondViewport": True,
            }, sid, timeout=_PRINT_TIMEOUT_SEC)

            data = base64.b64decode(result.get("data") or "")
            if not data:
                raise PosterRenderError("Пустая картинка — попробуйте ещё раз через минуту.")
            return data

    except PdfRenderError:
        raise
    except asyncio.TimeoutError:
        raise PosterRenderError("Страница слишком долго открывалась — попробуйте ещё раз.")
    except Exception as exc:                                    # noqa: BLE001
        logger.exception("poster_render: снимок не удался (%s)", url)
        raise PosterRenderError("Не получилось собрать афишу. Попробуйте ещё раз.") from exc
    finally:
        proc.kill()
        try:
            proc.wait(timeout=10)
        except Exception:                                       # noqa: BLE001
            pass
        shutil.rmtree(profile, ignore_errors=True)
