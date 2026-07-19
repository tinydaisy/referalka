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

from app.celery_app import celery
from app.database import get_pool
from app.config import settings
from app.services import r2_storage

RECORDINGS_DIR = os.environ.get("WEBINAR_RECORDINGS_DIR", "/var/www/plusson/media-server/recordings")


@celery.task(name="app.tasks.webinar_recording.upload_session_recording")
def upload_session_recording(session_id: int):
    asyncio.run(_run(session_id))


async def _run(session_id: int):
    pool = await get_pool()
    if not pool:
        return
    async with pool.acquire() as conn:
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
        await _mark_failed(pool, rec_id, "нет сегментов записи")
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
            await _mark_failed(pool, rec_id, "ffmpeg concat error")
            return

        size = os.path.getsize(tmp_out)
        with open(tmp_out, "rb") as f:
            data = f.read()
        key = f"clients/{sess['client_id']}/webinar/{sess['room_id']}/rec_{session_id}.mp4"
        url = await r2_storage.upload_bytes(key, data, "video/mp4")

        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE webinar_recordings SET status='ready', url=$1, r2_key=$2, size_bytes=$3 WHERE id=$4",
                url, key, size, rec_id)
    except Exception as e:
        await _mark_failed(pool, rec_id, str(e)[:200])
    finally:
        if os.path.exists(tmp_out):
            os.unlink(tmp_out)


async def _mark_failed(pool, rec_id, msg):
    async with pool.acquire() as conn:
        await conn.execute("UPDATE webinar_recordings SET status='failed' WHERE id=$1", rec_id)
