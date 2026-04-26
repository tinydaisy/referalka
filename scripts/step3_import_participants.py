# ⚠️ BROKEN_AFTER_036: использует удалённые поля platform_users.platform/email/phone/ref_code/etc.
# Требуется переписать через services/contact_merge.py (find_or_create_contact) — миграция 036.
#!/usr/bin/env python3
"""
Шаг 3: Импорт участников конфы iViSiON-7 (event_id=4) из ivision_full+basa.csv.

Предусловие: Steps 1-2 уже выполнены — все контакты в platform_users с заполненным ref_code.

Что делает:
3.1 — Отбирает строки с меткой event23042026, вставляет в event_participants:
      - ref_code берётся из platform_users (уже заполнен)
      - referrer_ref_code = ref_code реферера из platform_users
        (ставится всегда если реферер есть в БД, даже если он не участник конфы —
         тогда они корректно попадут в "Из базы" в отчёте)
      - is_registered = True если метка label_reg или is_registred [client] = 'ok'
3.2 — Синхронизирует conf_speaker_events.ref_code с platform_users.ref_code
      (на случай если остались рассинхронизированные спикеры)
"""

import csv
import json
import os
import asyncio
from datetime import datetime, timezone

import asyncpg

CSV_FILE     = os.environ.get('CSV_FILE', '/Users/macbookair/Documents/projects/referalka/ivision_full+basa.csv')
DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://postgres@localhost/plusson')
CLIENT_ID    = 1   # Маргарита Владимировна
EVENT_ID     = 4   # iViSiON-7

# Колонки в ivision_full+basa.csv (0-based)
COL_TG_ID  = 4    # Идентификатор внутри мессенджера
COL_METKI  = 13   # Метки (JSON с label_name)
COL_IS_REG = 23   # is_registred [client] → 'ok' = зарегистрирован


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


def parse_tags(tags_str):
    if not tags_str:
        return []
    try:
        items = json.loads(tags_str)
        return [item.get('label_name') for item in items if item.get('label_name')]
    except Exception:
        return []


async def main():
    print("=== Шаг 3: Импорт участников конфы из ivision_full+basa.csv ===\n")

    rows = []
    with open(CSV_FILE, encoding='utf-8-sig') as f:
        reader = csv.reader(f, delimiter=';')
        next(reader)  # пропускаем заголовок
        for row in reader:
            while len(row) < max(COL_TG_ID, COL_METKI, COL_IS_REG) + 1:
                row.append(None)
            rows.append(row)
    print(f"Строк в CSV: {len(rows)}")

    conn = await asyncpg.connect(DATABASE_URL)

    # ── Шаг 3.1: event_participants ───────────────────────────────────────────
    print("\n[3.1] Запись в event_participants...")

    ep_inserted  = 0
    ep_updated   = 0
    ep_skipped   = 0   # нет в platform_users
    ep_no_ref    = 0   # нет реферера в БД

    for row in rows:
        tg_id = clean_id(row[COL_TG_ID])
        if not tg_id:
            continue

        tags = parse_tags(clean_str(row[COL_METKI]))
        if 'event23042026' not in tags:
            continue

        is_registered = (
            'label_reg' in tags
            or clean_str(row[COL_IS_REG]) == 'ok'
        )

        # Берём данные из platform_users (ref_code уже заполнен на шагах 1-2)
        pu = await conn.fetchrow("""
            SELECT id, ref_code
            FROM platform_users
            WHERE client_id = $1 AND platform = 'telegram' AND platform_user_id = $2
        """, CLIENT_ID, tg_id)

        if not pu:
            ep_skipped += 1
            print(f"  ⚠ tg_id={tg_id} — нет в platform_users, пропущен")
            continue

        pu_id    = pu['id']
        ref_code = pu['ref_code']

        # referrer_ref_code = ref_code реферера из platform_users
        # Из ref_code вида tg_{id}_r_{referrer_id} извлекаем referrer_id
        referrer_ref_code = None
        if ref_code and '_r_' in ref_code:
            referrer_tg_id = ref_code.split('_r_')[-1]
            referrer_pu = await conn.fetchrow("""
                SELECT ref_code
                FROM platform_users
                WHERE client_id = $1 AND platform = 'telegram' AND platform_user_id = $2
            """, CLIENT_ID, referrer_tg_id)
            if referrer_pu:
                referrer_ref_code = referrer_pu['ref_code']
            else:
                ep_no_ref += 1

        result = await conn.fetchrow("""
            INSERT INTO event_participants
              (event_id, platform_user_id, ref_code, referrer_ref_code,
               is_registered, registered_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (event_id, platform_user_id) DO UPDATE SET
              is_registered     = GREATEST(event_participants.is_registered, EXCLUDED.is_registered),
              referrer_ref_code = COALESCE(event_participants.referrer_ref_code, EXCLUDED.referrer_ref_code),
              ref_code          = COALESCE(event_participants.ref_code, EXCLUDED.ref_code)
            RETURNING id, (xmax = 0) AS is_insert
        """, EVENT_ID, pu_id, ref_code, referrer_ref_code, is_registered)

        if result['is_insert']:
            ep_inserted += 1
        else:
            ep_updated += 1

    print(f"  Вставлено новых: {ep_inserted}")
    print(f"  Обновлено существующих: {ep_updated}")
    print(f"  Пропущено (нет в platform_users): {ep_skipped}")
    print(f"  Без реферера в БД (referrer_ref_code=NULL): {ep_no_ref}")

    # ── Шаг 3.2: Синхронизируем conf_speaker_events.ref_code ─────────────────
    print("\n[3.2] Синхронизация conf_speaker_events.ref_code с platform_users.ref_code...")

    synced  = 0
    no_pu   = 0

    speaker_rows = await conn.fetch("""
        SELECT cse.id, cse.ref_code AS old_code,
               col.personal_tg_id, pu.ref_code AS pu_ref_code
        FROM conf_speaker_events cse
        JOIN collaborators col ON col.id = cse.speaker_id
        LEFT JOIN platform_users pu
               ON pu.platform_user_id = col.personal_tg_id
              AND pu.client_id = $1
        WHERE cse.event_id = $2
    """, CLIENT_ID, EVENT_ID)

    for sr in speaker_rows:
        new_code = sr['pu_ref_code']
        old_code = sr['old_code']
        if not new_code:
            no_pu += 1
            continue
        if new_code != old_code:
            await conn.execute("""
                UPDATE conf_speaker_events SET ref_code = $1 WHERE id = $2
            """, new_code, sr['id'])
            print(f"  Обновлён: {old_code} → {new_code}")
            synced += 1

    print(f"  Обновлено: {synced}, нет в platform_users: {no_pu}, уже актуально: {len(speaker_rows) - synced - no_pu}")

    # ── Итог ─────────────────────────────────────────────────────────────────
    total_ep = await conn.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id = $1", EVENT_ID)
    reg_ep = await conn.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id = $1 AND is_registered = TRUE", EVENT_ID)
    with_referrer = await conn.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id = $1 AND referrer_ref_code IS NOT NULL", EVENT_ID)

    print(f"""
══════════════════════════════════
  Итог
  event_participants (всего):    {total_ep}
    из них зарегистрированы:     {reg_ep}
    с referrer_ref_code:         {with_referrer}
══════════════════════════════════
""")

    await conn.close()


if __name__ == '__main__':
    asyncio.run(main())
