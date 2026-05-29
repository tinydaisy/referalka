"""
Импорт пользователей в канал из CSV.

Принцип:
- Без telegram_id строка пропускается (без tg_id бот не сможет отправить).
- Существующие поля контакта (name/email/phone/username) НЕ перетираем.
  Если CSV даёт значение, отличное от того что в БД — пишем в отчёт о нестыковках.
- Подписка на канал — перетираем по CSV (это целевое действие импорта).
- Мердж: ищем `platform_users` по (client_id, telegram, tg_id). Не нашли —
  ищем `contacts` по email_normalized или phone_normalized у того же клиента.
  Не нашли — создаём contact + platform_users.

Возвращает stats + текстовый отчёт об ошибках/нестыковках для скачивания пользователем.
"""
import csv
import io
import re
import secrets
import string
from typing import Optional


_REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

_HEADER_ALIASES = {
    'telegram_id':       {'telegram_id', 'tg_id', 'tgid', 'telegramid', 'telegram', 'id_telegram', 'tg', 'chat_id'},
    'name':              {'name', 'имя', 'fio', 'fullname', 'full_name', 'фио', 'имя_фамилия'},
    'telegram_username': {'telegram_username', 'username', 'tg_username', 'tg_login', 'login', 'никнейм'},
    'email':             {'email', 'e-mail', 'mail', 'почта', 'емейл', 'емаил'},
    'phone':             {'phone', 'tel', 'phone_number', 'телефон', 'тел'},
    'subscribed':        {'subscribed', 'is_subscribed', 'подписан', 'подписка', 'is_unsubscribed_inverted'},
}

_TRUE_VALUES = {'1', 'true', 'yes', 'y', 'да', 'д', 'подписан', 'subscribed', 'on', '+', 'true.', 'истина'}
_FALSE_VALUES = {'0', 'false', 'no', 'n', 'нет', 'н', 'отписан', 'unsubscribed', 'off', '-', 'false.', 'ложь'}


def _normalize_header(h: str) -> Optional[str]:
    """Приводит заголовок к одному из канонических: telegram_id/name/.../subscribed."""
    if not h:
        return None
    h_clean = h.strip().lower().replace('-', '_').replace(' ', '_')
    for canonical, aliases in _HEADER_ALIASES.items():
        if h_clean in aliases:
            return canonical
    return None


def _normalize_email(email: Optional[str]) -> Optional[str]:
    if not email:
        return None
    cleaned = email.strip().lower()
    return cleaned or None


def _normalize_phone(phone: Optional[str]) -> Optional[str]:
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


def _normalize_username(username: Optional[str]) -> Optional[str]:
    if not username:
        return None
    u = username.strip()
    if u.startswith('@'):
        u = u[1:]
    return u or None


def _parse_subscribed(value: Optional[str], default: bool = True) -> bool:
    """Возвращает True (подписан) / False (отписан). Пустое или непонятное → default=подписан."""
    if value is None:
        return default
    v = value.strip().lower()
    if not v:
        return default
    if v in _TRUE_VALUES:
        return True
    if v in _FALSE_VALUES:
        return False
    return default


def _parse_tg_id(value: Optional[str]) -> Optional[str]:
    """Telegram ID — целое число. Возвращает строкой (так хранится в БД)."""
    if not value:
        return None
    v = value.strip()
    if not v:
        return None
    # Допускаем '12345', '12345.0' (Excel часто сохраняет числа так)
    if v.endswith('.0'):
        v = v[:-2]
    if not v.lstrip('-').isdigit():
        return None
    return v


async def _generate_unique_ref_code(db, max_tries: int = 10) -> str:
    for _ in range(max_tries):
        code = ''.join(secrets.choice(_REF_ALPHABET) for _ in range(8))
        exists = await db.fetchval("SELECT 1 FROM contacts WHERE ref_code = $1", code)
        if not exists:
            return code
    raise RuntimeError("Не удалось сгенерировать уникальный ref_code")


async def import_csv_to_channel(
    db,
    *,
    client_id: int,
    channel_id: int,
    file_bytes: bytes,
) -> dict:
    """
    Импортирует пользователей из CSV в канал.

    Возвращает:
    {
      "stats": {...счётчики...},
      "report_text": "...многостроковый отчёт об ошибках/нестыковках..."
    }
    """
    # Проверяем что канал доступен клиенту через client_channels (архитектура G)
    channel = await db.fetchrow(
        """SELECT ch.id, ch.platform_slug, ch.display_name, ch.is_system, cc.id AS cc_id
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE ch.id = $1 AND cc.client_id = $2""",
        channel_id, client_id
    )
    if not channel:
        raise ValueError("Канал не найден")
    if channel['platform_slug'] != 'telegram':
        raise ValueError(f"Импорт пока работает только для Telegram-каналов. Канал «{channel['display_name']}» — на платформе {channel['platform_slug']}.")
    if channel['is_system']:
        raise ValueError("Импорт CSV в системный канал запрещён — подписчики приходят сами через /start или Mini App.")
    client_channel_id: int = channel['cc_id']

    # Декодируем (UTF-8 / UTF-8-BOM / cp1251 — пробуем по очереди)
    text = None
    for encoding in ('utf-8-sig', 'utf-8', 'cp1251', 'windows-1251'):
        try:
            text = file_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ValueError("Не удалось распознать кодировку файла. Сохраните CSV в UTF-8.")

    # Определяем разделитель — , или ;
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
        dialect.delimiter = ','

    reader = csv.reader(io.StringIO(text), dialect=dialect)
    try:
        raw_headers = next(reader)
    except StopIteration:
        raise ValueError("Файл пустой")

    # Маппинг колонок
    header_map = {}  # canonical → column index
    unknown_headers = []
    for idx, h in enumerate(raw_headers):
        canonical = _normalize_header(h)
        if canonical:
            header_map[canonical] = idx
        elif h.strip():
            unknown_headers.append(h.strip())

    if 'telegram_id' not in header_map:
        raise ValueError(
            "В файле нет колонки telegram_id. "
            "Проверьте заголовки — нужно: telegram_id, name, telegram_username, email, phone, subscribed"
        )

    stats = {
        'total_rows': 0,
        'created_contacts': 0,       # новый contact (вообще не нашли в БД клиента)
        'matched_by_tg_id': 0,       # tg_id уже был у клиента (другой бот того же клиента) — обычная склейка
        'merged_by_email_phone': 0,  # ОБЪЕДИНЕНИЕ: новый tg_id, но contact найден по email/phone
        'matched_existing': 0,       # сумма matched_by_tg_id + merged_by_email_phone (legacy)
        'subscribed': 0,
        'unsubscribed': 0,
        'skipped_no_tgid': 0,
        'skipped_invalid_tgid': 0,
        'duplicates_in_file': 0,
        'mismatches': 0,
        'tg_clash_skipped': 0,       # contact найден по email/phone, но у него уже другая TG-identity
    }
    report_lines: list[str] = []
    merge_log: list[dict] = []       # детальный лог объединений (новый tg_id + найден contact по email/phone)
    tg_match_log: list[dict] = []    # детальный лог склеек по tg_id (тот же клиент, другой бот)

    if unknown_headers:
        report_lines.append(f"⚠ Незнакомые колонки в файле (проигнорированы): {', '.join(unknown_headers)}")
        report_lines.append('')

    seen_tg_ids_in_file: dict[str, int] = {}  # tg_id → row_num первой встречи
    row_num = 1  # 1 = заголовок, данные начинаются со 2

    async with db.transaction():
        for row in reader:
            row_num += 1
            stats['total_rows'] += 1

            def col(canonical: str) -> Optional[str]:
                idx = header_map.get(canonical)
                if idx is None or idx >= len(row):
                    return None
                v = row[idx]
                return v.strip() if v else None

            raw_tg = col('telegram_id')
            tg_id = _parse_tg_id(raw_tg)

            if not raw_tg:
                stats['skipped_no_tgid'] += 1
                report_lines.append(f"Строка {row_num}: пропущена — нет telegram_id")
                continue
            if not tg_id:
                stats['skipped_invalid_tgid'] += 1
                report_lines.append(f"Строка {row_num}: пропущена — telegram_id «{raw_tg}» не число")
                continue

            # Дубль внутри файла
            if tg_id in seen_tg_ids_in_file:
                stats['duplicates_in_file'] += 1
                first_row = seen_tg_ids_in_file[tg_id]
                report_lines.append(
                    f"Строка {row_num}: дубль telegram_id={tg_id} (впервые встретился в строке {first_row}). "
                    f"Обработана как обновление, не как новый контакт."
                )
                # Не continue — обрабатываем (CSV-семантика: первая выигрывает по полям, но подписка перетирается)
            else:
                seen_tg_ids_in_file[tg_id] = row_num

            csv_name     = col('name')
            csv_username = _normalize_username(col('telegram_username'))
            csv_email    = col('email')
            csv_phone    = col('phone')
            csv_email_n  = _normalize_email(csv_email)
            csv_phone_n  = _normalize_phone(csv_phone)
            is_subscribed = _parse_subscribed(col('subscribed'), default=True)

            # 1. Ищем platform_users
            pu = await db.fetchrow(
                """SELECT pu.id, pu.contact_id, pu.username,
                          c.name AS c_name,
                          (SELECT pe.platform_user_id FROM platform_users pe
                            WHERE pe.contact_id=c.id AND pe.platform_slug='email'
                            ORDER BY pe.id LIMIT 1) AS c_email,
                          (SELECT pe.platform_user_id FROM platform_users pe
                            WHERE pe.contact_id=c.id AND pe.platform_slug='email'
                            ORDER BY pe.id LIMIT 1) AS email_normalized,
                          c.phone AS c_phone, c.phone_normalized
                     FROM platform_users pu
                     JOIN contacts c ON c.id = pu.contact_id
                    WHERE pu.client_id = $1 AND pu.platform_slug = 'telegram'
                      AND pu.platform_user_id = $2""",
                client_id, tg_id
            )

            contact_id: Optional[int] = None
            platform_user_id: Optional[int] = None

            if pu:
                contact_id = pu['contact_id']
                platform_user_id = pu['id']
                stats['matched_by_tg_id'] += 1
                stats['matched_existing'] += 1
                tg_match_log.append({
                    'row': row_num,
                    'tg_id': tg_id,
                    'contact_id': contact_id,
                    'contact_name': pu['c_name'] or '(без имени)',
                })
                _check_mismatches(
                    report_lines, row_num, tg_id,
                    db_name=pu['c_name'], csv_name=csv_name,
                    db_email=pu['c_email'], db_email_n=pu['email_normalized'], csv_email=csv_email, csv_email_n=csv_email_n,
                    db_phone=pu['c_phone'], db_phone_n=pu['phone_normalized'], csv_phone=csv_phone, csv_phone_n=csv_phone_n,
                    db_username=pu['username'], csv_username=csv_username,
                    stats=stats,
                )
            else:
                # 2. Ищем contact по email/phone (мердж кросс-канал / новая identity у того же человека)
                contact_row = None
                if csv_email_n or csv_phone_n:
                    contact_row = await db.fetchrow(
                        """SELECT c.id, c.name,
                                  (SELECT pe.platform_user_id FROM platform_users pe
                                    WHERE pe.contact_id=c.id AND pe.platform_slug='email'
                                    ORDER BY pe.id LIMIT 1) AS email,
                                  (SELECT pe.platform_user_id FROM platform_users pe
                                    WHERE pe.contact_id=c.id AND pe.platform_slug='email'
                                    ORDER BY pe.id LIMIT 1) AS email_normalized,
                                  c.phone, c.phone_normalized
                             FROM contacts c
                            WHERE c.client_id = $1 AND c.is_active = TRUE
                              AND (
                                ($2::TEXT IS NOT NULL AND EXISTS(
                                   SELECT 1 FROM platform_users pe WHERE pe.contact_id=c.id
                                    AND pe.platform_slug='email' AND pe.platform_user_id=$2))
                                OR ($3::TEXT IS NOT NULL AND c.phone_normalized = $3)
                              )
                            ORDER BY c.id LIMIT 1""",
                        client_id, csv_email_n, csv_phone_n
                    )

                if contact_row:
                    contact_id = contact_row['id']
                    stats['merged_by_email_phone'] += 1
                    stats['matched_existing'] += 1
                    matched_by = []
                    if csv_email_n and contact_row['email_normalized'] == csv_email_n:
                        matched_by.append('email')
                    if csv_phone_n and contact_row['phone_normalized'] == csv_phone_n:
                        matched_by.append('телефон')
                    merge_log.append({
                        'row': row_num,
                        'tg_id': tg_id,
                        'contact_id': contact_id,
                        'contact_name': contact_row['name'] or '(без имени)',
                        'matched_by': '/'.join(matched_by) or 'email/phone',
                        'csv_name': csv_name,
                    })
                    _check_mismatches(
                        report_lines, row_num, tg_id,
                        db_name=contact_row['name'], csv_name=csv_name,
                        db_email=contact_row['email'], db_email_n=contact_row['email_normalized'], csv_email=csv_email, csv_email_n=csv_email_n,
                        db_phone=contact_row['phone'], db_phone_n=contact_row['phone_normalized'], csv_phone=csv_phone, csv_phone_n=csv_phone_n,
                        db_username=None, csv_username=csv_username,
                        stats=stats,
                    )
                    # Дозаполняем ТОЛЬКО пустые поля (грязь не подставляем)
                    await db.execute(
                        """UPDATE contacts
                              SET name             = COALESCE(name, $2),
                                  phone            = COALESCE(phone, $3),
                                  phone_normalized = COALESCE(phone_normalized, $4),
                                  last_contact_at  = NOW(),
                                  updated_at       = NOW()
                            WHERE id = $1""",
                        contact_id, csv_name, csv_phone, csv_phone_n
                    )
                else:
                    # 3. Создаём новый contact
                    ref_code = await _generate_unique_ref_code(db)
                    contact_id = await db.fetchval(
                        """INSERT INTO contacts (client_id, name,
                                                  phone, phone_normalized, ref_code, last_contact_at)
                           VALUES ($1, $2, $3, $4, $5, NOW())
                           RETURNING id""",
                        client_id, csv_name, csv_phone, csv_phone_n, ref_code
                    )
                    stats['created_contacts'] += 1

                # Перед INSERT проверяем: нет ли у contact уже другой TG-identity.
                # UNIQUE (contact_id, platform_slug) запретит INSERT, и это аборнёт всю транзакцию.
                # Поэтому проверяем заранее SELECT'ом.
                clash_tg = await db.fetchval(
                    """SELECT platform_user_id FROM platform_users
                        WHERE contact_id = $1 AND platform_slug = 'telegram'""",
                    contact_id
                )
                if clash_tg:
                    stats['tg_clash_skipped'] += 1
                    report_lines.append(
                        f"Строка {row_num}: telegram_id={tg_id} не привязан — у контакта "
                        f"(совпал по email/phone) уже есть другой TG: {clash_tg}. "
                        f"Подписка на канал не создана."
                    )
                    continue

                platform_user_id = await db.fetchval(
                    """INSERT INTO platform_users (contact_id, client_id, platform_slug,
                                                    platform_user_id, username)
                       VALUES ($1, $2, 'telegram', $3, $4)
                       RETURNING id""",
                    contact_id, client_id, tg_id, csv_username
                )

            # Если в CSV был email — синхронизируем email-идентичность
            # контакта + подписку на главный email-канал клиента (миграция 097).
            # Это обеспечивает, что после импорта CSV email-получатели
            # автоматически попадают в email-рассылку.
            if csv_email_n:
                from app.services.contact_merge import sync_email_identity_and_subscription
                await sync_email_identity_and_subscription(
                    db, client_id=client_id, contact_id=contact_id,
                    email=csv_email_n, first_name=csv_name or None,
                )

            # 4. Подписка на канал — перетираем по CSV (целевое действие импорта).
            # Архитектура G: подписка через client_channel_id (контекст клиент×канал).
            existing_sub = await db.fetchrow(
                """SELECT is_unsubscribed FROM platform_user_channels
                    WHERE platform_user_id = $1 AND client_channel_id = $2""",
                platform_user_id, client_channel_id
            )
            target_unsubscribed = not is_subscribed

            if existing_sub:
                if existing_sub['is_unsubscribed'] != target_unsubscribed:
                    await db.execute(
                        """UPDATE platform_user_channels
                              SET is_unsubscribed = $1,
                                  unsubscribed_at = CASE WHEN $1 THEN NOW() ELSE unsubscribed_at END,
                                  subscribed_at   = CASE WHEN $1 THEN subscribed_at ELSE NOW() END
                            WHERE platform_user_id = $2 AND client_channel_id = $3""",
                        target_unsubscribed, platform_user_id, client_channel_id
                    )
            else:
                await db.execute(
                    """INSERT INTO platform_user_channels (platform_user_id, client_channel_id,
                                                            is_unsubscribed, subscribed_at, unsubscribed_at)
                       VALUES ($1, $2, $3,
                               CASE WHEN $3 THEN NULL ELSE NOW() END,
                               CASE WHEN $3 THEN NOW() ELSE NULL END)""",
                    platform_user_id, client_channel_id, target_unsubscribed
                )

            if is_subscribed:
                stats['subscribed'] += 1
            else:
                stats['unsubscribed'] += 1

    # Финальный заголовок отчёта
    header = [
        f"Отчёт об импорте в канал «{channel['display_name']}»",
        f"Всего строк (без заголовка): {stats['total_rows']}",
        f"Создано новых контактов: {stats['created_contacts']}",
        f"Уже были у клиента (склейка по tg_id, другой бот того же клиента): {stats['matched_by_tg_id']}",
        f"Объединили со старым контактом по email/phone: {stats['merged_by_email_phone']}",
        f"Подписано на канал: {stats['subscribed']}",
        f"Отписано от канала: {stats['unsubscribed']}",
        f"Пропущено без telegram_id: {stats['skipped_no_tgid']}",
        f"Пропущено с невалидным telegram_id: {stats['skipped_invalid_tgid']}",
        f"Дубликатов внутри файла: {stats['duplicates_in_file']}",
        f"Нестыковок (CSV ≠ БД, оставлено как в БД): {stats['mismatches']}",
        f"Пропущено из-за конфликта TG-identity: {stats['tg_clash_skipped']}",
        '',
        '─' * 60,
    ]

    # Раздел: объединения по email/phone (новый tg_id привязан к существующему контакту)
    merge_section: list[str] = []
    if merge_log:
        merge_section.append('')
        merge_section.append(f"ОБЪЕДИНЕНИЯ ПО EMAIL/ТЕЛЕФОНУ — {len(merge_log)}")
        merge_section.append('Новый telegram_id привязан к уже существующему контакту в БД клиента.')
        merge_section.append('')
        for m in merge_log:
            line = (
                f"  Строка {m['row']}: tg_id={m['tg_id']} → contact #{m['contact_id']} "
                f"«{m['contact_name']}» (совпало по {m['matched_by']})"
            )
            if m.get('csv_name') and m['csv_name'].strip().lower() != m['contact_name'].strip().lower():
                line += f" [в CSV имя: «{m['csv_name']}»]"
            merge_section.append(line)
        merge_section.append('')
        merge_section.append('─' * 60)

    # Раздел: склейки по tg_id (этот человек уже был в другом боте этого же клиента)
    tg_match_section: list[str] = []
    if tg_match_log:
        tg_match_section.append('')
        tg_match_section.append(f"СКЛЕЙКА ПО TG_ID — {len(tg_match_log)}")
        tg_match_section.append('Этот telegram_id уже был у клиента (в другом боте). Просто добавили подписку на текущий канал.')
        tg_match_section.append('')
        for m in tg_match_log:
            tg_match_section.append(
                f"  Строка {m['row']}: tg_id={m['tg_id']} → contact #{m['contact_id']} «{m['contact_name']}»"
            )
        tg_match_section.append('')
        tg_match_section.append('─' * 60)

    # Раздел: проблемы и нестыковки
    issues_section: list[str] = ['']
    if report_lines:
        issues_section.append('ЗАМЕЧАНИЯ И ОШИБКИ')
        issues_section.append('')
        issues_section.extend(report_lines)
    else:
        issues_section.append('Замечаний и ошибок нет — все строки обработаны чисто.')

    full_text = '\n'.join(header + merge_section + tg_match_section + issues_section)

    return {
        'stats': stats,
        'report_text': full_text,
        'channel_name': channel['display_name'],
    }


def _check_mismatches(
    report_lines: list,
    row_num: int,
    tg_id: str,
    *,
    db_name: Optional[str], csv_name: Optional[str],
    db_email: Optional[str], db_email_n: Optional[str],
    csv_email: Optional[str], csv_email_n: Optional[str],
    db_phone: Optional[str], db_phone_n: Optional[str],
    csv_phone: Optional[str], csv_phone_n: Optional[str],
    db_username: Optional[str], csv_username: Optional[str],
    stats: dict,
):
    """Сравнивает поля БД и CSV, при отличии непустых значений — пишет в отчёт.
    Не считается отличием: одно из них пусто (тогда мы дозаполняем, не перетираем)."""
    issues = []
    if db_name and csv_name and db_name.strip().lower() != csv_name.strip().lower():
        issues.append(f"имя в базе «{db_name}», в CSV «{csv_name}»")
    if db_email_n and csv_email_n and db_email_n != csv_email_n:
        issues.append(f"email в базе «{db_email}», в CSV «{csv_email}»")
    if db_phone_n and csv_phone_n and db_phone_n != csv_phone_n:
        issues.append(f"телефон в базе «{db_phone}», в CSV «{csv_phone}»")
    if db_username and csv_username and db_username.strip().lower() != csv_username.strip().lower():
        issues.append(f"username в базе «@{db_username}», в CSV «@{csv_username}»")

    if issues:
        stats['mismatches'] += 1
        report_lines.append(
            f"Строка {row_num} (telegram_id={tg_id}): нестыковка — " + '; '.join(issues) +
            ". Оставлено как в базе."
        )
