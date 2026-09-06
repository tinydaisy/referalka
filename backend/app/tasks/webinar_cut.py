"""Нарезка записи эфира на куски по спикерам (Celery).

Зачем. Эфир пишется одним файлом: сначала настройка звука до «Начать эфир»,
потом открытие, потом выступления спикеров подряд. Целиком это никому не
отдать — спикеру нужно СВОЁ выступление, покупателю список по именам.

Клиент расставляет границы в редакторе (по программе дня одной кнопкой), затем
жмёт «Нарезать» — сюда приходит список кусков, и каждый вырезается из исходника.

⚠️ Режем БЫСТРЫМ способом (-c copy): ffmpeg копирует поток, не пережимая. Час
эфира на восемь частей — 10-30 секунд. Точная резка с пережатием шла бы 30-60
минут на 2 ядрах и заняла бы процессор целиком, а на нём живут сайт, боты и
рассылки. Плата — граница может уехать на пару секунд до ближайшего опорного
кадра; для выступлений это незаметно.

⚠️ Исходник НЕ удаляем (решение владельца): из кусков целое обратно не собрать,
а нарезать могли криво. Удаление — отдельной кнопкой, руками.
"""
from __future__ import annotations

import os
import asyncio
import logging
import shutil
import subprocess
import tempfile

import asyncpg

from app.celery_app import celery
from app.config import settings
from app.services import r2_storage
# ⚠️ Развилка «своё хранилище или служебное» — ОДНА функция на весь проект:
# копии в задаче и в API успели бы разъехаться.
from app.services.client_storage import storage_for

_log = logging.getLogger(__name__)

# Предел на один кусок. Двухчасовой кусок — это ошибка расстановки меток, а не
# выступление; резать такое значит зря занять воркера на минуты.
_MAX_CUT_SEC = 6 * 3600


def _run_async(coro):
    # ⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но НЕ делает
    # его текущим. Библиотеки внутри зовут asyncio.get_event_loop() и получают
    # ЗАКРЫТЫЙ цикл предыдущей задачи того же воркера → RuntimeError('Event loop
    # is closed'). Так молча терялись записи эфиров и Текст 3 воронок.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@celery.task(name="app.tasks.webinar_cut.cut_recording")
def cut_recording(recording_id: int):
    _run_async(_run(recording_id))


async def _run(recording_id: int):
    # ⚠️ Одиночное соединение, НЕ глобальный пул: пул привязан к event loop
    # первого вызова, и из нового loop его соединения падают.
    conn = await asyncpg.connect(settings.database_url)
    tmp_src = None
    try:
        rec = await conn.fetchrow(
            """SELECT rec.id, rec.r2_key, rec.status, rec.duration_sec,
                      COALESCE(rec.live_offset_sec, 0) AS live_offset,
                      wr.event_id, wr.id AS room_id,
                      (SELECT eo.client_id FROM event_owners eo
                        WHERE eo.event_id = wr.event_id AND eo.status = 'accepted'
                        ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1) AS client_id
                 FROM webinar_recordings rec
                 JOIN webinar_rooms wr ON wr.id = rec.room_id
                WHERE rec.id = $1""", recording_id)
        if not rec or rec["status"] != "ready" or not rec["r2_key"]:
            _log.warning("cut_recording %s: запись не готова", recording_id)
            return

        cuts = await conn.fetch(
            """SELECT id, start_sec, end_sec, title FROM webinar_recording_cuts
                WHERE recording_id = $1 AND status IN ('draft', 'failed')
                ORDER BY sort_order, start_sec""", recording_id)
        if not cuts:
            return

        if not shutil.which("ffmpeg"):
            await _fail_all(conn, [c["id"] for c in cuts], "на сервере нет ffmpeg")
            return

        await conn.execute(
            "UPDATE webinar_recording_cuts SET status='processing', error=NULL, "
            " updated_at=now() WHERE id = ANY($1::int[])", [c["id"] for c in cuts])

        client, bucket, public_base = await storage_for(conn, rec["client_id"])

        # Скачиваем исходник ОДИН раз на все куски: он весит гигабайты, и качать
        # его заново под каждое выступление — это часы сети на ровном месте.
        tmp_src = tempfile.mktemp(suffix="_src.mp4")
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: client.download_file(bucket, rec["r2_key"], tmp_src))

        offset = int(rec["live_offset"] or 0)
        for c in cuts:
            await _cut_one(conn, rec, c, tmp_src, offset, client, bucket, public_base)
    except Exception as e:
        _log.exception("cut_recording %s", recording_id)
        try:
            await conn.execute(
                "UPDATE webinar_recording_cuts SET status='failed', error=$2, "
                " updated_at=now() WHERE recording_id=$1 AND status='processing'",
                recording_id, str(e)[:200])
        except Exception:
            pass
    finally:
        if tmp_src and os.path.exists(tmp_src):
            try:
                os.unlink(tmp_src)
            except Exception:
                pass
        try:
            await conn.close()
        except Exception:
            pass


async def _cut_one(conn, rec, cut, src_path, offset, client, bucket, public_base):
    """Вырезает один кусок и заливает его в то же хранилище, что и исходник."""
    # ⚠️ Метки в базе — секунды ОТ НАЧАЛА ЭФИРА (так их видит клиент на
    # таймлайне). В файле эфир начинается на offset-й секунде: до него лежит
    # настройка звука. Без этого слагаемого каждый кусок уехал бы на величину
    # подготовки — обычно 5-30 минут.
    start = offset + int(cut["start_sec"])
    end = offset + int(cut["end_sec"]) if cut["end_sec"] is not None else None
    length = (end - start) if end is not None else None

    if length is not None and length <= 0:
        await _fail_all(conn, [cut["id"]], "конец куска раньше начала")
        return
    if length is not None and length > _MAX_CUT_SEC:
        await _fail_all(conn, [cut["id"]], "кусок длиннее шести часов — проверьте метки")
        return

    tmp_out = tempfile.mktemp(suffix="_cut.mp4")
    try:
        # ⚠️ -ss ДО -i (быстрый поиск по индексу) + -c copy. Порядок важен:
        # -ss после -i заставляет ffmpeg читать файл с начала до нужной секунды,
        # и на часовой записи это минуты вместо мгновения.
        cmd = ["ffmpeg", "-y", "-ss", str(start), "-i", src_path]
        if length is not None:
            cmd += ["-t", str(length)]
        cmd += [
            "-c", "copy",
            # ⚠️ Без +faststart плеер не начнёт играть, пока не скачает файл
            # целиком: заголовок mp4 иначе оказывается в конце.
            "-movflags", "+faststart",
            # ⚠️ -avoid_negative_ts: при копировании со сдвигом первые кадры
            # получают отрицательные метки времени, и часть плееров показывает
            # чёрный экран первые секунды.
            "-avoid_negative_ts", "make_zero",
            tmp_out,
        ]
        r = await asyncio.get_event_loop().run_in_executor(
            None, lambda: subprocess.run(cmd, capture_output=True, timeout=1800))
        if r.returncode != 0 or not os.path.exists(tmp_out) or os.path.getsize(tmp_out) == 0:
            await _fail_all(conn, [cut["id"]], "ffmpeg не смог вырезать кусок")
            return

        size = os.path.getsize(tmp_out)
        key = f"clients/{rec['client_id']}/webinar/{rec['room_id']}/cut_{cut['id']}.mp4"
        await asyncio.get_event_loop().run_in_executor(
            None, lambda: client.upload_file(
                tmp_out, bucket, key, ExtraArgs={"ContentType": "video/mp4"}))
        url = f"{public_base}/{key}"

        duration = _probe_duration(tmp_out)
        await conn.execute(
            "UPDATE webinar_recording_cuts SET status='ready', url=$2, r2_key=$3, "
            " size_bytes=$4, duration_sec=$5, error=NULL, updated_at=now() WHERE id=$1",
            cut["id"], url, key, size, duration)

        # ⚠️ Учёт в квоте клиента: куски — это гигабайты в хранилище, и без
        # регистрации счётчик их не видит (та же ошибка была у самой записи).
        if rec["client_id"]:
            await r2_storage.register_file(
                conn, rec["client_id"], "webinar_recording", key, url, size,
                "video/mp4", event_id=rec["event_id"])
    except Exception as e:
        _log.exception("cut %s", cut["id"])
        await _fail_all(conn, [cut["id"]], str(e)[:200])
    finally:
        if os.path.exists(tmp_out):
            try:
                os.unlink(tmp_out)
            except Exception:
                pass


def _probe_duration(path: str) -> int | None:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, timeout=60)
        return int(float(r.stdout.decode().strip()))
    except Exception:
        return None


async def _fail_all(conn, ids: list[int], msg: str) -> None:
    await conn.execute(
        "UPDATE webinar_recording_cuts SET status='failed', error=$2, updated_at=now() "
        " WHERE id = ANY($1::int[])", ids, msg[:200])
