"""Обложка нарезки выступления — из шаблона «Спикер».

⚠️⚠️ ШАБЛОН НЕ ЗАВОДИТСЯ ОТДЕЛЬНЫЙ. Вид `speaker` в `cover_templates` создан
ровно под это (миграция 387: «обложка нужна записи эфира — её грузят на YouTube
и клеят к видео»). Второй шаблон рядом означал бы, что клиент правит оформление
в двух местах и они расходятся.

⚠️ Рисуется тем же `render_cover_png`, что предпросмотр и скачивание PNG:
отдельный рисовальщик разошёлся бы с тем, что человек видел в конструкторе.

Что подставляется в шаблон:
  title    — имя спикера (если его нет — название нарезки);
  subtitle — тема выступления;
  overline — название события;
  photo    — фото спикера на прозрачном фоне.

⚠️⚠️ ТЕМА — ИЗ СЛОТА ПРОГРАММЫ, а не из `event_collaborators.speaker_topic`
(24.09.2026). То поле помечено в коде «устаревшее, оставлено для
совместимости»: у события 89 оно пустое у 5 спикеров из 18, и их обложки
выходили БЕЗ ТЕМЫ, хотя тема в программе есть. Настоящая тема живёт в
`conf_speaker_topics` и цепляется к слоту через `conf_sessions.topic_id` —
тот же порядок резолва, что на лендинге и в программе дня (conference.py).
Колонка `conf_sessions.title` здесь тоже НЕ ГОДИТСЯ: у большинства слотов
в ней стоит заглушка «Тема будет уточнена позже».
"""

from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import urlencode

import asyncpg

_log = logging.getLogger(__name__)


async def cut_cover_fields(conn: asyncpg.Connection, cut_id: int) -> dict:
    """Что написать на обложке этой нарезки.

    ⚠️ Имя собирается общим `display_name`, а не склейкой на месте: порядок
    «Имя Фамилия» задан одним правилом на весь проект, и своя склейка тут
    разошлась бы с карточками и лендингом.
    """
    row = await conn.fetchrow(
        """SELECT rc.title AS cut_title,
                  c.name AS first_name, c.last_name,
                  c.photo_url, c.cutout_url,
                  COALESCE(
                      NULLIF(btrim(cst.topic), ''),
                      (SELECT NULLIF(btrim(t.topic), '') FROM conf_speaker_topics t
                        WHERE t.cse_id = ec.id ORDER BY t.sort_order, t.id LIMIT 1),
                      NULLIF(btrim(ec.speaker_topic), '')
                  ) AS topic,
                  e.title AS event_title
             FROM webinar_recording_cuts rc
             LEFT JOIN event_collaborators ec ON ec.id = rc.speaker_ec_id
             LEFT JOIN collaborators c ON c.id = ec.speaker_id
             LEFT JOIN webinar_recordings wr ON wr.id = rc.recording_id
             LEFT JOIN webinar_rooms wrm ON wrm.id = wr.room_id
             LEFT JOIN events e ON e.id = wrm.event_id
             LEFT JOIN conf_sessions s ON s.event_id = wrm.event_id
                                      AND s.day = wrm.day_number
                                      AND s.speaker_id = ec.id
             LEFT JOIN conf_speaker_topics cst ON cst.id = s.topic_id
            WHERE rc.id = $1
            ORDER BY NULLIF(s.start_time, '') NULLS LAST, s.sort_order
            LIMIT 1""",
        cut_id,
    )
    if not row:
        return {}

    from app.services.person_name import display_name

    name = display_name(row["first_name"], row["last_name"]) if row["first_name"] else ""
    # ⚠️ Нет карточки спикера — берём название нарезки: обложка без единой
    # надписи хуже, чем обложка с названием куска.
    title = name or (row["cut_title"] or "")

    # ⚠️ Фото на ПРОЗРАЧНОМ фоне (cutout) в приоритете: шаблон кладёт человека
    # поверх фона, и прямоугольное фото выглядело бы наклейкой.
    photo = row["cutout_url"] or row["photo_url"] or ""

    return {
        "title": title,
        "subtitle": row["topic"] or "",
        "overline": row["event_title"] or "",
        "photo": photo,
    }


async def render_speaker_cover(
    conn: asyncpg.Connection, *, client_id: int, ec_id: int, topic: str = "",
) -> Optional[bytes]:
    """PNG обложки выступления — по спикеру и теме из программы, БЕЗ записи.

    ⚠️ Отдельная точка входа, а не «нарезка с пустыми полями»: обложку готовят
    ДО эфира, когда никакой записи ещё нет. Рисует тем же `render_cover_png` и
    тем же шаблоном `speaker`, что и обложка нарезки, — иначе картинки,
    собранные двумя путями, выглядели бы по-разному.
    """
    try:
        row = await conn.fetchrow(
            """SELECT c.name AS first_name, c.last_name,
                      c.photo_url, c.cutout_url,
                      e.title AS event_title
                 FROM event_collaborators ec
                 LEFT JOIN collaborators c ON c.id = ec.speaker_id
                 LEFT JOIN events e ON e.id = ec.event_id
                WHERE ec.id = $1""",
            ec_id,
        )
        if not row:
            return None

        from app.services.person_name import display_name

        title = display_name(row["first_name"], row["last_name"]) if row["first_name"] else ""
        if not title:
            return None

        return await _render_fields(client_id, {
            "title": title,
            "subtitle": topic or "",
            "overline": row["event_title"] or "",
            "photo": row["cutout_url"] or row["photo_url"] or "",
        })
    except Exception as e:                                      # noqa: BLE001
        _log.warning("обложка спикера %s не собралась: %s", ec_id, e)
        return None


async def _render_fields(client_id: int, fields: dict) -> Optional[bytes]:
    """Отрисовка подготовленных полей. Одна точка на оба пути сборки."""
    from app.services.client_domains import platform_base_url
    from app.services.cover_render import render_cover_png
    from app.services.preview_token import make_preview_token

    qs = urlencode({
        "kind": "speaker",
        "t": make_preview_token(client_id),
        **fields,
    })
    url = f"{platform_base_url().rstrip('/')}/cover?{qs}"
    return await render_cover_png(url)


async def render_cut_cover(
    conn: asyncpg.Connection, *, client_id: int, cut_id: int,
) -> Optional[bytes]:
    """PNG обложки нарезки. `None` — если собрать не удалось.

    ⚠️ Возвращает None вместо исключения: обложка — украшение, и её сбой не
    должен ронять саму нарезку. Видео важнее картинки.
    """
    try:
        fields = await cut_cover_fields(conn, cut_id)
        if not fields.get("title"):
            return None
        return await _render_fields(client_id, fields)
    except Exception as e:                                      # noqa: BLE001
        _log.warning("обложка нарезки %s не собралась: %s", cut_id, e)
        return None
