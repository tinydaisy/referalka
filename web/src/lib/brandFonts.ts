/**
 * Фирменные шрифты в кабинете — один источник на все превью.
 *
 * ⚠️⚠️ КЛЮЧ ШРИФТА ≠ ИМЯ СЕМЕЙСТВА. В теме хранится `BebasNeue` (слитно), а в
 * `/fonts/landing-fonts.css` семейство называется `Bebas Neue` (с пробелом).
 * Подставишь ключ как есть — браузер такого семейства не найдёт и молча нарисует
 * запасным: превью выглядит рабочим, но шрифт чужой. Ровно это и случилось с
 * первой версией обложек.
 *
 * ⚠️ Файл шрифтов подключён только на ПУБЛИЧНЫХ страницах (лендинги, витрины).
 * В кабинете его надо подключать самому — `useBrandFonts()`, иначе в превью
 * снова придёт запасной шрифт.
 */

/** Ключи, у которых имя семейства пишется иначе, чем ключ. */
const FAMILY_BY_KEY: Record<string, string> = {
  // ⚠️ У Bebas Neue нет кириллицы — в запас идёт Oswald, как в
  // backend/app/services/landing_fonts.py (_FALLBACK_BY_KEY). Держать
  // одинаковым: иначе кабинет и лендинг покажут русский текст по-разному.
  BebasNeue: "'Bebas Neue', 'Oswald', Impact, sans-serif",
}

/**
 * CSS `font-family` по ключу шрифта из темы.
 *
 * `label` — человеческое имя из справочника (`/clients/me/landing-theme` отдаёт
 * его в `fonts`). Есть — берём его; нет — разбиваем ключ по заглавным буквам
 * (`PlayfairDisplay` → `Playfair Display`).
 */
export function brandFontCss(key?: string | null, label?: string): string {
  if (!key) return 'system-ui, sans-serif'
  if (FAMILY_BY_KEY[key]) return FAMILY_BY_KEY[key]
  const family = (label || key).replace(/([a-z])([A-Z])/g, '$1 $2')
  return `'${family}', system-ui, sans-serif`
}

/**
 * Подключает файл фирменных шрифтов на страницу кабинета.
 *
 * ⚠️ Вставляем ОДИН тег на всё приложение (по id) и не убираем при размонтаже:
 * вкладки настроек переключаются часто, а каждое снятие/возврат тега заставляет
 * браузер перезагружать шрифты — превью моргает пустым текстом.
 */
export function ensureBrandFonts(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById('brand-fonts-css')) return
  const link = document.createElement('link')
  link.id = 'brand-fonts-css'
  link.rel = 'stylesheet'
  link.href = '/fonts/landing-fonts.css'
  document.head.appendChild(link)
}
