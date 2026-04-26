# ⚠️ BROKEN_AFTER_036: использует удалённые поля platform_users.platform/email/phone/ref_code/etc.
# Требуется переписать через services/contact_merge.py (find_or_create_contact) — миграция 036.
#!/usr/bin/env python3
"""
Загрузка отписавшихся контактов из ivision_unsubsribed.csv в platform_users.
Читает поля по НАЗВАНИЮ колонки, не по порядку.

После загрузки — запустить match_referrers.py для сопоставления рефереров.
"""

import csv
import subprocess
import sys

SSH_HOST = "root@62.113.98.30"
DB_NAME  = "plusson"
CLIENT_ID = 1
CSV_FILE  = "ivision_unsubsribed.csv"


def psql(query):
    r = subprocess.run(
        ["ssh", SSH_HOST, f'sudo -u postgres psql -d {DB_NAME} -t -A -F"|" -c "{query}"'],
        capture_output=True, text=True
    )
    return [line.split("|") for line in r.stdout.strip().split("\n") if line.strip()]


def psql_cmd(sql):
    r = subprocess.run(
        ["ssh", SSH_HOST, f'sudo -u postgres psql -d {DB_NAME} -c "{sql}"'],
        capture_output=True, text=True
    )
    return r.stdout.strip(), r.stderr.strip()


def esc(s):
    if not s:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def clean(s):
    if not s:
        return ""
    s = s.strip()
    if s in ("---", "None", "nan", "0"):
        return ""
    return s


def clean_username(s):
    s = clean(s).lstrip("@").lower()
    return s


def split_name(full_name):
    parts = full_name.strip().split(None, 1)
    first = parts[0] if parts else ""
    last  = parts[1] if len(parts) > 1 else ""
    return first, last


def main():
    with open(CSV_FILE, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f, delimiter=";"))

    print(f"Строк в файле: {len(rows)}")

    # Загружаем уже существующие tg_id из базы
    existing = set()
    for r in psql(f"SELECT platform_user_id FROM platform_users WHERE platform='telegram' AND client_id={CLIENT_ID}"):
        if r[0].strip():
            existing.add(r[0].strip())
    print(f"В базе уже: {len(existing)} контактов")

    inserts = []
    updates = []

    for row in rows:
        tg_id   = clean(row.get("Идентификатор внутри мессенджера", ""))
        name    = clean(row.get("Имя", ""))
        username = clean_username(row.get("tg_username [client]", ""))
        email   = clean(row.get("email [client]", "") or row.get("Email", ""))
        phone   = clean(row.get("phone [client]", "") or row.get("Phone", ""))
        salebot_id = clean(row.get("ID", ""))
        utm     = clean(row.get("utm_source [client]", ""))
        tags_raw = clean(row.get("Метки", ""))

        if not tg_id:
            continue

        first_name, last_name = split_name(name) if name else ("", "")

        if tg_id in existing:
            # Обновляем — помечаем как отписавшегося
            updates.append(tg_id)
        else:
            inserts.append({
                "tg_id": tg_id,
                "username": username,
                "first_name": first_name,
                "last_name": last_name,
                "email": email,
                "phone": phone,
                "salebot_id": salebot_id,
                "utm": utm,
            })

    print(f"Новых для вставки: {len(inserts)}")
    print(f"Существующих для update is_unsubscribed: {len(updates)}")

    # Вставляем новых пачками по 100
    BATCH = 100
    inserted = 0
    for i in range(0, len(inserts), BATCH):
        batch = inserts[i:i+BATCH]
        vals = []
        for r in batch:
            vals.append(
                f"({CLIENT_ID}, 'telegram', {esc(r['tg_id'])}, {esc(r['username'])}, "
                f"{esc(r['first_name'])}, {esc(r['last_name'])}, "
                f"{esc(r['salebot_id'])}, {esc(r['email'])}, {esc(r['phone'])}, "
                f"{esc(r['utm'])}, TRUE)"
            )
        sql = (
            "INSERT INTO platform_users "
            "(client_id, platform, platform_user_id, username, first_name, last_name, "
            "salebot_id, email, phone, utm_source, is_unsubscribed) "
            "VALUES " + ",".join(vals) + " "
            "ON CONFLICT (client_id, platform, platform_user_id) DO UPDATE SET "
            "is_unsubscribed=TRUE, "
            "username=COALESCE(EXCLUDED.username, platform_users.username), "
            "first_name=COALESCE(NULLIF(EXCLUDED.first_name,''), platform_users.first_name), "
            "last_name=COALESCE(NULLIF(EXCLUDED.last_name,''), platform_users.last_name), "
            "email=COALESCE(NULLIF(EXCLUDED.email,''), platform_users.email), "
            "phone=COALESCE(NULLIF(EXCLUDED.phone,''), platform_users.phone), "
            "updated_at=NOW()"
        )
        out, err = psql_cmd(sql)
        if err and "ERROR" in err:
            print(f"  ОШИБКА batch {i}: {err[:200]}")
        else:
            inserted += len(batch)
            if i % 500 == 0:
                print(f"  Вставлено: {inserted}/{len(inserts)}")

    # Обновляем существующих
    if updates:
        tgids_str = ",".join(esc(t) for t in updates)
        sql = (
            f"UPDATE platform_users SET is_unsubscribed=TRUE, updated_at=NOW() "
            f"WHERE platform='telegram' AND client_id={CLIENT_ID} "
            f"AND platform_user_id IN ({tgids_str})"
        )
        out, err = psql_cmd(sql)
        if err and "ERROR" in err:
            print(f"  ОШИБКА update: {err[:200]}")
        else:
            print(f"  Обновлено is_unsubscribed=TRUE: {len(updates)}")

    print(f"\nГотово: вставлено {inserted} новых, обновлено {len(updates)} существующих")


if __name__ == "__main__":
    main()
