#!/usr/bin/env bash
#
# Ежедневный бэкап БД PostgreSQL ПЛЮСОН.
#   1. pg_dump -Fc в /var/backups/plusson/plusson_YYYYMMDD_HHMMSS.dump
#   2. заливка копии на Cloudflare R2 в папку db-backups/
#   3. ротация: локально держим LOCAL_KEEP_DAYS, на R2 — R2_KEEP_DAYS
#
# Запускается из cron (/etc/cron.d/plusson-db-backup). Логи → /var/log/plusson-db-backup.log
#
set -euo pipefail

BACKUP_DIR="/var/backups/plusson"
LOG="/var/log/plusson-db-backup.log"
ENV_FILE="/var/www/plusson/web/.env.local"
UPLOADER="/var/www/plusson/deploy/r2_backup_upload.py"

# Пароль/имя БД — из backend/.env (те же, что использует приложение)
PGUSER="plusson"
PGPASSWORD="PlussonDB2026!"
PGDATABASE="plusson"
PGHOST="localhost"

LOCAL_KEEP_DAYS=7
R2_KEEP_DAYS=30

export PGPASSWORD

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

mkdir -p "$BACKUP_DIR"

STAMP="$(date '+%Y%m%d_%H%M%S')"
OUT="$BACKUP_DIR/plusson_${STAMP}.dump"

log "=== backup start ==="

# 1. Дамп (custom format -Fc — сжатый, для pg_restore)
if pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$OUT"; then
  SIZE="$(du -h "$OUT" | cut -f1)"
  log "pg_dump ok: $OUT ($SIZE)"
else
  log "ERROR: pg_dump failed"
  exit 1
fi

# 2. Заливка на R2 (реквизиты из web/.env.local)
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^CF_(ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET_NAME)=' "$ENV_FILE")
  set +a
  if python3 "$UPLOADER" upload "$OUT" >>"$LOG" 2>&1; then
    log "r2 upload ok"
  else
    log "WARNING: r2 upload failed (локальная копия сохранена)"
  fi
  # ротация на R2
  python3 "$UPLOADER" prune "$R2_KEEP_DAYS" >>"$LOG" 2>&1 || log "WARNING: r2 prune failed"
else
  log "WARNING: $ENV_FILE not found — skip R2 upload"
fi

# 3. Локальная ротация
DELETED="$(find "$BACKUP_DIR" -name 'plusson_*.dump' -mtime +"$LOCAL_KEEP_DAYS" -print -delete | wc -l)"
log "local pruned: $DELETED old dump(s) (>${LOCAL_KEEP_DAYS}d)"

log "=== backup done ==="
