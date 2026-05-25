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
    lookup_telegram_username: Optional[str] = None,
) -> tuple[int, bool]:
    """
    Находит contact по email/phone у клиента или создаёт новый.

    Возвращает (contact_id, is_new). Если автомердж сработал — обновляем
    пустые поля найденного контакта новыми данными.

    lookup_telegram_username: дополнительный fallback-поиск по TG-нику через
    platform_users (когда email/phone не нашли ничего). Используется
    интеграциями (GetCourse), где tg_id неизвестен, но в форме просили ник.
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

    # Fallback: ищем по TG-нику если email/phone не дали результата.
    if not found and lookup_telegram_username:
        tg_contact_id = await find_contact_by_telegram_username(
            db, client_id=client_id, telegram_username=lookup_telegram_username,
        )
        if tg_contact_id:
            found = await db.fetchrow(
                """SELECT id, name, email, email_normalized, phone, phone_normalized, salebot_id, utm_source
                     FROM contacts WHERE id = $1 AND is_active = TRUE""",
                tg_contact_id,
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
        # Sync email-идентичности + подписки на главный email-канал клиента.
        # Запускаем только если email был передан — иначе не трогаем существующую.
        if email_norm:
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=found['id'],
                email=email_norm, first_name=name,
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
    # Sync email-канала для нового контакта
    if email_norm:
        await sync_email_identity_and_subscription(
            db, client_id=client_id, contact_id=contact_id,
            email=email_norm, first_name=name,
        )
    return contact_id, True


async def _generate_unique_ref_code(db, max_tries: int = 10) -> str:
    for _ in range(max_tries):
        code = generate_ref_code()
        exists = await db.fetchval("SELECT 1 FROM contacts WHERE ref_code = $1", code)
        if not exists:
            return code
    raise RuntimeError("Не удалось сгенерировать уникальный ref_code за {} попыток".format(max_tries))


async def sync_email_identity_and_subscription(
    db,
    *,
    client_id: int,
    contact_id: int,
    email: Optional[str],
    first_name: Optional[str] = None,
) -> Optional[int]:
    """
    После INSERT/UPDATE contacts.email — синхронизирует email-идентичность
    в platform_users + подписку в platform_user_channels на главный
    email-канал клиента.

    Возвращает platform_users.id (email-идентичность) или None если email пустой.

    Логика:
    1. Нормализуем email. Если пустой → ничего не делаем, возвращаем None.
    2. Ищем существующую email-identity у contact (UNIQUE contact_id+platform_slug).
       - Есть и совпадает → берём её id.
       - Есть и НЕ совпадает (email сменился) → UPDATE platform_user_id.
         Может упасть на UNIQUE(client_id, slug, platform_user_id) если этот
         email уже занят другим контактом → подавляем и возвращаем существующую.
       - Нет → INSERT новую identity.
    3. Находим главный (is_active=TRUE) email-канал клиента через client_channels.
       Если нет — выходим (системный канал должен быть привязан миграцией 097,
       это страховка от рассинхрона).
    4. Делаем upsert подписки platform_user_channels для этой identity на этот канал.
       НЕ перезатираем is_unsubscribed=TRUE — если контакт уже отписался,
       сохраняем его выбор.
    """
    email_norm = normalize_email(email)
    if not email_norm:
        return None

    # 1) Ищем существующую email-идентичность контакта
    existing = await db.fetchrow(
        """SELECT id, platform_user_id FROM platform_users
            WHERE contact_id = $1 AND platform_slug = 'email'
            LIMIT 1""",
        contact_id,
    )

    pu_id: Optional[int] = None
    if existing:
        if existing["platform_user_id"] == email_norm:
            pu_id = existing["id"]
        else:
            # email сменился — пробуем UPDATE
            try:
                await db.execute(
                    """UPDATE platform_users
                          SET platform_user_id = $2,
                              first_name = COALESCE($3, first_name),
                              updated_at = NOW()
                        WHERE id = $1""",
                    existing["id"], email_norm, first_name,
                )
                pu_id = existing["id"]
            except Exception:
                # Конфликт: новый email уже привязан к другому контакту того же клиента.
                # Оставляем старую идентичность как есть — этот случай обработает
                # ручной мердж контактов или 409 на уровне API.
                pu_id = existing["id"]
    else:
        # 2) INSERT новой email-identity
        try:
            pu_id = await db.fetchval(
                """INSERT INTO platform_users
                       (contact_id, client_id, platform_slug, platform_user_id, first_name)
                    VALUES ($1, $2, 'email', $3, $4)
                 RETURNING id""",
                contact_id, client_id, email_norm, first_name,
            )
        except Exception:
            # Конфликт UNIQUE (client_id, platform_slug, platform_user_id) —
            # этот email уже привязан к другому contact_id у того же клиента.
            # Берём существующую запись и не падаем — подписку всё равно
            # привяжем на ту identity.
            other = await db.fetchrow(
                """SELECT id FROM platform_users
                    WHERE client_id = $1 AND platform_slug = 'email'
                      AND platform_user_id = $2
                    LIMIT 1""",
                client_id, email_norm,
            )
            if not other:
                # Странный случай — не получилось ни вставить, ни найти. Выходим.
                return None
            pu_id = other["id"]

    if not pu_id:
        return None

    # 3) Главный email-канал клиента
    client_channel_id = await db.fetchval(
        """SELECT cc.id
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'email'
              AND cc.is_active = TRUE
            ORDER BY cc.added_at LIMIT 1""",
        client_id,
    )
    if not client_channel_id:
        # У клиента нет email-канала вообще (рассинхрон с миграцией 097).
        # Идентичность создали — на этом всё.
        return pu_id

    # 4) Подписка (не перезаписываем is_unsubscribed!)
    await db.execute(
        """INSERT INTO platform_user_channels
               (platform_user_id, client_channel_id, subscribed_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (platform_user_id, client_channel_id) DO NOTHING""",
        pu_id, client_channel_id,
    )

    return pu_id


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


async def find_contact_by_telegram_username(
    db, *, client_id: int, telegram_username: str
) -> Optional[int]:
    """Ищет contact по TG-юзернейму через platform_users у этого клиента.
    Регистр игнорируется, ведущий @ убирается. Возвращает contact_id или None."""
    handle = (telegram_username or "").strip().lstrip('@')
    if not handle:
        return None
    return await db.fetchval(
        """SELECT contact_id FROM platform_users
            WHERE client_id = $1 AND platform_slug = 'telegram'
              AND lower(username) = lower($2)
            ORDER BY id LIMIT 1""",
        client_id, handle,
    )


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
    lookup_telegram_username: Optional[str] = None,
) -> tuple[int, int, bool]:
    """
    Главный helper: создаёт/находит contact и привязывает к нему идентичность.

    Возвращает (contact_id, platform_user_id, is_new_contact).

    Логика:
    1. Если идентичность уже существует — берём её contact_id, обновляем поля.
    2. Если нет — автомердж по email/phone находит contact (или ищем по
       lookup_telegram_username если email/phone не нашли), иначе создаём новый.
    3. Создаём идентичность с привязкой к contact_id.

    lookup_telegram_username: TG-ник для поиска существующего контакта (используется
    интеграциями типа GetCourse, где tg_id неизвестен, но в форме просили ник).
    На создание TG-идентичности не влияет — только поиск.
    """
    pu_existing = await db.fetchrow(
        """SELECT id, contact_id FROM platform_users
            WHERE client_id = $1 AND platform_slug = $2 AND platform_user_id = $3""",
        client_id, platform_slug, str(platform_user_id)
    )

    # Псевдо-запись от коллаборатора (project_collaborator_pseudo_platform_users):
    # организатор создал коллаба с @username без числового id → запись
    # platform_users существует с placeholder `platform_user_id='@<username>'`.
    # Когда настоящий юзер с этим ником впервые пишет в бот — находим
    # псевдо и обновляем её на реальный числовой id. Контакт остаётся тот,
    # которому организатор привязал коллаба.
    if not pu_existing and username:
        uname_clean = username.lstrip('@').strip()
        if uname_clean:
            pseudo = await db.fetchrow(
                """SELECT id, contact_id FROM platform_users
                    WHERE client_id = $1 AND platform_slug = $2
                      AND platform_user_id = $3
                    LIMIT 1""",
                client_id, platform_slug, f"@{uname_clean}",
            )
            if pseudo:
                # Защита: убедимся что реальный id ещё не занят другим контактом
                # (если такое — оставляем псевдо как есть и не апгрейдим).
                conflict = await db.fetchval(
                    """SELECT contact_id FROM platform_users
                        WHERE client_id = $1 AND platform_slug = $2
                          AND platform_user_id = $3 AND id <> $4
                        LIMIT 1""",
                    client_id, platform_slug, str(platform_user_id), pseudo["id"],
                )
                if conflict is None:
                    await db.execute(
                        """UPDATE platform_users
                              SET platform_user_id = $1,
                                  username         = $2,
                                  first_name       = COALESCE($3, first_name),
                                  last_name        = COALESCE($4, last_name),
                                  updated_at       = NOW()
                            WHERE id = $5""",
                        str(platform_user_id), uname_clean,
                        first_name, last_name, pseudo["id"],
                    )
                    # Снимаем is_unsubscribed=TRUE который был установлен при
                    # создании псевдо-записи — юзер реально подписался (написал боту).
                    await db.execute(
                        """UPDATE platform_user_channels
                              SET is_unsubscribed = FALSE,
                                  subscribed_at   = COALESCE(subscribed_at, NOW()),
                                  unsubscribed_at = NULL
                            WHERE platform_user_id = $1
                              AND is_unsubscribed = TRUE""",
                        pseudo["id"],
                    )
                    # Возвращаем как существующую идентичность — это и есть upsert.
                    pu_existing = pseudo

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
        # Если был передан email — синхронизируем email-канал.
        # (existing identity ≠ email; email — это поле контакта, синхронизация
        # касается отдельной email-identity у этого же contact_id)
        if email:
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=pu_existing['contact_id'],
                email=email, first_name=contact_name,
            )
        return pu_existing['contact_id'], pu_existing['id'], False

    # Идентичности нет — ищем/создаём контакт. TG-ник передаём как fallback
    # для случаев, когда email/phone не нашли ничего (например, GetCourse
    # webhook без email, но со скрытым полем telegram_username из формы).
    contact_id, is_new = await find_or_create_contact(
        db,
        client_id=client_id,
        name=name_from_parts(first_name, last_name),
        email=email,
        phone=phone,
        salebot_id=salebot_id,
        utm_source=utm_source,
        tags=tags,
        lookup_telegram_username=lookup_telegram_username,
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
        # Перед DELETE secondary's event_participants нужно разрулить FK
        # event_participants.referrer_participant_id, который ссылается на
        # удаляемые записи. Если у primary есть participant в том же событии —
        # переключаем FK на primary's participant; иначе обнуляем.
        await db.execute(
            """UPDATE event_participants child
                  SET referrer_participant_id = (
                    SELECT ep_primary.id
                      FROM event_participants ep_secondary
                      JOIN event_participants ep_primary
                        ON ep_primary.event_id = ep_secondary.event_id
                       AND ep_primary.contact_id = $1
                     WHERE ep_secondary.id = child.referrer_participant_id
                     LIMIT 1
                  )
                WHERE child.referrer_participant_id IN (
                  SELECT id FROM event_participants WHERE contact_id = $2
                )""",
            primary_id, secondary_id,
        )
        # Если выше подзапрос вернул NULL (у primary нет участия в этом событии) —
        # FK просто становится NULL (а не невалидным), и DELETE проходит.
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

        # Soft-delete второстепенного. ref_code НЕ обнуляем (миграция 060
        # сделала его NOT NULL). Secondary остаётся со своим ref_code, но
        # с merged_into != NULL и is_active = FALSE — резолверы должны
        # фильтровать `merged_into IS NULL` и/или ходить через
        # primary.merged_ref_codes (куда secondary_ref уже добавлен выше).
        await db.execute(
            """UPDATE contacts
                  SET merged_into = $1,
                      is_active   = FALSE,
                      updated_at  = NOW()
                WHERE id = $2""",
            primary_id, secondary_id
        )

        # Если у primary в результате остался email — убедимся, что
        # email-идентичность и подписка на главный email-канал на месте.
        # (мог быть кейс: secondary имел email, primary — нет → теперь у
        # primary email есть, identity ещё не было)
        primary_email_after = await db.fetchval(
            "SELECT email FROM contacts WHERE id = $1",
            primary_id,
        )
        if primary_email_after:
            primary_name_after = await db.fetchval(
                "SELECT name FROM contacts WHERE id = $1", primary_id
            )
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=primary_id,
                email=primary_email_after, first_name=primary_name_after,
            )

    return {"primary_id": primary_id, "secondary_id": secondary_id, "merged_ref_code": secondary_ref}
