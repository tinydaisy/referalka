"""Лендинг в PDF — «как на телефоне», одним длинным листом.

Зачем. У части людей ссылка не открывается: корпоративная сеть режет незнакомые
домены, встроенный браузер мессенджера падает, интернета может не быть вовсе.
Отправить такому человеку PDF — единственный способ показать ему страницу.
Поэтому файл должен выглядеть как лендинг на телефоне, а не как распечатка
сайта с обрезанными краями.

⚠️ ШИРИНА ТЕЛЕФОННАЯ (`VIEWPORT_WIDTH`) — это суть задачи, а не деталь.
Десктопная раскладка в PDF нечитаема: многоколоночные секции ужимаются, кегль
становится мелким. На узком вьюпорте срабатывают те же медиазапросы, что на
телефоне: колонки выстраиваются в одну, текст остаётся крупным.

⚠️ Рендерим ЧЕРЕЗ БРАУЗЕР, а не собираем PDF из данных. Лендинг — это блоки с
темой клиента, шрифтами, градиентами и живыми данными (спикеры, программа,
тарифы). Второй «рендерер в PDF» пришлось бы чинить параллельно вёрстке при
каждой правке блока, и он всё равно расходился бы с тем, что видит посетитель.
Здесь печатается ровно та же страница.

⚠️ Управление идёт по CDP (протокол отладки Chrome), а НЕ флагами
`--print-to-pdf*`. Проверено на проде: флаги размера бумаги эта сборка Chrome
молча игнорирует — получался Letter 612×792 pt, страница ехала в планшетную
раскладку (карточки в две колонки) и резалась на 14 листов. Через CDP
`Emulation.setDeviceMetricsOverride` + `Page.printToPDF` выходит ровно 390 px
шириной и ОДНИМ листом.

⚠️ Одним длинным листом — намеренно. Лендинг это сплошное полотно: разбей его
по высоте A4 — разрывы придутся на середину карточек и заголовков. Высоту
меряем у готовой страницы и печатаем ровно её.

⚠️ Chromium берём тот, что УЖЕ есть на сервере (кеш puppeteer от wa-bridge).
Отдельный пакет ради печати не ставим: на 4 ГБ памяти лишний браузер — риск.

⚠️ Черновик открывается по `?preview=` — тем же подписанным токеном, что и
кнопка «Посмотреть черновик»: PDF нужен как раз на этапе согласования, до
публикации.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Optional

import httpx
import websockets

logger = logging.getLogger(__name__)

# Ширина экрана телефона (iPhone 12–15 — 390 CSS-пикселей): на ней лендинг
# показывает мобильную раскладку.
VIEWPORT_WIDTH = 390

# Плотность пикселей: 2 = «retina», текст и картинки в файле чёткие. Выше не
# берём — вес растёт кратно, а разницы на экране уже не видно.
_SCALE = 2

# Сколько ждём готовности страницы: шрифты, картинки из R2, живые данные.
_LOAD_TIMEOUT_SEC = 45

# Сколько ждём саму печать: на длинном лендинге Chrome собирает файл не мгновенно.
_PRINT_TIMEOUT_SEC = 120

# ⚠️ Потолок высоты листа. Chrome не печатает бумагу выше ~200 дюймов: попроси
# больше — вернётся ошибка, и клиент не получит ничего. Упёрлись в потолок →
# печатаем несколькими листами (см. `_pdf_params`), это лучше пустоты.
_MAX_SHEET_PX = 18000

# Куда смотреть в поисках браузера. Первый существующий побеждает: сначала кеш
# puppeteer (там он уже стоит под wa-bridge), потом системные пути.
_CHROME_GLOBS = ("/root/.cache/puppeteer/chrome/*/chrome-linux64/chrome",)
_CHROME_PATHS = (
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
)

_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

# ⚠️ Что убираем при печати. Держать это в вёрстке лендинга нельзя: пришлось бы
# поддерживать `@media print` в каждом блоке. Здесь — один список того, что
# мешает именно в файле:
#   • липкая шапка: в PDF её меню не кликается, а кнопка «Зарегистрироваться»
#     и так есть в самом лендинге —-полосой поверх содержимого она только мешает;
#   • плашка предпросмотра — служебная, клиенту в файле не нужна;
#   • анимации застывают в случайной фазе, карточка могла попасть полупрозрачной;
#   • фоны и тени обязаны печататься, иначе Chrome «оптимизирует» их в белый и
#     лендинг теряет всё оформление.
#
# ⚠️⚠️ ШАПКУ ПРЯЧЕМ (`display: none`), а НЕ переводим в `position: static`.
# Проверено на проде: `static` в паре с `backdrop-filter` (а он у шапки есть)
# роняет печать целиком — Chrome отдаёт ПУСТУЮ страницу, один фон, 31 КБ
# вместо 7,7 МБ. При этом DOM не меняется, и по вёрстке причину не видно.
# Рабочие варианты — `display: none` либо `position: relative`; выбран первый:
# в файле полоса меню бесполезна. Не менять на `static` при правках.
_PRINT_CSS = """
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    animation: none !important;
    transition: none !important;
  }
  header[class*="sticky"] { display: none !important; }
  [data-preview-bar] { display: none !important; }
  html, body { margin: 0 !important; }
"""


class PdfRenderError(RuntimeError):
    """Не получилось собрать PDF. Текст уже человеческий — можно показать клиенту."""


def find_chrome() -> Optional[str]:
    """Путь к браузеру или None, если его на машине нет."""
    for pattern in _CHROME_GLOBS:
        matches = sorted(Path("/").glob(pattern.lstrip("/")))
        if matches:
            return str(matches[-1])          # самая свежая версия
    for path in _CHROME_PATHS:
        if os.path.exists(path):
            return path
    return shutil.which("chromium") or shutil.which("google-chrome")


class _Cdp:
    """Тонкий клиент протокола отладки Chrome: отправить команду, дождаться ответа."""

    def __init__(self, ws: Any):
        self._ws = ws
        self._id = 0

    async def call(self, method: str, params: Optional[dict] = None,
                   session_id: Optional[str] = None, timeout: float = 30) -> dict:
        self._id += 1
        msg_id = self._id
        payload: dict = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        await self._ws.send(json.dumps(payload))

        async def _wait() -> dict:
            while True:
                raw = await self._ws.recv()
                data = json.loads(raw)
                # Мимо проходят события браузера — ждём ответ на свой запрос.
                if data.get("id") != msg_id:
                    continue
                if "error" in data:
                    raise PdfRenderError(f"Браузер вернул ошибку: {data['error']}")
                return data.get("result", {})

        return await asyncio.wait_for(_wait(), timeout=timeout)


async def _wait_devtools(port: int) -> str:
    """Дождаться, пока браузер поднимет отладочный порт, и отдать адрес сокета."""
    async with httpx.AsyncClient() as client:
        for _ in range(80):                              # ~40 секунд
            try:
                res = await client.get(f"http://127.0.0.1:{port}/json/version", timeout=2)
                url = res.json().get("webSocketDebuggerUrl")
                if url:
                    return url
            except Exception:
                pass
            await asyncio.sleep(0.5)
    raise PdfRenderError("Браузер не запустился. Напишите в поддержку.")


def _free_port() -> int:
    """Свободный порт под отладку.

    ⚠️ Порт обязан быть свой на каждую печать: фиксированный занят соседним
    процессом, и второй запрос упал бы на ровном месте.
    """
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _pdf_params(height_px: int) -> dict:
    """Размер листа. Высоту режем потолком Chrome, иначе печать вернёт ошибку."""
    sheet_px = min(max(height_px + 4, 400), _MAX_SHEET_PX)
    return {
        "printBackground": True,                 # фоны и градиенты темы
        "paperWidth": VIEWPORT_WIDTH / 96,       # дюймы: CSS-пиксели / 96
        "paperHeight": sheet_px / 96,
        "marginTop": 0, "marginBottom": 0, "marginLeft": 0, "marginRight": 0,
        "preferCSSPageSize": False,
        "scale": 1,
    }


async def render_landing_pdf(url: str) -> bytes:
    """PDF мобильной версии страницы по её публичному адресу.

    `url` — полный адрес на домене клиента, при необходимости уже с `?preview=`.
    """
    chrome = find_chrome()
    if not chrome:
        raise PdfRenderError(
            "На сервере не установлен браузер для печати. Напишите в поддержку."
        )

    port = _free_port()
    # ⚠️ Свой профиль на каждую печать: на общем каталоге второй Chrome просто
    # не стартует, и параллельные запросы били бы друг друга.
    profile = tempfile.mkdtemp(prefix="lp-pdf-")
    proc = subprocess.Popen(
        [
            chrome,
            "--headless=new",
            # Под root песочница не запускается; открываем только свои страницы.
            "--no-sandbox", "--disable-setuid-sandbox",
            "--disable-gpu",
            # На сервере /dev/shm мал — иначе Chrome падает на длинных страницах.
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-component-update",
            "--disable-sync", "--metrics-recording-only",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            f"--window-size={VIEWPORT_WIDTH},2000",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        ws_url = await _wait_devtools(port)
        async with websockets.connect(ws_url, max_size=None) as ws:
            cdp = _Cdp(ws)

            target = await cdp.call("Target.createTarget", {"url": "about:blank"})
            attached = await cdp.call(
                "Target.attachToTarget",
                {"targetId": target["targetId"], "flatten": True},
            )
            sid = attached["sessionId"]

            await cdp.call("Page.enable", {}, sid)
            # ⚠️ Вот это и делает страницу «телефонной» — не флаги запуска.
            await cdp.call("Emulation.setDeviceMetricsOverride", {
                "width": VIEWPORT_WIDTH, "height": 844,
                "deviceScaleFactor": _SCALE, "mobile": True,
            }, sid)
            await cdp.call("Emulation.setUserAgentOverride", {"userAgent": _MOBILE_UA}, sid)

            await cdp.call("Page.navigate", {"url": url}, sid, timeout=_LOAD_TIMEOUT_SEC)

            # Ждём, пока догрузятся шрифты и картинки: без этого в файл попадала
            # бы страница с пустыми местами вместо фото.
            await _wait_page_ready(cdp, sid)

            # Печатные стили — уже после загрузки, чтобы не перебила своя вёрстка.
            await cdp.call("Runtime.evaluate", {
                "expression": (
                    "(() => { const s = document.createElement('style');"
                    f"s.textContent = {json.dumps(_PRINT_CSS)};"
                    "document.head.appendChild(s); })()"
                ),
            }, sid)

            height = await _page_height(cdp, sid)

            result = await cdp.call(
                "Page.printToPDF", _pdf_params(height), sid, timeout=_PRINT_TIMEOUT_SEC,
            )
            data = base64.b64decode(result["data"])
            if not data:
                raise PdfRenderError("Пустой файл — попробуйте ещё раз через минуту.")
            return data

    except PdfRenderError:
        raise
    except asyncio.TimeoutError:
        raise PdfRenderError(
            "Страница слишком долго открывалась — попробуйте ещё раз через минуту."
        )
    except Exception as exc:                                  # noqa: BLE001
        logger.exception("landing_pdf: печать не удалась (%s)", url)
        raise PdfRenderError(
            "Не получилось собрать PDF. Проверьте, что страница открывается по ссылке."
        ) from exc
    finally:
        proc.kill()
        try:
            proc.wait(timeout=10)
        except Exception:                                     # noqa: BLE001
            pass
        shutil.rmtree(profile, ignore_errors=True)


async def _wait_page_ready(cdp: _Cdp, sid: str) -> None:
    """Дождаться отрисовки: DOM готов, шрифты загружены, картинки подтянуты.

    ⚠️ Ждём именно шрифты (`document.fonts.ready`): у лендингов свои семейства,
    и на медленной загрузке текст успевал напечататься запасным шрифтом — файл
    выглядел чужим.
    """
    deadline = asyncio.get_event_loop().time() + _LOAD_TIMEOUT_SEC
    while asyncio.get_event_loop().time() < deadline:
        try:
            res = await cdp.call("Runtime.evaluate", {
                "expression": (
                    "(() => document.readyState === 'complete'"
                    " && (!document.fonts || document.fonts.status === 'loaded'))()"
                ),
                "returnByValue": True,
            }, sid, timeout=10)
            if res.get("result", {}).get("value") is True:
                break
        except Exception:                                     # noqa: BLE001
            pass
        await asyncio.sleep(0.5)

    # Дать время «дорисоваться»: ленивые картинки и последние перестановки блоков.
    await asyncio.sleep(2.5)
    # Прокрутка до конца и обратно — будит отложенную загрузку картинок
    # (`loading="lazy"`): без неё нижние секции печатались пустыми.
    try:
        await cdp.call("Runtime.evaluate", {
            "expression": (
                "(async () => {"
                "  const h = document.documentElement.scrollHeight;"
                "  for (let y = 0; y < h; y += 600) {"
                "    window.scrollTo(0, y);"
                "    await new Promise(r => setTimeout(r, 60));"
                "  }"
                "  window.scrollTo(0, 0);"
                "})()"
            ),
            "awaitPromise": True,
        }, sid, timeout=40)
    except Exception:                                         # noqa: BLE001
        pass
    await asyncio.sleep(1.0)


async def _page_height(cdp: _Cdp, sid: str) -> int:
    """Высота полотна в CSS-пикселях.

    ⚠️ Меряем у готовой страницы, а не задаём числом: высота зависит от числа
    блоков, длины текстов и количества спикеров — у одного клиента экран, у
    другого десять. Печать наугад дала бы обрезанный низ или километр пустоты.
    """
    try:
        res = await cdp.call("Runtime.evaluate", {
            "expression": (
                "Math.ceil(Math.max("
                "  document.body ? document.body.scrollHeight : 0,"
                "  document.documentElement.scrollHeight,"
                "  document.body ? document.body.offsetHeight : 0,"
                "  document.documentElement.offsetHeight))"
            ),
            "returnByValue": True,
        }, sid, timeout=15)
        height = int(res.get("result", {}).get("value") or 0)
        if height > 0:
            return height
    except Exception:                                         # noqa: BLE001
        pass
    logger.warning("landing_pdf: высоту измерить не удалось, печатаем по умолчанию")
    return 4000
