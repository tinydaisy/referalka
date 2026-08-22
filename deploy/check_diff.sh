#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Проверка выкатки на опасные изменения — ДО того, как код попадёт на прод.
#
# Зачем. Скрипт наката выполняется от root, а его текст приезжает из
# репозитория. Кто пушит в main — тот может выполнить на сервере что угодно:
# прочитать пароль базы, ключи платёжек, токены ботов и отправить их наружу.
# Запретить пуш в main нельзя (защита ветки требует платного GitHub), поэтому
# ловим опасное здесь.
#
# ⚠️ Это НЕ абсолютная защита. Намеренную атаку можно замаскировать: собрать
# команду из кусков, закодировать строку. Проверка ловит другое — куда более
# частое: правку файлов деплоя, которую иначе никто бы не заметил, и грубые
# попытки вытащить секреты. Плюс владелец узнаёт о попытке сразу, а не потом.
#
# Запуск: check_diff.sh <старый_коммит> <новый_коммит>
# Выход:  0 — чисто, 1 — найдено опасное (накат отменяется)
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

OLD="${1:?укажите старый коммит}"
NEW="${2:?укажите новый коммит}"
PROJECT_DIR="/var/www/plusson"

cd "$PROJECT_DIR"

FINDINGS=""
add() { FINDINGS="${FINDINGS}• $1"$'\n'; }

CHANGED="$(git diff --name-only "$OLD" "$NEW" 2>/dev/null || echo '')"
[ -z "$CHANGED" ] && exit 0

# ── 1. Тронуты файлы, отвечающие за выкатку ────────────────────────────────
# Обычной задаче они не нужны. Правка здесь = возможность выполнить свой код
# от root, поэтому смотрим на неё отдельно и всегда.
DEPLOY_FILES="$(echo "$CHANGED" | grep -E '^(deploy/|\.github/workflows/)' || true)"
if [ -n "$DEPLOY_FILES" ]; then
  add "Изменены файлы выкатки (выполняются от root):"$'\n'"$(echo "$DEPLOY_FILES" | sed 's/^/    /')"
fi

# ── 2. Опасные конструкции в добавленных строках ───────────────────────────
# Смотрим ТОЛЬКО добавленное (строки с +): удаление опасного кода — это хорошо.
ADDED="$(git diff "$OLD" "$NEW" -- . 2>/dev/null | grep '^+' | grep -v '^+++' || true)"

check() {  # <шаблон> <объяснение>
  local hits
  hits="$(echo "$ADDED" | grep -inE "$1" | head -3 || true)"
  [ -n "$hits" ] && add "$2"$'\n'"$(echo "$hits" | cut -c1-160 | sed 's/^/    /')"
}

# Чтение файлов с ключами и паролями
check '(\.env|authorized_keys|id_rsa|id_ed25519|shadow)' \
      'Обращение к файлам с ключами и паролями'
# Отправка данных наружу
check '(curl|wget|nc |netcat|requests\.(post|get))[^|]*https?://' \
      'Отправка данных на внешний адрес'
# Повышение прав
check '(sudo |chmod \+s|setuid|/etc/sudoers|useradd|usermod -aG)' \
      'Повышение прав или новый пользователь'
# Выполнение произвольного кода
check '(eval |exec\(|base64 -d|\$\(curl|`curl)' \
      'Выполнение кода из строки или из сети'
# Прямой доступ к базе и её выгрузка
check '(pg_dump|psql .*(postgresql|-c )|DROP TABLE|TRUNCATE)' \
      'Прямой доступ к базе или её выгрузка'
# Наши секреты по именам
check '(PlussonDB2026|JWT_SECRET|CF_R2_SECRET|BOT_TOKEN *=)' \
      'Упоминание наших секретов'

[ -z "$FINDINGS" ] && exit 0

# ── 3. Нашли опасное — сообщаем и НЕ выкатываем ────────────────────────────
COMMITS="$(git log --format='%h %an: %s' "$OLD..$NEW" 2>/dev/null | head -5)"
MSG="🚨 ВЫКАТКА ОСТАНОВЛЕНА

В коде найдено то, что требует вашей проверки.

Коммиты:
$COMMITS

Что насторожило:
$FINDINGS
Прод не тронут — работает прежняя версия.

Если изменения ваши и вы их узнаёте, выкатите вручную:
Actions → «Выкатить на прод» → Run workflow"

echo "$MSG"

# Уведомления — обе точки. Молча останавливать нельзя: клиент будет ждать
# выкатку, которой не произошло, и не поймёт причину.
python3 - "$MSG" <<'PY' 2>/dev/null || true
import sys, asyncio, os
sys.path.insert(0, "/var/www/plusson/backend")
os.chdir("/var/www/plusson/backend")
text = sys.argv[1]

async def main():
    import asyncpg
    from app.config import settings
    conn = await asyncpg.connect(settings.database_url)
    try:
        # Канал уведомлений владельца + его почта
        row = await conn.fetchrow(
            "SELECT email, notifications_telegram_chat_id FROM clients WHERE id = 1")
        token = await conn.fetchval(
            """SELECT ch.bot_token FROM channels ch
                JOIN client_channels cc ON cc.channel_id = ch.id
               WHERE cc.client_id = 1 AND ch.platform_slug = 'telegram'
                 AND COALESCE(ch.bot_token,'') <> '' ORDER BY cc.is_active DESC LIMIT 1""")
        if token and row and row["notifications_telegram_chat_id"]:
            import httpx
            async with httpx.AsyncClient(timeout=10) as c:
                await c.post(f"https://api.telegram.org/bot{token}/sendMessage",
                             json={"chat_id": row["notifications_telegram_chat_id"],
                                   "text": text})
        if row and row["email"]:
            from app.services.email_sender import EmailSender
            ch = await conn.fetchrow(
                """SELECT ch.* FROM channels ch
                    JOIN client_channels cc ON cc.channel_id = ch.id
                   WHERE cc.client_id = 1 AND ch.platform_slug = 'email' LIMIT 1""")
            if ch:
                await EmailSender(dict(ch)).send(
                    row["email"], "Выкатка остановлена — нужна ваша проверка",
                    text.replace("\n", "<br>"))
    finally:
        await conn.close()

asyncio.run(main())
PY

exit 1
