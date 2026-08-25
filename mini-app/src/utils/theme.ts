/**
 * Фирменные цвета клиента → CSS-переменные Mini App и веб-витрины.
 *
 * Зачем. Клиент настраивает оформление в «Стилях лендингов», а Mini App и
 * веб-витрина рисовались зашитыми цветами платформы — человек собирал
 * фирменную тему и не видел её там, куда приводит свою аудиторию.
 *
 * ⚠️ ОДНА ТОЧКА ПРИМЕНЕНИЯ. Тема ставится в переменные на `:root`, и каждый
 * экран красится сам. Раскрашивать компоненты по отдельности нельзя: цветов в
 * разметке сотни, и половина мест неминуемо осталась бы старой — экраны
 * разъехались бы между собой.
 *
 * ⚠️ ТЕМЫ НЕТ (null) — НИЧЕГО НЕ ТРОГАЕМ. Галочка у клиента снята → бэкенд
 * отдаёт `theme: null`, и Mini App остаётся ровно в тех цветах, что были.
 */

import { getPlatform } from '../platform'

export type MiniAppTheme = {
  bg?: string | null
  bg_color?: string | null
  bg_color_2?: string | null
  icon?: string | null
  btn?: string | null
  btn_text?: string | null
  btn_border?: string | null
  btn_border_width?: number | null
  card_bg?: string | null
  card_text?: string | null
  card_bg_opacity?: number | null
  day_tab?: string | null
  day_tab_text?: string | null
  heading?: string | null
  body?: string | null
} | null | undefined

/** `#25455D` → `37,69,93`. Нужен для rgba-теней и полупрозрачных подложек. */
export function hexToRgb(hex?: string | null): string | null {
  if (!hex) return null
  const m = String(hex).trim().replace('#', '')
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  const n = parseInt(full, 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}

/**
 * Тёмный ли цвет — по воспринимаемой яркости.
 * Нужен, чтобы выбрать читаемый цвет текста поверх фона клиента: у одного он
 * тёмно-синий, у другого светло-бежевый, и зашитый белый текст на втором
 * исчезнет.
 */
export function isDarkColor(color?: string | null): boolean {
  if (!color) return false
  // Берём первый hex из строки: сюда прилетает и градиент целиком.
  const m = String(color).match(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/)
  const rgb = hexToRgb(m ? m[0] : null)
  if (!rgb) return true // не разобрали — считаем тёмным: белый текст безопаснее
  const [r, g, b] = rgb.split(',').map(Number)
  return (0.299 * r + 0.587 * g + 0.114 * b) < 150
}

/**
 * Ставит переменные темы на :root. Зовётся один раз, когда пришли данные
 * клиента (событие или профиль).
 */
export function applyTheme(theme: MiniAppTheme): void {
  if (!theme) return
  const root = document.documentElement
  const set = (name: string, value?: string | null) => {
    if (value) root.style.setProperty(name, value)
  }

  // ── Фон: тёмные шапки, подложки, плашки ─────────────────────────────
  set('--dark', theme.bg_color)
  set('--dark2', theme.bg_color_2 || theme.bg_color)
  set('--gradient', theme.bg)
  // ⚠️ Второй градиент под углом 135° существует в разметке отдельно от
  // основного (45°). Без него половина плашек послушалась бы настройки
  // клиента, а половина осталась прежней — вперемешку на одном экране.
  if (theme.bg_color) {
    const c2 = theme.bg_color_2 || theme.bg_color
    set('--gradient-135', `linear-gradient(135deg, ${theme.bg_color}, ${c2})`)
  }
  set('--dark-rgb', hexToRgb(theme.bg_color))

  // ── Акцент: иконки меню, стрелки, кружки ────────────────────────────
  set('--peach', theme.icon)
  set('--peach-rgb', hexToRgb(theme.icon))

  // ── Кнопка призыва к действию ───────────────────────────────────────
  set('--cta-bg', theme.btn)
  set('--cta-text', theme.btn_text)
  set('--cta-border', theme.btn_border)
  if (theme.btn_border_width != null) {
    root.style.setProperty('--cta-border-width', `${theme.btn_border_width}px`)
  }

  // ── Карточки спикеров, «Об основателе» ──────────────────────────────
  // Заливка светлая: акцентный цвет, разбавленный до заданной прозрачности.
  const cardRgb = hexToRgb(theme.card_bg)
  if (cardRgb) {
    const a = theme.card_bg_opacity ?? 1
    set('--card-tint', `rgba(${cardRgb},${a})`)
  }
  set('--card-text', theme.card_text)

  // ── Вкладка выбранного дня программы ────────────────────────────────
  set('--day-tab', theme.day_tab)
  set('--day-tab-text', theme.day_tab_text)

  // ── Текст ───────────────────────────────────────────────────────────
  set('--heading', theme.heading)

  // Цвет текста поверх фирменного фона — считается, а не задаётся: клиент
  // выбирает фон, а не «какой текст на нём читается».
  set('--on-dark', isDarkColor(theme.bg_color) ? '#ffffff' : '#25455D')

  // ⚠️ Полоса самого мессенджера (часы, крестик, три точки) красится НЕ
  // вёрсткой, а командой в SDK — CSS туда не достаёт. Поэтому здесь идёт
  // настоящее значение цвета, а не `var(--dark2)`: переменную SDK не поймёт.
  // Ставим после темы, а не при старте: при старте цветов клиента ещё нет.
  const headerColor = theme.bg_color_2 || theme.bg_color
  if (headerColor) {
    try {
      getPlatform()?.setHeaderColor?.(headerColor)
    } catch { /* адаптер недоступен — полоса остаётся платформенной */ }
  }
}
