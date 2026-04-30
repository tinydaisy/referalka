"""
Helper-сервис для иерархии Контактов (миграция 036).

Главная функция — `upsert_contact_with_identity`: при создании/обновлении
идентичности на платформе ищем существующий contact по email/phone и привязываем
новую identity к нему. Если не нашли — создаём новый contact + identity.

Используется во всех точках входа контактов в систему:
- TG /start (participants.register)
- Salebot webhook (integrations)
- Импортёры (load_contacts, import_participants_v5, etc)
- Регистрация на лендинге
"""
import re
import secrets
import string
from typing import Optional


def normalize_email(email: Optional[str]) -> Optional[str]:
    """Lowercase + trim. Пустую строку → None."""
    if not email:
        return None
    cleaned = email.strip().lower()
    return cleaned or None


def normalize_phone(phone: Optional[str]) -> Optional[str]:
    """Только цифры + 8→+7. Пустую строку → None."""
    if not phone:
        return None
    digits = re.sub(r'[^0-9]', '', phone)
    if not digits:
        return None
    if len(digits) == 11 and digits.startswith('8'):
        return '+7' + digits[1:]
    if len(digits) == 11 and digits.startswith('7'):
        return '+' + digits
    return digits


def generate_ref_code(length: int = 8) -> str:
    """ABC123-формат, без 0/O/1/I."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return ''.join(secrets.choice(alphabet) for _ in range(length))


async def resolve_ref_code(db, ref_code: Optional[str], client_id: Optional[int] = None):
    """
    Принимает входящий ref_code (любого формата, включая legacy длинный из
    Salebot/GetCourse) и возвращает (актуальный_ref_code, contact_id).

    Сначала пробуем точное совпадение в contacts.ref_code, затем fallback
    на contacts.merged_ref_codes (туда положены старые ref_code после
    миграции на короткий формат). Это нужно чтобы старые ссылки в воронках
    клиента продолжали резолвиться.

    Возвращает (None, None) если ничего не нашли.
    """
    if not ref_code:
        return None, None

    where_client = ""
    args = [ref_code]
    if client_id:
        where_client = "AND client_id = $2"
        args.append(client_id)

    # 1) Прямое совпадение по актуальному ref_code
    row = await db.fetchrow(
        f"SELECT id, ref_code FROM contacts WHERE ref_code = $1 {where_client} LIMIT 1",
        *args,
    )
    if row:
        return row["ref_code"], row["id"]

    # 2) Fallback: ищем в JSONB-массиве merged_ref_codes (legacy коды)
    row = await db.fetchrow(
        f"SELECT id, ref_code FROM contacts "
        f"WHERE merged_ref_codes ? $1 {where_client} LIMIT 1",
        *args,
    )
    if row:
        return row["ref_code"], row["id"]

    return None, None


async def find_or_create_contact(
    db,
    *,
    client_id: int,
    name: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    salebot_id: Optional[str] = None,
    utm_source: Optional[str] = None,
    tags: Optional[list] = None,
) -> tuple[int, bool]:
    """
    Находит contact по email/phone у клиента или создаёт новый.

    Возвращает (contact_id, is_new). Если автомердж сработал — обновляем
    пустые поля найденного контакта новыми данными.
    """
    email_norm = normalize_email(email)
    phone_norm = normalize_phone(phone)

    found = None
    if email_norm or phone_norm:
        found = await db.fetchrow(
            """SELECT id, name, email, email_normalized, phone, phone_normalized, salebot_id, utm_source
                 FROM contacts
                WHERE client_id = $1 AND is_active = TRUE
                  AND (
                    ($2::TEXT IS NOT NULL AND email_normalized = $2)
                    OR ($3::TEXT IS NOT NULL AND phone_normalized = $3)
                  )
                ORDER BY id LIMIT 1""",
            client_id, email_norm, phone_norm
        )

    if found:
        # Дозаполняем пустые поля (если у нашли есть пробелы — берём из нового импорта)
        await db.execute(
            """UPDATE contacts
                  SET name              = COALESCE(name, $2),
                      email             = COALESCE(email, $3),
                      email_normalized  = COALESCE(email_normalized, $4),
                      phone             = COALESCE(phone, $5),
                      phone_normalized  = COALESCE(phone_normalized, $6),
                      salebot_id        = COALESCE(salebot_id, $7),
                      utm_source        = COALESCE(utm_source, $8),
                      updated_at        = NOW()
                WHERE id = $1""",
            found['id'], name, email, email_norm, phone, phone_norm, salebot_id, utm_source
        )
        return found['id'], False

    # Создаём новый contact с уникальным ref_code
    ref_code = await _generate_unique_ref_code(db)
    contact_id = await db.fetchval(
        """INSERT INTO contacts (client_id, name, email, email_normalized, phone, phone_normalized,
                                  salebot_id, utm_source, tags, ref_code)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::JSONB, '[]'::JSONB), $10)
         RETURNING id""",
        client_id, name, email, email_norm, phone, phone_norm,
        salebot_id, utm_source, tags, ref_code
    )
    return contact_id, True


async def _generate_unique_ref_code(db, max_tries: int = 10) -> str:
    for _ in range(max_tries):
        code = generate_ref_code()
        exists = await db.fetchval("SELECT 1 FROM contacts WHERE ref_code = $1", code)
        if not exists:
            return code
    raise RuntimeError("Не удалось сгенерировать уникальный ref_code за {} попыток".format(max_tries))


async def upsert_platform_user(
    db,
    *,
    contact_id: int,
    client_id: int,
    platform_slug: str,
    platform_user_id: str,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    platform_meta: Optional[dict] = None,
) -> int:
    """
    Создаёт/обновляет идентичность контакта на платформе.

    Возвращает platform_users.id.
    """
    if username and username.startswith('@'):
        username = username[1:]

    existing = await db.fetchrow(
        """SELECT id FROM platform_users
            WHERE client_id = $1 AND platform_slug = $2 AND platform_user_id = $3""",
        client_id, platform_slug, str(platform_user_id)
    )

    if existing:
        await db.execute(
            """UPDATE platform_users
                  SET username      = COALESCE($2, username),
                      first_name    = COALESCE($3, first_name),
                      last_name     = COALESCE($4, last_name),
                      platform_meta = COALESCE($5, platform_meta),
                      updated_at    = NOW()
                WHERE id = $1""",
            existing['id'], username, first_name, last_name, platform_meta
        )
        return existing['id']

    pu_id = await db.fetchval(
        """INSERT INTO platform_users (contact_id, client_id, platform_slug, platform_user_id,
                                        username, first_name, last_name, platform_meta)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id""",
        contact_id, client_id, platform_slug, str(platform_user_id),
        username, first_name, last_name, platform_meta
    )
    return pu_id


async def upsert_contact_with_identity(
    db,
    *,
    client_id: int,
    platform_slug: str,
    platform_user_id: str,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    salebot_id: Optional[str] = None,
    utm_source: Optional[str] = None,
    tags: Optional[list] = None,
    platform_meta: Optional[dict] = None,
) -> tuple[int, int, bool]:
    """
    Главный helper: создаёт/находит contact и привязывает к нему идентичность.

    Возвращает (contact_id, platform_user_id, is_new_contact).

    Логика:
    1. Если идентичность уже существует — берём её contact_id, обновляем поля.
    2. Если нет — автомердж по email/phone находит contact или создаёт новый.
    3. Создаём идентичность с привязкой к contact_id.
    """
    pu_existing = await db.fetchrow(
        """SELECT id, contact_id FROM platform_users
            WHERE client_id = $1 AND platform_slug = $2 AND platform_user_id = $3""",
        client_id, platform_slug, str(platform_user_id)
    )

    if pu_existing:
        # Идентичность есть, обновляем данные платформы и контакт
        if username and username.startswith('@'):
            username = username[1:]
        await db.execute(
            """UPDATE platform_users
                  SET username   = COALESCE($2, username),
                      first_name = COALESCE($3, first_name),
                      last_name  = COALESCE($4, last_name),
                      updated_at = NOW()
                WHERE id = $1""",
            pu_existing['id'], username, first_name, last_name
        )
        # Дозаполняем пустые поля контакта (без замены email/phone — это рискованно)
        contact_name = name_from_parts(first_name, last_name)
        await db.execute(
            """UPDATE contacts
                  SET name             = COALESCE(name, $2),
                      email            = COALESCE(email, $3),
                      email_normalized = COALESCE(email_normalized, $4),
                      phone            = COALESCE(phone, $5),
                      phone_normalized = COALESCE(phone_normalized, $6),
                      salebot_id       = COALESCE(salebot_id, $7),
                      utm_source       = COALESCE(utm_source, $8),
                      last_contact_at  = NOW(),
                      updated_at       = NOW()
                WHERE id = $1""",
            pu_existing['contact_id'], contact_name,
            email, normalize_email(email), phone, normalize_phone(phone),
            salebot_id, utm_source
        )
        return pu_existing['contact_id'], pu_existing['id'], False

    # Идентичности нет — ищем/создаём контакт
    contact_id, is_new = await find_or_create_contact(
        db,
        client_id=client_id,
        name=name_from_parts(first_name, last_name),
        email=email,
        phone=phone,
        salebot_id=salebot_id,
        utm_source=utm_source,
        tags=tags,
    )

    # Контакт нашли по email/phone, но у него уже привязан ДРУГОЙ tg/vk — не можем
    # добавить вторую идентичность той же платформы (UNIQUE contact_id, platform_slug).
    # Один email = один человек, у него может быть TG + VK + MAX, но не два разных TG.
    # Отдаём 409 с человеческим сообщением — указываем какой именно аккаунт уже привязан.
    if not is_new:
        clash = await db.fetchrow(
            """SELECT username FROM platform_users
                WHERE contact_id = $1 AND platform_slug = $2
                  AND platform_user_id <> $3
                ORDER BY id LIMIT 1""",
            contact_id, platform_slug, str(platform_user_id)
        )
        if clash:
            from fastapi import HTTPException
            platform_label = {
                "telegram": "Telegram",
                "vk": "ВКонтакте",
                "max": "MAX",
            }.get(platform_slug, platform_slug)
            matched_by_field = "email" if normalize_email(email) else "телефон"
            matched_by_value = (email or phone or "").strip()
            existing_handle = (clash["username"] or "").strip()
            existing_label = f"@{existing_handle}" if existing_handle else "другой аккаунт"
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{matched_by_field.capitalize()} {matched_by_value} уже привязан к "
                    f"{platform_label}-аккаунту {existing_label}. "
                    f"Введите другой {matched_by_field} или войдите в {platform_label} "
                    "тем аккаунтом, которым регистрировались раньше."
                ),
            )

    pu_id = await upsert_platform_user(
        db,
        contact_id=contact_id,
        client_id=client_id,
        platform_slug=platform_slug,
        platform_user_id=platform_user_id,
        username=username,
        first_name=first_name,
        last_name=last_name,
        platform_meta=platform_meta,
    )

    return contact_id, pu_id, is_new


def name_from_parts(first_name: Optional[str], last_name: Optional[str]) -> Optional[str]:
    parts = [p for p in [first_name, last_name] if p and p.strip()]
    return ' '.join(parts) if parts else None


async def merge_contacts(db, *, primary_id: int, secondary_id: int, client_id: int) -> dict:
    """
    Ручной мердж: переносит все идентичности/события/коллабы со второстепенного
    контакта на главный. Реф-код второстепенного → в merged_ref_codes главного.
    Второстепенный: merged_into = primary_id, is_active = false.

    Возвращает dict со статистикой переноса.
    """
    if primary_id == secondary_id:
        raise ValueError("primary_id и secondary_id совпадают")

    # Проверяем что оба контакта принадлежат тому же клиенту
    rows = await db.fetch(
        "SELECT id, client_id, ref_code, name, email, phone FROM contacts WHERE id = ANY($1::int[])",
        [primary_id, secondary_id]
    )
    by_id = {r['id']: r for r in rows}
    if primary_id not in by_id or secondary_id not in by_id:
        raise ValueError("Один из контактов не найден")
    if by_id[primary_id]['client_id'] != client_id or by_id[secondary_id]['client_id'] != client_id:
        raise ValueError("Контакт принадлежит другому клиенту")

    secondary_ref = by_id[secondary_id]['ref_code']

    async with db.transaction():
        # Перенос идентичностей: если у primary уже есть идентичность на той же платформе — удаляем secondary's
        await db.execute(
            """UPDATE platform_users
                  SET contact_id = $1
                WHERE contact_id = $2
                  AND NOT EXISTS (
                    SELECT 1 FROM platform_users pu2
                     WHERE pu2.contact_id = $1
                       AND pu2.platform_slug = platform_users.platform_slug
                  )""",
            primary_id, secondary_id
        )
        await db.execute("DELETE FROM platform_users WHERE contact_id = $1", secondary_id)

        # Перенос участий: если у primary уже есть участие в том же event — пропускаем secondary
        await db.execute(
            """UPDATE event_participants
                  SET contact_id = $1
                WHERE contact_id = $2
                  AND NOT EXISTS (
                    SELECT 1 FROM event_participants ep2
                     WHERE ep2.contact_id = $1 AND ep2.event_id = event_participants.event_id
                  )""",
            primary_id, secondary_id
        )
        await db.execute("DELETE FROM event_participants WHERE contact_id = $1", secondary_id)

        # Коллабы (если есть)
        await db.execute(
            "UPDATE collaborators SET contact_id = $1 WHERE contact_id = $2",
            primary_id, secondary_id
        )

        # Реф-связи: тех кого привёл secondary → теперь привёл primary
        await db.execute(
            "UPDATE contacts SET first_referrer_contact_id = $1 WHERE first_referrer_contact_id = $2",
            primary_id, secondary_id
        )

        # Обновляем главного: добавляем ref_code второго в merged_ref_codes,
        # дозаполняем пустые поля
        sec = by_id[secondary_id]
        prim = by_id[primary_id]
        await db.execute(
            """UPDATE contacts
                  SET name             = COALESCE(name, $2),
                      email            = COALESCE(email, $3),
                      phone            = COALESCE(phone, $4),
                      email_normalized = COALESCE(email_normalized, LOWER(TRIM($3))),
                      merged_ref_codes = CASE
                          WHEN $5::TEXT IS NULL THEN merged_ref_codes
                          ELSE merged_ref_codes || to_jsonb($5::TEXT)
                      END,
                      updated_at = NOW()
                WHERE id = $1""",
            primary_id, sec['name'], sec['email'], sec['phone'], secondary_ref
        )

        # Soft-delete второстепенного
        await db.execute(
            """UPDATE contacts
                  SET merged_into = $1,
                      is_active   = FALSE,
                      ref_code    = NULL,
                      updated_at  = NOW()
                WHERE id = $2""",
            primary_id, secondary_id
        )

    return {"primary_id": primary_id, "secondary_id": secondary_id, "merged_ref_code": secondary_ref}
