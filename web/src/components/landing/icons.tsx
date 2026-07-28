'use client'

/**
 * Набор иконок для карточек лендинга (ценности, «чем отличаемся»).
 *
 * Каждая иконка — круг с металлической заливкой из цвета иконок темы плюс
 * тёмный символ поверх. Символ рисуется на сетке 80×80, чтобы все иконки
 * смотрелись одинаково по весу линий.
 *
 * Ключ (`key`) хранится в карточке блока: items[i].icon. Пусто — иконки нет.
 */

export interface IconDef {
  key: string
  label: string
  /** Символ поверх круга. Цвет задаётся через `currentColor` родителя. */
  path: React.ReactNode
}

const S = { fill: 'none', strokeWidth: 4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const CARD_ICONS: IconDef[] = [
  { key: 'handshake', label: 'Коллаборации', path: (
    <path d="M40 24v32M28 32l12-8 12 8M28 48l12 8 12-8" {...S} /> ) },
  { key: 'smile', label: 'Улыбка', path: (
    <>
      <circle cx="30" cy="33" r="4" fill="currentColor" stroke="none" />
      <circle cx="50" cy="33" r="4" fill="currentColor" stroke="none" />
      <path d="M26 46c3 7 9 11 14 11s11-4 14-11" {...S} strokeWidth={4.5} />
    </> ) },
  { key: 'chart', label: 'Рост / лидерство', path: (
    <>
      <path d="M24 52V38M40 52V26M56 52V32" {...S} strokeWidth={6} />
      <path d="M40 20l4 6h-8z" fill="currentColor" stroke="none" />
    </> ) },
  { key: 'bulb', label: 'Идея', path: (
    <>
      <path d="M40 22c-8 0-14 6-14 13 0 5 3 8 5 11v5h18v-5c2-3 5-6 5-11 0-7-6-13-14-13z"
            fill="currentColor" stroke="none" />
      <path d="M34 56h12M36 60h8" {...S} strokeWidth={3} />
    </> ) },
  { key: 'book', label: 'Наследие / книга', path: (
    <path d="M28 56V30c0-4 3-7 7-7h17v33H35c-4 0-7 3-7 7" {...S} /> ) },
  { key: 'wave', label: 'Нелинейность', path: (
    <>
      <path d="M22 54c6 0 8-24 18-24s12 24 18 24" {...S} />
      <circle cx="22" cy="54" r="4" fill="currentColor" stroke="none" />
      <circle cx="58" cy="54" r="4" fill="currentColor" stroke="none" />
    </> ) },
  { key: 'star', label: 'Звезда', path: (
    <path d="M40 22l5.5 11.5L58 35l-9 9 2 12.5L40 51l-11 5.5 2-12.5-9-9 12.5-1.5z" {...S} /> ) },
  { key: 'target', label: 'Цель', path: (
    <>
      <circle cx="40" cy="40" r="16" {...S} />
      <circle cx="40" cy="40" r="6" fill="currentColor" stroke="none" />
    </> ) },
  { key: 'rocket', label: 'Запуск', path: (
    <>
      <path d="M40 20c8 6 12 15 12 24l-6 6H34l-6-6c0-9 4-18 12-24z" {...S} />
      <path d="M34 50l-6 10 10-4M46 50l6 10-10-4" {...S} strokeWidth={3.5} />
    </> ) },
  { key: 'shield', label: 'Надёжность', path: (
    <path d="M40 20l16 6v14c0 10-7 17-16 20-9-3-16-10-16-20V26z" {...S} /> ) },
  { key: 'people', label: 'Сообщество', path: (
    <>
      <circle cx="30" cy="31" r="7" {...S} />
      <circle cx="52" cy="33" r="6" {...S} />
      <path d="M18 56c0-7 5-12 12-12s12 5 12 12M44 56c0-6 4-10 9-10s9 4 9 10" {...S} strokeWidth={3.5} />
    </> ) },
  { key: 'crown', label: 'Статус', path: (
    <path d="M22 50l-4-22 12 8 10-14 10 14 12-8-4 22z" {...S} /> ) },
  { key: 'gift', label: 'Подарок', path: (
    <>
      <path d="M24 38h32v20H24zM22 30h36v8H22zM40 30v28" {...S} strokeWidth={3.5} />
      <path d="M40 30c-6-10-16-4-8 0M40 30c6-10 16-4 8 0" {...S} strokeWidth={3.5} />
    </> ) },
  { key: 'check', label: 'Галочка', path: (
    <path d="M26 41l10 10 20-22" {...S} strokeWidth={6} /> ) },
  { key: 'fire', label: 'Энергия', path: (
    <path d="M42 20c2 8-6 10-6 18 0-4-3-6-4-9-4 5-8 9-8 16 0 8 7 14 16 14s16-6 16-14c0-12-8-19-14-25z" {...S} /> ) },
  { key: 'clock', label: 'Время', path: (
    <>
      <circle cx="40" cy="40" r="17" {...S} />
      <path d="M40 30v11l7 5" {...S} />
    </> ) },
]

export const ICON_KEYS = new Set(CARD_ICONS.map(i => i.key))

/**
 * Круглая иконка с металлической (или сплошной) заливкой.
 * `id` обязателен и уникален — иначе градиенты на странице перетрут друг друга.
 */
export function CardIcon({
  iconKey, color, metallic = true, size = 96, symbolColor = '#25455D', id,
}: {
  iconKey: string
  color: string
  metallic?: boolean
  size?: number
  symbolColor?: string
  id: string
}) {
  const def = CARD_ICONS.find(i => i.key === iconKey)
  if (!def) return null
  const gid = `lp-ic-${id}`
  return (
    <svg viewBox="0 0 80 80" width={size} height={size} style={{ display: 'block' }}
         xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {metallic && (
        <linearGradient id={gid} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor={shade(color, -32)} />
          <stop offset="35%" stopColor={color} />
          <stop offset="50%" stopColor={shade(color, 28)} />
          <stop offset="65%" stopColor={color} />
          <stop offset="100%" stopColor={shade(color, -32)} />
        </linearGradient>
      )}
      <circle cx="40" cy="40" r="40" fill={metallic ? `url(#${gid})` : color} />
      <g stroke={symbolColor} color={symbolColor}>{def.path}</g>
    </svg>
  )
}

/** Осветление/затемнение HEX на процент — для металлического перелива. */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return hex || '#FFCFA4'
  const n = parseInt(m[1], 16)
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + (255 - v) * (pct / 100))))
  const g = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 + pct / 100))))
  const fn = pct >= 0 ? f : g
  return `#${[fn((n >> 16) & 255), fn((n >> 8) & 255), fn(n & 255)]
    .map(v => v.toString(16).padStart(2, '0')).join('')}`
}
