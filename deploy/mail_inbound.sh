#!/bin/sh
# Postfix pipe: письмо на support@pluson.ru → API → «Диалоги» (миграция 521).
#
# Вызывается Postfix-сервисом `plusoninbound` из /etc/postfix/master.cf,
# письмо приходит на stdin целиком.
#
# ⚠️ Коды выхода — язык Postfix, а не «0/1»:
#   0  — принято, письмо доставлено;
#   75 — ВРЕМЕННАЯ ошибка (EX_TEMPFAIL): Postfix повторит позже. Так при
#        лежащем API письмо ждёт в очереди, а не теряется;
#   65 — ПОСТОЯННАЯ (EX_DATAERR): отправитель получит отбойник. Только когда
#        повтор ничего не изменит (слишком большое письмо).
#
# ⚠️ Токен читается из файла, а не из аргументов: аргументы видны всем в `ps`.

TOKEN_FILE=/etc/postfix/plusson_inbound.token
URL=http://127.0.0.1:8000/api/v1/internal/inbound-email

[ -r "$TOKEN_FILE" ] || exit 75
TOKEN=$(cat "$TOKEN_FILE")

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 \
  -H "X-Inbound-Token: $TOKEN" -H "Content-Type: message/rfc822" \
  --data-binary @- "$URL")

case "$CODE" in
  2??) exit 0 ;;
  413) exit 65 ;;
  *)   exit 75 ;;
esac
