"""
База коллабораций — per-client CRM людей и организаций, с которыми работает клиент.
Используется в конференциях (спикеры, организаторы, партнёры), премиях, турнирах.
Данные хранятся один раз и переиспользуются в любых событиях через junction-таблицы.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Any
from app.auth import get_current_client
from app.database import get_db
import asyncpg
import secrets
import json

router = APIRouter(prefix="/api/v1/collaborators", tags=["Коллаборации (база)"])


# Алфавит из миграции 108: без 0/o/1/l/i, 16 символов
ACCESS_CODE_ALPHABET = "a234bc56de7fgh89"


# Медийные активы коллаба (миграция 111). Платформы фиксированы — клиент в UI
# выбирает из этого списка, посторонние slug-и тихо отфильтровываются.
# `total` — особый «слот» для совокупного охвата (суммарный показатель).
ALLOWED_MEDIA_PLATFORMS = {
    "tg", "youtube", "vk", "tiktok", "instagram", "max", "rutube",
    "chatbots",   # совокупно по всем чат-ботам клиента
    "database",   # «База» — общий размер базы контактов (email/CRM)
    "total",      # «Суммарно» — совокупный охват одной цифрой
}


def _normalize_media_assets(value: Any) -> Optional[List[dict]]:
    """`media_assets` приходит как массив `{platform, subscribers}`.

    Поле `subscribers` хранится в **тысячах подписчиков** — клиент в UI
    вводит «19.9», бэк хранит 19.9, лендинг отображает «19.9к». Округляем
    до 1 знака после запятой. Допускаются float и int (JSON).

    Платформа `total` — особый слот для совокупного охвата, если клиент не
    хочет разбивать по площадкам или хочет показать общую цифру отдельно.

    Возвращает нормализованный список или None если value=None
    (поле не передано — не трогать в БД). Пустой [] — валидно: «удалить всё».
    """
    if value is None:
        return None
    if not isinstance(value, list):
        raise HTTPException(status_code=422, detail="media_assets должен быть массивом")
    out: List[dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        platform = str(item.get("platform", "")).strip().lower()
        if platform not in ALLOWED_MEDIA_PLATFORMS:
            continue
        raw = item.get("subscribers")
        try:
            subs = float(raw) if raw not in (None, "") else 0.0
        except (TypeError, ValueError):
            continue
        if subs < 0:
            subs = 0.0
        subs = round(subs, 1)
        # Целое число оставляем int (чтоб JSON не имел "19.0" — только "19" или "19.9")
        if subs == int(subs):
            subs = int(subs)
        out.append({"platform": platform, "subscribers": subs})
    return out


async def _generate_unique_access_code(db: asyncpg.Connection, length: int = 8) -> str:
    """8-символьный код для входа спикера в мини-кабинет (миграция 108)."""
    for _ in range(20):
        code = "".join(secrets.choice(ACCESS_CODE_ALPHABET) for _ in range(length))
        exists = await db.fetchval("SELECT 1 FROM collaborators WHERE access_code = $1", code)
        if not exists:
            return code
    raise HTTPException(status_code=500, detail="Не удалось сгенерировать access_code")


class CollaboratorCreate(BaseModel):
    # contact_id обязателен: коллаб = расширение существующего контакта (миграция 086)
    contact_id: int
    # name опционален — если не передан, берётся из contacts.name
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    # poster_url убран миграцией 121 — афиши теперь в таблице collaborator_posters
    # (CRUD `/api/v1/collaborators/{id}/posters`).
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    # Индивидуальное видео коллаба (миграция 113) — один файл в R2.
    # Отдаётся ему же на странице самоправки → вкладка «Материалы».
    video_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    # Публичные каналы коллаба на VK/MAX (по аналогии с tg_channel_url). Миграция 108.
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    # Числовые id каналов VK/MAX для проверки подписки (миграция 177).
    # VK — резолвится автоматически из vk_url; MAX — вводится вручную.
    vk_channel_id: Optional[str] = None
    max_channel_id: Optional[str] = None
    # Личные идентичности — пишутся в platform_users (миграции 107/108)
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    # Медийные активы (миграция 111) — массив {platform, subscribers}
    media_assets: Optional[List[dict]] = None


class CollaboratorUpdate(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    # poster_url убран миграцией 121 — афиши теперь в таблице collaborator_posters.
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    video_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    vk_channel_id: Optional[str] = None
    max_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    contact_id: Optional[int] = None
    media_assets: Optional[List[dict]] = None


def row_to_dict(row):
    d = dict(row)
    if d.get("achievements") is None:
        d["achievements"] = []
    # JSONB читается из asyncpg как строка — парсим обратно в list
    ma = d.get("media_assets")
    if isinstance(ma, str):
        try:
            d["media_assets"] = json.loads(ma)
        except (ValueError, TypeError):
            d["media_assets"] = []
    elif ma is None:
        d["media_assets"] = []
    return d


# Идентичности на всех платформах — через JOIN на platform_users. API наружу
# отдаёт под старыми именами personal_{tg,vk,max}_id / _username, чтобы UI
# и Mini App не пришлось менять.
_COLLAB_SELECT = """
    c.id, c.name, c.title, c.achievements,
    c.photo_url,
    (SELECT url FROM collaborator_posters cp
       WHERE cp.collaborator_id = c.id
       ORDER BY cp.sort_order, cp.id
       LIMIT 1) AS poster_url,
    (SELECT COUNT(*) FROM collaborator_posters cp WHERE cp.collaborator_id = c.id) AS posters_count,
    c.photo_folder_url, c.video_folder_url, c.video_url,
    c.tg_channel_url, c.vk_url, c.max_url,
    c.instagram_url, c.website_url,
    c.tg_channel_id, c.vk_channel_id, c.max_channel_id, c.assistant_tg_username,
    c.access_code,
    c.media_assets,
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

    # Личный никнейм / ID на платформах НЕ обязателен — бизнес-партнёры
    # (компании типа FREEDOM/GRANI) могут быть карточками без личного
    # аккаунта. Рассылки им не идут (см. _upsert_personal_identity:
    # псевдо-запись создаётся со статусом is_unsubscribed=TRUE).
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
    access_code = await _generate_unique_access_code(db)
    media_assets = _normalize_media_assets(data.media_assets) or []
    new_id = await db.fetchval(
        """INSERT INTO collaborators
           (contact_id, name, title, achievements,
            photo_url, photo_folder_url, video_folder_url,
            tg_channel_url, vk_url, max_url, instagram_url, website_url,
            tg_channel_id, assistant_tg_username,
            access_code, media_assets,
            created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17) RETURNING id""",
        data.contact_id, name, data.title, data.achievements,
        data.photo_url, data.photo_folder_url, data.video_folder_url,
        data.tg_channel_url, data.vk_url, data.max_url, data.instagram_url, data.website_url,
        data.tg_channel_id, data.assistant_tg_username,
        access_code, json.dumps(media_assets),
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
    platform_slug.

    Сценарии:
    1. Запись platform_users уже есть для (contact_id, platform_slug) → UPDATE
       (можно сменить и id, и username).
    2. Записи нет, передан числовой `user_id` → стандартный INSERT.
    3. Записи нет, передан ТОЛЬКО `username` (без id) → пробуем резолвить
       username → реальный id через TG getChat / VK users.get:
       - Удачно → INSERT с реальным id, статус подписки выставляется отдельно.
       - Не удалось → INSERT с placeholder `platform_user_id='@<username>'`
         и пометкой `is_unsubscribed=TRUE` на главном канале клиента
         (рассылки не идут пока коллаб реально не написал боту).

    Подробности: project_collaborator_pseudo_platform_users.md.

    Дополнительно: при сохранении username проверяем uniqueness в рамках клиента
    на этой платформе — два разных contact не могут иметь один и тот же ник.
    """
    uid_clean = (user_id or "").strip() or None
    uname_clean = (username or "").lstrip("@").strip() or None
    if not uid_clean and not uname_clean:
        return {"status": "ok"}

    # Uniqueness по username: если у клиента уже есть запись с таким username
    # на этой платформе, но привязана к ДРУГОМУ контакту — не разрешаем.
    if uname_clean:
        username_collision = await db.fetchval(
            """SELECT contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = $2
                  AND LOWER(username) = LOWER($3)
                  AND contact_id <> $4
                LIMIT 1""",
            client_id, platform_slug, uname_clean, contact_id,
        )
        if username_collision is not None:
            return {"status": "username_taken", "other_contact_id": username_collision}

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
        return {"status": "ok"}

    # Записи нет. Если передан числовой id — стандартный путь.
    if uid_clean:
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

    # Только username, без числового id → резолвим (TG getChat / VK users.get).
    # Если не получилось — создаём псевдо-запись с placeholder-id `@username`.
    from app.services.identity_resolver import resolve_personal_identity
    resolved_id, is_subscribed = await resolve_personal_identity(
        db, client_id=client_id, platform_slug=platform_slug, username=uname_clean,
    )
    final_id = resolved_id or f"@{uname_clean}"
    # Защита от коллизии: если такой platform_user_id уже привязан к другому
    # контакту у клиента — не пишем (UNIQUE-конфликт).
    existing_other = await db.fetchval(
        """SELECT contact_id FROM platform_users
            WHERE client_id = $1 AND platform_slug = $2 AND platform_user_id = $3
            LIMIT 1""",
        client_id, platform_slug, final_id,
    )
    if existing_other is not None and existing_other != contact_id:
        return {"status": "foreign_owner", "other_contact_id": existing_other}
    await db.execute(
        """INSERT INTO platform_users
             (client_id, contact_id, platform_slug, platform_user_id, username, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (client_id, platform_slug, platform_user_id) DO NOTHING""",
        client_id, contact_id, platform_slug, final_id, uname_clean
    )
    # Подписка на главный канал клиента: если резолв удался и юзер подписан →
    # is_unsubscribed=FALSE. Если резолв не удался ИЛИ юзер не подписан →
    # is_unsubscribed=TRUE (рассылки не идут пока сам не подпишется).
    await _set_subscription_state(
        db, client_id=client_id, contact_id=contact_id,
        platform_slug=platform_slug, is_subscribed=is_subscribed,
    )
    return {"status": "pseudo" if not resolved_id else "ok"}


async def _set_subscription_state(
    db,
    *,
    client_id: int,
    contact_id: int,
    platform_slug: str,
    is_subscribed: bool,
):
    """Проставить is_unsubscribed на главном канале клиента для personal_users контакта."""
    # Главный канал клиента на платформе
    cc_row = await db.fetchrow(
        """SELECT cc.id AS cc_id
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND ch.platform_slug = $2 AND cc.is_active = TRUE
            ORDER BY ch.id LIMIT 1""",
        client_id, platform_slug,
    )
    if not cc_row:
        return
    pu_row = await db.fetchrow(
        "SELECT id FROM platform_users WHERE contact_id = $1 AND platform_slug = $2 LIMIT 1",
        contact_id, platform_slug,
    )
    if not pu_row:
        return
    unsub = not is_subscribed
    await db.execute(
        """INSERT INTO platform_user_channels
             (platform_user_id, client_channel_id, is_unsubscribed, subscribed_at, unsubscribed_at)
           VALUES ($1, $2, $3,
                   CASE WHEN $3 THEN NULL ELSE NOW() END,
                   CASE WHEN $3 THEN NOW() ELSE NULL END)
           ON CONFLICT (platform_user_id, client_channel_id) DO UPDATE
              SET is_unsubscribed = EXCLUDED.is_unsubscribed,
                  unsubscribed_at = COALESCE(platform_user_channels.unsubscribed_at, EXCLUDED.unsubscribed_at),
                  subscribed_at   = COALESCE(platform_user_channels.subscribed_at, EXCLUDED.subscribed_at)""",
        pu_row["id"], cc_row["cc_id"], unsub,
    )


_PLATFORM_HUMAN = {"telegram": "Telegram", "vk": "VK", "max": "MAX"}


async def _raise_if_identity_collision(db, client_id: int, platform_slug: str, res: dict):
    """Если _upsert_personal_identity вернул коллизию (ник/ID уже у другого
    контакта) — бросаем 409 с понятным текстом и именем того контакта.

    Это защита от частой ошибки: ассистент при добавлении нового спикера/жюри
    вписывает Telegram, который уже привязан к ДРУГОМУ человеку. Раньше статус
    молча игнорировался — получался дубль и псевдо-запись рядом с чужой реальной.
    """
    status = (res or {}).get("status")
    if status not in ("username_taken", "foreign_owner"):
        return
    other_id = res.get("other_contact_id")
    other_name = None
    if other_id is not None:
        other_name = await db.fetchval("SELECT name FROM contacts WHERE id = $1", other_id)
    platform = _PLATFORM_HUMAN.get(platform_slug, platform_slug)
    who = f"«{other_name}»" if other_name else f"контактом #{other_id}"
    raise HTTPException(
        status_code=409,
        detail=(
            f"Этот {platform}-аккаунт уже привязан к другому человеку — {who}. "
            f"Один и тот же {platform} нельзя указать двум людям. "
            f"Проверьте ник: возможно, вы вписали аккаунт ассистента или другого спикера."
        ),
    )


async def _upsert_personal_identities(
    db: asyncpg.Connection,
    client_id: int,
    contact_id: int,
    data,
):
    """Прокидывает personal_{tg,vk,max}_{id,username} из payload в platform_users.

    При коллизии (ник/ID уже принадлежит другому контакту) бросает 409 —
    создание коллаба откатывается (вызовы идут внутри транзакции), ассистент
    видит понятную ошибку вместо тихого дубля.
    """
    res_tg = await _upsert_personal_identity(
        db, client_id, contact_id, 'telegram',
        getattr(data, "personal_tg_id", None),
        getattr(data, "personal_tg_username", None),
    )
    await _raise_if_identity_collision(db, client_id, 'telegram', res_tg)
    res_vk = await _upsert_personal_identity(
        db, client_id, contact_id, 'vk',
        getattr(data, "personal_vk_id", None),
        getattr(data, "personal_vk_username", None),
    )
    await _raise_if_identity_collision(db, client_id, 'vk', res_vk)
    res_max = await _upsert_personal_identity(
        db, client_id, contact_id, 'max',
        getattr(data, "personal_max_id", None),
        getattr(data, "personal_max_username", None),
    )
    await _raise_if_identity_collision(db, client_id, 'max', res_max)


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
    posters = await db.fetch(
        """SELECT id, url, label, sort_order
             FROM collaborator_posters
            WHERE collaborator_id = $1
            ORDER BY sort_order, id""",
        collaborator_id,
    )
    d["posters"] = [dict(p) for p in posters]
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
    # Личные идентичности TG/VK/MAX живут в platform_users (миграция 107),
    # а не в collaborators. Отделяем их из updates_full, чтобы не пытаться
    # UPDATE collaborators SET personal_vk_id = ... (колонок таких нет).
    tg_id_in = updates_full.pop("personal_tg_id", None)
    tg_uname_in = updates_full.pop("personal_tg_username", None)
    vk_id_in = updates_full.pop("personal_vk_id", None)
    vk_uname_in = updates_full.pop("personal_vk_username", None)
    max_id_in = updates_full.pop("personal_max_id", None)
    max_uname_in = updates_full.pop("personal_max_username", None)
    has_personal = any([
        tg_id_in, tg_uname_in, vk_id_in, vk_uname_in, max_id_in, max_uname_in,
    ])
    # media_assets — JSONB, нужен явный ::jsonb cast и json.dumps. Обрабатываем отдельно.
    media_assets_in = _normalize_media_assets(updates_full.pop("media_assets", None))
    # Авто-резолв числового id VK-сообщества коллаба из vk_url (для проверки
    # подписки groups.isMember). Делаем когда меняется vk_url, а vk_channel_id
    # явно не передан — чтобы клиент не вписывал id руками (как у клиента в профиле).
    # Очистка vk_url (пришла пустая строка) → зануляем и кешированный vk_channel_id,
    # иначе старый id останется и проверка подписки будет идти на удалённое сообщество.
    if "vk_url" in updates_full and not (updates_full.get("vk_url") or "").strip():
        updates_full["vk_url"] = None
        updates_full["vk_channel_id"] = None
    # Очистка max_url → зануляем max_channel_id.
    if "max_url" in updates_full and not (updates_full.get("max_url") or "").strip():
        updates_full["max_url"] = None
        updates_full["max_channel_id"] = None
    if updates_full.get("vk_url") and not data.vk_channel_id:
        from app.services.social_links import vk_screen_name_from_link
        from app.services.vk_api import vk_call
        screen = vk_screen_name_from_link(updates_full["vk_url"])
        if screen:
            try:
                resp = await vk_call("utils.resolveScreenName", {"screen_name": screen})
                if isinstance(resp, dict) and resp.get("type") in ("group", "page") and resp.get("object_id"):
                    updates_full["vk_channel_id"] = str(int(resp["object_id"]))
            except Exception:
                pass  # резолв не получился — не блокируем сохранение коллаба
    if "contact_id" in updates_full:
        own = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
            updates_full["contact_id"], client_id
        )
        if not own:
            raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
    # Узнаём contact_id коллаба для UPSERT в platform_users (если меняется любая идентичность)
    contact_id_for_identity = updates_full.get("contact_id")
    if contact_id_for_identity is None and has_personal:
        contact_id_for_identity = await db.fetchval(
            "SELECT contact_id FROM collaborators WHERE id = $1 AND created_by_client_id = $2",
            collaborator_id, client_id
        )
    if updates_full or media_assets_in is not None:
        set_parts = []
        vals = []
        for i, (k, v) in enumerate(updates_full.items()):
            set_parts.append(f"{k} = ${i+2}")
            vals.append(v)
        if media_assets_in is not None:
            set_parts.append(f"media_assets = ${len(vals)+2}::jsonb")
            vals.append(json.dumps(media_assets_in))
        set_parts.append("updated_at = NOW()")
        updated_id = await db.fetchval(
            f"UPDATE collaborators SET {', '.join(set_parts)} "
            f"WHERE id = $1 AND created_by_client_id = ${len(vals)+2} RETURNING id",
            collaborator_id, *vals, client_id
        )
        if not updated_id:
            raise HTTPException(status_code=404, detail="Коллаборация не найдена")
    if has_personal and contact_id_for_identity:
        if tg_id_in or tg_uname_in:
            await _upsert_personal_identity(
                db, client_id, contact_id_for_identity, 'telegram', tg_id_in, tg_uname_in,
            )
        if vk_id_in or vk_uname_in:
            await _upsert_personal_identity(
                db, client_id, contact_id_for_identity, 'vk', vk_id_in, vk_uname_in,
            )
        if max_id_in or max_uname_in:
            await _upsert_personal_identity(
                db, client_id, contact_id_for_identity, 'max', max_id_in, max_uname_in,
            )
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
    # poster_url убран миграцией 121 — афиши теперь в таблице collaborator_posters.
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
    media_assets: Optional[List[dict]] = None
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
    # Личный аккаунт коллаба НЕ обязателен (2026-05-25) — бизнес-партнёры
    # (FREEDOM/GRANI и т.п.) создаются без личного TG/VK/MAX, рассылок не идёт.
    # Если username введён, но id не известен — _upsert_personal_identity сам
    # попробует резолвить → fallback на псевдо-запись с is_unsubscribed=TRUE.

    if contact_id is None and not data.force_create:
        matches = await db.fetch(
            """SELECT c.id, c.name,
                      (SELECT pe.platform_user_id FROM platform_users pe
                        WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                        ORDER BY pe.id LIMIT 1) AS email,
                      c.phone,
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

        access_code = await _generate_unique_access_code(db)
        media_assets = _normalize_media_assets(data.media_assets) or []
        new_id = await db.fetchval(
            """INSERT INTO collaborators
               (contact_id, name, title, achievements,
                photo_url,
                tg_channel_url, tg_channel_id,
                vk_url, max_url,
                instagram_url, website_url,
                assistant_tg_username,
                access_code, media_assets,
                created_by_client_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) RETURNING id""",
            contact_id, name, data.title, data.achievements,
            data.photo_url,
            data.tg_channel_url, data.tg_channel_id,
            data.vk_url, data.max_url,
            data.instagram_url, data.website_url,
            data.assistant_tg_username,
            access_code, json.dumps(media_assets),
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
    media_assets: Optional[List[dict]] = None


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
            access_code = await _generate_unique_access_code(db)
            media_assets = _normalize_media_assets(item.media_assets) or []
            row = await db.fetchrow(
                """INSERT INTO collaborators
                   (contact_id, name, title, achievements, photo_url, photo_folder_url, video_folder_url,
                    tg_channel_url, vk_url, max_url, instagram_url, website_url,
                    tg_channel_id, assistant_tg_username,
                    access_code, media_assets,
                    created_by_client_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17) RETURNING id, name""",
                contact_id, item.name, item.title, item.achievements,
                item.photo_url, item.photo_folder_url, item.video_folder_url,
                item.tg_channel_url or None,
                item.vk_url or None, item.max_url or None,
                item.instagram_url or None, item.website_url or None,
                item.tg_channel_id or None, item.assistant_tg_username or None,
                access_code, json.dumps(media_assets),
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
    # Карточка основателя (self_collaborator, миграция 141) — удалять нельзя:
    # она связана с профилем клиента и используется в событиях/Коллабораторной.
    is_self = await db.fetchval(
        "SELECT 1 FROM clients WHERE id = $1 AND self_collaborator_id = $2",
        client_id, collaborator_id,
    )
    if is_self:
        raise HTTPException(
            status_code=409,
            detail=(
                "Это ваша карточка организатора — её нельзя удалить. "
                "Она связана с вашим профилем и используется в событиях."
            ),
        )
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
            WHERE c.id = $1 AND ec.event_id = $2 AND EXISTS(SELECT 1 FROM event_owners eo WHERE eo.event_id=e.id AND eo.client_id=$3 AND eo.status='accepted')""",
        collaborator_id, event_id, client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не привязан к этому событию")

    access_code = row["access_code"]
    event_slug = row["event_slug"]
    event_title = row["event_title"] or "событие"
    speaker_name = row["name"] or "Спикер"

    links = await build_invite_links_for_collaborator(db, client_id, access_code, event_id)
    landing_url = f"https://pluson.ru/speaker/{event_slug}"

    lines = [
        f"{speaker_name}, нужно будет заполнить свои данные.",
        "",
        "Здесь ссылка на удобный мессенджер — бот пришлёт код доступа и ссылку для заполнения формы:",
    ]
    if links.get("telegram"):
        lines.append(f"  Telegram: {links['telegram']}")
    if links.get("vk"):
        lines.append(f"  VK: {links['vk']}")
    if links.get("max"):
        lines.append(f"  MAX: {links['max']}")
    lines += [
        "",
        "Там же будет ваша реферальная ссылка на событие и материалы для анонсов.",
        "",
        "Что важно в первую очередь сделать в кабинете:",
        "— загрузить фото",
        "— внести регалии",
        "— зарегистрировать себя партнёром в GetCourse для получения кэшбэка",
        "",
        "В кабинете там всё есть — если что, задавайте вопросы.",
        "",
        "Как заполните — сообщите! Мы на основе вашего фото сделаем индивидуальную афишу и загрузим в ваш личный кабинет.",
        "",
        "Всё, что вы вводите, пойдёт напрямую в мини-апп события в боте и на сайт события. По своей реферальной ссылке сможете проверить.",
    ]
    return {
        "access_code": access_code,
        "landing_url": landing_url,
        "links": links,
        "message": "\n".join(lines),
    }
