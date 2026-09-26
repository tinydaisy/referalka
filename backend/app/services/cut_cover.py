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
    from app.services.event_photo import photo_columns, photo_join

    row = await conn.fetchrow(
        f"""SELECT rc.title AS cut_title,
                  c.name AS first_name, c.last_name,
                  c.photo_url, c.cutout_photo_url,
                  {photo_columns()},
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
             {photo_join()}
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
    # ⚠️ Через ОБЩИЙ `cover_photo` — то же правило, что у обложки по программе
    # дня: два своих порядка выбора разошлись бы, и один путь давал бы вырезку,
    # а другой прямоугольный снимок того же человека.
    photo, crop = cover_photo(dict(row))

    return {
        "title": title,
        "subtitle": row["topic"] or "",
        "overline": row["event_title"] or "",
        "photo": photo,
        **_crop_params(crop),
    }


async def render_speaker_cover(
    conn: asyncpg.Connection, *, client_id: int, ec_id: int, topic: str = "",
    errors: Optional[list[str]] = None,
) -> Optional[bytes]:
    """PNG обложки выступления — по спикеру и теме из программы, БЕЗ записи.

    ⚠️ Отдельная точка входа, а не «нарезка с пустыми полями»: обложку готовят
    ДО эфира, когда никакой записи ещё нет. Рисует тем же `render_cover_png` и
    тем же шаблоном `speaker`, что и обложка нарезки, — иначе картинки,
    собранные двумя путями, выглядели бы по-разному.

    ⚠️⚠️ ПРИЧИНА СБОЯ КОПИТСЯ В `errors` И УХОДИТ КЛИЕНТУ (25.09.2026). Раньше
    сбой глушился в лог, наружу шло голое «не собралось», а кабинет подставлял
    ЕДИНСТВЕННУЮ догадку — «проверьте, заполнены ли имена спикеров». Имена были
    заполнены, падал SQL (`c.cutout_url` — такой колонки нет, она называется
    `cutout_photo_url`), и человек чинил то, что не ломалось. Выдуманная
    причина хуже, чем никакой: она уводит от настоящей.
    """
    from app.services.event_photo import photo_columns, photo_join

    try:
        row = await conn.fetchrow(
            f"""SELECT c.name AS first_name, c.last_name,
                      c.photo_url, c.cutout_photo_url,
                      {photo_columns()},
                      e.title AS event_title
                 FROM event_collaborators ec
                 LEFT JOIN collaborators c ON c.id = ec.speaker_id
                 {photo_join()}
                 LEFT JOIN events e ON e.id = ec.event_id
                WHERE ec.id = $1""",
            ec_id,
        )
        if not row:
            if errors is not None:
                errors.append(f"спикер #{ec_id}: карточка не найдена")
            return None

        from app.services.person_name import display_name

        title = display_name(row["first_name"], row["last_name"]) if row["first_name"] else ""
        if not title:
            if errors is not None:
                errors.append(f"спикер #{ec_id}: не заполнено имя в карточке")
            return None

        photo, crop = cover_photo(dict(row))
        png = await _render_fields(client_id, {
            "title": title,
            "subtitle": topic or "",
            "overline": row["event_title"] or "",
            "photo": photo,
            # ⚠️ Кадр едет вместе с фото: без него точка лица не применялась
            # вовсе, и на обложке лицо оказывалось обрезанным (26.09.2026).
            **_crop_params(crop),
        })
        if not png and errors is not None:
            errors.append(f"{title}: рисовальщик картинки не ответил")
        return png
    except Exception as e:                                      # noqa: BLE001
        _log.warning("обложка спикера %s не собралась: %s", ec_id, e)
        if errors is not None:
            errors.append(f"спикер #{ec_id}: {e}")
        return None


def _crop_params(crop: dict) -> dict:
    """Кадр → параметры адреса страницы отрисовки.

    ⚠️ Только непустые: пустые значения сделали бы адрес длиннее без пользы,
    а у страницы на этот случай свои умолчания (точка 50/50, зум 1).
    """
    out: dict[str, str] = {}
    for k, v in (crop or {}).items():
        if v is None or v == "":
            continue
        out[k] = str(v)
    return out


def cover_photo(row: dict) -> tuple[str, dict]:
    """Фото для обложки и КАДР к нему: (адрес, поля кадра).

    ⚠️⚠️ ВЫРЕЗКА ИЗ ПРОФИЛЯ БЕРЁТСЯ, ДАЖЕ ЕСЛИ ДЛЯ СОБЫТИЯ ВЫБРАНО ДРУГОЕ ФОТО
    (26.09.2026). Здесь стоял `resolve_photo_url(cutout=True)`, и на проде он
    у ВСЕХ ВОСЬМИ спикеров дня возвращал обычный снимок, хотя вырезка была у
    каждого. Почему: вырезка лежит в профиле (`collaborators.cutout_photo_url`),
    а для события выбрано фото из библиотеки (`event_collaborators.photo_id`),
    у которого своей вырезки нет. Общее правило `apply_event_photo` честно
    отдаёт пустую вырезку выбранного фото — подставлять к чужому снимку чужую
    вырезку нельзя, это был бы другой человек в другой позе, — и обложка
    откатывалась на прямоугольное фото. Отсюда и разнобой: у кого квадрат, у
    кого узкая полоса, у кого обрезанное лицо.

    Порядок (сверху вниз, первое сработавшее):
      1. вырезка ВЫБРАННОГО для события фото — со своим кадром;
      2. вырезка из профиля — со СВОИМ кадром (`cutout_photo_focal`), а не с
         кадром выбранного фото: у вырезки своя композиция;
      3. выбранное для события фото — со своим кадром;
      4. профильное фото — со своим.

    ⚠️ Кадр всегда едет ВМЕСТЕ со своим снимком. Взять фото одно, а точку лица
    от другого — гарантированно промахнуться мимо лица; ровно это правило уже
    записано в `event_photo`, здесь оно просто не должно теряться.
    """
    from app.services.event_photo import CROP_FIELDS

    def crop(prefix: str) -> dict:
        return {f: row.get(f"{prefix}{f}") for f in CROP_FIELDS}

    ep_url = row.get("ep_url")
    ep_cutout = row.get("ep_cutout_url")

    # 1. У выбранного фото есть своя вырезка — лучший случай.
    if ep_cutout:
        return ep_cutout, crop("ep_")
    # 2. Вырезка из профиля — со своим кадром.
    if row.get("cutout_photo_url"):
        return row["cutout_photo_url"], crop("")
    # 3-4. Вырезки нет вовсе — обычное фото, выбранное или профильное.
    if ep_url:
        return ep_url, crop("ep_")
    return row.get("photo_url") or "", crop("")


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
    png = await render_cover_png(url)
    return _shrink(png) if png else png


def cover_format(data: bytes) -> tuple[str, str]:
    """(расширение, content_type) готовой обложки — по самим байтам.

    ⚠️ Формат определяем по сигнатуре файла, а не пишем «png» на месте: после
    `_shrink` обложка почти всегда JPEG, и сохранить её под именем `.png` с
    типом `image/png` значило бы отдавать браузеру заведомо неверный тип.
    """
    return ("png", "image/png") if data[:8] == b"\x89PNG\r\n\x1a\n" else ("jpg", "image/jpeg")


def _shrink(png: bytes) -> bytes:
    """Ужать обложку до веса, который принимают там, куда её несут.

    ⚠️⚠️ БЕЗ ЭТОГО ОБЛОЖКА ВЕСИТ ~4.7 МБ (25.09.2026, проверено на проде).
    Headless Chrome отдаёт PNG без сжатия, а `store_bytes` картинки НЕ жмёт —
    жмётся только то, что идёт через `/uploads`. Ровно на этом уже обожглись
    афиши: уезжали по 4 МБ, и мессенджер молча не показывал их при верном
    og:image. У обложки цена ошибки та же: YouTube не принимает превью тяжелее
    2 МБ, и человек узнал бы об этом уже при заливке ролика.

    ⚠️ Размер кадра НЕ трогаем — только вес: обложка видео должна остаться
    1280×720, ужатая до 1200 px по стороне она перестала бы годиться.
    Поэтому не `process_image` (там `material_media` режет до 1200), а JPEG
    того же кадра: прозрачность обложке не нужна — она непрозрачна по всей
    площади, фон шаблона закрывает кадр целиком.
    """
    try:
        import io

        from PIL import Image

        from app.services.image_processor import JPEG_QUALITY

        with Image.open(io.BytesIO(png)) as im:
            out = io.BytesIO()
            im.convert("RGB").save(out, format="JPEG", quality=JPEG_QUALITY,
                                   optimize=True, progressive=True)
        small = out.getvalue()
        # ⚠️ Отдаём меньшее из двух: если JPEG вдруг вышел тяжелее исходника,
        # менять формат незачем.
        return small if len(small) < len(png) else png
    except Exception as e:                                      # noqa: BLE001
        # ⚠️ Сбой сжатия не должен ронять сборку: тяжёлая обложка лучше, чем
        # никакой. Но в лог — громко, иначе вес снова вырастет незаметно.
        _log.warning("обложку не удалось ужать (%s) — отдаю как есть, %d байт",
                     e, len(png))
        return png


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
