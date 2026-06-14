"""
Self-коллаб клиента — собственная карточка организатора (контакт + коллаб),
создаваемая из профиля клиента (clients). Привязка через clients.self_collaborator_id
(миграция 141).

Зачем: каждый клиент ПЛЮСОН имеет ОДНУ свою карточку-коллаб, которую можно
добавлять организатором/спикером в любые события (в т.ч. коллаб-события хаба),
не плодя дублей. Запрет удаления своей карточки и авто-добавление в коллаб-событие
опираются на это поле.

Идемпотентно: если self_collaborator_id уже задан и коллаб жив — ничего не делает.
"""
import asyncpg
from typing import Optional


async def ensure_self_collaborator(db: asyncpg.Connection, client_id: int) -> Optional[int]:
    """Гарантирует, что у клиента есть его карточка-коллаб, и возвращает её id.

    Шаги:
    1. Если clients.self_collaborator_id уже указывает на живой коллаб — вернуть его.
    2. Иначе попробовать найти существующий коллаб клиента (его contact в его базе) — привязать.
    3. Иначе создать contact (из clients.name) + collaborator из профиля клиента, привязать.

    Безопасно звать многократно и из любой ветки.
    """
    cl = await db.fetchrow(
        """SELECT id, name, brand_name, owner_photo_url, profile_photo_url,
                  owner_positioning, positioning, bio, owner_achievements,
                  self_collaborator_id
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not cl:
        return None

    # 1. Уже привязан и жив?
    if cl["self_collaborator_id"]:
        alive = await db.fetchval(
            "SELECT 1 FROM collaborators WHERE id = $1", cl["self_collaborator_id"]
        )
        if alive:
            return cl["self_collaborator_id"]

    # 2. Есть ли уже коллаб клиента (его contact в его же базе)? Привязать самый ранний.
    existing = await db.fetchval(
        """SELECT MIN(co.id)
             FROM collaborators co
             JOIN contacts ct ON ct.id = co.contact_id
            WHERE ct.client_id = $1""",
        client_id,
    )
    if existing:
        await db.execute(
            "UPDATE clients SET self_collaborator_id = $1 WHERE id = $2",
            existing, client_id,
        )
        return existing

    # 3. Создать contact + collaborator из профиля клиента.
    from app.services.contact_merge import _generate_unique_ref_code
    name = (cl["name"] or cl["brand_name"] or "").strip() or "Организатор"
    photo = cl["owner_photo_url"] or cl["profile_photo_url"]
    title = cl["owner_positioning"] or cl["positioning"]
    achievements = cl["owner_achievements"]

    ref_code = await _generate_unique_ref_code(db)
    contact_id = await db.fetchval(
        "INSERT INTO contacts (client_id, name, ref_code) VALUES ($1, $2, $3) RETURNING id",
        client_id, name, ref_code,
    )

    access_code = await _generate_unique_access_code(db)
    collab_id = await db.fetchval(
        """INSERT INTO collaborators
             (contact_id, name, title, achievements, photo_url, access_code, created_by_client_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id""",
        contact_id, name, title, achievements, photo, access_code, client_id,
    )
    await db.execute(
        "UPDATE clients SET self_collaborator_id = $1 WHERE id = $2",
        collab_id, client_id,
    )
    return collab_id


async def _generate_unique_access_code(db: asyncpg.Connection, length: int = 8) -> str:
    """8-символьный код доступа коллаба, алфавит без визуально похожих символов.

    Дублирует логику collaborators._generate_unique_access_code, чтобы избежать
    циклического импорта api → service.
    """
    import secrets
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    for _ in range(50):
        code = "".join(secrets.choice(alphabet) for _ in range(length))
        exists = await db.fetchval("SELECT 1 FROM collaborators WHERE access_code = $1", code)
        if not exists:
            return code
    # крайне маловероятно — берём более длинный
    return "".join(secrets.choice(alphabet) for _ in range(length + 4))
