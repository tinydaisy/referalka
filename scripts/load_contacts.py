# ⚠️ BROKEN_AFTER_036: использует удалённые поля platform_users.platform/email/phone/ref_code/etc.
# Требуется переписать через services/contact_merge.py (find_or_create_contact) — миграция 036.
#!/usr/bin/env python3
"""
Загрузка контактов из CSV Salebot в platform_users.
Читает поля по НАЗВАНИЮ колонки.
Рефоводы — отдельным проходом через match_referrers.py.

Использование:
    python3 scripts/load_contacts.py <файл.csv> [client_id=1]
"""

import csv
import sys
import subprocess
from pathlib import Path

SSH_HOST  = "root@62.113.98.30"
DB_NAME   = "plusson"
CLIENT_ID = int(sys.argv[2]) if len(sys.argv) > 2 else 1
CSV_FILE  = sys.argv[1] if len(sys.argv) > 1 else "ivision_full+basa.csv"


def psql(q):
    r = subprocess.run(
        ["ssh", SSH_HOST, f'sudo -u postgres psql -d {DB_NAME} -t -A -F"|" -c "{q}"'],
        capture_output=True, text=True
    )
    return [line.split("|") for line in r.stdout.strip().split("\n") if line.strip()]


def psql_file(sql, path="/tmp/load_contacts.sql"):
    with open(path, "w") as f:
        f.write(sql)
    subprocess.run(["scp", path, f"{SSH_HOST}:{path}"], check=True, capture_output=True)
    r = subprocess.run(
        ["ssh", SSH_HOST, f"sudo -u postgres psql -d {DB_NAME} -f {path}"],
        capture_output=True, text=True
    )
    return r.stdout, r.stderr


def clean(v):
    v = str(v or "").strip()
    return "" if v in ("---", "None", "nan", "0", "") else v


def esc(s):
    if not s:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def split_name(n):
    parts = n.strip().split(None, 1)
    return (parts[0] if parts else ""), (parts[1] if len(parts) > 1 else "")


def parse_date(s):
    s = clean(s)
    if not s:
        return None
    # "2025-01-15 16:32:40 +0300" → убираем timezone offset для psql
    try:
        return s[:19]  # "2025-01-15 16:32:40"
    except:
        return None


def main():
    print(f"Файл: {CSV_FILE}")
    print(f"Client ID: {CLIENT_ID}")

    with open(CSV_FILE, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    print(f"Строк в файле: {len(rows)}")

    # Загружаем существующие tg_id из базы
    existing = set()
    for r in psql(f"SELECT platform_user_id FROM platform_users WHERE platform='telegram' AND client_id={CLIENT_ID}"):
        if r[0].strip():
            existing.add(r[0].strip())
    print(f"Уже в базе: {len(existing)}")

    # Дедупликация по tg_id (берём первую строку)
    seen = {}
    for row in rows:
        tgid = clean(row.get("Идентификатор внутри мессенджера", ""))
        try:
            tgid = str(int(float(tgid)))
        except:
            pass
        if not tgid or tgid.startswith("-"):
            continue
        if tgid not in seen:
            seen[tgid] = row

    print(f"Уникальных tg_id (без отриц.): {len(seen)}")

    to_upsert = []
    for tgid, row in seen.items():
        name     = clean(row.get("Имя", ""))
        fn, ln   = split_name(name) if name else ("", "")
        username = clean(row.get("tg_username [client]", "")).lstrip("@").lower()
        email    = clean(row.get("email [client]", "") or row.get("Email", ""))
        phone    = clean(row.get("phone [client]", "") or row.get("Phone", ""))
        salebot_id = clean(row.get("ID", ""))
        utm      = clean(row.get("utm_source [client]", ""))
        created  = parse_date(row.get("Дата первого контакта", ""))
        last_contact = parse_date(row.get("Дата последнего контакта", ""))
        tags_raw = clean(row.get("Тег", ""))
        is_unsub = clean(row.get("notSubscribed", "")) == "1"

        to_upsert.append({
            "tgid": tgid,
            "username": username,
            "fn": fn,
            "ln": ln,
            "email": email,
            "phone": phone,
            "salebot_id": salebot_id,
            "utm": utm,
            "created": created,
            "last_contact": last_contact,
            "tags": tags_raw,
            "is_unsub": is_unsub,
        })

    print(f"Для upsert: {len(to_upsert)}")

    BATCH = 100
    total_done = 0
    errors = 0

    for i in range(0, len(to_upsert), BATCH):
        batch = to_upsert[i:i+BATCH]
        vals = []
        for r in batch:
            created_sql   = esc(r["created"])   if r["created"]      else "NOW()"
            last_sql      = esc(r["last_contact"]) if r["last_contact"] else "NULL"
            vals.append(
                f"({CLIENT_ID}, 'telegram', {esc(r['tgid'])}, {esc(r['username'])}, "
                f"{esc(r['fn'])}, {esc(r['ln'])}, {esc(r['salebot_id'])}, "
                f"{esc(r['email'])}, {esc(r['phone'])}, {esc(r['utm'])}, "
                f"{created_sql}, {last_sql}, {esc(r['tags'])}, "
                f"{'TRUE' if r['is_unsub'] else 'FALSE'})"
            )

        sql = (
            "INSERT INTO platform_users "
            "(client_id, platform, platform_user_id, username, first_name, last_name, "
            "salebot_id, email, phone, utm_source, created_at, last_contact_at, tags, is_unsubscribed) "
            "VALUES " + ",\n".join(vals) + "\n"
            "ON CONFLICT (client_id, platform, platform_user_id) DO UPDATE SET\n"
            "  username        = COALESCE(NULLIF(EXCLUDED.username, ''),        platform_users.username),\n"
            "  first_name      = COALESCE(NULLIF(EXCLUDED.first_name, ''),      platform_users.first_name),\n"
            "  last_name       = COALESCE(NULLIF(EXCLUDED.last_name, ''),       platform_users.last_name),\n"
            "  email           = COALESCE(NULLIF(EXCLUDED.email, ''),           platform_users.email),\n"
            "  phone           = COALESCE(NULLIF(EXCLUDED.phone, ''),           platform_users.phone),\n"
            "  salebot_id      = COALESCE(NULLIF(EXCLUDED.salebot_id, ''),      platform_users.salebot_id),\n"
            "  utm_source      = COALESCE(NULLIF(EXCLUDED.utm_source, ''),      platform_users.utm_source),\n"
            "  tags            = COALESCE(NULLIF(EXCLUDED.tags, ''),            platform_users.tags),\n"
            "  last_contact_at = COALESCE(EXCLUDED.last_contact_at,             platform_users.last_contact_at),\n"
            "  is_unsubscribed = EXCLUDED.is_unsubscribed,\n"
            "  updated_at      = NOW()"
        )

        out, err = psql_file(sql)
        if "ERROR" in err:
            print(f"  ОШИБКА batch {i}: {err[:300]}")
            errors += 1
        else:
            total_done += len(batch)
            if (i // BATCH) % 5 == 0:
                print(f"  Обработано: {total_done}/{len(to_upsert)}")

    # Финальный счёт
    total_db = psql(f"SELECT COUNT(*) FROM platform_users WHERE platform='telegram' AND client_id={CLIENT_ID}")[0][0]
    unsub_db = psql(f"SELECT COUNT(*) FROM platform_users WHERE platform='telegram' AND client_id={CLIENT_ID} AND is_unsubscribed=TRUE")[0][0]

    print(f"\n=== ГОТОВО ===")
    print(f"Обработано строк:  {total_done}")
    print(f"Ошибок:            {errors}")
    print(f"Итого в базе:      {total_db}")
    print(f"  подписаны:       {int(total_db) - int(unsub_db)}")
    print(f"  отписались:      {unsub_db}")


if __name__ == "__main__":
    main()
