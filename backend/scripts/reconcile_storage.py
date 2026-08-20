"""Сверка бакета R2 с учётом квоты (client_files + clients.storage_used_bytes).

Зачем. Файл может лежать в R2, но не числиться в учёте — тогда квота врёт в
меньшую сторону. И наоборот: строка в client_files есть, а файла нет — квота
врёт в большую. Скрипт показывает и то, и другое, и умеет починить.

Запуск (на сервере):
    /var/www/plusson/venv/bin/python backend/scripts/reconcile_storage.py            # только показать
    /var/www/plusson/venv/bin/python backend/scripts/reconcile_storage.py --apply    # починить

Что делает --apply:
  1. регистрирует неучтённые файлы клиентов в client_files (kind='untracked');
  2. убирает из client_files строки, файла которых в бакете уже нет;
  3. пересчитывает clients.storage_used_bytes ПО СУММЕ client_files —
     ⚠️ именно пересчёт, а не «плюс разница»: счётчик мог разъехаться в обе
     стороны, и сумма — единственный источник истины.

⚠️ Служебным считается ТОЛЬКО то, что перечислено в SERVICE_PREFIXES (бэкапы БД).
Всё остальное — файлы клиента, даже если лежит вне clients/{id}/: часть контента
(уроки, видео для лендинга) заливалась вручную до появления учёта и попала в
корень бакета. Считать её «служебной» по расположению — ошибка: это оплаченный
клиентом контент, он обязан быть в квоте. Такие файлы приписываются владельцу
из FALLBACK_OWNER.
"""
import asyncio
import os
import re
import sys

import asyncpg
import boto3
from botocore.client import Config as BotoConfig

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _load_env(path):
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


for _p in ("/var/www/plusson/backend/.env", "/var/www/plusson/web/.env.local",
           "backend/.env", "web/.env.local"):
    _load_env(_p)

APPLY = "--apply" in sys.argv
CLIENT_KEY = re.compile(r"^clients/(\d+)/")

# Служебные файлы САМОЙ платформы — единственное, что не идёт в квоту клиентов.
SERVICE_PREFIXES = ("db-backups/",)

# Владелец файлов, залитых вручную мимо кабинета (корень бакета: lessons/,
# ivision_chastushki/, img/, posters/ и т.п.). Это контент клиента 1 — он
# заливался до появления учёта, когда папок по клиентам ещё не было.
FALLBACK_OWNER = 1


def human(n):
    for unit in ("Б", "КБ", "МБ", "ГБ"):
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} ТБ"


async def main():
    acc = os.getenv("CF_ACCOUNT_ID")
    bucket = os.getenv("CF_R2_BUCKET_NAME")
    public = (os.getenv("CF_R2_PUBLIC_URL") or "").rstrip("/")
    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{acc}.r2.cloudflarestorage.com",
        aws_access_key_id=os.getenv("CF_R2_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("CF_R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=BotoConfig(signature_version="s3v4"),
    )

    bucket_objs = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket):
        for o in page.get("Contents", []):
            bucket_objs[o["Key"]] = o["Size"]

    dsn = os.getenv("DATABASE_URL") or "postgresql://plusson:PlussonDB2026!@localhost:5432/plusson"
    conn = await asyncpg.connect(dsn)
    tracked = {r["r2_key"]: (r["id"], r["client_id"], int(r["size_bytes"]))
               for r in await conn.fetch("SELECT id, r2_key, client_id, size_bytes FROM client_files")}
    known_clients = {r["id"] for r in await conn.fetch("SELECT id FROM clients")}

    untracked, service, orphans = [], [], []
    for key, size in bucket_objs.items():
        if key in tracked:
            continue
        if key.startswith(SERVICE_PREFIXES):
            service.append((key, size))
            continue
        m = CLIENT_KEY.match(key)
        if m and int(m.group(1)) in known_clients:
            untracked.append((key, size, int(m.group(1))))
        elif FALLBACK_OWNER in known_clients:
            # Вне clients/{id}/ — ручная заливка, владелец по умолчанию.
            untracked.append((key, size, FALLBACK_OWNER))
        else:
            service.append((key, size))
    for key, (fid, cid, size) in tracked.items():
        if key not in bucket_objs:
            orphans.append((key, size, cid, fid))

    print(f"В бакете:            {len(bucket_objs):5d} файлов, {human(sum(bucket_objs.values()))}")
    print(f"Учтено в квоте:      {len(tracked):5d} файлов, {human(sum(v[2] for v in tracked.values()))}")
    print(f"НЕ учтено (клиенты): {len(untracked):5d} файлов, {human(sum(s for _, s, _ in untracked))}")
    print(f"Служебные платформы: {len(service):5d} файлов, {human(sum(s for _, s in service))}  (бэкапы БД, в квоту не идут)")
    print(f"Учтено, но нет файла:{len(orphans):5d} файлов, {human(sum(s for _, s, _, _ in orphans))}")

    if untracked:
        print("\n--- не учтено (топ-15) ---")
        for key, size, cid in sorted(untracked, key=lambda x: -x[1])[:15]:
            print(f"  клиент {cid:3d}  {human(size):>10}  {key}")
    if orphans:
        print("\n--- в учёте есть, в бакете нет (топ-15) ---")
        for key, size, cid, _ in sorted(orphans, key=lambda x: -x[1])[:15]:
            print(f"  клиент {cid:3d}  {human(size):>10}  {key}")
    if service:
        print("\n--- служебные файлы платформы (топ-10) ---")
        for key, size in sorted(service, key=lambda x: -x[1])[:10]:
            print(f"  {human(size):>10}  {key}")

    if not APPLY:
        print("\nЭто только отчёт. Чтобы починить учёт — запустить с --apply")
        await conn.close()
        return

    async with conn.transaction():
        for key, size, cid in untracked:
            await conn.execute(
                """INSERT INTO client_files (client_id, kind, r2_key, url, size_bytes, content_type)
                   VALUES ($1,'untracked',$2,$3,$4,NULL) ON CONFLICT (r2_key) DO NOTHING""",
                cid, key, f"{public}/{key}", size,
            )
        for _, _, _, fid in orphans:
            await conn.execute("DELETE FROM client_files WHERE id=$1", fid)
        # Пересчёт от суммы — счётчик мог разъехаться в обе стороны.
        await conn.execute("""
            UPDATE clients c SET storage_used_bytes = COALESCE(
                (SELECT SUM(size_bytes) FROM client_files f WHERE f.client_id = c.id), 0)
        """)

    print(f"\nГотово: учтено {len(untracked)}, снято с учёта {len(orphans)}, квоты пересчитаны.")
    for r in await conn.fetch("""
        SELECT c.id, c.name, c.storage_used_bytes u, c.storage_quota_bytes q
          FROM clients c WHERE c.storage_used_bytes > 0 ORDER BY c.storage_used_bytes DESC LIMIT 10"""):
        pct = (r["u"] / r["q"] * 100) if r["q"] else 0
        print(f"  клиент {r['id']:3d} {(r['name'] or '')[:28]:28s} {human(r['u']):>10} из {human(r['q']):>10} ({pct:.0f}%)")
    await conn.close()


asyncio.run(main())
