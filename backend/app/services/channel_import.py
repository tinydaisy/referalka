"""
Импорт пользователей в канал из CSV.

Принцип:
- Без telegram_id строка пропускается (без tg_id бот не сможет отправить).
- Существующие поля контакта (name/email/phone/username) НЕ перетираем.
  Если CSV даёт значение, отличное от того что в БД — пишем в отчёт о нестыковках.
- Подписка на канал — перетираем по CSV (это целевое действие импорта).
- Ник: нет в файле — спрашиваем у Telegram (getChat токеном канала импорта).
  Выгрузки ботов ник не отдают, а Telegram его знает — человек писал этому боту.
- utm_source: пишется в contacts.utm_source, если у контакта он ещё пуст.
- Мердж: ищем `platform_users` по (client_id, telegram, tg_id). Не нашли —
  ищем `contacts` по email_normalized или phone_normalized у того же клиента.
  Не нашли — создаём contact + platform_users.

Возвращает stats + текстовый отчёт об ошибках/нестыковках для скачивания пользователем.
"""
import asyncio
import csv
import io
import json
import logging
import re
import secrets
import string
from datetime import datetime, timezone
from typing import Optional

import httpx

log = logging.getLogger(__name__)

_REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# Сколько getChat делаем параллельно. Лимит Telegram ~30 запросов/сек;
# держимся ниже, чтобы не поймать 429 на базе в десять тысяч человек.
_USERNAME_LOOKUP_CONCURRENCY = 20

_HEADER_ALIASES = {
    'telegram_id':       {'telegram_id', 'tg_id', 'tgid', 'telegramid', 'telegram', 'id_telegram', 'tg', 'chat_id'},
    'name':              {'name', 'имя', 'fio', 'fullname', 'full_name', 'фио', 'имя_фамилия'},
    'telegram_username': {'telegram_username', 'username', 'tg_username', 'tg_login', 'login', 'никнейм'},
    'email':             {'email', 'e-mail', 'mail', 'почта', 'емейл', 'емаил'},
    'phone':             {'phone', 'tel', 'phone_number', 'телефон', 'тел'},
    'subscribed':        {'subscribed', 'is_subscribed', 'подписан', 'подписка', 'is_unsubscribed_inverted'},
    'utm_source':        {'utm_source', 'utm', 'source', 'источник', 'utmsource'},
    'subscribed_at':     {'subscribed_at', 'first_contact_at', 'created_at', 'signup_at',
                          'подписался', 'дата_подписки', 'дата_регистрации'},
    'last_contact_at':   {'last_contact_at', 'last_seen_at', 'последний_контакт'},
    'tags':              {'tags', 'user_tags', 'теги', 'метки', 'tag'},
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


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    """Дата из CSV → datetime с таймзоной (UTC).

    Выгрузки ботов отдают unix-таймштамп (BotHelp: `1774621792`), выгрузки из
    таблиц — строку `2026-08-20 14:30:00` или `20.08.2026`. Принимаем всё.
    Не разобрали — None: дата не настолько важна, чтобы ронять из-за неё строку.
    """
    if not value:
        return None
    v = value.strip()
    if not v:
        return None

    # unix-таймштамп (10 цифр — секунды, 13 — миллисекунды)
    if v.isdigit():
        ts = int(v)
        if len(v) == 13:
            ts //= 1000
        # Отсекаем мусор: до 2001 года и слишком далёкое будущее.
        if not (1_000_000_000 < ts < 4_000_000_000):
            return None
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None

    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d',
                '%d.%m.%Y %H:%M:%S', '%d.%m.%Y %H:%M', '%d.%m.%Y'):
        try:
            return datetime.strptime(v[:len(fmt) + 4], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    # ISO с зоной («2026-08-20T14:30:00+03:00») — питон разберёт сам
    try:
        dt = datetime.fromisoformat(v.replace('Z', '+00:00'))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _parse_tags(value: Optional[str]) -> list:
    """Теги из CSV → список строк.

    Разделители — `;` (BotHelp), `,` или `|`. Дубли убираем, порядок держим.
    ⚠️ Регистр НЕ трогаем: в contacts.tags теги лежат как их завёл клиент,
    и «Оплатил» с «оплатил» для него могут быть разными метками.
    """
    if not value:
        return []
    parts = re.split(r'[;,|]', value)
    out = []
    for p in parts:
        t = p.strip()
        if t and t not in out:
            out.append(t)
    return out[:50]  # разумный потолок, чтобы битая колонка не залила базу


async def _merge_tags(db, contact_id: int, new_tags: list) -> bool:
    """Добавляет теги к контакту, не затирая уже существующие.

    ⚠️ Именно ДОБАВЛЯЕТ: теги — это сегментация базы, накопленная клиентом.
    Импорт из одного бота не должен стирать метки, проставленные из другого
    источника (Salebot, вручную, нашими воронками).

    Регистр не нормализуем — в базе живут и «GetCourse», и «ivision»,
    для клиента это разные метки. Дубль считаем только при точном совпадении.

    Возвращает True, если реально что-то добавили.
    """
    if not new_tags:
        return False
    row = await db.fetchrow("SELECT tags FROM contacts WHERE id = $1", contact_id)
    current = row['tags'] if row else None
    if isinstance(current, str):          # asyncpg отдаёт JSONB строкой
        try:
            current = json.loads(current)
        except (ValueError, TypeError):
            current = []
    if not isinstance(current, list):
        current = []

    merged = list(current)
    added = False
    for t in new_tags:
        if t not in merged:
            merged.append(t)
            added = True
    if not added:
        return False

    await db.execute(
        "UPDATE contacts SET tags = $2::JSONB, updated_at = NOW() WHERE id = $1",
        contact_id, json.dumps(merged, ensure_ascii=False)
    )
    return True


async def _fetch_username_by_tg_id(token: str, tg_id: str) -> Optional[str]:
    """Ник по ЧИСЛОВОМУ telegram_id через getChat токеном канала импорта.

    ⚠️ Токен берём именно того канала, в который идёт импорт, а не главного
    канала клиента: getChat отдаёт данные, только если человек писал ИМЕННО
    этому боту. Выгрузка BotHelp — это база конкретного бота, значит его
    токеном ники достаются, а токеном соседнего бота пришло бы chat not found.

    Ошибку не поднимаем: не достали ник — контакт всё равно создаём, ник
    допишется сам, когда человек напишет боту (upsert_contact_with_identity).
    """
    if not token or not tg_id:
        return None
    try:
        async with httpx.AsyncClient(timeout=8.0) as cli:
            r = await cli.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": str(tg_id)},
            )
        data = r.json()
        if not data.get("ok"):
            return None
        return (data.get("result") or {}).get("username") or None
    except Exception as e:  # noqa: BLE001 — сеть не должна ронять импорт
        log.info("getChat(%s) не удался: %s", tg_id, e)
        return None


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
        """SELECT ch.id, ch.platform_slug, ch.display_name, ch.is_system,
                  ch.bot_token, cc.id AS cc_id
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
            "Проверьте заголовки — нужно: telegram_id, name, telegram_username, "
            "email, phone, subscribed, utm_source"
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
        'usernames_resolved': 0,       # ников достали у Telegram (в файле их не было)
        'usernames_already_known': 0,  # ников не спрашивали — они уже были в базе
        'dates_kept': 0,             # строк, где перенесли настоящую дату подписки
        'tags_added': 0,             # контактов, которым добавили теги
    }
    report_lines: list[str] = []
    merge_log: list[dict] = []       # детальный лог объединений (новый tg_id + найден contact по email/phone)
    tg_match_log: list[dict] = []    # детальный лог склеек по tg_id (тот же клиент, другой бот)

    if unknown_headers:
        report_lines.append(f"⚠ Незнакомые колонки в файле (проигнорированы): {', '.join(unknown_headers)}")
        report_lines.append('')

    seen_tg_ids_in_file: dict[str, int] = {}  # tg_id → row_num первой встречи
    row_num = 1  # 1 = заголовок, данные начинаются со 2

    # ─── Ники: достаём у Telegram ДО транзакции ────────────────────────────
    #
    # Выгрузки ботов (BotHelp и подобные) ник не отдают — там только числовой
    # id. Но сам Telegram ник знает: человек писал ЭТОМУ боту, значит getChat
    # по его id отвечает. Токен берём канала импорта — соседний бот на тот же
    # id ответил бы «chat not found».
    #
    # ⚠️ Проход именно ДО транзакции и пачками: 10 000 запросов по одному
    # заняли бы больше получаса, и всё это время висела бы открытая
    # транзакция БД. Пачками по 20 — те же 10 000 проходят за ~10 минут,
    # база при этом не занята.
    data_rows = list(reader)

    tg_col = header_map['telegram_id']
    uname_col = header_map.get('telegram_username')

    def _cell(row: list, idx: Optional[int]) -> Optional[str]:
        if idx is None or idx >= len(row):
            return None
        v = row[idx]
        return v.strip() if v else None

    # Кого спрашивать: валидный id и при этом ника в файле нет.
    need_lookup: list[str] = []
    for row in data_rows:
        tg = _parse_tg_id(_cell(row, tg_col))
        if tg and not _normalize_username(_cell(row, uname_col)):
            need_lookup.append(tg)
    need_lookup = list(dict.fromkeys(need_lookup))  # порядок сохраняем, дубли убираем

    # ⚠️ У кого ник уже есть в базе — у Telegram не спрашиваем.
    # Без этого повторный импорт того же файла заново гонял тысячи getChat
    # ради данных, которые давно лежат в БД: на базе в 10 000 человек это
    # лишние минуты ожидания при каждом запуске.
    if need_lookup:
        known = await db.fetch(
            """SELECT platform_user_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'telegram'
                  AND username IS NOT NULL
                  AND platform_user_id = ANY($2::TEXT[])""",
            client_id, need_lookup
        )
        known_ids = {r['platform_user_id'] for r in known}
        if known_ids:
            need_lookup = [tg for tg in need_lookup if tg not in known_ids]
            stats['usernames_already_known'] = len(known_ids)

    resolved_usernames: dict[str, str] = {}
    bot_token = channel['bot_token'] or ''

    if need_lookup and bot_token:
        sem = asyncio.Semaphore(_USERNAME_LOOKUP_CONCURRENCY)

        async def _one(tg: str):
            async with sem:
                uname = await _fetch_username_by_tg_id(bot_token, tg)
                if uname:
                    resolved_usernames[tg] = uname

        await asyncio.gather(*(_one(tg) for tg in need_lookup))
        stats['usernames_resolved'] = len(resolved_usernames)
    elif need_lookup and not bot_token:
        report_lines.append(
            "⚠ Ники не подтянуты: у канала не задан токен бота. "
            "Подключите бота в разделе «Каналы» — тогда ники подтянутся при импорте."
        )
        report_lines.append('')

    async with db.transaction():
        for row in data_rows:
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
            # Ника в файле не было — берём тот, что достали у Telegram выше.
            if not csv_username:
                csv_username = resolved_usernames.get(tg_id)
            csv_utm      = col('utm_source')
            csv_email    = col('email')
            csv_phone    = col('phone')
            csv_email_n  = _normalize_email(csv_email)
            csv_phone_n  = _normalize_phone(csv_phone)
            csv_tags     = _parse_tags(col('tags'))
            csv_sub_at   = _parse_dt(col('subscribed_at'))
            csv_last_at  = _parse_dt(col('last_contact_at')) or csv_sub_at
            is_subscribed = _parse_subscribed(col('subscribed'), default=True)
            if csv_sub_at:
                stats['dates_kept'] += 1

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
                # Дозаполняем ТОЛЬКО пустые поля — существующие не трогаем.
                # ⚠️ created_at двигаем лишь НАЗАД (LEAST): человек мог прийти
                # к клиенту раньше, чем в этого бота — раннюю дату не затираем.
                # last_contact_at, наоборот, вперёд (GREATEST) — это «последний».
                await db.execute(
                    """UPDATE contacts
                          SET name             = COALESCE(name, $2),
                              phone            = COALESCE(phone, $3),
                              phone_normalized = COALESCE(phone_normalized, $4),
                              utm_source       = COALESCE(utm_source, $5),
                              created_at       = LEAST(created_at, COALESCE($6, created_at)),
                              last_contact_at  = GREATEST(COALESCE(last_contact_at, $7),
                                                          COALESCE($7, last_contact_at), NOW()),
                              updated_at       = NOW()
                        WHERE id = $1""",
                    contact_id, csv_name, csv_phone, csv_phone_n, csv_utm,
                    csv_sub_at, csv_last_at
                )
                if await _merge_tags(db, contact_id, csv_tags):
                    stats['tags_added'] += 1
                # Ник мог появиться только сейчас (в базе его не было).
                if csv_username and not pu['username']:
                    await db.execute(
                        "UPDATE platform_users SET username = $2 WHERE id = $1",
                        platform_user_id, csv_username
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
                                  utm_source       = COALESCE(utm_source, $5),
                                  created_at       = LEAST(created_at, COALESCE($6, created_at)),
                                  last_contact_at  = GREATEST(COALESCE(last_contact_at, $7),
                                                              COALESCE($7, last_contact_at), NOW()),
                                  updated_at       = NOW()
                            WHERE id = $1""",
                        contact_id, csv_name, csv_phone, csv_phone_n, csv_utm,
                        csv_sub_at, csv_last_at
                    )
                    if await _merge_tags(db, contact_id, csv_tags):
                        stats['tags_added'] += 1
                else:
                    # 3. Создаём новый contact
                    ref_code = await _generate_unique_ref_code(db)
                    contact_id = await db.fetchval(
                        """INSERT INTO contacts (client_id, name,
                                                  phone, phone_normalized, ref_code,
                                                  utm_source, tags,
                                                  created_at, last_contact_at)
                           VALUES ($1, $2, $3, $4, $5, $6,
                                   COALESCE($7::JSONB, '[]'::JSONB),
                                   COALESCE($8, NOW()), COALESCE($9, NOW()))
                           RETURNING id""",
                        client_id, csv_name, csv_phone, csv_phone_n, ref_code, csv_utm,
                        json.dumps(csv_tags, ensure_ascii=False) if csv_tags else None,
                        csv_sub_at, csv_last_at
                    )
                    stats['created_contacts'] += 1
                    if csv_tags:
                        stats['tags_added'] += 1

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

            # ⚠️ subscribed_at берём из файла ($4), иначе вся перенесённая база
            # выглядит подписавшейся в день импорта — «давно с нами» и сортировка
            # по стажу ломаются. Даты в файле нет → NOW(), как было.
            if existing_sub:
                if existing_sub['is_unsubscribed'] != target_unsubscribed:
                    await db.execute(
                        """UPDATE platform_user_channels
                              SET is_unsubscribed = $1,
                                  unsubscribed_at = CASE WHEN $1 THEN NOW() ELSE unsubscribed_at END,
                                  subscribed_at   = CASE WHEN $1 THEN subscribed_at
                                                         ELSE COALESCE($4, NOW()) END
                            WHERE platform_user_id = $2 AND client_channel_id = $3""",
                        target_unsubscribed, platform_user_id, client_channel_id, csv_sub_at
                    )
                elif csv_sub_at and not target_unsubscribed:
                    # Подписка уже была и статус тот же — но дату могли не знать
                    # или знать позднюю. Двигаем только НАЗАД.
                    await db.execute(
                        """UPDATE platform_user_channels
                              SET subscribed_at = LEAST(COALESCE(subscribed_at, $3), $3)
                            WHERE platform_user_id = $1 AND client_channel_id = $2""",
                        platform_user_id, client_channel_id, csv_sub_at
                    )
            else:
                await db.execute(
                    """INSERT INTO platform_user_channels (platform_user_id, client_channel_id,
                                                            is_unsubscribed, subscribed_at, unsubscribed_at)
                       VALUES ($1, $2, $3,
                               CASE WHEN $3 THEN NULL ELSE COALESCE($4, NOW()) END,
                               CASE WHEN $3 THEN NOW() ELSE NULL END)""",
                    platform_user_id, client_channel_id, target_unsubscribed, csv_sub_at
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
        f"Ников подтянуто у Telegram (в файле их не было): {stats['usernames_resolved']}",
        f"Ников не запрашивали — уже были в базе: {stats['usernames_already_known']}",
        f"Перенесена настоящая дата подписки: {stats['dates_kept']}",
        f"Контактов, которым добавили теги: {stats['tags_added']}",
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
