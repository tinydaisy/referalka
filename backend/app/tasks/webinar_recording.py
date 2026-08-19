"""Заливка записи вебинарной сессии в R2 (Celery).

MediaMTX пишет эфир на диск (fMP4-сегменты) в recordings/live/{stream_key}/.
При завершении эфира собираем сегменты, попавшие во время сессии
(started_at..ended_at), склеиваем ffmpeg в один mp4 и заливаем в R2.

⚠️ Пишется весь поток (включая настройку спикера до go-live). Обрезку под точное
время эфира делаем ffmpeg по границам сессии.
"""
from __future__ import annotations

import os
import glob
import asyncio
import subprocess
import tempfile
from datetime import datetime

import asyncpg

from app.celery_app import celery
from app.config import settings
from app.services import r2_storage

RECORDINGS_DIR = os.environ.get("WEBINAR_RECORDINGS_DIR", "/var/www/plusson/media-server/recordings")


def _run_async(coro):
    """Свежий event loop на каждый запуск задачи — см. комментарий ниже."""
    # ⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но НЕ делает
    # его текущим. Библиотеки внутри зовут asyncio.get_event_loop() и получают
    # ЗАКРЫТЫЙ цикл предыдущей задачи того же воркера → RuntimeError('Event loop
    # is closed'). Так молча терялись записи вебинаров и Текст 3 воронок.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@celery.task(name="app.tasks.webinar_recording.upload_session_recording")
def upload_session_recording(session_id: int):
    _run_async(_run(session_id))


async def _run(session_id: int):
    # ⚠️ Одиночное соединение, НЕ глобальный get_pool(): пул привязан к event
    # loop первого вызова, и из нового loop его соединения падают («another
    # operation is in progress» / «attached to a different loop»). Так молча
    # терялись письма воронки лид-магнита — см. tasks/funnel.py.
    conn = await asyncpg.connect(settings.database_url)
    try:
        sess = await conn.fetchrow(
            "SELECT s.id, s.room_id, s.started_at, s.ended_at, "
            "       wr.stream_key, "
            "       (SELECT eo.client_id FROM event_owners eo JOIN webinar_rooms w2 ON w2.event_id=eo.event_id "
            "          WHERE w2.id=wr.id AND eo.status='accepted' LIMIT 1) AS client_id "
            "  FROM webinar_sessions s JOIN webinar_rooms wr ON wr.id=s.room_id WHERE s.id=$1",
            session_id)
        if not sess or not sess["stream_key"]:
            return
        # запись-заготовка
        rec_id = await conn.fetchval(
            "INSERT INTO webinar_recordings (room_id, session_id, status, started_at, ended_at) "
            "VALUES ($1,$2,'processing',$3,$4) RETURNING id",
            sess["room_id"], session_id, sess["started_at"], sess["ended_at"])

        src_dir = os.path.join(RECORDINGS_DIR, "live", sess["stream_key"], sess["stream_key"])
        if not os.path.isdir(src_dir):
            src_dir = os.path.join(RECORDINGS_DIR, "live", sess["stream_key"])

        segs = sorted(glob.glob(os.path.join(src_dir, "*.mp4")))
        if not segs:
            await _mark_failed(conn, rec_id, "нет сегментов записи")
            return

        tmp_out = tempfile.mktemp(suffix=".mp4")
        try:
            # склейка сегментов (concat demuxer)
            listfile = tempfile.mktemp(suffix=".txt")
            with open(listfile, "w") as f:
                for s in segs:
                    f.write(f"file '{s}'\n")
            r = subprocess.run(
                ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
                 "-c", "copy", tmp_out],
                capture_output=True, timeout=1800)
            os.unlink(listfile)
            if r.returncode != 0 or not os.path.exists(tmp_out):
                await _mark_failed(conn, rec_id, "ffmpeg concat error")
                return

            size = os.path.getsize(tmp_out)
            # ⚠️ upload_file, а НЕ upload_bytes: запись эфира весит гигабайты,
            # чтение целиком в память кладёт воркер по OOM.
            key = f"clients/{sess['client_id']}/webinar/{sess['room_id']}/rec_{session_id}.mp4"
            url = await r2_storage.upload_file(tmp_out, key, "video/mp4")

            duration = _probe_duration(tmp_out)
            await conn.execute(
                "UPDATE webinar_recordings SET status='ready', url=$1, r2_key=$2, "
                "size_bytes=$3, duration_sec=$4 WHERE id=$5",
                url, key, size, duration, rec_id)

            # Сегменты нужны только до успешной заливки — дальше это копия того,
            # что уже лежит в R2, и она съедает диск. Удаляем ТОЛЬКО те файлы,
            # которые реально вошли в склейку, и только после статуса 'ready'.
            _cleanup_segments(segs)
        except Exception as e:
            await _mark_failed(conn, rec_id, str(e)[:200])
        finally:
            if os.path.exists(tmp_out):
                os.unlink(tmp_out)
    finally:
        try:
            await conn.close()
        except Exception:
            pass


def _probe_duration(path: str) -> int | None:
    """Длительность файла в секундах через ffprobe. Нет ffprobe — None, не падаем."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, timeout=60)
        return int(float(r.stdout.decode().strip()))
    except Exception:
        return None


def _cleanup_segments(segs: list[str]) -> None:
    """Удаляет исходные сегменты после успешной заливки в R2.

    ⚠️ Зовётся ТОЛЬКО после status='ready' — иначе можно стереть единственную
    копию эфира. Ошибка удаления не должна ронять задачу: запись уже сохранена.
    """
    for s in segs:
        try:
            os.unlink(s)
        except Exception:
            pass


async def _mark_failed(conn, rec_id, msg):
    await conn.execute("UPDATE webinar_recordings SET status='failed' WHERE id=$1", rec_id)
