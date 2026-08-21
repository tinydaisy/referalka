"""Заливка кусков записи эфира ПО ХОДУ трансляции (Celery, раз в минуту).

Зачем. MediaMTX пишет эфир на диск сервера. Раньше всё лежало там до конца
эфира: два часа — это ~2 ГБ, а несколько параллельных эфиров забили бы диск, и
легла бы вся платформа (база, рассылки, кабинет), а не только вебинары.

Теперь: сегмент дописан → залит в хранилище → удалён с диска. На диске в любой
момент один-два куска вместо целого эфира.

⚠️ Писать сразу в хранилище, минуя диск, невозможно: MediaMTX умеет писать
только на файловую систему, а в S3 кладут готовый объект целиком.

⚠️ Заливается только ЗАКОНЧЕННЫЙ сегмент. Признак — файл не менялся последние
SETTLE_SEC секунд. Залить тот, что пишется прямо сейчас, значит получить
обрезанный кусок и дыру в записи.
"""
from __future__ import annotations

import os
import glob
import time
import asyncio
import logging
from datetime import datetime, timezone

import asyncpg

from app.celery_app import celery
from app.config import settings
from app.services import r2_storage

_log = logging.getLogger(__name__)

RECORDINGS_DIR = os.environ.get(
    "WEBINAR_RECORDINGS_DIR", "/var/www/plusson/media-server/recordings"
)

# Сколько секунд файл должен «молчать», чтобы считаться дописанным.
# Сегменты нарезаются по 5 минут; 90 секунд — с запасом на задержку записи и
# при этом достаточно быстро, чтобы диск не копил лишнего.
SETTLE_SEC = 90

# Предохранитель на один заход: чтобы одна задача не заливала полчаса и не
# держала воркера, мешая рассылкам. Не успели — доберём на следующем тике.
MAX_PER_RUN = 40


def _run_async(coro):
    # ⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но НЕ делает
    # его текущим. Библиотеки внутри зовут get_event_loop() и получают ЗАКРЫТЫЙ
    # цикл предыдущей задачи того же воркера → RuntimeError('Event loop is
    # closed'). Так молча терялись записи эфиров и Текст 3 воронок.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@celery.task(name="app.tasks.webinar_chunks.upload_ready_chunks")
def upload_ready_chunks():
    _run_async(_run())


def _seg_started_at(file_name: str) -> datetime | None:
    """Время начала сегмента из его имени: 2026-07-26_07-37-18-075628.mp4.

    Имя задаёт сам MediaMTX (recordPath), это единственный надёжный источник
    порядка кусков: время изменения файла на диске сдвигается при дозаписи.
    """
    base = os.path.basename(file_name).rsplit(".", 1)[0]
    for fmt in ("%Y-%m-%d_%H-%M-%S-%f", "%Y-%m-%d_%H-%M-%S"):
        try:
            # MediaMTX пишет в UTC — приводим явно, иначе склейка перепутает порядок
            return datetime.strptime(base, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


async def _run():
    live_dir = os.path.join(RECORDINGS_DIR, "live")
    if not os.path.isdir(live_dir):
        return

    # ⚠️ Одиночное соединение, НЕ глобальный пул: пул привязан к event loop
    # первого вызова, и из нового loop его соединения падают.
    conn = await asyncpg.connect(settings.database_url)
    try:
        # Какие потоки вообще наши — чтобы не заливать мусор из чужих папок.
        rooms = await conn.fetch(
            """SELECT wr.id AS room_id, wr.stream_key,
                      (SELECT eo.client_id FROM event_owners eo
                        WHERE eo.event_id = wr.event_id AND eo.status = 'accepted'
                        ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id
                 FROM webinar_rooms wr
                WHERE COALESCE(wr.stream_key,'') <> ''"""
        )
        by_key = {r["stream_key"]: r for r in rooms}
        if not by_key:
            return

        now = time.time()
        done = 0

        for stream_key, room in by_key.items():
            if done >= MAX_PER_RUN:
                break
            # MediaMTX кладёт файлы либо в live/{key}/, либо в live/{key}/{key}/
            for src_dir in (
                os.path.join(live_dir, stream_key, stream_key),
                os.path.join(live_dir, stream_key),
            ):
                if not os.path.isdir(src_dir):
                    continue
                for path in sorted(glob.glob(os.path.join(src_dir, "*.mp4"))):
                    if done >= MAX_PER_RUN:
                        break
                    try:
                        st = os.stat(path)
                    except FileNotFoundError:
                        continue
                    # Ещё пишется — не трогаем, иначе кусок уедет обрезанным.
                    if now - st.st_mtime < SETTLE_SEC:
                        continue
                    if st.st_size == 0:
                        os.unlink(path)
                        continue

                    file_name = os.path.basename(path)
                    # Уже заливали? (сторож бегает по кругу)
                    if await conn.fetchval(
                        "SELECT 1 FROM webinar_recording_chunks "
                        " WHERE stream_key=$1 AND file_name=$2",
                        stream_key, file_name,
                    ):
                        # В хранилище есть, на диске — лишний. Убираем.
                        try:
                            os.unlink(path)
                        except OSError:
                            pass
                        continue

                    key = (
                        f"clients/{room['client_id']}/webinar/{room['room_id']}"
                        f"/chunks/{stream_key}/{file_name}"
                    )
                    try:
                        # upload_file (потоком), НЕ upload_bytes: кусок весит
                        # десятки-сотни МБ, чтение в память кладёт воркер.
                        await r2_storage.upload_file(path, key, "video/mp4")
                    except Exception as e:
                        # Сеть моргнула — оставляем файл на диске и пробуем
                        # на следующем тике. Терять кусок нельзя.
                        _log.warning("chunk upload failed %s: %s", file_name, e)
                        continue

                    await conn.execute(
                        """INSERT INTO webinar_recording_chunks
                             (room_id, stream_key, file_name, r2_key, size_bytes,
                              seg_started_at)
                           VALUES ($1,$2,$3,$4,$5,$6)
                           ON CONFLICT (stream_key, file_name) DO NOTHING""",
                        room["room_id"], stream_key, file_name, key,
                        st.st_size, _seg_started_at(file_name),
                    )
                    # ⚠️ Удаляем ТОЛЬКО после успешной заливки И записи в базу:
                    # иначе кусок исчезнет с диска, а найти его будет нечем.
                    try:
                        os.unlink(path)
                    except OSError:
                        pass
                    done += 1

        if done:
            _log.info("webinar chunks uploaded: %s", done)
    finally:
        try:
            await conn.close()
        except Exception:
            pass
