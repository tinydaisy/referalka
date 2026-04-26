# ⚠️ BROKEN_AFTER_036: использует удалённые поля platform_users.platform/email/phone/ref_code/etc.
# Требуется переписать через services/contact_merge.py (find_or_create_contact) — миграция 036.
#!/usr/bin/env python3
"""
Импорт участников из report_513177_part1 5.csv
Шаги:
  1. Upsert platform_users (контакты)
  2. Определить рефоводов → referrer_tg_id, referrer_ref_code в platform_users
  3. Участники с меткой event23042026 → event_participants
  3.1. Скопировать ref_code и referrer_ref_code
  4. Участники с меткой event23042026_reg → is_registered = true
"""

import csv
import json
import asyncio
import asyncpg
import secrets
import string
import os

DB_URL = "postgresql://plusson:PlussonDB2026!@localhost:5432/plusson"
CSV_FILE = os.environ.get("CSV_FILE", "/var/www/plusson/report_part1_6.csv")
EVENT_ID = 4
CLIENT_ID = 1

# Алиасы: salebot tg_id → реальный tg_id в ПЛЮСОН
ALIASES = {
    "7976854412": "392695076",
}

def clean_username(u):
    if not u:
        return None
    return u.lstrip("@").strip() or None

def generate_ref_code():
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))

async def get_unique_ref_code(db):
    for _ in range(20):
        code = generate_ref_code()
        exists = await db.fetchval(
            "SELECT 1 FROM platform_users WHERE ref_code = $1 UNION SELECT 1 FROM event_participants WHERE ref_code = $1",
            code, code
        )
        if not exists:
            return code
    raise Exception("Не удалось сгенерировать уникальный ref_code")

def parse_labels(labels_str):
    """Парсит JSON-строку меток, возвращает set label_name."""
    if not labels_str:
        return set()
    try:
        labels = json.loads(labels_str)
        return {l["label_name"] for l in labels if "label_name" in l}
    except Exception:
        return set()

def get_partner_tg_id(row, headers):
    """Возвращает tg_id рефовода по приоритету: old_partner_id > new_partner_id > partner_str."""
    idx = {h: i for i, h in enumerate(headers)}

    old_partner_id = row[idx.get("old_partner_id [client]", -1)].strip() if idx.get("old_partner_id [client]") is not None else ""
    new_partner_id = row[idx.get("new_partner_id [client]", -1)].strip() if idx.get("new_partner_id [client]") is not None else ""
    partner_str = row[idx.get("partner_str [order]", -1)].strip() if idx.get("partner_str [order]") is not None else ""

    # Применяем алиасы
    for field in [old_partner_id, new_partner_id, partner_str]:
        if field:
            return ALIASES.get(field, field)
    return None

async def find_referrer_ref_code(db, partner_tg_id, event_id):
    """Ищет ref_code рефовода: сначала collaborators, потом platform_users."""
    if not partner_tg_id:
        return None, None

    # 1. Коллабораторы — по personal_tg_id
    row = await db.fetchrow(
        """SELECT cse.ref_code FROM conf_speaker_events cse
           JOIN collaborators c ON c.id = cse.speaker_id
           WHERE c.personal_tg_id = $1 AND cse.event_id = $2""",
        partner_tg_id, event_id
    )
    if row and row["ref_code"]:
        return partner_tg_id, row["ref_code"]

    # 2. Коллабораторы — по personal_tg_username
    row = await db.fetchrow(
        """SELECT cse.ref_code FROM conf_speaker_events cse
           JOIN collaborators c ON c.id = cse.speaker_id
           WHERE c.personal_tg_username = $1 AND cse.event_id = $2""",
        partner_tg_id, event_id
    )
    if row and row["ref_code"]:
        return partner_tg_id, row["ref_code"]

    # 3. platform_users — по platform_user_id
    row = await db.fetchrow(
        """SELECT platform_user_id, ref_code FROM platform_users
           WHERE platform_user_id = $1 AND client_id = $2""",
        partner_tg_id, CLIENT_ID
    )
    if row and row["ref_code"]:
        return row["platform_user_id"], row["ref_code"]

    # 4. platform_users — по username
    row = await db.fetchrow(
        """SELECT platform_user_id, ref_code FROM platform_users
           WHERE username = $1 AND client_id = $2""",
        clean_username(partner_tg_id), CLIENT_ID
    )
    if row and row["ref_code"]:
        return row["platform_user_id"], row["ref_code"]

    return partner_tg_id, None

async def main():
    db = await asyncpg.connect(DB_URL)

    unresolved = []  # рефоводы которых не нашли

    with open(CSV_FILE, encoding="utf-8-sig") as f:
        reader = csv.reader(f, delimiter=";")
        headers = next(reader)
        rows = list(reader)

    idx = {h: i for i, h in enumerate(headers)}

    print(f"Загружено строк: {len(rows)}")

    # ── ШАГ 1: Upsert platform_users ─────────────────────────────────────────
    print("\n=== ШАГ 1: Контакты (platform_users) ===")
    step1_new = 0
    step1_updated = 0

    for row in rows:
        salebot_id = row[idx["ID"]].strip()
        tg_id = row[idx["Идентификатор внутри мессенджера"]].strip()
        tg_id = ALIASES.get(tg_id, tg_id)
        if not tg_id:
            continue

        first_name = row[idx["Имя"]].strip() or None
        username = clean_username(row[idx.get("tg_username [client]", -1)].strip() if idx.get("tg_username [client]") is not None else "")
        email = row[idx.get("Email", -1)].strip() or None if idx.get("Email") is not None else None
        phone = row[idx.get("Phone", -1)].strip() or None if idx.get("Phone") is not None else None
        utm_source = row[idx.get("utm_source [client]", -1)].strip() or None if idx.get("utm_source [client]") is not None else None
        not_subscribed = row[idx["notSubscribed"]].strip().lower() in ("1", "true", "yes") if "notSubscribed" in idx else False
        last_contact_str = row[idx["Дата последнего контакта"]].strip() if "Дата последнего контакта" in idx else None

        existing = await db.fetchrow(
            "SELECT id, ref_code FROM platform_users WHERE client_id = $1 AND platform = 'telegram' AND platform_user_id = $2",
            CLIENT_ID, tg_id
        )

        if existing is None:
            ref_code = await get_unique_ref_code(db)
            await db.execute(
                """INSERT INTO platform_users
                   (client_id, platform, platform_user_id, username, first_name, salebot_id,
                    email, phone, utm_source, is_unsubscribed, ref_code)
                   VALUES ($1, 'telegram', $2, $3, $4, $5, $6, $7, $8, $9, $10)""",
                CLIENT_ID, tg_id, username, first_name, salebot_id,
                email, phone, utm_source, not_subscribed, ref_code
            )
            step1_new += 1
        else:
            await db.execute(
                """UPDATE platform_users SET
                   username = COALESCE($1, username),
                   first_name = COALESCE($2, first_name),
                   salebot_id = COALESCE($3, salebot_id),
                   email = COALESCE($4, email),
                   phone = COALESCE($5, phone),
                   utm_source = COALESCE($6, utm_source),
                   is_unsubscribed = $7,
                   updated_at = NOW()
                   WHERE id = $8""",
                username, first_name, salebot_id,
                email, phone, utm_source, not_subscribed, existing["id"]
            )
            step1_updated += 1

    print(f"  Новых: {step1_new}, обновлено: {step1_updated}")

    # ── ШАГ 2: Рефоводы в platform_users ─────────────────────────────────────
    print("\n=== ШАГ 2: Рефоводы (platform_users) ===")
    step2_set = 0

    for row in rows:
        tg_id = row[idx["Идентификатор внутри мессенджера"]].strip()
        tg_id = ALIASES.get(tg_id, tg_id)
        if not tg_id:
            continue

        old_partner_id = row[idx["old_partner_id [client]"]].strip() if "old_partner_id [client]" in idx else ""
        new_partner_id = row[idx["new_partner_id [client]"]].strip() if "new_partner_id [client]" in idx else ""
        partner_str_val = row[idx["partner_str [order]"]].strip() if "partner_str [order]" in idx else ""

        # Применяем алиасы к значениям партнёра
        old_partner_id = ALIASES.get(old_partner_id, old_partner_id)
        new_partner_id = ALIASES.get(new_partner_id, new_partner_id)
        partner_str_val = ALIASES.get(partner_str_val, partner_str_val)

        partner_tg_id = old_partner_id or new_partner_id or partner_str_val
        if not partner_tg_id:
            continue

        referrer_tg_id, referrer_ref_code = await find_referrer_ref_code(db, partner_tg_id, EVENT_ID)

        if referrer_ref_code:
            await db.execute(
                """UPDATE platform_users SET referrer_tg_id = $1, referrer_ref_code = $2
                   WHERE client_id = $3 AND platform = 'telegram' AND platform_user_id = $4
                   AND (referrer_ref_code IS NULL OR referrer_ref_code = '')""",
                referrer_tg_id, referrer_ref_code, CLIENT_ID, tg_id
            )
            step2_set += 1
        else:
            first_name = row[idx["Имя"]].strip()
            unresolved.append({
                "tg_id": tg_id,
                "name": first_name,
                "old_partner_id": old_partner_id,
                "new_partner_id": new_partner_id,
                "partner_str": partner_str_val,
                "raw_partner": partner_tg_id,
            })

    print(f"  Рефоводов установлено: {step2_set}, не найдено: {len(unresolved)}")

    # ── ШАГ 3: Участники конфы (event23042026) → event_participants ───────────
    print("\n=== ШАГ 3: Участники конференции (event_participants) ===")
    step3_new = 0
    step3_exists = 0

    for row in rows:
        labels = parse_labels(row[idx["Метки"]] if "Метки" in idx else "")
        if "event23042026" not in labels:
            continue

        tg_id = row[idx["Идентификатор внутри мессенджера"]].strip()
        tg_id = ALIASES.get(tg_id, tg_id)
        if not tg_id:
            continue

        pu = await db.fetchrow(
            "SELECT id, ref_code, referrer_ref_code FROM platform_users WHERE client_id = $1 AND platform = 'telegram' AND platform_user_id = $2",
            CLIENT_ID, tg_id
        )
        if not pu:
            continue

        existing_ep = await db.fetchrow(
            "SELECT id FROM event_participants WHERE event_id = $1 AND platform_user_id = $2",
            EVENT_ID, pu["id"]
        )

        if existing_ep:
            step3_exists += 1
            # Обновляем ref_code если пустой
            await db.execute(
                """UPDATE event_participants SET
                   ref_code = COALESCE(NULLIF(ref_code, ''), $1),
                   referrer_ref_code = COALESCE(NULLIF(referrer_ref_code, ''), $2)
                   WHERE id = $3""",
                pu["ref_code"], pu["referrer_ref_code"], existing_ep["id"]
            )
        else:
            # Рефовод участника конфы: берём из platform_users
            referrer_ref_code = pu["referrer_ref_code"]

            await db.execute(
                """INSERT INTO event_participants
                   (event_id, platform_user_id, ref_code, referrer_ref_code, is_registered, is_in_chat, registered_at)
                   VALUES ($1, $2, $3, $4, false, false, NOW())""",
                EVENT_ID, pu["id"], pu["ref_code"], referrer_ref_code
            )
            step3_new += 1

    print(f"  Новых участников: {step3_new}, уже были: {step3_exists}")

    # ── ШАГ 4: Зарегистрированные (event23042026_reg) ────────────────────────
    print("\n=== ШАГ 4: Зарегистрированные (event23042026_reg) ===")
    step4_updated = 0

    for row in rows:
        labels = parse_labels(row[idx["Метки"]] if "Метки" in idx else "")
        if "event23042026_reg" not in labels:
            continue

        tg_id = row[idx["Идентификатор внутри мессенджера"]].strip()
        tg_id = ALIASES.get(tg_id, tg_id)
        if not tg_id:
            continue

        pu = await db.fetchrow(
            "SELECT id FROM platform_users WHERE client_id = $1 AND platform = 'telegram' AND platform_user_id = $2",
            CLIENT_ID, tg_id
        )
        if not pu:
            continue

        result = await db.execute(
            """UPDATE event_participants SET is_registered = true
               WHERE event_id = $1 AND platform_user_id = $2""",
            EVENT_ID, pu["id"]
        )
        if result != "UPDATE 0":
            step4_updated += 1

    print(f"  Помечено зарегистрированными: {step4_updated}")

    # ── Нерешённые рефоводы → файл ───────────────────────────────────────────
    unresolved_path = "/var/www/plusson/unresolved_referrers.csv"
    with open(unresolved_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["tg_id", "name", "old_partner_id", "new_partner_id", "partner_str", "raw_partner"])
        writer.writeheader()
        writer.writerows(unresolved)

    print(f"\n✅ Готово. Нерешённые рефоводы → {unresolved_path} ({len(unresolved)} строк)")

    await db.close()

if __name__ == "__main__":
    asyncio.run(main())
