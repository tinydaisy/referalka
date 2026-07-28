#!/usr/bin/env bash
# Скачивает шрифты конструктора лендингов в web/public/fonts/.
#
# Зачем локально, а не ссылкой на Google: у части пользователей в РФ
# fonts.googleapis.com тормозит или режется — лендинг мигает системным шрифтом.
# Свои файлы = предсказуемая отдача с нашего же домена.
#
# Как работает: берём у Google готовый CSS с @font-face (там уже разбивка по
# алфавитам через unicode-range — грузится только нужный кусок), скачиваем
# .woff2 и переписываем в CSS ссылки на локальные. Итог — один файл
# web/public/fonts/landing-fonts.css, его подключает страница лендинга.
#
# Запуск (разово, при добавлении шрифта):  bash web/scripts/fetch_landing_fonts.sh
# ⚠️ Список должен совпадать с backend/app/services/landing_fonts.py.

set -euo pipefail
cd "$(dirname "$0")/../public/fonts"

# key|Google family|начертания
FONTS=(
  "Manrope|Manrope|400;600;800"
  "Inter|Inter|400;600;800"
  "Roboto|Roboto|400;500;700"
  "OpenSans|Open+Sans|400;600;700"
  "Montserrat|Montserrat|400;600;800"
  "Nunito|Nunito|400;600;800"
  "Rubik|Rubik|400;500;700"
  "PTSans|PT+Sans|400;700"
  "Golos|Golos+Text|400;600;800"
  "Onest|Onest|400;600;800"
  "PlayfairDisplay|Playfair+Display|400;700;900"
  "Merriweather|Merriweather|400;700"
  "PTSerif|PT+Serif|400;700"
  "Lora|Lora|400;600;700"
  "BebasNeue|Bebas+Neue|400"
  "Oswald|Oswald|400;600;700"
  "Unbounded|Unbounded|400;700;900"
  "AlumniSans|Alumni+Sans|400;700"
  "Cormorant|Cormorant|400;600;700"
  "RussoOne|Russo+One|400"
)

# UA современного браузера — иначе Google отдаёт устаревший ttf вместо woff2.
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

OUT="landing-fonts.css"
: > "$OUT"
echo "/* Шрифты конструктора лендингов. Сгенерировано fetch_landing_fonts.sh — не править руками. */" >> "$OUT"

for row in "${FONTS[@]}"; do
  IFS='|' read -r key family weights <<< "$row"
  mkdir -p "$key"

  # Кириллица обязательна — события русскоязычные.
  css=$(curl -sf -A "$UA" \
    "https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap&subset=cyrillic,cyrillic-ext,latin,latin-ext") || {
      echo "  ✗ $key — не удалось получить CSS"; continue; }

  i=0
  # Каждую ссылку на gstatic заменяем локальным файлом, остальное (unicode-range,
  # font-weight, font-display) оставляем как есть — Google уже всё посчитал.
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    file="${key}/${key}-${i}.woff2"
    if curl -sf -A "$UA" -o "$file" "$url"; then
      css=${css//"$url"//fonts/"$file"}
      i=$((i+1))
    fi
  done <<< "$(echo "$css" | grep -o 'https://fonts\.gstatic\.com/[^)]*\.woff2' | sort -u)"

  echo "$css" >> "$OUT"
  echo "  ✓ $key — файлов: $i"
done

echo "Готово: $(pwd)/$OUT"
