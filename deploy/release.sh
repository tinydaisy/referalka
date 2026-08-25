#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# ПЛЮСОН — накат готовой сборки на сервер
#
# Отличие от старого deploy.sh: НИЧЕГО не собирает. Сборка приезжает готовой
# от GitHub, здесь только распаковка и переключение. Раньше npm run build шёл
# прямо на проде поверх работающей .next — Next.js читал папку, которую в этот
# момент переписывали, и сайт «шатало» 5–10 минут.
#
# Что делает:
#   1. Раскладывает новую сборку РЯДОМ со старой (releases/<метка>)
#   2. Переключает ссылку current → новая
#   3. Рестартует ТОЛЬКО те сервисы, чей код реально менялся
#
# Простой: секунды вместо минут. Откат — переставить ссылку обратно.
#
# Запуск: release.sh <путь-к-архиву> [коммит]
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ARCHIVE="${1:?укажите путь к build.tar.gz}"
NEW_SHA="${2:-}"

PROJECT_DIR="/var/www/plusson"
RELEASES_DIR="$PROJECT_DIR/releases"
LOG="/var/log/plusson-deploy.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"; }

# ── 0. Не мешаем другому деплою ────────────────────────────────────────────
# ⚠️ Деплой может пойти из двух мест одновременно. Тогда они правят одни и те
# же файлы: одна переключает сборку, вторая её в этот момент перезаписывает —
# и человек видит белый экран. Так прод и лёг в ночь на 22.08.
LOCK="/var/run/plusson-deploy.lock"

# Идёт ли сборка прямо сейчас — по живым процессам next/vite в папках проекта.
if command -v is-building >/dev/null 2>&1; then
  for _ in $(seq 1 60); do          # ждём до 10 минут
    is-building || break
    log "Сборка уже идёт — ждём её окончания..."
    sleep 10
  done
  if is-building; then
    log "ОТМЕНА: сборка идёт больше 10 минут. Прод не тронут."
    exit 1
  fi
fi

# Чужой накат через GitHub? Метка живёт максимум 15 минут: если процесс умер,
# не убрав её, следующий деплой не должен ждать вечно.
if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || echo 0) )) -lt 900 ]; then
  log "ОТМЕНА: другой деплой уже идёт. Прод не тронут."
  exit 1
fi
date +%s > "$LOCK"
# Снимаем метку ЛЮБЫМ выходом, включая ошибку и откат.
trap 'rm -f "$LOCK"' EXIT

# ── 0б. Идёт эфир — деплой не делаем ───────────────────────────────────────
# ⚠️ Запись эфира и картинку у зрителей деплой не рвёт (их ведут MediaMTX и
# nginx, мы их не трогаем). Но рестарт plusson-api убивает ЖИВУЮ ЧАСТЬ: чат,
# кнопки покупки, опросы, реакции. А Next.js на двух ядрах поднимается больше
# минуты — для человека в прямом эфире это очень много.
#
# Спикер в этот момент продаёт, и «кнопка не нажимается» стоит ему денег.
# Поэтому просто не начинаем: код подождёт, эфир — нет.
LIVE_Q="SELECT count(*) FROM webinar_sessions WHERE started_at IS NOT NULL AND ended_at IS NULL"
LIVE="$(sudo -u postgres psql -d plusson -t -A -c "$LIVE_Q" 2>/dev/null || echo 0)"
if [ "${LIVE:-0}" -gt 0 ] 2>/dev/null; then
  log "ОТМЕНА: сейчас идёт эфир ($LIVE шт). Деплой рестартует чат и кнопки покупки — ждём окончания."
  log "Если эфир на самом деле завершён и запись «повисла»: FORCE_DEPLOY=1 перезапустить деплой."
  [ "${FORCE_DEPLOY:-0}" = "1" ] || exit 1
  log "FORCE_DEPLOY=1 — продолжаем несмотря на идущий эфир."
fi

log "===== Деплой начат ====="

OLD_SHA="$(cd "$PROJECT_DIR" && git rev-parse HEAD 2>/dev/null || echo '')"

# ── 1. Код из git ──────────────────────────────────────────────────────────
# Бэкенд и боты — это Python, он не собирается: нужен только свежий код.
cd "$PROJECT_DIR"
log "Забираем код из main..."
git fetch origin main --quiet
git reset --hard origin/main --quiet
NEW_SHA="${NEW_SHA:-$(git rev-parse HEAD)}"
log "Код: ${OLD_SHA:0:8} → ${NEW_SHA:0:8}"

# ── 1а. Проверка на опасные изменения ──────────────────────────────────────
# ⚠️ Идёт ДО переключения сборки и до рестартов: если код подозрительный, прод
# не должен его увидеть вовсе. Скрипт выполняется от root, а его текст приезжает
# из репозитория — значит, кто пушит в main, может выполнить на сервере что
# угодно. Запретить пуш в main нельзя (защита ветки требует платного GitHub),
# поэтому ловим здесь.
#
# ⚠️ Проверяем ПРЕЖНЕЙ версией скрипта — той, что уже лежала на сервере до
# reset --hard. Иначе правка самой проверки отключила бы её же.
if [ -n "${OLD_SHA:-}" ] && [ "$OLD_SHA" != "$NEW_SHA" ] \
   && [ -x "$PROJECT_DIR/deploy/check_diff.sh" ]; then
  if ! "$PROJECT_DIR/deploy/check_diff.sh" "$OLD_SHA" "$NEW_SHA"; then
    log "===== ДЕПЛОЙ ОСТАНОВЛЕН: найден подозрительный код, владелец уведомлён ====="
    # Возвращаем код на прежний коммит — на проде остаётся то, что работало.
    git reset --hard "$OLD_SHA" --quiet
    exit 1
  fi
fi

# ── 2. Зависимости Python ──────────────────────────────────────────────────
# ⚠️ venv в КОРНЕ проекта, не в backend/ — так же его зовёт plusson-api.service.
# Путь backend/venv ломал деплой с 14.08 и обрывал скрипт на этой строке.
if git diff --name-only "${OLD_SHA:-$NEW_SHA}" "$NEW_SHA" 2>/dev/null | grep -q '^backend/requirements.txt$'; then
  log "requirements.txt изменился — обновляем зависимости"
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/venv/bin/activate"
  pip install -q -r "$PROJECT_DIR/backend/requirements.txt"
fi

# ── 2б. Миграции базы ──────────────────────────────────────────────────────
# ⚠️ Идёт ДО переключения сайта. Пока база обновляется, работает СТАРАЯ сборка,
# которая со старой базой совместима. Не получилось обновить — сайт остаётся
# как был, ничего не падает.
#
# Зачем вообще: раньше миграции накатывались руками отдельной командой на
# сервере. При деплое код приезжал, а база оставалась старой — код просил
# колонку, которой нет, и кабинет падал. Пока миграции писал и накатывал один
# человек, это было незаметно; подрядчик про ручную команду не узнает.
MIGRATE="$PROJECT_DIR/deploy/migrate.sh"
# ⚠️ Проверяем СУЩЕСТВОВАНИЕ файла (-f), а не право на исполнение (-x).
# Скрипт всё равно запускается через `bash "$MIGRATE"`, так что флаг +x ему не
# нужен, — а вот проверка по нему однажды тихо отключила ВЕСЬ накат миграций:
# файл лежал с правами 644 (таким он был записан и в git), условие не
# проходило, блок пропускался молча. Код при этом уезжал на прод и просил
# колонки, которых в базе нет: у клиентов падала страница очереди рассылок
# с 500, а в кабинете было написано «очередь пуста».
if [ -f "$MIGRATE" ]; then
  # Сначала смотрим, нет ли среди неприменённых опасных.
  RISKY="$(bash "$MIGRATE" risky 2>/dev/null || true)"
  if [ -n "$RISKY" ]; then
    log "ОСТАНОВКА: среди миграций есть удаляющие данные — автоматом не накатываем:"
    echo "$RISKY" | sed 's/^/    /' | tee -a "$LOG"
    log "Такую миграцию снимок не спасёт: данные уже потеряны, а возврат снимка"
    log "отменит и всю сегодняшнюю работу клиентов. Накатите вручную:"
    log "  cd $PROJECT_DIR && bash deploy/migrate.sh apply"
    git reset --hard "${OLD_SHA:-$NEW_SHA}" --quiet 2>/dev/null || true
    exit 1
  fi

  PENDING_CNT="$(bash "$MIGRATE" status 2>/dev/null | grep -oP 'НЕ применено: \K\d+' || echo 0)"
  if [ "${PENDING_CNT:-0}" -gt 0 ] 2>/dev/null; then
    log "Миграций к накату: $PENDING_CNT — делаем снимок базы"
    SNAP="/var/backups/plusson/before_deploy_$(date +%Y%m%d_%H%M%S).sql.gz"
    mkdir -p /var/backups/plusson
    if ! sudo -u postgres pg_dump plusson 2>/dev/null | gzip > "$SNAP"; then
      log "ОШИБКА: не удалось сделать снимок базы — миграции не накатываем, деплой отменён"
      rm -f "$SNAP"
      exit 1
    fi
    log "Снимок: $SNAP ($(du -h "$SNAP" | cut -f1))"

    if bash "$MIGRATE" apply 2>&1 | tee -a "$LOG"; then
      log "Миграции накачены"
    else
      log "ОШИБКА НА МИГРАЦИИ — возвращаем базу из снимка"
      # ⚠️ Сначала гасим тех, кто держит соединения и пишет в базу, иначе
      # восстановление упрётся в занятые таблицы.
      systemctl stop plusson-api plusson-celery plusson-celery-beat 2>/dev/null || true
      if gunzip -c "$SNAP" | sudo -u postgres psql -d plusson -q >/dev/null 2>&1; then
        log "База возвращена к состоянию до деплоя"
      else
        log "⚠️⚠️ ВЕРНУТЬ БАЗУ НЕ УДАЛОСЬ. Снимок здесь: $SNAP"
      fi
      systemctl start plusson-api plusson-celery plusson-celery-beat 2>/dev/null || true
      git reset --hard "${OLD_SHA:-$NEW_SHA}" --quiet 2>/dev/null || true
      log "===== ДЕПЛОЙ ОСТАНОВЛЕН: сайт остался на прежней версии ====="
      exit 1
    fi
    # Держим 10 последних снимков — остальные съедают диск.
    ls -1t /var/backups/plusson/before_deploy_*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f || true
  fi
else
  # ⚠️ Молчать здесь нельзя. Без наката миграций код уезжает на прод и просит
  # колонки, которых в базе нет, — а выглядит это для клиента как «раздел
  # пуст» или «страница не работает», и причину ищут где угодно, только не в
  # базе. Останавливаем деплой: лучше не выкатить, чем выкатить в поломку.
  log "ОСТАНОВКА: не найден $MIGRATE — накатить миграции нечем."
  log "Проверьте, что файл на месте: ls -la $PROJECT_DIR/deploy/migrate.sh"
  exit 1
fi

# ── 3. Раскладываем сборку РЯДОМ ───────────────────────────────────────────
STAMP="$(date +%Y%m%d_%H%M%S)_${NEW_SHA:0:8}"
REL="$RELEASES_DIR/$STAMP"
mkdir -p "$REL"
log "Распаковываем в $REL"
tar -xzf "$ARCHIVE" -C "$REL"

if [ ! -d "$REL/web/.next/server" ]; then
  log "ОШИБКА: в архиве нет web/.next/server — накат отменён, ничего не тронуто"
  rm -rf "$REL"
  exit 1
fi

# ── 4. Переключаем ────────────────────────────────────────────────────────
# Пока идёт распаковка, сайт работает на старой сборке. Момент переключения —
# это перемещение папки, доли секунды.
log "Переключаем web..."
PREV_NEXT="$PROJECT_DIR/web/.next.prev"
rm -rf "$PREV_NEXT"
[ -d "$PROJECT_DIR/web/.next" ] && mv "$PROJECT_DIR/web/.next" "$PREV_NEXT"
mv "$REL/web/.next" "$PROJECT_DIR/web/.next"

# Mini App — статика, её отдаёт nginx напрямую. Рестарт не нужен вовсе.
log "Переключаем mini-app..."
for d in dist dist-vk dist-max dist-web; do
  if [ -d "$REL/mini-app/$d" ]; then
    rm -rf "$PROJECT_DIR/mini-app/$d.prev"
    [ -d "$PROJECT_DIR/mini-app/$d" ] && mv "$PROJECT_DIR/mini-app/$d" "$PROJECT_DIR/mini-app/$d.prev"
    mv "$REL/mini-app/$d" "$PROJECT_DIR/mini-app/$d"
  fi
done

# ── 5. Рестартуем ТОЛЬКО изменившееся ─────────────────────────────────────
# Раньше рестартовалось всё подряд каждый раз: правишь кнопку на лендинге —
# ложатся боты и обрывается Celery. Теперь смотрим, что реально менялось.
CHANGED="$(git diff --name-only "${OLD_SHA:-$NEW_SHA}" "$NEW_SHA" 2>/dev/null || echo 'ALL')"
need() { [ "$CHANGED" = "ALL" ] && return 0; echo "$CHANGED" | grep -qE "$1"; }

RESTARTED=""

# ⚠️ Веб рестартуем ВСЕГДА, а не по списку изменённых файлов. Мы только что
# подменили ему папку .next — процесс держит в памяти СТАРУЮ сборку и просит
# файлы, которых на диске уже нет: человек видит «Application error» и страницу
# без стилей. Так и случилось при повторном деплое того же коммита: скрипт
# сравнил его сам с собой, решил «ничего не менялось» и не рестартовал, хотя
# файлы переключил. Рестарт веба стоит секунды и ничего не рвёт — в отличие от
# ботов и Celery, которые тут действительно надо трогать по делу.
systemctl restart plusson-web && RESTARTED="$RESTARTED plusson-web"

if need '^backend/app/(api|services|main\.py|config\.py|database\.py)'; then
  systemctl restart plusson-api && RESTARTED="$RESTARTED plusson-api"
fi

if need '^backend/(app/(tasks|services)|celery_app)'; then
  # ⚠️ Мягкая остановка: сначала даём доработать текущую задачу, иначе
  # рестарт рвёт идущую рассылку на середине — часть людей получила,
  # часть нет. Не успел за 60 с — рестартуем принудительно.
  log "Celery: ждём завершения текущих задач (до 60 с)..."
  pkill -TERM -f 'celery.*worker' 2>/dev/null || true
  for _ in $(seq 1 60); do
    pgrep -f 'celery.*worker' >/dev/null 2>&1 || break
    sleep 1
  done
  systemctl restart plusson-celery plusson-celery-beat
  RESTARTED="$RESTARTED plusson-celery"
fi

if need '^backend/(bot|app/services)/'; then
  systemctl restart plusson-bot plusson-vk-bot 2>/dev/null || true
  RESTARTED="$RESTARTED plusson-bot plusson-vk-bot"
fi

# ⚠️ MediaMTX и WhatsApp-мост НЕ трогаем автоматически: первый пишет эфиры
# (рестарт обрывает запись), второй держит залогиненные сессии клиентов
# (рестарт разлогинивает). Только вручную и осознанно.
if need '^media-server/'; then
  log "ВНИМАНИЕ: менялся media-server — MediaMTX НЕ рестартован (оборвёт эфир). Рестартуйте вручную, когда эфиров нет."
fi

log "Рестарт:${RESTARTED:- ничего не потребовалось}"

# ── 6. Проверяем, что живо ────────────────────────────────────────────────
# ⚠️ С ПОВТОРАМИ, а не один раз через 5 секунд. Next.js после рестарта
# поднимается дольше, и одиночная проверка объявляла откат на живом сайте:
# первый же накат так и «упал», хотя сборка встала и сайт отвечал 200.
check_once() {
  curl -sf -o /dev/null --max-time 10 http://127.0.0.1:8000/health || return 1
  local code
  # ⚠️ 30 секунд на ответ, а не 15: первый запрос к только что поднятому Next.js
  # идёт медленно — он собирает страницу «на лету», и короткий таймаут обрывал
  # его раньше, чем сайт успевал ответить.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://127.0.0.1:3000/ || echo 000)"
  case "$code" in 2*|3*) return 0 ;; *) return 1 ;; esac
}

# ⚠️ До ТРЁХ МИНУТ, а не одной: на 2 ядрах Next.js после рестарта поднимается
# дольше минуты, и накат отмечался «упавшим» на живом сайте — сборка вставала,
# сайт отвечал 200, а деплой показывал красный крестик.
HEALTH_OK=0
for _ in $(seq 1 36); do
  sleep 5
  if check_once; then HEALTH_OK=1; break; fi
done

if [ "$HEALTH_OK" != "1" ]; then
  log "ПРОВЕРКА НЕ ПРОШЛА (api/health или web) — ОТКАТ на предыдущую сборку"
  if [ -d "$PREV_NEXT" ]; then
    rm -rf "$PROJECT_DIR/web/.next"
    mv "$PREV_NEXT" "$PROJECT_DIR/web/.next"
    systemctl restart plusson-web
  fi
  log "===== Откат выполнен, сайт на прежней версии ====="
  exit 1
fi

# ── 7. Уборка ─────────────────────────────────────────────────────────────
rm -rf "$REL"
# Держим 3 последние сборки — на случай отката на пару версий назад.
#
# ⚠️ `|| true` ОБЯЗАТЕЛЕН. Когда старых сборок нет, ls возвращает ошибку, и при
# set -e скрипт умирал НА ПОСЛЕДНЕЙ СТРОКЕ — уже после успешного наката. Накат
# при этом проходил, сайт работал, а GitHub показывал красный крестик и слал
# письмо «run failed» на каждый деплой.
ls -1dt "$RELEASES_DIR"/* 2>/dev/null | tail -n +4 | xargs -r rm -rf || true

log "Готово: ${NEW_SHA:0:8}${RESTARTED:+, рестарт:$RESTARTED}"
log "===== Деплой завершён успешно (${NEW_SHA:0:8}) ====="
exit 0
