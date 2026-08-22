#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# ПЛЮСОН — накат миграций базы
#
# Зачем. Учёта применённых миграций не было: какие из 337 файлов накачены —
# нигде не записано. Из-за этого dev и прод расходились месяцами, и проверка
# «сделал на dev» ничего не значила — структура там была другая.
#
# Как пользоваться:
#   migrate.sh status   — что применено, чего не хватает (НИЧЕГО не меняет)
#   migrate.sh apply    — накатить недостающее по порядку
#   migrate.sh mark <файл> — отметить применённой, не выполняя (для тех,
#                            что накатили руками до появления учёта)
#
# ⚠️ Ключ учёта — ИМЯ ФАЙЛА, не номер: в db/migrations 21 пара файлов с
# одинаковыми номерами, при учёте по номеру вторая молча терялась бы.
#
# ⚠️ DDL идёт от postgres: роль plusson не владелец таблиц, ALTER от неё падает
# с permission denied.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

PROJECT_DIR="/var/www/plusson"
MIG_DIR="$PROJECT_DIR/db/migrations"
DB="plusson"
CMD="${1:-status}"

psql_ro() { sudo -u postgres psql -d "$DB" -t -A -F'|' -c "$1" 2>/dev/null; }

# Список файлов в порядке применения: по номеру, при равном номере — по имени.
all_files() { ls -1 "$MIG_DIR"/*.sql 2>/dev/null | xargs -n1 basename | sort -t_ -k1,1n -k2; }

applied_list() { psql_ro "SELECT filename FROM schema_migrations" | sort; }

case "$CMD" in

  status)
    if ! psql_ro "SELECT to_regclass('public.schema_migrations')" | grep -q schema_migrations; then
      echo "⚠️  Учёта миграций ещё нет — сначала накатите 325_schema_migrations.sql"
      exit 1
    fi
    TOTAL=$(all_files | wc -l)
    DONE=$(applied_list | grep -c . || echo 0)
    echo "══════ МИГРАЦИИ ══════"
    echo "  всего файлов:  $TOTAL"
    echo "  применено:     $DONE"
    PENDING="$(comm -23 <(all_files) <(applied_list))"
    if [ -z "$PENDING" ]; then
      echo "  ✓ база в актуальном состоянии"
    else
      echo "  ⚠️ НЕ применено: $(echo "$PENDING" | grep -c .)"
      echo "$PENDING" | sed 's/^/     /'
      echo
      echo "  Накатить: migrate.sh apply"
    fi
    ;;

  apply)
    PENDING="$(comm -23 <(all_files) <(applied_list))"
    [ -z "$PENDING" ] && { echo "✓ Нечего накатывать — база актуальна."; exit 0; }

    echo "К накату: $(echo "$PENDING" | grep -c .) миграций"
    while read -r f; do
      [ -z "$f" ] && continue
      echo "► $f"
      # ⚠️ ON_ERROR_STOP: без него psql проглатывает ошибку и идёт дальше, а мы
      # отмечаем миграцию применённой — база остаётся в неизвестном состоянии.
      if sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$MIG_DIR/$f" >/dev/null 2>&1; then
        SUM=$(sha256sum "$MIG_DIR/$f" | cut -c1-64)
        psql_ro "INSERT INTO schema_migrations (filename, source, checksum)
                 VALUES ('$f','manual','$SUM') ON CONFLICT (filename) DO NOTHING" >/dev/null
        echo "  ✓ применена"
      else
        echo "  ✗ ОШИБКА — накат остановлен, остальные не применялись"
        echo "  Подробности: sudo -u postgres psql -d $DB -v ON_ERROR_STOP=1 -f $MIG_DIR/$f"
        exit 1
      fi
    done <<< "$PENDING"
    echo "✓ Готово"
    ;;

  mark)
    F="${2:?укажите имя файла миграции}"
    [ -f "$MIG_DIR/$F" ] || { echo "Нет такого файла: $F"; exit 1; }
    SUM=$(sha256sum "$MIG_DIR/$F" | cut -c1-64)
    psql_ro "INSERT INTO schema_migrations (filename, source, checksum)
             VALUES ('$F','backfill','$SUM') ON CONFLICT (filename) DO NOTHING" >/dev/null
    echo "✓ Отмечена применённой (без выполнения): $F"
    ;;

  *)
    echo "Использование: migrate.sh [status|apply|mark <файл>]"
    exit 1
    ;;
esac
