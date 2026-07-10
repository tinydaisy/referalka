#!/usr/bin/env python3
"""
Загрузка дампа БД на Cloudflare R2 в папку db-backups/ + ротация старых.

Вызывается из deploy/db_backup.sh. Реквизиты R2 читаются из окружения
(экспортируются скриптом из web/.env.local):
  CF_ACCOUNT_ID, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY, CF_R2_BUCKET_NAME

Использование:
  r2_backup_upload.py upload <local_file>   — залить файл в db-backups/<basename>
  r2_backup_upload.py prune  <keep_days>    — удалить объекты db-backups/ старше N дней
"""
import os
import sys
from datetime import datetime, timezone, timedelta

import boto3

PREFIX = "db-backups/"  # всё строго в этой папке, чтобы не засорять корень бакета


def _client():
    account = os.environ["CF_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["CF_R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["CF_R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload(local_path):
    bucket = os.environ["CF_R2_BUCKET_NAME"]
    key = PREFIX + os.path.basename(local_path)
    _client().upload_file(local_path, bucket, key)
    print(f"[r2] uploaded s3://{bucket}/{key}")


def prune(keep_days):
    bucket = os.environ["CF_R2_BUCKET_NAME"]
    cutoff = datetime.now(timezone.utc) - timedelta(days=int(keep_days))
    cli = _client()
    paginator = cli.get_paginator("list_objects_v2")
    deleted = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=PREFIX):
        for obj in page.get("Contents", []):
            # не трогаем саму «папку»-маркер, если есть
            if obj["Key"] == PREFIX:
                continue
            if obj["LastModified"] < cutoff:
                cli.delete_object(Bucket=bucket, Key=obj["Key"])
                print(f"[r2] pruned {obj['Key']}")
                deleted += 1
    print(f"[r2] pruned {deleted} old object(s) (>{keep_days}d)")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "upload":
        upload(sys.argv[2])
    elif cmd == "prune":
        prune(sys.argv[2])
    else:
        sys.exit(f"unknown command: {cmd}")
