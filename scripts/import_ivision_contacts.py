# ⚠️ BROKEN_AFTER_036: использует удалённые поля platform_users.platform/email/phone/ref_code/etc.
# Требуется переписать через services/contact_merge.py (find_or_create_contact) — миграция 036.
#!/usr/bin/env python3
"""
Импорт базы Salebot (ivision_2_db.numbers) в platform_users + event_participants.

Логика:
- Все 2333 контакта → platform_users (ON CONFLICT = обновить данные)
- Метка event23042026     → event_participants (is_registered=False), event_id=4
- Метка event23042026_reg → event_participants (is_registered=True),  event_id=4
- ref_code строится по партнёру; если не найден → noname_{partner_id}
- Спикеры ищутся в collaborators по personal_tg_id / personal_tg_username
- Файл undefined.json — случаи когда partner_id есть, но человек не найден
"""

import json
import csv
import re
import os
import sys
import asyncio
from datetime import datetime, timezone

import asyncpg

# ─── Настройки ───────────────────────────────────────────────────────────────
CSV_FILE = os.environ.get('CSV_FILE', '/tmp/ivision_2_db.csv')
UNDEFINED_FILE = os.environ.get('UNDEFINED_FILE', '/tmp/undefined.json')
DATABASE_URL = os.environ.get(
    'DATABASE_URL',
    'postgresql://plusson:plusson@localhost/plusson'
)
CLIENT_ID = 1    # Маргарита Владимировна
EVENT_ID   = 4   # iViSiON-7 конференция

PARTICIPANT_LABELS = {'event23042026', 'event23042026_reg'}

# Поля CSV по индексу
COL = {
    'salebot_id':          0,
    'name':                1,
    'tg_id':               4,
    'created_at':          5,
    'last_contact_at':     6,
    'tags':                8,
    'email':               9,
    'phone':               10,
    'is_registered_client':12,
    'new_partner':         13,
    'new_partner_id':      14,
    'old_partner':         15,
    'old_partner_id':      16,
    'tg_username':         18,
    'utm_source':          44,
    'new_partner_id_order':32,
    'temp_new_partner_id': 45,
    'temp_new_partner':    46,
    'partner_str':         47,
}

# ─── Вспомогательные функции ──────────────────────────────────────────────────

def clean_username(val):
    if not val or str(val).strip() in ('', '---', 'None'):
        return None
    return str(val).strip().lstrip('@')

def clean_id(val):
    if not val or str(val).strip() in ('', '---', 'None'):
        return None
    try:
        return str(int(float(str(val))))
    except Exception:
        return None

def clean_str(val):
    if val is None:
        return None
    s = str(val).strip()
    return s if s and s not in ('---', 'None') else None

def parse_name(name_str):
    if not name_str:
        return None, None
    # Убираем часть после | (типа "Алина | Запуски в TG")
    name_str = name_str.split('|')[0].strip()
    parts = name_str.split(' ', 1)
    first = parts[0] if parts else None
    last  = parts[1] if len(parts) > 1 else None
    return first, last

def parse_tags(tags_str):
    if not tags_str:
        return []
    try:
        items = json.loads(tags_str)
        return [item.get('label_name') for item in items if item.get('label_name')]
    except Exception:
        return []

def parse_dt(val):
    if not val:
        return None
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=timezone.utc)
        return val
    try:
        return datetime.fromisoformat(str(val))
    except Exception:
        return None

def make_ref_code(tg_id, referrer_tg_id=None):
    """ref_code = tg_{tg_id} или tg_{tg_id}_r_{referrer_tg_id}"""
    if referrer_tg_id:
        return f"tg_{tg_id}_r_{referrer_tg_id}"
    return f"tg_{tg_id}"

def make_noname_ref_code(tg_id, partner_id_raw):
    return f"noname_{partner_id_raw}_{tg_id}"

# ─── Загрузка данных из CSV ───────────────────────────────────────────────────

def load_rows():
    rows = []
    with open(CSV_FILE, encoding='utf-8') as f:
        reader = csv.reader(f)
        headers = next(reader)
        for row in reader:
            # дополняем до нужной длины если колонок меньше
            while len(row) < 51:
                row.append(None)
            rows.append(row)
    return rows

# ─── Основной импорт ──────────────────────────────────────────────────────────

async def main():
    print("=== Импорт ivision_2_db → ПЛЮСОН ===\n")

    rows = load_rows()
    print(f"Загружено строк из CSV: {len(rows)}")

    conn = await asyncpg.connect(DATABASE_URL)

    # Загружаем спикеров: {tg_id: cse.ref_code, username: cse.ref_code}
    speaker_by_tg_id  = {}  # str(tg_id) → ref_code спикера (из conf_speaker_events)
    speaker_by_uname  = {}  # username lower → ref_code спикера
    speaker_rows = await conn.fetch("""
        SELECT c.personal_tg_id, c.personal_tg_username, cse.ref_code
        FROM collaborators c
        JOIN conf_speaker_events cse ON cse.speaker_id = c.id
        WHERE cse.event_id = $1
    """, EVENT_ID)
    for sr in speaker_rows:
        if sr['personal_tg_id']:
            speaker_by_tg_id[str(sr['personal_tg_id']).strip()] = sr['ref_code']
        if sr['personal_tg_username']:
            speaker_by_uname[sr['personal_tg_username'].lower().lstrip('@')] = sr['ref_code']
    print(f"Спикеров конфы в БД: {len(speaker_rows)}")

    undefined_cases = []

    # ── Проход 1: залить всех в platform_users (без referrer) ────────────────
    print("\n[1/3] Загрузка контактов в platform_users...")

    inserted_pu = 0
    updated_pu  = 0
    skipped_pu  = 0

    for row in rows:
        tg_id = clean_id(row[COL['tg_id']])
        if not tg_id:
            skipped_pu += 1
            continue

        salebot_id = clean_id(row[COL['salebot_id']])
        first_name, last_name = parse_name(clean_str(row[COL['name']]))
        username    = clean_username(row[COL['tg_username']])
        email       = clean_str(row[COL['email']])
        phone       = clean_str(row[COL['phone']])
        utm_source  = clean_str(row[COL['utm_source']])
        tags        = parse_tags(clean_str(row[COL['tags']]))
        created_at  = parse_dt(row[COL['created_at']])
        last_contact= parse_dt(row[COL['last_contact_at']])

        # ref_code будет проставлен в проходе 2 — пока ставим временный
        temp_ref = f"tg_{tg_id}"

        result = await conn.fetchrow("""
            INSERT INTO platform_users
              (client_id, platform, platform_user_id, username, first_name, last_name,
               salebot_id, email, phone, utm_source, tags, last_contact_at,
               is_unsubscribed, ref_code, created_at, updated_at)
            VALUES ($1,'telegram',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE,$12,$13,NOW())
            ON CONFLICT (client_id, platform, platform_user_id) DO UPDATE SET
              username         = COALESCE(EXCLUDED.username, platform_users.username),
              first_name       = COALESCE(EXCLUDED.first_name, platform_users.first_name),
              last_name        = COALESCE(EXCLUDED.last_name, platform_users.last_name),
              salebot_id       = COALESCE(EXCLUDED.salebot_id, platform_users.salebot_id),
              email            = COALESCE(EXCLUDED.email, platform_users.email),
              phone            = COALESCE(EXCLUDED.phone, platform_users.phone),
              utm_source       = COALESCE(EXCLUDED.utm_source, platform_users.utm_source),
              tags             = COALESCE(EXCLUDED.tags, platform_users.tags),
              last_contact_at  = COALESCE(EXCLUDED.last_contact_at, platform_users.last_contact_at),
              updated_at       = NOW()
            RETURNING id, (xmax = 0) AS is_insert
        """, CLIENT_ID, tg_id, username, first_name, last_name,
             salebot_id, email, phone, utm_source,
             json.dumps(tags) if tags else None,
             last_contact, temp_ref,
             created_at or datetime.now(timezone.utc))

        if result['is_insert']:
            inserted_pu += 1
        else:
            updated_pu += 1

    print(f"  Вставлено: {inserted_pu}, обновлено: {updated_pu}, пропущено (нет tg_id): {skipped_pu}")

    # ── Проход 2: проставляем ref_code с учётом партнёра ─────────────────────
    print("\n[2/3] Проставляем ref_code и referrer...")

    ref_set     = 0
    noname_set  = 0
    no_partner  = 0

    for row in rows:
        tg_id = clean_id(row[COL['tg_id']])
        if not tg_id:
            continue

        salebot_id = clean_id(row[COL['salebot_id']])

        # Собираем кандидатов на партнёра по приоритету
        candidates_by_id = [
            clean_id(row[COL['old_partner_id']]),
            clean_id(row[COL['new_partner_id']]),
            clean_id(row[COL['new_partner_id_order']]),
            clean_id(row[COL['temp_new_partner_id']]),
        ]
        candidates_by_uname = [
            clean_username(row[COL['old_partner']]),
            clean_username(row[COL['new_partner']]),
            clean_username(row[COL['temp_new_partner']]),
            clean_username(row[COL['partner_str']]),
        ]

        referrer_tg_id = None
        found_via      = None
        raw_partner_id = None  # для noname

        # Ищем сначала по tg_id: спикеры → platform_users
        for pid in candidates_by_id:
            if not pid or pid == tg_id:
                continue
            raw_partner_id = pid
            # 1. спикер
            if pid in speaker_by_tg_id:
                referrer_tg_id = pid
                found_via = f"speaker_tg_id:{pid}"
                break
            # 2. platform_users
            pu = await conn.fetchrow("""
                SELECT platform_user_id FROM platform_users
                WHERE client_id=$1 AND platform='telegram' AND platform_user_id=$2
            """, CLIENT_ID, pid)
            if pu:
                referrer_tg_id = pid
                found_via = f"platform_user_tg_id:{pid}"
                break

        # Если не нашли по id — ищем по username
        if not referrer_tg_id:
            for uname in candidates_by_uname:
                if not uname or uname in ('---',):
                    continue
                uname_lower = uname.lower()
                # 1. спикер
                if uname_lower in speaker_by_uname:
                    # восстанавливаем tg_id спикера
                    sp = await conn.fetchrow("""
                        SELECT personal_tg_id FROM collaborators
                        WHERE LOWER(personal_tg_username)=$1
                    """, uname_lower)
                    if sp and sp['personal_tg_id']:
                        referrer_tg_id = str(sp['personal_tg_id'])
                        found_via = f"speaker_uname:{uname}"
                        break
                # 2. platform_users
                pu = await conn.fetchrow("""
                    SELECT platform_user_id FROM platform_users
                    WHERE client_id=$1 AND platform='telegram' AND LOWER(username)=$2
                """, CLIENT_ID, uname_lower)
                if pu:
                    referrer_tg_id = pu['platform_user_id']
                    found_via = f"platform_user_uname:{uname}"
                    break

        # Формируем ref_code
        if referrer_tg_id:
            ref_code = make_ref_code(tg_id, referrer_tg_id)
            ref_set += 1
        elif raw_partner_id:
            # partner_id есть, но никого не нашли — аномалия
            ref_code = make_noname_ref_code(tg_id, raw_partner_id)
            noname_set += 1
            undefined_cases.append({
                'tg_id': tg_id,
                'salebot_id': salebot_id,
                'raw_partner_id': raw_partner_id,
                'candidates_by_uname': [u for u in candidates_by_uname if u],
                'ref_code': ref_code,
            })
        else:
            # Партнёра нет совсем — реф-код просто по tg_id
            ref_code = make_ref_code(tg_id)
            no_partner += 1

        await conn.execute("""
            UPDATE platform_users SET ref_code=$1, updated_at=NOW()
            WHERE client_id=$2 AND platform='telegram' AND platform_user_id=$3
        """, ref_code, CLIENT_ID, tg_id)

    print(f"  С партнёром: {ref_set}")
    print(f"  noname (partner_id есть, человек не найден): {noname_set}")
    print(f"  Без партнёра: {no_partner}")

    # ── Проход 3: event_participants ──────────────────────────────────────────
    print("\n[3/3] Загрузка участников конфы в event_participants...")

    ep_inserted = 0
    ep_updated  = 0

    for row in rows:
        tg_id = clean_id(row[COL['tg_id']])
        if not tg_id:
            continue

        tags = parse_tags(clean_str(row[COL['tags']]))
        has_event  = 'event23042026' in tags
        has_reg    = 'event23042026_reg' in tags

        if not has_event and not has_reg:
            continue

        is_registered = has_reg

        # Берём platform_user id и ref_code из platform_users
        pu = await conn.fetchrow("""
            SELECT id, ref_code FROM platform_users
            WHERE client_id=$1 AND platform='telegram' AND platform_user_id=$2
        """, CLIENT_ID, tg_id)
        if not pu:
            continue

        pu_id    = pu['id']
        ref_code = pu['ref_code']

        # Ищем referrer_participant_id — партнёр должен быть участником этой конфы
        referrer_participant_id = None
        if ref_code and '_r_' in ref_code:
            referrer_tg_id = ref_code.split('_r_')[1]
            ref_pu = await conn.fetchrow("""
                SELECT ep.id FROM event_participants ep
                JOIN platform_users pu ON pu.id = ep.platform_user_id
                WHERE ep.event_id=$1 AND pu.platform_user_id=$2 AND pu.client_id=$3
            """, EVENT_ID, referrer_tg_id, CLIENT_ID)
            if ref_pu:
                referrer_participant_id = ref_pu['id']

        result = await conn.fetchrow("""
            INSERT INTO event_participants
              (event_id, platform_user_id, ref_code, is_registered, referrer_participant_id, registered_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (event_id, platform_user_id) DO UPDATE SET
              is_registered           = GREATEST(event_participants.is_registered, EXCLUDED.is_registered),
              referrer_participant_id = COALESCE(event_participants.referrer_participant_id, EXCLUDED.referrer_participant_id),
              ref_code                = COALESCE(event_participants.ref_code, EXCLUDED.ref_code)
            RETURNING id, (xmax = 0) AS is_insert
        """, EVENT_ID, pu_id, ref_code, is_registered, referrer_participant_id)

        if result['is_insert']:
            ep_inserted += 1
        else:
            ep_updated += 1

    print(f"  Участников вставлено: {ep_inserted}, обновлено: {ep_updated}")

    # ── Сохраняем undefined ───────────────────────────────────────────────────
    with open(UNDEFINED_FILE, 'w', encoding='utf-8') as f:
        json.dump(undefined_cases, f, ensure_ascii=False, indent=2)
    print(f"\nФайл undefined.json: {len(undefined_cases)} записей → {UNDEFINED_FILE}")

    # ── Итоговая статистика ───────────────────────────────────────────────────
    total_pu = await conn.fetchval("SELECT COUNT(*) FROM platform_users WHERE client_id=$1", CLIENT_ID)
    total_ep = await conn.fetchval("SELECT COUNT(*) FROM event_participants WHERE event_id=$1", EVENT_ID)
    reg_ep   = await conn.fetchval("SELECT COUNT(*) FROM event_participants WHERE event_id=$1 AND is_registered=TRUE", EVENT_ID)

    print(f"""
══════════════════════════════════
  Итог импорта
  platform_users (всего):   {total_pu}
  event_participants:        {total_ep}
    из них зарегистрированы: {reg_ep}
  undefined.json:            {len(undefined_cases)}
══════════════════════════════════
""")

    await conn.close()

if __name__ == '__main__':
    asyncio.run(main())
