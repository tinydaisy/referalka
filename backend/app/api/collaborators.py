"""
База коллабораций — per-client CRM людей и организаций, с которыми работает клиент.
Используется в конференциях (спикеры, организаторы, партнёры), премиях, турнирах.
Данные хранятся один раз и переиспользуются в любых событиях через junction-таблицы.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/api/v1/collaborators", tags=["Коллаборации (база)"])


class CollaboratorCreate(BaseModel):
    # contact_id обязателен: коллаб = расширение существующего контакта (миграция 086)
    contact_id: int
    # name опционален — если не передан, берётся из contacts.name
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    # Публичные каналы коллаба на VK/MAX (по аналогии с tg_channel_url). Миграция 108.
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    # Личные идентичности — пишутся в platform_users (миграции 107/108)
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None


class CollaboratorUpdate(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    contact_id: Optional[int] = None


def row_to_dict(row):
    d = dict(row)
    if d.get("achievements") is None:
        d["achievements"] = []
    return d


# Идентичности на всех платформах — через JOIN на platform_users. API наружу
# отдаёт под старыми именами personal_{tg,vk,max}_id / _username, чтобы UI
# и Mini App не пришлось менять.
_COLLAB_SELECT = """
    c.id, c.name, c.title, c.achievements,
    c.photo_url, c.poster_url, c.photo_folder_url, c.video_folder_url,
    c.tg_channel_url, c.vk_url, c.max_url,
    c.instagram_url, c.website_url,
    c.tg_channel_id, c.assistant_tg_username,
    c.access_code,
    c.contact_id, c.created_by_client_id, c.created_at, c.updated_at,
    pu_tg.platform_user_id  AS personal_tg_id,
    pu_tg.username          AS personal_tg_username,
    pu_vk.platform_user_id  AS personal_vk_id,
    pu_vk.username          AS personal_vk_username,
    pu_max.platform_user_id AS personal_max_id,
    pu_max.username         AS personal_max_username
"""

_COLLAB_JOIN = """
    LEFT JOIN platform_users pu_tg
      ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
    LEFT JOIN platform_users pu_vk
      ON pu_vk.contact_id = c.contact_id AND pu_vk.platform_slug = 'vk'
    LEFT JOIN platform_users pu_max
      ON pu_max.contact_id = c.contact_id AND pu_max.platform_slug = 'max'
"""


@router.get("/", summary="Список коллабораций клиента")
async def list_collaborators(
    q: Optional[str] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    if q:
        rows = await db.fetch(
            f"SELECT {_COLLAB_SELECT} FROM collaborators c {_COLLAB_JOIN} "
            f"WHERE c.created_by_client_id = $1 AND c.name ILIKE $2 ORDER BY c.name",
            client_id, f"%{q}%"
        )
    else:
        rows = await db.fetch(
            f"SELECT {_COLLAB_SELECT} FROM collaborators c {_COLLAB_JOIN} "
            f"WHERE c.created_by_client_id = $1 ORDER BY c.name",
            client_id
        )
    return {"collaborators": [row_to_dict(r) for r in rows]}


@router.post("/", summary="Добавить коллаборацию из существующего контакта")
async def create_collaborator(
    data: CollaboratorCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    # Проверяем что contact_id принадлежит этому клиенту и не помечен мерджем
    contact = await db.fetchrow(
        "SELECT id, name FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
        data.contact_id, client_id
    )
    if not contact:
        raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
    # Один коллаб на контакт — повторное добавление запрещаем
    existing = await db.fetchval(
        "SELECT id FROM collaborators WHERE contact_id = $1", data.contact_id
    )
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"У этого контакта уже есть коллаборатор (id={existing}). Откройте его карточку."
        )
    name = (data.name or contact["name"] or "").strip() or "Без имени"
    new_id = await db.fetchval(
        """INSERT INTO collaborators
           (contact_id, name, title, achievements,
            photo_url, poster_url, photo_folder_url, video_folder_url,
            tg_channel_url, vk_url, max_url, instagram_url, website_url,
            tg_channel_id, assistant_tg_username,
            created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id""",
        data.contact_id, name, data.title, data.achievements,
        data.photo_url, data.poster_url, data.photo_folder_url, data.video_folder_url,
        data.tg_channel_url, data.vk_url, data.max_url, data.instagram_url, data.website_url,
        data.tg_channel_id, data.assistant_tg_username,
        client_id
    )
    # Личные идентичности коллаба живут в platform_users (миграции 107/108)
    await _upsert_personal_identities(db, client_id, data.contact_id, data)
    row = await db.fetchrow(
        f"SELECT {_COLLAB_SELECT} FROM collaborators c {_COLLAB_JOIN} WHERE c.id = $1",
        new_id
    )
    d = row_to_dict(row)
    return {"speaker": d, "collaborator": d}


async def _upsert_personal_identity(
    db: asyncpg.Connection,
    client_id: int,
    contact_id: int,
    platform_slug: str,  # 'telegram' | 'vk' | 'max'
    user_id: Optional[str],
    username: Optional[str],
):
    """Записать/обновить личную идентичность коллаба в platform_users.

    Унифицирует логику для всех трёх платформ. Привязка идёт по contact_id +
    platform_slug. Если запись уже есть — обновляем (можно сменить и id, и
    username). Если нет — создаём (нужен id, потому что platform_user_id NOT NULL).
    """
    uid_clean = (user_id or "").strip() or None
    uname_clean = (username or "").lstrip("@").strip() or None
    if not uid_clean and not uname_clean:
        return
    existing = await db.fetchrow(
        """SELECT id, platform_user_id, username FROM platform_users
            WHERE contact_id = $1 AND platform_slug = $2
            LIMIT 1""",
        contact_id, platform_slug
    )
    if existing:
        new_id = uid_clean or existing["platform_user_id"]
        new_uname = uname_clean if uname_clean is not None else existing["username"]
        # Если новый platform_user_id уже занят ДРУГИМ contact у того же клиента —
        # не переписываем (это перетёрло бы чужую запись и нарушило бы UNIQUE).
        if new_id and new_id != existing["platform_user_id"]:
            collision = await db.fetchval(
                """SELECT contact_id FROM platform_users
                    WHERE client_id = $1 AND platform_slug = $2 AND platform_user_id = $3
                      AND id <> $4
                    LIMIT 1""",
                client_id, platform_slug, new_id, existing["id"],
            )
            if collision is not None:
                return {"status": "foreign_owner", "other_contact_id": collision}
        await db.execute(
            """UPDATE platform_users
                  SET platform_user_id = $1,
                      username         = $2
                WHERE id = $3""",
            new_id, new_uname, existing["id"]
        )
    elif uid_clean:
        # Защита от конфликта с другим contact_id: если platform_user_id
        # уже привязан к ДРУГОМУ contact у этого клиента — не вставляем
        # (это значит что код спикера открыл не тот человек, например, сам
        # клиент со своего личного аккаунта). Возвращаем "foreign", чтобы
        # вызывающий код мог отдать вменяемое сообщение.
        existing_other = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = $2 AND platform_user_id = $3
                LIMIT 1""",
            client_id, platform_slug, uid_clean,
        )
        if existing_other is not None and existing_other != contact_id:
            return {"status": "foreign_owner", "other_contact_id": existing_other}
        await db.execute(
            """INSERT INTO platform_users
                 (client_id, contact_id, platform_slug, platform_user_id, username, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW())
               ON CONFLICT (client_id, platform_slug, platform_user_id) DO NOTHING""",
            client_id, contact_id, platform_slug, uid_clean, uname_clean
        )
    return {"status": "ok"}


async def _upsert_personal_identities(
    db: asyncpg.Connection,
    client_id: int,
    contact_id: int,
    data,
):
    """Прокидывает personal_{tg,vk,max}_{id,username} из payload в platform_users."""
    await _upsert_personal_identity(
        db, client_id, contact_id, 'telegram',
        getattr(data, "personal_tg_id", None),
        getattr(data, "personal_tg_username", None),
    )
    await _upsert_personal_identity(
        db, client_id, contact_id, 'vk',
        getattr(data, "personal_vk_id", None),
        getattr(data, "personal_vk_username", None),
    )
    await _upsert_personal_identity(
        db, client_id, contact_id, 'max',
        getattr(data, "personal_max_id", None),
        getattr(data, "personal_max_username", None),
    )


# Алиас для обратной совместимости с местами, где зовётся _upsert_personal_tg.
async def _upsert_personal_tg(db, client_id, contact_id, tg_id, tg_username):
    await _upsert_personal_identity(db, client_id, contact_id, 'telegram', tg_id, tg_username)


@router.get("/{collaborator_id}", summary="Коллаборация по ID")
async def get_collaborator(
    collaborator_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        f"""SELECT {_COLLAB_SELECT},
                   c2.name  AS contact_name,
                   c2.email AS contact_email,
                   c2.phone AS contact_phone
              FROM collaborators c
              {_COLLAB_JOIN}
              LEFT JOIN contacts c2 ON c2.id = c.contact_id
             WHERE c.id = $1 AND c.created_by_client_id = $2""",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    d = row_to_dict(row)
    return {"speaker": d, "collaborator": d}


@router.patch("/{collaborator_id}", summary="Обновить данные коллаборации")
async def update_collaborator(
    collaborator_id: int,
    data: CollaboratorUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    updates_full = {k: v for k, v in data.model_dump().items() if v is not None}
    # Личный TG живёт в platform_users (миграция 107) — отделяем от UPDATE collaborators
    tg_id_in = updates_full.pop("personal_tg_id", None)
    tg_uname_in = updates_full.pop("personal_tg_username", None)
    if "contact_id" in updates_full:
        own = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
            updates_full["contact_id"], client_id
        )
        if not own:
            raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
    # Узнаём contact_id коллаба для UPSERT в platform_users (если меняется TG)
    contact_id_for_tg = updates_full.get("contact_id")
    if contact_id_for_tg is None and (tg_id_in or tg_uname_in):
        contact_id_for_tg = await db.fetchval(
            "SELECT contact_id FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
            collaborator_id, client_id
        )
    if updates_full:
        set_parts = []
        vals = []
        for i, (k, v) in enumerate(updates_full.items()):
            set_parts.append(f"{k} = ${i+2}")
            vals.append(v)
        set_parts.append("updated_at = NOW()")
        updated_id = await db.fetchval(
            f"UPDATE collaborators SET {', '.join(set_parts)} "
            f"WHERE id = $1 AND created_by_client_id = ${len(vals)+2} RETURNING id",
            collaborator_id, *vals, client_id
        )
        if not updated_id:
            raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    if (tg_id_in or tg_uname_in) and contact_id_for_tg:
        await _upsert_personal_tg(db, client_id, contact_id_for_tg, tg_id_in, tg_uname_in)
    row = await db.fetchrow(
        f"SELECT {_COLLAB_SELECT} FROM collaborators c {_COLLAB_JOIN} "
        f"WHERE c.id = $1 AND c.created_by_client_id = $2",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    d = row_to_dict(row)
    return {"speaker": d, "collaborator": d}


class CollaboratorQuickCreate(BaseModel):
    """
    Создать коллаба «с нуля» (без предварительного создания контакта в /clients).
    Дедупликация по имени: если у клиента есть контакт с таким же именем,
    эндпоинт без force_create возвращает needs_choice + варианты для UI.
    """
    name: str
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    # Минимум одна личная идентичность обязательна — но если контакт уже
    # существует (existing_contact_id заполнен), валидация снимается:
    # личные контакты могут быть уже привязаны через предыдущий импорт.
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    force_create: bool = False
    existing_contact_id: Optional[int] = None


@router.post("/quick", summary="Создать коллаба + контакт одной транзакцией (с дедупом по имени)")
async def create_collaborator_quick(
    data: CollaboratorQuickCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Имя обязательно")

    contact_id: Optional[int] = data.existing_contact_id
    if contact_id is not None:
        own = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
            contact_id, client_id
        )
        if not own:
            raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
    else:
        # При создании нового контакта (без existing_contact_id) обязательна
        # минимум одна личная идентичность спикера — иначе мы не сможем ему
        # отправить инструкцию по самообслуживанию.
        has_personal = any([
            (data.personal_tg_id or "").strip(),
            (data.personal_tg_username or "").strip(),
            (data.personal_vk_id or "").strip(),
            (data.personal_vk_username or "").strip(),
            (data.personal_max_id or "").strip(),
            (data.personal_max_username or "").strip(),
        ])
        if not has_personal:
            raise HTTPException(
                status_code=422,
                detail="Укажите хотя бы один личный аккаунт спикера: Telegram, VK или MAX. Без этого ему не получится отправить инструкцию для редактирования профиля."
            )

    if contact_id is None and not data.force_create:
        matches = await db.fetch(
            """SELECT c.id, c.name, c.email, c.phone,
                      EXISTS(SELECT 1 FROM collaborators col WHERE col.contact_id = c.id) AS has_collab
                 FROM contacts c
                WHERE c.client_id = $1
                  AND c.merged_into IS NULL
                  AND LOWER(TRIM(c.name)) = LOWER($2)
                ORDER BY c.id
                LIMIT 10""",
            client_id, name
        )
        if matches:
            return {
                "needs_choice": True,
                "matches": [
                    {"id": m["id"], "name": m["name"], "email": m["email"],
                     "phone": m["phone"], "has_collab": m["has_collab"]}
                    for m in matches
                ],
            }

    async with db.transaction():
        if contact_id is None:
            contact_id = await db.fetchval(
                """INSERT INTO contacts (client_id, name, ref_code)
                   VALUES ($1, $2, SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8))
                   RETURNING id""",
                client_id, name
            )
        else:
            existing_coll = await db.fetchval(
                "SELECT id FROM collaborators WHERE contact_id = $1", contact_id
            )
            if existing_coll:
                raise HTTPException(
                    status_code=409,
                    detail=f"У этого контакта уже есть коллаборатор (id={existing_coll})."
                )

        new_id = await db.fetchval(
            """INSERT INTO collaborators
               (contact_id, name, title, achievements,
                photo_url, poster_url,
                tg_channel_url, tg_channel_id,
                vk_url, max_url,
                instagram_url, website_url,
                assistant_tg_username,
                created_by_client_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id""",
            contact_id, name, data.title, data.achievements,
            data.photo_url, data.poster_url,
            data.tg_channel_url, data.tg_channel_id,
            data.vk_url, data.max_url,
            data.instagram_url, data.website_url,
            data.assistant_tg_username,
            client_id
        )
        await _upsert_personal_identities(db, client_id, contact_id, data)

    row = await db.fetchrow(
        f"SELECT {_COLLAB_SELECT} FROM collaborators c {_COLLAB_JOIN} WHERE c.id = $1",
        new_id
    )
    d = row_to_dict(row)
    return {"collaborator": d, "speaker": d}


class CollaboratorImportItem(BaseModel):
    name: str
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None


class CollaboratorImportRequest(BaseModel):
    collaborations: List[CollaboratorImportItem]
    skip_duplicates: bool = True


@router.post("/import", summary="Пакетный импорт коллабораций из JSON")
async def import_collaborators(
    data: CollaboratorImportRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    created, skipped, errors = [], [], []

    for item in data.collaborations:
        try:
            existing = await db.fetchrow(
                "SELECT id FROM collaborators WHERE name = $1 AND created_by_client_id = $2",
                item.name, client_id
            )
            if existing:
                if data.skip_duplicates:
                    skipped.append(item.name)
                    continue
            # contact_id обязателен (миграция 086). Ищем контакт по имени,
            # если нет — создаём пустой (без email/phone) и привязываем.
            contact_row = await db.fetchrow(
                """SELECT id FROM contacts
                    WHERE client_id = $1 AND merged_into IS NULL
                      AND LOWER(name) = LOWER($2)
                    ORDER BY id LIMIT 1""",
                client_id, item.name
            )
            if contact_row:
                contact_id = contact_row["id"]
            else:
                new_contact = await db.fetchrow(
                    """INSERT INTO contacts (client_id, name)
                       VALUES ($1, $2)
                       RETURNING id""",
                    client_id, item.name
                )
                contact_id = new_contact["id"]
            row = await db.fetchrow(
                """INSERT INTO collaborators
                   (contact_id, name, title, achievements, photo_url, photo_folder_url, video_folder_url,
                    tg_channel_url, vk_url, max_url, instagram_url, website_url,
                    tg_channel_id, assistant_tg_username,
                    created_by_client_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, name""",
                contact_id, item.name, item.title, item.achievements,
                item.photo_url, item.photo_folder_url, item.video_folder_url,
                item.tg_channel_url or None,
                item.vk_url or None, item.max_url or None,
                item.instagram_url or None, item.website_url or None,
                item.tg_channel_id or None, item.assistant_tg_username or None,
                client_id
            )
            await _upsert_personal_identities(db, client_id, contact_id, item)
            created.append({"id": row["id"], "name": row["name"]})
        except Exception as e:
            errors.append({"name": item.name, "error": str(e)})

    return {
        "created": created,
        "skipped": skipped,
        "errors": errors,
        "summary": f"Создано: {len(created)}, пропущено: {len(skipped)}, ошибок: {len(errors)}"
    }


@router.delete("/{collaborator_id}", summary="Удалить коллаборацию из базы")
async def delete_collaborator(
    collaborator_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    row = await db.fetchrow(
        "SELECT id FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
        collaborator_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    count = await db.fetchval(
        "SELECT COUNT(*) FROM event_collaborators WHERE speaker_id = $1", collaborator_id
    )
    if count > 0:
        raise HTTPException(
            status_code=400,
            detail=f"Коллаборация участвует в {count} событиях. Сначала удалите её из всех событий."
        )
    await db.execute("DELETE FROM collaborators WHERE id = $1", collaborator_id)
    return {"message": "Коллаборация удалена из базы"}


@router.get("/{collaborator_id}/invite-message", summary="Готовое сообщение для отправки спикеру (с 3 invite-ссылками)")
async def collaborator_invite_message(
    collaborator_id: int,
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Возвращает {access_code, message, links} — текст для копирования и
    отправки спикеру вручную (Margo шлёт в личку, потому что спикера ещё нет
    в боте). Спикер кликает любую из 3 ссылок → бот шлёт ему код + ссылку
    на лендинг pluson.ru/speaker/<event_slug>.

    Какой бот в ссылке: клиентский VIP-бот если есть подключённый канал
    на платформе, иначе системный.
    """
    from app.services.share_links import build_invite_links_for_collaborator
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT c.id, c.name, c.access_code, e.slug AS event_slug, e.title AS event_title
             FROM collaborators c
             JOIN event_collaborators ec ON ec.speaker_id = c.id
             JOIN events e ON e.id = ec.event_id
            WHERE c.id = $1 AND ec.event_id = $2 AND e.client_id = $3""",
        collaborator_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не привязан к этому событию")

    access_code = row["access_code"]
    event_slug = row["event_slug"]
    event_title = row["event_title"] or "событие"
    speaker_name = row["name"] or "Спикер"

    links = await build_invite_links_for_collaborator(db, client_id, access_code)
    landing_url = f"https://pluson.ru/speaker/{event_slug}"

    lines = [
        f"{speaker_name}, для участия в «{event_title}» нужно заполнить свои данные.",
        "",
        "Откройте любую удобную ссылку — бот пришлёт код доступа и ссылку на форму:",
    ]
    if links.get("telegram"):
        lines.append(f"  Telegram: {links['telegram']}")
    if links.get("vk"):
        lines.append(f"  VK: {links['vk']}")
    if links.get("max"):
        lines.append(f"  MAX: {links['max']}")
    lines += [
        "",
        "Можно передать ссылку своему ассистенту — он откроет её в боте, получит код и заполнит за вас.",
    ]
    return {
        "access_code": access_code,
        "landing_url": landing_url,
        "links": links,
        "message": "\n".join(lines),
    }
