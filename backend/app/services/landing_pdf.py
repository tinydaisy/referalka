"""Лендинг в PDF — «мобильная версия» страницы одним файлом.

Зачем. У части людей ссылка не открывается вовсе: корпоративная сеть режет
незнакомые домены, в мессенджере встроенный браузер падает, у кого-то просто
нет интернета в нужный момент. Отправить такому человеку PDF — единственный
способ показать ему лендинг. Поэтому файл должен выглядеть как страница на
телефоне, а не как «распечатка сайта» с обрезанными краями.

⚠️ ШИРИНА — ТЕЛЕФОННАЯ (`_VIEWPORT_WIDTH`), и это главное требование.
Десктопная раскладка в PDF нечитаема: лендинги свёрстаны на широкий экран,
многоколоночные секции ужимаются, шрифт становится мелким. На узком вьюпорте
срабатывают те же медиазапросы, что на телефоне — колонки выстраиваются в
одну, кегль остаётся крупным.

⚠️ Рендерим ЧЕРЕЗ БРАУЗЕР (headless Chrome), а не собираем PDF из данных.
Лендинг — это блоки с темой клиента, шрифтами, градиентами и живыми данными
(спикеры, программа, тарифы). Второй «рендерер в PDF» пришлось бы чинить
параллельно вёрстке при каждой правке блока — и он всё равно расходился бы с
тем, что видит посетитель. Здесь печатается ровно та же страница.

⚠️ Chromium берём тот, что УЖЕ стоит на сервере (кеш puppeteer от wa-bridge) —
`_find_chrome`. Отдельный пакет ради печати не ставим: на 4 ГБ памяти лишний
браузер — это риск, а не удобство.

⚠️ Печать идёт ОДНОЙ ДЛИННОЙ СТРАНИЦЕЙ, а не набором A4. Лендинг — сплошное
полотно: разбей его по высоте A4 — разрывы придутся на середину карточек и
заголовков. Высоту меряем у готовой страницы и печатаем ровно её
(`--print-to-pdf` + заданный размер бумаги).

⚠️ Черновик открывается по `?preview=` — тем же подписанным токеном, что и
кнопка «Посмотреть черновик». Иначе владелец не смог бы получить PDF, пока
не опубликует страницу, а PDF нужен как раз на этапе согласования.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Ширина экрана телефона (iPhone 12/13/14 — 390 CSS-пикселей). Ровно на этой
# ширине лендинг показывает мобильную раскладку.
_VIEWPORT_WIDTH = 390

# Множитель плотности: 2 = «retina». Чем выше, тем чётче текст и картинки в
# файле. Выше 2 не берём — вес растёт кратно, а разницы на экране уже не видно.
_SCALE = 2

# Сколько ждём готовности страницы. Лендинг тянет шрифты, картинки из R2 и
# живые данные; на холодном старте это дольше обычного.
_TIMEOUT_SEC = 120

# Ограничение высоты одной «страницы» PDF. Chrome не печатает бумагу выше
# ~200 дюймов — длинный лендинг режем на несколько кусков такой высоты.
_MAX_PAGE_INCHES = 190.0

# Где искать браузер. Первый существующий и побеждает: сначала кеш puppeteer
# (там он уже есть под wa-bridge), потом системные пути.
_CHROME_CANDIDATES = (
    "/root/.cache/puppeteer/chrome/*/chrome-linux64/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
)


class PdfRenderError(RuntimeError):
    """Не удалось получить PDF — сообщение уже человеческое, для клиента."""


def _find_chrome() -> Optional[str]:
    """Путь к браузеру или None, если его на машине нет."""
    for pattern in _CHROME_CANDIDATES:
        if "*" in pattern:
            # Версия в имени папки меняется при обновлении — берём свежую.
            matches = sorted(Path("/").glob(pattern.lstrip("/")))
            if matches:
                return str(matches[-1])
        elif os.path.exists(pattern):
            return pattern
    return shutil.which("chromium") or shutil.which("google-chrome")


# ⚠️ Стили печати. Их нельзя держать в самой странице: `@media print` там
# пришлось бы поддерживать в вёрстке каждого блока. Здесь — один список того,
# что в файле мешает.
#
#  • липкая шапка и плашка предпросмотра в PDF «залипают» поверх содержимого
#    и закрывают первый экран;
#  • анимации на печати застывают в случайной фазе — карточка могла попасть в
#    файл полупрозрачной;
#  • тени и фоновые градиенты обязаны печататься (`print-color-adjust`), иначе
#    Chrome «оптимизирует» фон в белый и лендинг теряет оформление.
_PRINT_CSS = """
  *, *::before, *::after {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    animation: none !important;
    transition: none !important;
  }
  /* Липкие элементы делаем обычными: в PDF «прилипать» не к чему. */
  [class*="sticky"], [style*="position: sticky"], [style*="position:sticky"] {
    position: static !important;
  }
  /* Плашка предпросмотра — служебная, в файле для клиента ей не место. */
  [data-preview-bar] { display: none !important; }
  /* Мобильное меню-«гамбургер»: в PDF оно не раскрывается, только мешает. */
  [data-mobile-menu] { display: none !important; }
  html, body { width: %(w)dpx !important; margin: 0 !important; }
"""


def _chrome_argv(chrome: str, url: str, out_pdf: str, profile_dir: str,
                 *, page_height_in: float) -> list[str]:
    """Аргументы запуска. Вынесено, чтобы обе печати шли одинаково."""
    return [
        chrome,
        "--headless=new",
        # ⚠️ Без песочницы: процесс работает под root, а root-песочница Chrome
        # не запускается вовсе. Открываем только свои же страницы.
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        # ⚠️ На сервере /dev/shm маленький, и Chrome падает на длинных
        # страницах с картинками. Флаг переводит его на обычный диск.
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--disable-extensions",
        "--no-first-run",
        f"--user-data-dir={profile_dir}",
        f"--window-size={_VIEWPORT_WIDTH},2400",
        # Плотность пикселей: текст и картинки в файле остаются чёткими.
        f"--force-device-scale-factor={_SCALE}",
        # Мобильный User-Agent: часть страниц отдаёт по нему мобильную вёрстку.
        "--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        # Ждём, пока догрузятся шрифты, картинки и данные. Без этого в файл
        # попадала бы страница со «скелетами» вместо содержимого.
        "--virtual-time-budget=25000",
        "--run-all-compositor-stages-before-draw",
        f"--print-to-pdf={out_pdf}",
        "--no-pdf-header-footer",
        # Размер «бумаги» = ширина телефона и посчитанная высота полотна.
        f"--print-to-pdf-paper-width={_VIEWPORT_WIDTH / 96:.4f}",
        f"--print-to-pdf-paper-height={page_height_in:.4f}",
        url,
    ]


async def _run(argv: list[str], timeout: int = _TIMEOUT_SEC) -> tuple[int, str]:
    """Запуск браузера. Возвращает код возврата и хвост вывода для лога."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise PdfRenderError(
            "Страница слишком долго открывалась — попробуйте ещё раз через минуту."
        )
    return proc.returncode, (out or b"").decode("utf-8", "replace")[-1500:]


async def _measure_height_px(chrome: str, url: str, profile_dir: str) -> int:
    """Высота полотна в CSS-пикселях.

    ⚠️ Меряем ОТДЕЛЬНЫМ запуском, а не берём «на глаз»: высота лендинга зависит
    от количества блоков, длины текстов и числа спикеров — у одного клиента
    экран, у другого десять. Печать наугад дала бы либо обрезанный низ, либо
    километр пустоты в конце файла.

    Способ — снимок DOM (`--dump-dom`) после отрисовки: в него попадает уже
    посчитанная браузером высота, которую страница сама пишет в атрибут.
    """
    probe = (
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--hide-scrollbars", "--no-first-run",
        f"--user-data-dir={profile_dir}",
        f"--window-size={_VIEWPORT_WIDTH},2400",
        "--virtual-time-budget=25000",
        "--run-all-compositor-stages-before-draw",
        "--dump-dom",
        url,
    )
    code, out = await _run([chrome, *probe])
    if code != 0 and not out:
        raise PdfRenderError("Не удалось открыть страницу для печати.")

    # Страница ставит высоту в data-атрибут корня (см. `PRINT_HEIGHT_SNIPPET`).
    marker = 'data-lp-height="'
    idx = out.find(marker)
    if idx != -1:
        raw = out[idx + len(marker):idx + len(marker) + 12].split('"')[0]
        try:
            height = int(float(raw))
            if height > 0:
                return height
        except ValueError:
            pass
    # Не смогли измерить — печатаем разумной длиной, лучше так, чем ничего.
    logger.warning("landing_pdf: высота не измерена, печатаем по умолчанию")
    return 4000


async def render_landing_pdf(url: str) -> bytes:
    """PDF мобильной версии страницы по её публичному адресу.

    `url` — полный адрес (домен клиента), при необходимости уже с `?preview=`.
    """
    chrome = _find_chrome()
    if not chrome:
        raise PdfRenderError(
            "На сервере не установлен браузер для печати. Напишите в поддержку."
        )

    # Свой профиль на каждую печать: параллельные запросы не делят один каталог
    # (Chrome на общем профиле просто не стартует вторым процессом).
    with tempfile.TemporaryDirectory(prefix="lp-pdf-") as tmp:
        profile_dir = os.path.join(tmp, "profile")
        out_pdf = os.path.join(tmp, "landing.pdf")

        height_px = await _measure_height_px(chrome, url, profile_dir)
        height_in = height_px / 96.0

        # ⚠️ Очень длинный лендинг Chrome одной «бумагой» не осилит — режем на
        # куски по _MAX_PAGE_INCHES. Разрыв в таком случае неизбежен, но файл
        # получается целым, а не обрезанным.
        page_height_in = min(max(height_in + 0.2, 4.0), _MAX_PAGE_INCHES)

        code, out = await _run(
            _chrome_argv(chrome, url, out_pdf, profile_dir, page_height_in=page_height_in)
        )
        if not os.path.exists(out_pdf) or os.path.getsize(out_pdf) == 0:
            logger.error("landing_pdf: печать не удалась (code=%s): %s", code, out)
            raise PdfRenderError(
                "Не получилось собрать PDF. Проверьте, что страница открывается по ссылке."
            )
        return Path(out_pdf).read_bytes()
