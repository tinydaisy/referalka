"""Афиши спикера НА СОБЫТИЕ — по одной на ориентацию (миграция 492).

У спикера в карточке события ровно три слота: горизонтальный, квадратный,
вертикальный. Как вкладки чатов TG/ВК/MAX — три вкладки, в каждой одна
картинка. Вторая афиша той же ориентации ЗАМЕНЯЕТ первую, а не копится
рядом.

⚠️ Чем это отличается от `collaborator_posters` (старая библиотека коллаба).
Там афиши валились кучей, а ориентация и событие были закодированы СТРОКОЙ в
`label` («iViSiON-9: ТВОЙ РЫЧАГ (square)»). У 66 из 96 афиш прода label пуст —
ориентацию не определить вовсе; переименование события «отвязывало» афиши.
Здесь ориентация — поле с CHECK, событие — внешний ключ.

⚠️ Старую библиотеку НЕ трогаем: на неё завязаны `event_collaborators.poster_id`,
`announcement_poster_ids`, ZIP-выгрузка и кабинет спикера. Потребители
переводятся по одному.
"""
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db

router = APIRouter(prefix="/api/v1/events", tags=["Афиши спикера"])

ORIENTATIONS = ("horizontal", "square", "vertical")

# Человеческие подписи — те же, что в ZIP-выгрузке материалов, чтобы клиент
# видел одни и те же слова в кабинете и в скачанном архиве.
ORIENTATION_RU = {
    "horizontal": "Горизонтальная",
    "square": "Квадратная",
    "vertical": "Вертикальная",
}


class PosterIn(BaseModel):
    url: str
    orientation: str


async def _check_event(db: asyncpg.Connection, event_id: int, client_id: int) -> None:
    """Событие принадлежит клиенту. В коллабе организаторы равноправны —
    EXISTS по всем владельцам, а не «первый владелец»."""
    ok = await db.fetchval(
        """SELECT 1 FROM events e
            WHERE e.id = $1
              AND EXISTS (SELECT 1 FROM event_owners eo
                           WHERE eo.event_id = e.id AND eo.client_id = $2
                             AND eo.status = 'accepted')""",
        event_id, client_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Событие не найдено")


async def _check_speaker(db: asyncpg.Connection, event_id: int, ec_id: int) -> None:
    ok = await db.fetchval(
        "SELECT 1 FROM event_collaborators WHERE id = $1 AND event_id = $2",
        ec_id, event_id,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Спикер не найден в этом событии")


async def fetch_speaker_posters(db: asyncpg.Connection, ec_id: int) -> dict:
    """{orientation: url} для спикера. Пустые слоты отсутствуют в словаре."""
    rows = await db.fetch(
        "SELECT orientation, url FROM event_speaker_posters WHERE ec_id = $1",
        ec_id,
    )
    return {r["orientation"]: r["url"] for r in rows}


async def pick_speaker_poster(db: asyncpg.Connection, ec_id: int) -> Optional[str]:
    """Афиша спикера для РАССЫЛОК — по приоритету владельца (22.09.2026):
    КВАДРАТ → ГОРИЗОНТАЛЬНАЯ → ВЕРТИКАЛЬНАЯ.

    ⚠️ Порядок не случайный: квадрат одинаково хорошо смотрится и в ленте, и
    в превью сообщения, горизонтальная — компромисс, вертикальная занимает
    весь экран и в переписке выглядит навязчиво. Раньше бралась «первая из
    библиотеки» по sort_order — то есть какая попадётся.
    """
    return await db.fetchval(
        """SELECT url FROM event_speaker_posters
            WHERE ec_id = $1
            ORDER BY CASE orientation
                       WHEN 'square'     THEN 1
                       WHEN 'horizontal' THEN 2
                       WHEN 'vertical'   THEN 3
                       ELSE 4 END
            LIMIT 1""",
        ec_id,
    )


@router.get("/{event_id}/speakers/{ec_id}/posters", summary="Афиши спикера по типам")
async def list_speaker_posters(
    event_id: int,
    ec_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event(db, event_id, int(client["sub"]))
    await _check_speaker(db, event_id, ec_id)
    rows = await db.fetch(
        """SELECT orientation, url, source, updated_at
             FROM event_speaker_posters WHERE ec_id = $1""",
        ec_id,
    )
    by_or = {r["orientation"]: dict(r) for r in rows}
    # Отдаём ВСЕ три слота, включая пустые: фронту нужно нарисовать три
    # вкладки независимо от того, что уже загружено.
    return {
        "items": [
            {
                "orientation": o,
                "label": ORIENTATION_RU[o],
                "url": (by_or.get(o) or {}).get("url"),
                "source": (by_or.get(o) or {}).get("source"),
            }
            for o in ORIENTATIONS
        ]
    }


@router.put("/{event_id}/speakers/{ec_id}/posters", summary="Загрузить афишу в слот")
async def set_speaker_poster(
    event_id: int,
    ec_id: int,
    data: PosterIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Кладёт афишу в слот ориентации. Слот занят — ЗАМЕНЯЕТ (одна на тип)."""
    if data.orientation not in ORIENTATIONS:
        raise HTTPException(status_code=400, detail="Неверная ориентация")
    if not (data.url or "").strip():
        raise HTTPException(status_code=400, detail="Пустая ссылка на афишу")
    await _check_event(db, event_id, int(client["sub"]))
    await _check_speaker(db, event_id, ec_id)
    await db.execute(
        """INSERT INTO event_speaker_posters
               (event_id, ec_id, orientation, url, source)
           VALUES ($1, $2, $3, $4, 'manual')
           ON CONFLICT (ec_id, orientation) DO UPDATE
               SET url = EXCLUDED.url,
                   source = 'manual',
                   updated_at = NOW()""",
        event_id, ec_id, data.orientation, data.url.strip(),
    )
    return {"ok": True}


@router.delete("/{event_id}/speakers/{ec_id}/posters/{orientation}",
               summary="Очистить слот афиши")
async def delete_speaker_poster(
    event_id: int,
    ec_id: int,
    orientation: str,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    if orientation not in ORIENTATIONS:
        raise HTTPException(status_code=400, detail="Неверная ориентация")
    await _check_event(db, event_id, int(client["sub"]))
    await _check_speaker(db, event_id, ec_id)
    await db.execute(
        "DELETE FROM event_speaker_posters WHERE ec_id = $1 AND orientation = $2",
        ec_id, orientation,
    )
    return {"ok": True}
