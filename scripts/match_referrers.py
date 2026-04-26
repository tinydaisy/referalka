# ⚠️ BROKEN_AFTER_036: использует удалённые поля platform_users.platform/email/phone/ref_code/etc.
# Требуется переписать через services/contact_merge.py (find_or_create_contact) — миграция 036.
#!/usr/bin/env python3
"""
Сопоставление рефереров из CSV/Numbers-выгрузки Salebot с базой ПЛЮСОН.

Использование:
    python3 scripts/match_referrers.py <файл.csv или файл.numbers> <event_id>

Что делает:
  1. Читает выгрузку из Salebot (CSV или Numbers)
  2. Для каждой строки определяет реферера по приоритету:
       old_partner_id → new_partner_id → partner_str
  3. Ищет реферера в базе ПЛЮСОН:
       сначала среди collaborators (по tg_id, потом по username)
       потом среди platform_users (по tg_id, потом по username)
  4. Записывает в platform_users.referrer_tg_id — от кого пришёл каждый контакт
  5. Участников с меткой CONF_LABEL и записью в event_participants
     заполняет поле referrer_ref_code (реф-код спикера или участника)
  6. Выводит итоговую статистику и сохраняет unknown_ref.txt

Требования:
    pip3 install numbers-parser
    SSH-доступ к root@62.113.98.30 (dev) или root@194.156.119.17 (prod)
"""

import sys
import csv
import subprocess
import pickle
import os
from pathlib import Path

# ──────────────────────────────────────────────────────────────
# Настройки
# ──────────────────────────────────────────────────────────────

# Алиасы: tg_id из Salebot → реальный tg_id в базе ПЛЮСОН
# Бывает когда у человека два аккаунта Telegram
TG_ID_ALIASES = {
    "7976854412": "392695076",  # Элина Бутенко (@mrs_elinabutenko)
}

SSH_HOST = "root@62.113.98.30"   # dev-сервер; для прода: root@194.156.119.17
DB_NAME  = "plusson"

# Метка в поле «Метки» которая означает участника конференции
CONF_LABEL = "event23042026"

# Выходной файл с неизвестными рефереровами
OUTPUT_UNKNOWN = "/tmp/unknown_ref.txt"


# ──────────────────────────────────────────────────────────────
# Вспомогательные функции
# ──────────────────────────────────────────────────────────────

def psql(query):
    r = subprocess.run(
        ["ssh", SSH_HOST, f'sudo -u postgres psql -d {DB_NAME} -t -A -F"|" -c "{query}"'],
        capture_output=True, text=True
    )
    return [line.split("|") for line in r.stdout.strip().split("\n") if line.strip()]


def clean_tg(s):
    return s.lstrip("@").strip().lower() if s else ""


def fix_id(s):
    if not s: return ""
    try:
        return str(int(float(s)))
    except:
        return s.strip()


def is_num(s):
    try:
        int(float(s))
        return True
    except:
        return False


def cell(row, col):
    """Безопасно достать значение из dict-строки CSV или списка."""
    val = ""
    if isinstance(row, dict):
        val = str(row.get(col, "") or "").strip()
    else:
        val = str(row) if row else ""
    return "" if val in ("---", "None", "nan", "") else val


# ──────────────────────────────────────────────────────────────
# Чтение входного файла
# ──────────────────────────────────────────────────────────────

def read_file(path):
    """Возвращает (headers: list[str], rows: list[dict])"""
    ext = Path(path).suffix.lower()

    if ext == ".csv":
        with open(path, encoding="utf-8-sig") as f:
            reader = csv.DictReader(f, delimiter=';')
            headers = reader.fieldnames or []
            rows = list(reader)
        return headers, rows

    elif ext == ".numbers":
        try:
            from numbers_parser import Document
        except ImportError:
            print("Установите: pip3 install numbers-parser")
            sys.exit(1)
        doc = Document(path)
        raw = list(doc.sheets[0].tables[0].iter_rows())
        headers = [str(c.value or "") for c in raw[0]]
        rows = []
        for raw_row in raw[1:]:
            d = {headers[i]: str(raw_row[i].value or "").strip() for i in range(len(headers))}
            rows.append(d)
        return headers, rows

    else:
        print(f"Неподдерживаемый формат файла: {ext}. Нужен .csv или .numbers")
        sys.exit(1)


# ──────────────────────────────────────────────────────────────
# Загрузка данных из ПЛЮСОН
# ──────────────────────────────────────────────────────────────

def load_plusson_data(event_id):
    print("Загружаю данные из ПЛЮСОН...")

    collab_by_tgid, collab_by_username = {}, {}
    for r in psql("SELECT id, name, personal_tg_id, personal_tg_username FROM collaborators"):
        if len(r) < 4: continue
        cid, name, tgid, tgusr = [x.strip() for x in r]
        if tgid: collab_by_tgid[tgid] = (cid, name, "collaborator")
        if tgusr: collab_by_username[clean_tg(tgusr)] = (cid, name, "collaborator")

    pu_by_tgid, pu_by_username = {}, {}
    pu_refcodes = {}  # tg_id -> ref_code контакта
    for r in psql("SELECT id, platform_user_id, username, first_name || ' ' || last_name, ref_code FROM platform_users WHERE platform = 'telegram'"):
        if len(r) < 5: continue
        pid, tgid, usr = r[0].strip(), r[1].strip(), r[2].strip()
        name = r[3].strip() or usr
        rc = r[4].strip()
        pu_by_tgid[tgid] = (pid, name, "contact")
        if rc: pu_refcodes[tgid] = rc
        if usr: pu_by_username[clean_tg(usr)] = (pid, name, "contact")

    # Реф-коды спикеров события
    speaker_refcodes = {}
    for r in psql(f"""SELECT col.personal_tg_id, cse.ref_code
                      FROM conf_speaker_events cse
                      JOIN collaborators col ON col.id = cse.speaker_id
                      WHERE cse.event_id = {event_id}
                        AND cse.ref_code IS NOT NULL
                        AND col.personal_tg_id != ''"""):
        if len(r) >= 2 and r[0].strip() and r[1].strip():
            speaker_refcodes[r[0].strip()] = r[1].strip()

    # Участники события: tg_id -> {ep_id, ref_code}
    ep_by_tgid = {}
    for r in psql(f"""SELECT pu.platform_user_id, ep.id, ep.ref_code
                      FROM event_participants ep
                      JOIN platform_users pu ON pu.id = ep.platform_user_id
                      WHERE ep.event_id = {event_id}"""):
        if len(r) >= 3:
            ep_by_tgid[r[0].strip()] = {"ep_id": r[1].strip(), "ref_code": r[2].strip()}

    print(f"  Коллабораторов: {len(collab_by_tgid)} по tg_id, {len(collab_by_username)} по username")
    print(f"  Контактов: {len(pu_by_tgid)} по tg_id, {len(pu_by_username)} по username")
    print(f"  Участников события {event_id}: {len(ep_by_tgid)}")
    print(f"  Реф-кодов спикеров: {len(speaker_refcodes)}")

    return collab_by_tgid, collab_by_username, pu_by_tgid, pu_by_username, speaker_refcodes, ep_by_tgid, pu_refcodes


# ──────────────────────────────────────────────────────────────
# Основная логика
# ──────────────────────────────────────────────────────────────

def find_ref(ref_id, ref_name, collab_by_tgid, collab_by_username, pu_by_tgid, pu_by_username):
    if ref_id:
        if ref_id in collab_by_tgid: return collab_by_tgid[ref_id]
        if ref_id in pu_by_tgid:     return pu_by_tgid[ref_id]
    if ref_name:
        uname = clean_tg(ref_name)
        if uname in collab_by_username: return collab_by_username[uname]
        if uname in pu_by_username:     return pu_by_username[uname]
    return None


def process(path, event_id):
    headers, rows = read_file(path)
    collab_by_tgid, collab_by_username, pu_by_tgid, pu_by_username, speaker_refcodes, ep_by_tgid, pu_refcodes = load_plusson_data(event_id)

    results = []
    unknown_refs = {}
    self_refs = []

    for row in rows:
        tg_id   = fix_id(cell(row, "Идентификатор внутри мессенджера"))
        username = clean_tg(cell(row, "tg_username [client]"))
        is_reg  = cell(row, "is_registred [client]") == "ok"
        labels  = cell(row, "Метки")
        is_conf = CONF_LABEL in labels

        old_pid   = fix_id(cell(row, "old_partner_id [client]"))
        old_pname = cell(row, "old_partner [client]")
        new_pid   = fix_id(cell(row, "new_partner_id [client]"))
        new_pname = cell(row, "new_partner [client]")
        partner_str = cell(row, "partner_str [order]")

        # Приоритет: old_partner_id → new_partner_id → partner_str
        ref_id, ref_name, ref_source = "", "", ""
        if old_pid and is_num(old_pid):
            ref_id, ref_name, ref_source = old_pid, old_pname, "old_partner_id"
        elif new_pid and is_num(new_pid):
            ref_id, ref_name, ref_source = new_pid, new_pname, "new_partner_id"
        elif partner_str:
            ref_name, ref_source = partner_str, "partner_str"

        # Подмена алиасов (разные аккаунты одного человека)
        if ref_id in TG_ID_ALIASES:
            ref_id = TG_ID_ALIASES[ref_id]

        # Самореферал — игнорируем
        if ref_id and tg_id and ref_id == tg_id:
            self_refs.append(tg_id)
            ref_id, ref_name, ref_source = "", "", ""

        matched = find_ref(ref_id, ref_name, collab_by_tgid, collab_by_username, pu_by_tgid, pu_by_username) \
                  if (ref_id or ref_name) else None

        if (ref_id or ref_name) and not matched:
            key = ref_id or ref_name
            unknown_refs[key] = unknown_refs.get(key, 0) + 1

        results.append({
            "tg_id": tg_id, "username": username, "is_reg": is_reg,
            "is_conf": is_conf,
            "ref_source": ref_source, "ref_id": ref_id, "ref_name": ref_name,
            "matched": matched,
        })

    # Формируем UPDATE для event_participants
    updates = []
    for r in results:
        if not r["is_conf"]: continue
        tg_id = r["tg_id"]
        if tg_id not in ep_by_tgid: continue
        if not r["matched"]: continue

        ep = ep_by_tgid[tg_id]
        ref_tg_id = r["ref_id"]
        referrer_ref_code = None

        if ref_tg_id and ref_tg_id in speaker_refcodes:
            referrer_ref_code = speaker_refcodes[ref_tg_id]
        elif ref_tg_id and ref_tg_id in ep_by_tgid:
            referrer_ref_code = ep_by_tgid[ref_tg_id]["ref_code"]

        if referrer_ref_code:
            updates.append((ep["ep_id"], referrer_ref_code, tg_id))

    return results, updates, unknown_refs, self_refs, speaker_refcodes, ep_by_tgid, pu_refcodes


def apply_updates_platform_users(results, known_tgids, pu_tgids, speaker_refcodes, ep_by_tgid, pu_refcodes):
    """Записывает referrer_tg_id и referrer_ref_code в platform_users для всех контактов из файла."""
    updates = []
    skipped_not_in_db = 0

    for r in results:
        tg_id = r["tg_id"]
        if not tg_id or tg_id not in pu_tgids:
            continue
        if not r["ref_id"]:
            continue
        ref_id = r["ref_id"]
        if ref_id not in known_tgids:
            skipped_not_in_db += 1
            continue
        # Ищем реф-код рефовода: сначала из platform_users, потом из спикеров
        ref_code = pu_refcodes.get(ref_id) or speaker_refcodes.get(ref_id) or (ep_by_tgid[ref_id].get("ref_code", "") if ref_id in ep_by_tgid else "")
        updates.append((tg_id, ref_id, ref_code or ""))

    if not updates:
        print("Нет апдейтов referrer_tg_id для platform_users.")
        return

    sql_lines = ["BEGIN;"]
    for tg_id, ref_id, ref_code in updates:
        rc_sql = f"'{ref_code}'" if ref_code else "NULL"
        sql_lines.append(
            f"UPDATE platform_users SET referrer_tg_id = '{ref_id}', referrer_ref_code = {rc_sql} "
            f"WHERE platform_user_id = '{tg_id}' AND platform = 'telegram';"
        )
    sql_lines.append("COMMIT;")
    sql = "\n".join(sql_lines)

    sql_path = "/tmp/update_pu_referrers.sql"
    with open(sql_path, "w") as f:
        f.write(sql)
    subprocess.run(["scp", sql_path, f"{SSH_HOST}:{sql_path}"], check=True)
    r = subprocess.run(["ssh", SSH_HOST, f"sudo -u postgres psql -d {DB_NAME} -f {sql_path}"],
                       capture_output=True, text=True)
    if r.returncode == 0:
        with_rc = sum(1 for _, _, rc in updates if rc)
        print(f"  ✓ platform_users.referrer_tg_id: обновлено {len(updates)}, реферер не найден: {skipped_not_in_db}")
        print(f"  ✓ platform_users.referrer_ref_code: заполнено {with_rc} из {len(updates)}")
    else:
        print("  Ошибка:", r.stderr[-300:])


def apply_updates(updates):
    if not updates:
        print("Нет апдейтов для применения.")
        return

    sql_lines = ["BEGIN;"]
    for ep_id, ref_code, tg_id in updates:
        sql_lines.append(f"UPDATE event_participants SET referrer_ref_code = '{ref_code}' WHERE id = {ep_id};")
    sql_lines.append("COMMIT;")
    sql = "\n".join(sql_lines)

    sql_path = "/tmp/update_referrers.sql"
    with open(sql_path, "w") as f:
        f.write(sql)

    subprocess.run(["scp", sql_path, f"{SSH_HOST}:{sql_path}"], check=True)
    r = subprocess.run(
        ["ssh", SSH_HOST, f"sudo -u postgres psql -d {DB_NAME} -f {sql_path}"],
        capture_output=True, text=True
    )
    if r.returncode == 0:
        print(f"  ✓ Применено {len(updates)} UPDATE-запросов")
    else:
        print("  Ошибка:", r.stderr[-300:])


def save_unknown(unknown_refs):
    with open(OUTPUT_UNKNOWN, "w") as f:
        f.write(f"Неизвестные рефереры (не найдены ни в collaborators, ни в contacts)\n")
        f.write(f"Всего уникальных: {len(unknown_refs)}, привлечённых ими: {sum(unknown_refs.values())}\n\n")
        f.write(f"{'ref_id / ref_name':<35} {'привлёк':>8}\n")
        f.write("-" * 46 + "\n")
        for key, cnt in sorted(unknown_refs.items(), key=lambda x: -x[1]):
            f.write(f"{key:<35} {cnt:>8}\n")
    print(f"  Список неизвестных: {OUTPUT_UNKNOWN}")


# ──────────────────────────────────────────────────────────────
# Точка входа
# ──────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print("Использование: python3 match_referrers.py <файл.csv|.numbers> <event_id>")
        print("Пример: python3 match_referrers.py ~/Downloads/salebot_export.csv 4")
        sys.exit(1)

    path = sys.argv[1]
    event_id = int(sys.argv[2])

    if not os.path.exists(path):
        print(f"Файл не найден: {path}")
        sys.exit(1)

    print(f"\n=== Сопоставление рефереров ===")
    print(f"Файл: {path}")
    print(f"Событие: {event_id}")
    print(f"Метка участников конференции: {CONF_LABEL}\n")

    results, updates, unknown_refs, self_refs, speaker_refcodes, ep_by_tgid, pu_refcodes = process(path, event_id)

    with_ref   = [r for r in results if r["ref_source"]]
    no_ref     = [r for r in results if not r["ref_source"]]
    matched    = [r for r in with_ref if r["matched"]]
    unmatched  = [r for r in with_ref if not r["matched"]]
    conf_total = [r for r in results if r["is_conf"]]

    print(f"\n=== ИТОГО ===")
    print(f"Всего строк в файле:       {len(results)}")
    print(f"С реф-кодом:               {len(with_ref)}")
    print(f"  → сопоставлено:          {len(matched)}")
    print(f"  → НЕ сопоставлено:       {len(unmatched)}")
    print(f"Без реф-кода (из базы):    {len(no_ref)}")
    print(f"Самореферал (пропущено):   {len(self_refs)}")
    print(f"Участников конференции:    {len(conf_total)}")
    print(f"Неизвестных рефереров:     {len(unknown_refs)}")
    print(f"UPDATE-запросов:           {len(updates)}")

    # 1. Записываем referrer_tg_id в platform_users для ВСЕХ контактов из файла
    # (ищем реферера сначала в collaborators, потом в platform_users)
    collab_tgids = {r[0].strip() for r in psql(
        "SELECT personal_tg_id FROM collaborators WHERE personal_tg_id IS NOT NULL AND personal_tg_id != ''")}
    pu_tgids = {r[0].strip() for r in psql(
        "SELECT platform_user_id FROM platform_users WHERE platform = 'telegram'")}
    known_tgids = collab_tgids | pu_tgids

    auto_yes = "--yes" in sys.argv or "-y" in sys.argv
    if auto_yes:
        ans = "y"
    else:
        ans = input(f"\nЗаписать referrer_tg_id в platform_users для всех контактов? (y/n): ").strip().lower()
    if ans == "y":
        apply_updates_platform_users(results, known_tgids, pu_tgids, speaker_refcodes, ep_by_tgid, pu_refcodes)

    # 2. Записываем referrer_ref_code в event_participants для участников конференции
    if updates:
        if auto_yes:
            ans2 = "y"
        else:
            ans2 = input(f"Применить {len(updates)} UPDATE referrer_ref_code в event_participants? (y/n): ").strip().lower()
        if ans2 == "y":
            apply_updates(updates)
        else:
            print("Пропущено. SQL сохранён в /tmp/update_referrers.sql")

    save_unknown(unknown_refs)

    if unknown_refs:
        print(f"\nТоп-5 неизвестных рефереров:")
        for key, cnt in sorted(unknown_refs.items(), key=lambda x: -x[1])[:5]:
            print(f"  {key:<30} {cnt} чел.")

    print("\nГотово.")


if __name__ == "__main__":
    main()
