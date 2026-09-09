import type { CSSProperties } from 'react'

/**
 * Фирменное оформление в кабинете — шрифты и металлический перелив.
 *
 * ⚠️ ОДИН ИСТОЧНИК НА ВСЕ ПРЕВЬЮ. И шрифт, и металл раньше жили локальными
 * функциями внутри страниц (`LandingThemeTab`, `LandingRenderer`) — каждое новое
 * превью повторяло их заново и по-своему. Обложка должна выглядеть ровно как
 * лендинг, поэтому формулы взяты оттуда и вынесены сюда.
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

/**
 * Оттенок цвета: `pct > 0` осветляет, `pct < 0` затемняет.
 *
 * ⚠️ Мусор в поле цвета (недописанный HEX из формы) не должен ронять страницу —
 * возвращаем чёрный, а не бросаем исключение.
 */
export function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return '#000000'
  const n = parseInt(m[1], 16)
  const f = (v: number) => pct >= 0
    ? Math.round(v + (255 - v) * (pct / 100))
    : Math.round(v * (1 + pct / 100))
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)]
    .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Металлический градиент заголовка — тот же, что на лендингах.
 *
 * ⚠️⚠️ ИМЕННО ВЕРТИКАЛЬ (180deg) И СИММЕТРИЯ дают ощущение металла: тёмный →
 * цвет → светлый блик → цвет → тёмный. Диагональный градиент или несимметричный
 * набор стопов выглядят обычной заливкой. Формула снята с боевого лендинга —
 * менять её здесь нельзя, обложка разойдётся с сайтом.
 */
export function metallicGradient(color: string): string {
  const dark = shade(color, -45)
  const light = shade(color, 30)
  return `linear-gradient(180deg, ${dark}, ${color}, ${light}, ${color}, ${dark})`
}

/**
 * Стиль текста с металлическим переливом.
 *
 * ⚠️ Металл рисуется градиентом ПО ТЕКСТУ (`background-clip: text`), а сам текст
 * делается прозрачным. Поэтому у такого заголовка нет обычного `color` — если
 * где-то понадобится сплошной цвет (печать в PDF), металл надо просто не
 * применять, а не пытаться совместить.
 */
export function metallicTextStyle(color: string): CSSProperties {
  return {
    background: metallicGradient(color),
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  }
}
