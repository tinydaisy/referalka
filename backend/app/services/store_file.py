"""Сохранение готовых байтов в хранилище клиента — одна точка на всех.

⚠️⚠️ ЛОГИКА КВОТЫ И ПОНЯТНЫХ ОШИБОК ЖИВЁТ ЗДЕСЬ, А НЕ КОПИЯМИ ПО МОДУЛЯМ.
Раньше она была только внутри `POST /uploads` (загрузка файла человеком), и всё,
что рождает файл САМО (обложка из конструктора, обложка видео, будущие
генераторы), либо дублировало бы сотню строк, либо писало бы в хранилище мимо
учёта — и место у клиента кончалось бы незаметно для него самого.

⚠️ Своя квота действует только на НАШЕ хранилище: подключил своё в Cloud.ru —
место у него своё, ограничивать нашим лимитом неверно.

⚠️ Ошибки хранилища переводятся на человеческий здесь же. Клиенту нужно знать,
ЧТО случилось и куда идти («кончилось место в Cloud.ru», «ключ больше не
работает»), а не видеть техническую ошибку S3.
"""

from __future__ import annotations

import logging
from typing import Optional

import asyncpg
from fastapi import HTTPException

from app.services import r2_storage

logger = logging.getLogger(__name__)


def human_bytes(n: int) -> str:
    """«2,4 МБ» — размер, как его читает человек."""
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.1f} ГБ".replace(".", ",")
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.1f} МБ".replace(".", ",")
    if n >= 1024:
        return f"{n / 1024:.0f} КБ"
    return f"{n} Б"


async def store_bytes(
    db: asyncpg.Connection,
    *,
    client_id: int,
    data: bytes,
    kind: str,
    ext: str,
    content_type: str,
    event_id: Optional[int] = None,
    collaborator_id: Optional[int] = None,
    lead_magnet_id: Optional[int] = None,
    poster_type: Optional[str] = None,
) -> dict:
    """Кладёт байты в хранилище клиента и учитывает их в квоте.

    Возвращает `{id, url, key, size_bytes}` — как `POST /uploads`.
    """
    size = len(data)

    quota_row = await db.fetchrow(
        """SELECT storage_used_bytes, storage_quota_bytes, storage_provider
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not quota_row:
        raise HTTPException(404, detail="Клиент не найден")

    used = int(quota_row["storage_used_bytes"])
    quota = int(quota_row["storage_quota_bytes"])
    own_storage = bool(quota_row["storage_provider"])

    if not own_storage and used + size > quota:
        raise HTTPException(
            413,
            detail=(
                f"Не хватает места: занято {human_bytes(used)} из {human_bytes(quota)}, "
                f"а файл весит {human_bytes(size)}. "
                "Удалите ненужные файлы в разделе «Файловое хранилище» или подключите "
                "своё бесплатное хранилище на 15 ГБ — это там же, в настройках."
            ),
        )

    # ⚠️ `poster_type` обязателен для kind='event_poster' — без него build_key
    # бросает ValueError. Раньше этот аргумент сюда не пробрасывался вовсе, и
    # сохранить готовую афишу через store_bytes было нельзя в принципе.
    key = r2_storage.build_key(
        client_id, kind, ext,
        event_id=event_id, collaborator_id=collaborator_id,
        poster_type=poster_type,
    )

    try:
        url = await r2_storage.upload_bytes(key, data, content_type)
    except Exception as e:                                      # noqa: BLE001
        text = str(e)
        if own_storage:
            if "QuotaExceeded" in text or "EntityTooLarge" in text or "insufficient" in text.lower():
                msg = ("В вашем хранилище Cloud.ru закончилось место. Освободите его "
                       "или увеличьте объём в кабинете Cloud.ru — бесплатно даётся 15 ГБ.")
            elif "InvalidAccessKeyId" in text or "SignatureDoesNotMatch" in text:
                msg = ("Ключ доступа к вашему хранилищу больше не работает — возможно, "
                       "его удалили или истёк срок. Создайте новый ключ и обновите его "
                       "в Настройках → Файловое хранилище.")
            elif "AccessDenied" in text:
                msg = ("Нет прав на запись в ваше хранилище Cloud.ru. Проверьте ключ "
                       "в Настройках → Файловое хранилище.")
            elif "NoSuchBucket" in text:
                msg = ("Хранилище в Cloud.ru не найдено — возможно, его удалили. "
                       "Подключите заново в Настройках → Файловое хранилище.")
            else:
                msg = f"Ваше хранилище Cloud.ru не принимает файл: {text[:150]}"
        else:
            msg = "Не удалось сохранить файл — попробуйте ещё раз через минуту."
        logger.error("store_bytes failed (client %s, own=%s): %s",
                     client_id, own_storage, text[:300])
        raise HTTPException(502, detail=msg)

    # ⚠️ Запись файла и увеличение занятого места — ОДНОЙ транзакцией: иначе
    # при сбое между ними квота разъедется с тем, что реально лежит.
    async with db.transaction():
        row = await db.fetchrow(
            """INSERT INTO client_files
                 (client_id, kind, r2_key, url, size_bytes, content_type,
                  event_id, collaborator_id, lead_magnet_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               RETURNING id""",
            client_id, kind, key, url, size, content_type,
            event_id, collaborator_id, lead_magnet_id,
        )
        await db.execute(
            "UPDATE clients SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2",
            size, client_id,
        )

    return {"id": row["id"], "url": url, "key": key, "size_bytes": size}
