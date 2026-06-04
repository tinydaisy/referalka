"""
Извлечение метаданных видео и кадра-обложки через ffprobe/ffmpeg.

Зачем: при отправке видео в Telegram через sendVideo нужно передать
width/height (иначе Telegram показывает квадратное окно, ломая пропорции)
и thumbnail (иначе у видео нет обложки-постера).

ffprobe/ffmpeg должны быть установлены на сервере. Если их нет или они упали —
функции возвращают None и отправка идёт без размеров/обложки (graceful degrade,
рассылка не падает).
"""
import asyncio
import json
import logging
import shutil
import tempfile
import os

logger = logging.getLogger(__name__)


def _has_ffmpeg() -> bool:
    return bool(shutil.which("ffprobe")) and bool(shutil.which("ffmpeg"))


async def probe_dimensions(video_bytes: bytes) -> tuple[int, int, int] | None:
    """Возвращает (width, height, duration_sec) или None.

    Пишем байты во временный файл (ffprobe по stdin не всегда корректно читает
    moov-атом, если он в конце файла), запускаем ffprobe, парсим JSON.
    """
    if not _has_ffmpeg():
        return None
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(video_bytes)
            tmp_path = f.name
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height:format=duration",
            "-of", "json", tmp_path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        data = json.loads(out.decode("utf-8") or "{}")
        streams = data.get("streams") or []
        if not streams:
            return None
        w = int(streams[0].get("width") or 0)
        h = int(streams[0].get("height") or 0)
        dur = 0
        try:
            dur = int(float((data.get("format") or {}).get("duration") or 0))
        except (TypeError, ValueError):
            dur = 0
        if w <= 0 or h <= 0:
            return None
        return w, h, dur
    except Exception as e:
        logger.warning(f"probe_dimensions failed: {e}")
        return None
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


async def extract_thumbnail(video_bytes: bytes) -> bytes | None:
    """Вырезает кадр-обложку (JPEG) примерно с 1-й секунды. None при неудаче.

    Telegram thumbnail: JPEG, ≤ 320px по большей стороне, ≤ 200 КБ.
    """
    if not _has_ffmpeg():
        return None
    in_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(video_bytes)
            in_path = f.name
        out_path = in_path + ".thumb.jpg"
        # -ss 00:00:01 — кадр с 1-й секунды (для коротких видео ffmpeg возьмёт
        # ближайший доступный); scale до 320px по ширине с сохранением пропорций.
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-ss", "00:00:01", "-i", in_path,
            "-frames:v", "1",
            "-vf", "scale='min(320,iw)':-2",
            "-q:v", "5",
            out_path,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(proc.communicate(), timeout=30)
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            # Видео короче 1с — пробуем самый первый кадр.
            proc2 = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-i", in_path,
                "-frames:v", "1",
                "-vf", "scale='min(320,iw)':-2",
                "-q:v", "5",
                out_path,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc2.communicate(), timeout=30)
        if os.path.exists(out_path) and 0 < os.path.getsize(out_path) <= 200 * 1024:
            with open(out_path, "rb") as fh:
                return fh.read()
        return None
    except Exception as e:
        logger.warning(f"extract_thumbnail failed: {e}")
        return None
    finally:
        for p in (in_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass
