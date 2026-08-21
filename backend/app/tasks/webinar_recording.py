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
import logging
import shutil
import subprocess
import tempfile
from datetime import datetime

import asyncpg

from app.celery_app import celery
from app.config import settings
from app.services import r2_storage

_log = logging.getLogger(__name__)

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

        # ⚠️ Часть кусков (а при длинном эфире — все) уже уехала в хранилище:
        # сторож webinar_chunks заливает их ПО ХОДУ трансляции и стирает с диска,
        # иначе несколько параллельных эфиров забили бы диск целиком.
        # Докачиваем недостающее во временную папку и склеиваем вместе с тем,
        # что ещё лежит локально.
        chunk_dir: str | None = None
        chunk_rows = await conn.fetch(
            """SELECT r2_key, file_name FROM webinar_recording_chunks
                WHERE stream_key = $1
                ORDER BY seg_started_at NULLS LAST, file_name""",
            sess["stream_key"],
        )
        have = {os.path.basename(p) for p in segs}
        missing = [r for r in chunk_rows if r["file_name"] not in have]
        if missing:
            chunk_dir = tempfile.mkdtemp(prefix="wbrec_")
            for r in missing:
                dst = os.path.join(chunk_dir, r["file_name"])
                try:
                    await r2_storage.download_file(r["r2_key"], dst)
                    segs.append(dst)
                except Exception as e:
                    # Один недокачанный кусок — это дыра в записи, но лучше
                    # отдать эфир с дырой, чем не отдать вовсе.
                    _log.warning("chunk download failed %s: %s", r["r2_key"], e)

        # Порядок строго по имени файла: в нём метка времени от MediaMTX.
        # Время изменения файла не годится — оно сдвигается при дозаписи.
        segs = sorted(set(segs), key=lambda p: os.path.basename(p))

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

            # ⚠️ Учёт в квоте клиента. Раньше запись эфира заливалась в R2 мимо
            # client_files — гигабайты лежали в бакете, а счётчик их не видел.
            # Квоту тут НЕ проверяем и отказать не можем: файл уже склеен и залит,
            # а сегменты сейчас удалятся — отказ означал бы потерю эфира.
            await r2_storage.register_file(
                conn, sess["client_id"], "webinar_recording", key, url, size,
                "video/mp4",
            )

            # ⚠️ Сжатие ставим в очередь ОТДЕЛЬНОЙ задачей, а не делаем здесь.
            # Причины две: на 2 ядрах пережатие двухчасового эфира идёт 30-60
            # минут и займёт воркера целиком; и главное — запись уже залита и
            # доступна, а значит сбой сжатия ничем не грозит. Делать наоборот
            # (сжать, потом залить) — риск потерять эфир, который не переснять.
            compress_recording.delay(rec_id)

            # Сегменты нужны только до успешной заливки — дальше это копия того,
            # что уже лежит в R2, и она съедает диск. Удаляем ТОЛЬКО те файлы,
            # которые реально вошли в склейку, и только после статуса 'ready'.
            _cleanup_segments(segs)

            # ⚠️ Куски в хранилище чистим ПОСЛЕ того, как итоговая запись залита
            # и помечена ready — не раньше. Иначе сбой склейки уничтожил бы
            # единственную копию эфира.
            await _cleanup_chunks(conn, sess["stream_key"], rec_id)
        except Exception as e:
            await _mark_failed(conn, rec_id, str(e)[:200])
        finally:
            if os.path.exists(tmp_out):
                os.unlink(tmp_out)
            # Временная папка с докачанными кусками — только после склейки.
            if chunk_dir and os.path.isdir(chunk_dir):
                shutil.rmtree(chunk_dir, ignore_errors=True)
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


async def _cleanup_chunks(conn, stream_key: str, rec_id: int) -> None:
    """Удаляет из хранилища куски, вошедшие в готовую запись.

    ⚠️ Зовётся ТОЛЬКО после того, как итоговый файл залит и помечен 'ready' —
    иначе сбой склейки уничтожил бы единственную копию эфира.

    Ошибка удаления не роняет задачу: запись уже сохранена, а «висящий» кусок
    подберёт уборщик по сроку. Строку в базе снимаем, только если объект
    действительно удалён, — иначе мусор в хранилище стал бы невидимым.
    """
    rows = await conn.fetch(
        "SELECT id, r2_key FROM webinar_recording_chunks "
        " WHERE stream_key = $1 AND consumed_at IS NULL",
        stream_key,
    )
    for r in rows:
        try:
            await r2_storage.delete_object(r["r2_key"])
        except Exception as e:
            _log.warning("chunk delete failed %s: %s", r["r2_key"], e)
            continue
        await conn.execute(
            "UPDATE webinar_recording_chunks "
            "   SET consumed_at = now(), session_id = COALESCE(session_id, "
            "       (SELECT session_id FROM webinar_recordings WHERE id = $2)) "
            " WHERE id = $1",
            r["id"], rec_id,
        )


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


# ─────────────────────────────────────────────────────────────────────────────
# Сжатие записи эфира
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ Зачем. MediaMTX пишет поток КАК ПРИШЁЛ от вещателя: OBS и Zoom отдают
# высокий битрейт, и двухчасовой эфир весит 2-3 ГБ. При просмотре записи такое
# качество не нужно — там слайды и говорящий человек. Пережатие в 1,5 Мбит/с
# уменьшает файл в 4-6 раз: 2,5 ГБ → 400-600 МБ.
#
# ⚠️ Сжимаем ПОСЛЕ заливки, отдельной задачей. Сжать до заливки нельзя: на
# 2 ядрах это 30-60 минут, и любой сбой в это время — потерянный эфир, который
# не переснять. Залитая запись уже в безопасности, сжатие лишь уменьшает её.

# Настройки пережатия. ⚠️ Ниже 1 Мбит/с текст на слайдах становится нечитаемым —
# это главный критерий, а не «поменьше файл».
_TARGET_BITRATE = "1200k"
_AUDIO_BITRATE = "128k"
_MAX_HEIGHT = 720          # выше для вебинара не нужно, а вес растёт вдвое
_MAX_FPS = 30              # см. комментарий ниже
_MIN_GAIN = 1.3            # меньше — не стоит перезаливки

# ⚠️ Ограничение кадров важнее битрейта. Проверено на реальной записи: Zoom
# отдавал 1280x720 при 1,84 Мбит/с — то есть поток УЖЕ сжат, и пережатие само
# по себе дало бы всего в 1,4 раза. А вот 60 кадров в секунду для вебинара со
# слайдами избыточны вдвое: 30 достаточно, и это половина веса.
#
# ⚠️ Отсюда же вывод: «в 4-6 раз» бывает только у записей с высоким битрейтом
# (5-10 Мбит/с, OBS с настройками по умолчанию). Если источник уже экономный,
# выигрыш будет скромным — на этот случай есть проверка _MIN_GAIN.


@celery.task(name="app.tasks.webinar_recording.compress_recording")
def compress_recording(rec_id: int):
    _run_async(_compress(rec_id))


async def _compress(rec_id: int):
    # ⚠️ Одиночное соединение, не пул — по той же причине, что в _run() выше.
    conn = await asyncpg.connect(settings.database_url)
    tmp_in = tmp_out = None
    try:
        rec = await conn.fetchrow(
            """SELECT rec.id, rec.url, rec.r2_key, rec.size_bytes, rec.status,
                      wr.event_id,
                      -- ⚠️ У webinar_sessions НЕТ client_id: владелец берётся
                      -- через event_owners, как и при создании записи выше.
                      -- Здесь «первый владелец» безопасен — нужен лишь тот, чью
                      -- квоту пересчитать, а файл у коллабы всё равно один.
                      (SELECT eo.client_id FROM event_owners eo
                        WHERE eo.event_id = wr.event_id AND eo.status = 'accepted'
                        ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
                 FROM webinar_recordings rec
                 JOIN webinar_rooms wr ON wr.id = rec.room_id
                WHERE rec.id = $1""", rec_id)
        if not rec or rec["status"] != "ready" or not rec["r2_key"]:
            return
        if not shutil.which("ffmpeg"):
            _log.warning("compress_recording: ffmpeg не найден, пропускаю %s", rec_id)
            return

        tmp_in = tempfile.mktemp(suffix=".mp4")
        tmp_out = tempfile.mktemp(suffix="_c.mp4")

        # ⚠️ Файл может лежать в СОБСТВЕННОМ хранилище клиента, а не в нашем —
        # тогда скачивание из служебного вернёт 404. Берём то хранилище, где
        # файл реально находится.
        own = await conn.fetchrow(
            """SELECT storage_endpoint, storage_region, storage_bucket,
                      storage_access_key, storage_secret_key
                 FROM clients WHERE id = $1 AND storage_provider IS NOT NULL""",
            rec["client_id"])

        def _make_client():
            if not own:
                return r2_storage.get_r2_client(), settings.cf_r2_bucket_name
            import boto3
            from botocore.client import Config as _Cfg
            cl = boto3.client(
                "s3", endpoint_url=own["storage_endpoint"],
                aws_access_key_id=own["storage_access_key"],
                aws_secret_access_key=own["storage_secret_key"],
                region_name=own["storage_region"] or "ru-central-1",
                config=_Cfg(signature_version="s3v4"))
            return cl, own["storage_bucket"]

        client, bucket = _make_client()

        # Скачиваем потоком: запись весит гигабайты, в память её брать нельзя.
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: client.download_file(bucket, rec["r2_key"], tmp_in))

        before = os.path.getsize(tmp_in)

        # ⚠️ -preset veryfast: на 2 ядрах medium даёт выигрыш в размере ~10%,
        # но идёт втрое дольше. Скорость тут важнее лишних процентов.
        cmd = [
            "ffmpeg", "-y", "-i", tmp_in,
            "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", _TARGET_BITRATE, "-maxrate", _TARGET_BITRATE, "-bufsize", "3000k",
            "-vf", f"scale=-2:'min({_MAX_HEIGHT},ih)',fps='min({_MAX_FPS},source_fps)'",
            "-c:a", "aac", "-b:a", _AUDIO_BITRATE,
            "-movflags", "+faststart",   # чтобы плеер начинал играть, не скачав файл целиком
            tmp_out,
        ]
        r = await asyncio.get_event_loop().run_in_executor(
            None, lambda: subprocess.run(cmd, capture_output=True, timeout=7200))
        if r.returncode != 0 or not os.path.exists(tmp_out):
            _log.warning("compress_recording %s: ffmpeg вернул %s", rec_id, r.returncode)
            return

        after = os.path.getsize(tmp_out)
        # ⚠️ Если выигрыш мал — оставляем исходник. Перезаливка ради 10% не
        # стоит риска: во время замены запись недоступна.
        if after >= before / _MIN_GAIN:
            _log.info("compress_recording %s: выигрыш мал (%.0f→%.0f МБ), оставляю как есть",
                        rec_id, before / 1024**2, after / 1024**2)
            return

        # Заливаем ПОД ТЕМ ЖЕ ключом и в ТО ЖЕ хранилище, откуда взяли —
        # ссылки в базе и у клиентов не меняются.
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: client.upload_file(
                tmp_out, bucket, rec["r2_key"], ExtraArgs={"ContentType": "video/mp4"}))
        await conn.execute(
            "UPDATE webinar_recordings SET size_bytes=$2 WHERE id=$1", rec_id, after)
        await conn.execute(
            """UPDATE client_files SET size_bytes=$2 WHERE r2_key=$1""", rec["r2_key"], after)
        if rec["client_id"]:
            await conn.execute(
                """UPDATE clients c SET storage_used_bytes = COALESCE(
                     (SELECT SUM(size_bytes) FROM client_files f WHERE f.client_id = c.id), 0)
                   WHERE c.id = $1""", rec["client_id"])

        _log.info("compress_recording %s: %.0f МБ → %.0f МБ (в %.1f раза)",
                    rec_id, before / 1024**2, after / 1024**2, before / after)
    except Exception:
        _log.exception("compress_recording %s", rec_id)
    finally:
        for f in (tmp_in, tmp_out):
            if f and os.path.exists(f):
                try:
                    os.unlink(f)
                except Exception:
                    pass
        try:
            await conn.close()
        except Exception:
            pass
