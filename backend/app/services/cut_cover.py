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
                  ec.speaker_topic,
                  e.title AS event_title
             FROM webinar_recording_cuts rc
             LEFT JOIN event_collaborators ec ON ec.id = rc.speaker_ec_id
             LEFT JOIN collaborators c ON c.id = ec.speaker_id
             LEFT JOIN webinar_recordings wr ON wr.id = rc.recording_id
             LEFT JOIN webinar_rooms wrm ON wrm.id = wr.room_id
             LEFT JOIN events e ON e.id = wrm.event_id
            WHERE rc.id = $1""",
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
        "subtitle": row["speaker_topic"] or "",
        "overline": row["event_title"] or "",
        "photo": photo,
    }


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
    except Exception as e:                                      # noqa: BLE001
        _log.warning("обложка нарезки %s не собралась: %s", cut_id, e)
        return None
