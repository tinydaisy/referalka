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
        # Email живёт как идентичность в platform_users(platform_slug='email'),
        # НЕ в contacts.email. Поэтому дедуп по email идёт через идентичность.
        # Телефон — по contacts.phone_normalized (платформы phone нет).
        found = await db.fetchrow(
            """SELECT c.id, c.name, c.phone, c.phone_normalized, c.salebot_id, c.utm_source
                 FROM contacts c
                WHERE c.client_id = $1 AND c.is_active = TRUE
                  AND (
                    ($2::TEXT IS NOT NULL AND EXISTS (
                       SELECT 1 FROM platform_users pe
                        WHERE pe.contact_id = c.id
                          AND pe.platform_slug = 'email'
                          AND pe.platform_user_id = $2))
                    OR ($3::TEXT IS NOT NULL AND c.phone_normalized = $3)
                  )
                ORDER BY c.id LIMIT 1""",
            client_id, email_norm, phone_norm
        )

    # Fallback: ищем по TG-нику если email/phone не дали результата.
    if not found and lookup_telegram_username:
        tg_contact_id = await find_contact_by_telegram_username(
            db, client_id=client_id, telegram_username=lookup_telegram_username,
        )
        if tg_contact_id:
            found = await db.fetchrow(
                """SELECT id, name, phone, phone_normalized, salebot_id, utm_source
                     FROM contacts WHERE id = $1 AND is_active = TRUE""",
                tg_contact_id,
            )

    if found:
        # Дозаполняем пустые поля (email НЕ трогаем — он живёт как идентичность,
        # синхронизируется ниже через sync_email_identity_and_subscription).
        await db.execute(
            """UPDATE contacts
                  SET name              = COALESCE(name, $2),
                      phone             = COALESCE(phone, $3),
                      phone_normalized  = COALESCE(phone_normalized, $4),
                      salebot_id        = COALESCE(salebot_id, $5),
                      utm_source        = COALESCE(utm_source, $6),
                      updated_at        = NOW()
                WHERE id = $1""",
            found['id'], name, phone, phone_norm, salebot_id, utm_source
        )
        # Sync email-идентичности + подписки на главный email-канал клиента.
        # Запускаем только если email был передан — иначе не трогаем существующую.
        if email_norm:
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=found['id'],
                email=email_norm, first_name=name,
            )
        return found['id'], False

    # Создаём новый contact с уникальным ref_code.
    # email НЕ пишем в contacts — он создаётся как идентичность ниже.
    ref_code = await _generate_unique_ref_code(db)
    contact_id = await db.fetchval(
        """INSERT INTO contacts (client_id, name, phone, phone_normalized,
                                  salebot_id, utm_source, tags, ref_code)
            VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::JSONB, '[]'::JSONB), $8)
         RETURNING id""",
        client_id, name, phone, phone_norm,
        salebot_id, utm_source, tags, ref_code
    )
    # Sync email-канала для нового контакта
    if email_norm:
        await sync_email_identity_and_subscription(
            db, client_id=client_id, contact_id=contact_id,
            email=email_norm, first_name=name,
        )
    await _after_contact_created(db, client_id)
    return contact_id, True


async def _after_contact_created(db, client_id: int) -> None:
    """Проверка лимита контактов тарифа после создания нового контакта.

    ⚠️ Вызывается ПОСЛЕ вставки, а не до: контакт создаётся всегда, даже сверх
    лимита (человек сам пришёл в бот — терять его нельзя). Проверка лишь
    переводит клиента на подходящий тариф и шлёт уведомления.

    ⚠️ Никогда не бросает исключение — сбой проверки не должен ронять
    регистрацию человека.
    """
    try:
        from app.services.contact_limits import check_contact_limit
        from app.services.contact_limit_notify import notify_contact_limit
        event = await check_contact_limit(db, client_id)
        if event:
            await notify_contact_limit(db, client_id, event)
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning(
            "contact limit hook failed (client %s): %s", client_id, e)


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
    known_contact_id: Optional[int] = None,
) -> tuple[int, int, bool]:
    """
    Главный helper: создаёт/находит contact и привязывает к нему идентичность.

    Возвращает (contact_id, platform_user_id, is_new_contact).

    Логика:
    1. Если идентичность уже существует — берём её contact_id, обновляем поля.
    2. Если передан known_contact_id (человек пришёл по ссылке, в которой зашит
       его contact_id) — привязываем новую идентичность к ЭТОМУ контакту, не
       плодя дубль. Это ключ против дублей при переходе между платформами:
       зарегался в VK → перешёл по кнопке в TG со своим contact_id → его TG
       становится новой platform_users внутри того же контакта.
    3. Иначе — автомердж по email/phone находит contact (или ищем по
       lookup_telegram_username если email/phone не нашли), иначе создаём новый.
    4. Создаём идентичность с привязкой к contact_id.

    lookup_telegram_username: TG-ник для поиска существующего контакта (используется
    интеграциями типа GetCourse, где tg_id неизвестен, но в форме просили ник).
    На создание TG-идентичности не влияет — только поиск.

    known_contact_id: contact_id из ссылки/кнопки. Используется только если
    идентичности ещё нет И контакт принадлежит тому же client_id И не смерджен.
    Иначе тихо игнорируется (fallback на обычный автомердж).
    """
    # Защита от гонки: Mini App иногда шлёт event_start ДВАЖДЫ за одну секунду
    # (двойной useEffect / повтор запроса). Два параллельных вызова с одним
    # tg_id оба не находят идентичность → оба создают контакт → второй падает
    # на UNIQUE при вставке identity и оставляет ПУСТОЙ контакт-сироту («Без
    # имени»). Берём транзакционный advisory-lock по (client_id, platform,
    # platform_user_id) — параллельные вызовы сериализуются, второй дождётся
    # первого и увидит уже созданную идентичность в SELECT ниже.
    # hashtext даёт стабильный bigint-ключ; lock держится до конца транзакции.
    lock_key = f"{client_id}:{platform_slug}:{platform_user_id}"
    in_tx = db.is_in_transaction() if hasattr(db, "is_in_transaction") else False
    if in_tx:
        await db.execute("SELECT pg_advisory_xact_lock(hashtext($1))", lock_key)
        return await _upsert_contact_with_identity_locked(
            db, client_id=client_id, platform_slug=platform_slug,
            platform_user_id=platform_user_id, username=username,
            first_name=first_name, last_name=last_name, email=email, phone=phone,
            salebot_id=salebot_id, utm_source=utm_source, tags=tags,
            platform_meta=platform_meta,
            lookup_telegram_username=lookup_telegram_username,
            known_contact_id=known_contact_id,
        )
    # Нет внешней транзакции — открываем свою, чтобы xact-lock реально держался.
    async with db.transaction():
        await db.execute("SELECT pg_advisory_xact_lock(hashtext($1))", lock_key)
        return await _upsert_contact_with_identity_locked(
            db, client_id=client_id, platform_slug=platform_slug,
            platform_user_id=platform_user_id, username=username,
            first_name=first_name, last_name=last_name, email=email, phone=phone,
            salebot_id=salebot_id, utm_source=utm_source, tags=tags,
            platform_meta=platform_meta,
            lookup_telegram_username=lookup_telegram_username,
            known_contact_id=known_contact_id,
        )


async def _upsert_contact_with_identity_locked(
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
    known_contact_id: Optional[int] = None,
) -> tuple[int, int, bool]:
    """Внутренняя реализация upsert — вызывается под advisory-lock (см. выше).
    Вся прежняя логика без изменений."""
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
        # Дозаполняем пустые поля контакта (email НЕ трогаем — идентичность, sync ниже)
        contact_name = name_from_parts(first_name, last_name)
        await db.execute(
            """UPDATE contacts
                  SET name             = COALESCE(name, $2),
                      phone            = COALESCE(phone, $3),
                      phone_normalized = COALESCE(phone_normalized, $4),
                      salebot_id       = COALESCE(salebot_id, $5),
                      utm_source       = COALESCE(utm_source, $6),
                      last_contact_at  = NOW(),
                      updated_at       = NOW()
                WHERE id = $1""",
            pu_existing['contact_id'], contact_name,
            phone, normalize_phone(phone),
            salebot_id, utm_source
        )
        if normalize_email(email):
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=pu_existing['contact_id'],
                email=normalize_email(email), first_name=first_name,
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

    # Идентичности нет. Сначала пробуем known_contact_id (из ссылки): человек
    # уже есть в базе под этим контактом, просто впервые заходит на новой
    # платформе — привязываем идентичность к нему, дубль не плодим.
    contact_id = None
    is_new = False
    if known_contact_id:
        target = await db.fetchrow(
            """SELECT id FROM contacts
                WHERE id = $1 AND client_id = $2 AND merged_into IS NULL""",
            int(known_contact_id), client_id,
        )
        if target:
            # У контакта уже может быть идентичность на ЭТОЙ платформе с ДРУГИМ
            # id (например два разных TG) — тогда привязать нельзя (UNIQUE
            # contact_id+platform_slug). В этом случае откатываемся на обычный
            # автомердж, чтобы не упасть.
            same_platform = await db.fetchval(
                """SELECT platform_user_id FROM platform_users
                    WHERE contact_id = $1 AND platform_slug = $2 LIMIT 1""",
                target["id"], platform_slug,
            )
            if same_platform is None or str(same_platform) == str(platform_user_id):
                contact_id = target["id"]
                # дозаполним пустые поля контакта
                await db.execute(
                    """UPDATE contacts
                          SET name             = COALESCE(name, $2),
                              phone            = COALESCE(phone, $3),
                              phone_normalized = COALESCE(phone_normalized, $4),
                              utm_source       = COALESCE(utm_source, $5),
                              last_contact_at  = NOW(),
                              updated_at       = NOW()
                        WHERE id = $1""",
                    contact_id, name_from_parts(first_name, last_name),
                    phone, normalize_phone(phone), utm_source,
                )

    # Если по known_contact_id не привязались — обычный автомердж по email/phone.
    # TG-ник передаём как fallback (GetCourse webhook без email, но со скрытым
    # полем telegram_username из формы).
    if contact_id is None:
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

    if is_new:
        await _after_contact_created(db, client_id)
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
        "SELECT id, client_id, ref_code, name, phone FROM contacts WHERE id = ANY($1::int[])",
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

        # Реферер per-событие при конфликте участий.
        # Если оба контакта участвуют в ОДНОМ событии, у primary-участия
        # реферер ПУСТОЙ, а у secondary-участия — заполнен, то перед удалением
        # secondary's переносим его реферера на выжившее primary-участие.
        # Правило: «непустой реферер, иначе от самого раннего участия».
        # primary = самый ранний контакт, поэтому его участие приоритетно;
        # добираем реферера у secondary только когда у primary его нет.
        # Переносим ТОЛЬКО referrer_ref_code (строку) — она самодостаточна и
        # резолвится через resolve_ref_code. referrer_participant_id у secondary
        # указывает на участие, которое ниже будет удалено → не копируем его,
        # чтобы не оставить битый FK; он опционален и пересчитывается при выдаче.
        await db.execute(
            """UPDATE event_participants ep_primary
                  SET referrer_ref_code = ep_secondary.referrer_ref_code
                 FROM event_participants ep_secondary
                WHERE ep_primary.contact_id = $1
                  AND ep_secondary.contact_id = $2
                  AND ep_secondary.event_id = ep_primary.event_id
                  AND (ep_primary.referrer_ref_code IS NULL OR ep_primary.referrer_ref_code = '')
                  AND ep_secondary.referrer_ref_code IS NOT NULL
                  AND ep_secondary.referrer_ref_code <> ''""",
            primary_id, secondary_id,
        )

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
        # email НЕ переносим как поле — email-идентичность (platform_users)
        # уже переехала на главного выше через UPDATE platform_users.
        await db.execute(
            """UPDATE contacts
                  SET name             = COALESCE(name, $2),
                      phone            = COALESCE(phone, $3),
                      merged_ref_codes = CASE
                          WHEN $4::TEXT IS NULL THEN merged_ref_codes
                          ELSE merged_ref_codes || to_jsonb($4::TEXT)
                      END,
                      updated_at = NOW()
                WHERE id = $1""",
            primary_id, sec['name'], sec['phone'], secondary_ref
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

        # Email-идентичность переносится вместе с остальными platform_users выше
        # (почта живёт только там, колонки contacts.email нет — миграция 282),
        # поэтому досинхронизировать её отдельно больше не нужно.

    return {"primary_id": primary_id, "secondary_id": secondary_id, "merged_ref_code": secondary_ref}


async def merge_contacts_oldest_primary(db, *, contact_a: int, contact_b: int, client_id: int) -> dict:
    """Слить два контакта, главным выбрав САМЫЙ РАННИЙ (меньший id = создан раньше).

    Возвращает результат merge_contacts + поле `noop=True`, если это один и тот же
    контакт (уже объединены или одна идентичность). Реферер на событие
    разруливается внутри merge_contacts по правилу «непустой, иначе от раннего».
    """
    if contact_a == contact_b:
        return {"noop": True, "primary_id": contact_a}
    primary_id, secondary_id = (contact_a, contact_b) if contact_a < contact_b else (contact_b, contact_a)
    result = await merge_contacts(
        db, primary_id=primary_id, secondary_id=secondary_id, client_id=client_id
    )
    result["noop"] = False
    return result


async def find_contact_by_identity(db, *, client_id: int, platform_slug: str, platform_user_id: str) -> Optional[int]:
    """Найти АКТИВНЫЙ contact_id по идентичности (client_id, platform, platform_user_id).

    Если контакт уже смержен (merged_into != NULL) — возвращаем главного.
    None, если такой идентичности у клиента нет.
    """
    row = await db.fetchrow(
        """SELECT pu.contact_id, c.merged_into
             FROM platform_users pu
             JOIN contacts c ON c.id = pu.contact_id
            WHERE c.client_id = $1
              AND pu.platform_slug = $2
              AND pu.platform_user_id = $3
            ORDER BY pu.id DESC LIMIT 1""",
        client_id, platform_slug, str(platform_user_id),
    )
    if not row:
        return None
    return row["merged_into"] or row["contact_id"]


async def merge_my_account_with_identity(
    db,
    *,
    client_id: int,
    current_contact_id: int,
    other_platform_slug: str,
    other_platform_user_id: str,
) -> dict:
    """Точка входа «Объединить аккаунты» из любого бота.

    Человек находится в одном боте (current_contact_id — его контакт там), вводит
    свой ID на другой площадке. Находим контакт той идентичности у ЭТОГО клиента и
    сливаем, главным оставляя самый ранний контакт.

    Возвращает dict:
      {"status": "merged", "primary_id": N, "merged_ref_code": "..."}
      {"status": "already"}                  — это уже один контакт
      {"status": "not_found"}                — у клиента нет такой идентичности
    """
    other_contact_id = await find_contact_by_identity(
        db, client_id=client_id,
        platform_slug=other_platform_slug,
        platform_user_id=other_platform_user_id,
    )
    if other_contact_id is None:
        return {"status": "not_found"}
    if other_contact_id == current_contact_id:
        return {"status": "already"}
    res = await merge_contacts_oldest_primary(
        db, contact_a=current_contact_id, contact_b=other_contact_id, client_id=client_id
    )
    return {
        "status": "merged",
        "primary_id": res.get("primary_id"),
        "merged_ref_code": res.get("merged_ref_code"),
    }

# ─────────────────────────────────────────────────────────────────────────────
# «Это вы?» — когда данные формы указывают на РАЗНЫХ людей
# ─────────────────────────────────────────────────────────────────────────────
def mask_email(email: Optional[str]) -> Optional[str]:
    """ma••••ta@mail.ru — первые/последние буквы до @, домен как есть."""
    if not email or "@" not in email:
        return email
    local, dom = email.split("@", 1)
    if len(local) <= 2:
        return local[0] + "•••@" + dom
    return f"{local[:2]}••••{local[-2:]}@{dom}"


def mask_phone(phone: Optional[str]) -> Optional[str]:
    """+791••••••234 — первые 4 цифры и 3 последних."""
    if not phone:
        return phone
    digits = "".join(ch for ch in phone if ch.isdigit() or ch == "+")
    if len(digits) <= 7:
        return digits
    return digits[:4] + "•" * max(0, len(digits) - 7) + digits[-3:]


async def resolve_or_ask(db, client_id: int, email, phone, tg_username,
                         vk_username=None, max_username=None,
                         known_contact_id=None):
    """Кого записывать: конкретный контакт, выбор человека или новый.

    ⚠️ Правило опирается на то, что уникально В БАЗЕ:
      • email и ники площадок (Telegram, ВКонтакте, MAX) — уникальны у
        клиента: ограничение на platform_users не даст одному нику
        принадлежать двум контактам, поэтому спорить не о чем. Сейчас формы
        спрашивают только Telegram, но правило написано на все площадки —
        добавите поле, оно заработает само;
      • телефон — обычное поле в contacts, БЕЗ ограничения: два человека
        могут делить один номер (семья, рабочий).

    Отсюда:
      • совпал только email → это он;
      • совпал только ник площадки → это он;
      • email и ник (или ники разных площадок) указывают на РАЗНЫХ людей →
        спрашиваем;
      • совпал только телефон → спрашиваем (номер не доказательство);
      • ничего не совпало → новый контакт.

    Возвращает (contact_id, candidates, can_create_new):
      • contact_id задан — записываем сразу;
      • иначе candidates непуст — показываем «Это вы?»;
      • can_create_new — можно ли предложить «я здесь впервые». Нельзя, если
        email или ник УЖЕ в базе: они уникальны, второй контакт с ними просто
        не создастся (упрёмся в ограничение). Кнопка врала бы человеку.
    """
    en = normalize_email(email)
    pn = normalize_phone(phone)
    nick = (tg_username or "").strip().lstrip("@")

    by_email = None
    if en:
        by_email = await db.fetchval(
            "SELECT c.id FROM contacts c WHERE c.client_id=$1 AND c.is_active=TRUE "
            "  AND EXISTS (SELECT 1 FROM platform_users pu WHERE pu.contact_id=c.id "
            "              AND pu.platform_slug='email' AND pu.platform_user_id=$2) "
            "LIMIT 1",
            client_id, en)

    # Ники площадок: сейчас формы спрашивают только Telegram, остальные
    # заведены на будущее — логика от площадки не зависит.
    by_platform: dict = {}
    if nick:
        cid = await find_contact_by_telegram_username(
            db, client_id=client_id, telegram_username=nick)
        if cid:
            by_platform["telegram"] = cid
    for slug, uname in (("vk", vk_username), ("max", max_username)):
        u = (uname or "").strip().lstrip("@")
        if not u:
            continue
        cid = await db.fetchval(
            "SELECT contact_id FROM platform_users "
            " WHERE client_id=$1 AND platform_slug=$2 AND LOWER(username)=LOWER($3) "
            " LIMIT 1",
            client_id, slug, u)
        if cid:
            by_platform[slug] = cid

    found = set(by_platform.values())
    if by_email:
        found.add(by_email)

    # ⚠️ Контакт, ПОД КОТОРЫМ человек зашёл (Mini App, бот, ссылка с ?c=), —
    # такой же полноправный кандидат, как введённые руками данные. Иначе
    # получается абсурд: человек сидит под своим аккаунтом, опечатался в нике
    # и указал почту второго своего аккаунта — а себя в списке не видит.
    known = None
    if known_contact_id:
        known = await db.fetchval(
            "SELECT id FROM contacts WHERE id=$1 AND client_id=$2 "
            "AND is_active=TRUE AND merged_into IS NULL",
            int(known_contact_id), client_id)
        if known:
            found.add(known)

    # Разные ключи указывают на РАЗНЫХ людей: только человек знает, кто он.
    if len(found) > 1:
        cands = await find_contact_candidates(
            db, client_id, email, phone, tg_username, known_contact_id=known)
        return None, cands, False

    if by_email:
        return by_email, [], False
    if by_platform:
        return next(iter(by_platform.values())), [], False

    # Введённое руками ни на кого не указало, но человек зашёл под своим
    # аккаунтом — это он и есть, переспрашивать не о чем.
    if known:
        return known, [], False

    # Остался только телефон — он не уникален, поэтому спрашиваем.
    # Здесь «я здесь впервые» уместно: ни email, ни ника в базе нет.
    if pn:
        cands = await find_contact_candidates(db, client_id, None, phone, None)
        if cands:
            return None, cands, True

    return None, [], True


async def known_contact_fields(db, client_id: int, contact_id) -> dict:
    """Что мы уже знаем о человеке — для предзаполнения форм.

    ⚠️ Одна точка на ВСЕ формы с ручным вводом (заказ тарифа, анкета,
    авторизация в вебинарной комнате). Пришедший из Mini App или бота уже
    опознан, и заставлять его набирать имя, почту и ник заново — значит
    провоцировать опечатки: так появляются записи, где ник от одного аккаунта,
    а почта от другого, и форма спрашивает «это вы?» вместо дела.

    ⚠️ Контакт обязан принадлежать этому клиенту: иначе по чужому id из
    адресной строки можно было бы подсмотреть почту и телефон постороннего.

    Пустой словарь — контакт не найден или чужой.
    """
    if not contact_id:
        return {}
    row = await db.fetchrow(
        """SELECT c.name, c.phone,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'email'
                    LIMIT 1) AS email,
                  (SELECT COALESCE(NULLIF(pu.username, ''),
                                   NULLIF(LTRIM(pu.platform_user_id, '@'), ''))
                     FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram'
                    ORDER BY (pu.username IS NULL), pu.id LIMIT 1) AS tg
             FROM contacts c
            WHERE c.id = $1 AND c.client_id = $2
              AND c.is_active = TRUE AND c.merged_into IS NULL""",
        int(contact_id), client_id)
    if not row:
        return {}
    return {
        "name": row["name"] or "",
        "email": row["email"] or "",
        "phone": row["phone"] or "",
        "telegram_username": (row["tg"] or "").lstrip("@"),
    }


async def find_contact_candidates(
    db, client_id: int, email, phone, tg_username, known_contact_id=None,
):
    """Все контакты клиента, подходящие по email / телефону / TG-нику.

    ⚠️ Нужна там, где человек вводит данные РУКАМИ: email может принадлежать
    одному его аккаунту, а телефон — другому. Молча взять первый нельзя
    (заказ уйдёт не тому), сливать автоматически — тем более. Показываем
    найденных и просим выбрать себя.

    ⚠️ known_contact_id — контакт, ПОД КОТОРЫМ человек зашёл (из Mini App, бота
    или ссылки с ?c=). Он добавляется к найденным ВСЕГДА, даже если введённые
    руками данные на него не указывают. Иначе выходит абсурд: человек сидит под
    своим аккаунтом, опечатался в нике и почте — и себя в списке не находит.

    Контакты возвращаются с ЗАМАСКИРОВАННЫМИ данными: по чужому email нельзя
    подсмотреть чужой телефон.
    """
    ids = set()
    if known_contact_id:
        # Сверяем принадлежность клиенту: id приходит из адресной строки.
        own = await db.fetchval(
            "SELECT id FROM contacts WHERE id=$1 AND client_id=$2 "
            "AND is_active=TRUE AND merged_into IS NULL",
            int(known_contact_id), client_id)
        if own:
            ids.add(own)
    en = normalize_email(email)
    pn = normalize_phone(phone)
    if en:
        rows = await db.fetch(
            "SELECT c.id FROM contacts c WHERE c.client_id=$1 AND c.is_active=TRUE AND EXISTS "
            "(SELECT 1 FROM platform_users pu WHERE pu.contact_id=c.id "
            " AND pu.platform_slug='email' AND pu.platform_user_id=$2)",
            client_id, en)
        ids.update(r["id"] for r in rows)
    if pn:
        rows = await db.fetch(
            "SELECT id FROM contacts WHERE client_id=$1 AND is_active=TRUE "
            "AND phone_normalized=$2", client_id, pn)
        ids.update(r["id"] for r in rows)
    if tg_username:
        cid = await find_contact_by_telegram_username(
            db, client_id=client_id, telegram_username=tg_username)
        if cid:
            ids.add(cid)
    if not ids:
        return []
    rows = await db.fetch(
        "SELECT c.id, c.name, c.phone, "
        "  (SELECT pu.platform_user_id FROM platform_users pu "
        "     WHERE pu.contact_id=c.id AND pu.platform_slug='email' LIMIT 1) AS email "
        "FROM contacts c WHERE c.id = ANY($1::int[]) ORDER BY c.id", list(ids))

    # ⚠️ Показываем ВСЕ известные площадки человека, а не только email с
    # телефоном: по нику в MAX или ВК он узнает себя быстрее, чем по
    # замаскированной почте. Ники маскировать не нужно — они и так публичны.
    accounts = await db.fetch(
        "SELECT contact_id, platform_slug, username, platform_user_id "
        "  FROM platform_users "
        " WHERE contact_id = ANY($1::int[]) AND platform_slug <> 'email' "
        " ORDER BY contact_id, platform_slug", list(ids))
    by_contact: dict = {}
    for a in accounts:
        nick = (a["username"] or "").strip().lstrip("@")
        if not nick:
            pid = str(a["platform_user_id"] or "")
            # Псевдо-запись '@ник' — ник берём из неё; числовой id не показываем.
            nick = pid[1:] if pid.startswith("@") else ""
        if not nick:
            continue
        by_contact.setdefault(a["contact_id"], []).append(
            {"platform": a["platform_slug"], "username": nick})

    return [{"id": r["id"], "name": r["name"],
             "email": mask_email(r["email"]), "phone": mask_phone(r["phone"]),
             "accounts": by_contact.get(r["id"], [])}
            for r in rows]


async def create_new_contact(
    db, *, client_id: int, name=None, email=None, phone=None, utm_source=None,
) -> int:
    """Создать заведомо НОВЫЙ контакт, минуя автомердж.

    ⚠️ Нужна для кнопки «Я здесь впервые» на экране «Это вы?»: человек
    посмотрел найденные записи и сказал, что это не он. Обычный
    find_or_create_contact снова нашёл бы старый контакт по email — и выбор
    человека был бы проигнорирован.
    """
    contact_id = await db.fetchval(
        """INSERT INTO contacts (client_id, name, phone, phone_normalized,
                                 utm_source, ref_code)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id""",
        client_id, name, phone, normalize_phone(phone), utm_source,
        await _generate_unique_ref_code(db),
    )
    if normalize_email(email):
        await sync_email_identity_and_subscription(
            db, client_id=client_id, contact_id=contact_id,
            email=normalize_email(email), first_name=name,
        )
    return contact_id
