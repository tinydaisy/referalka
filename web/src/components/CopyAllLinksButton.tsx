'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

/**
 * Единый формат «скопировать сразу все площадки» одной кнопкой.
 *
 * Формат текста в буфере (между строками — пустая строка):
 *
 *   Через ТГ: <ссылка>
 *
 *   Через MAX: <ссылка>
 *
 *   Через ВК: <ссылка>
 *
 * Площадки без ссылки в текст не попадают. Порядок фиксированный
 * (ТГ → MAX → ВК) — он же в подсказке, чтобы человек знал, что скопировал.
 */

export type PlatformLinks = Partial<Record<'telegram' | 'vk' | 'max' | 'web' | 'landing', string>>

/** Порядок и подписи — единая точка. Меняется здесь, применяется везде.
 *
 *  ⚠️ 'landing' и 'web' (24.09.2026) — веб-страницы без мессенджера, и они
 *  идут ПОСЛЕ мессенджеров: это запасной путь для тех, кого нет в ботах.
 *  Ключа нет в наборе — строка просто не попадёт в текст, как и раньше. */
const ORDER: Array<{ key: 'telegram' | 'max' | 'vk' | 'landing' | 'web'; label: string }> = [
  { key: 'telegram', label: 'Через ТГ' },
  { key: 'max', label: 'Через MAX' },
  { key: 'vk', label: 'Через ВК' },
  { key: 'landing', label: 'Лендинг' },
  { key: 'web', label: 'Без мессенджера' },
]

/** Собрать текст для буфера. Экспортирую отдельно — Mini App живёт в другом
 *  бандле и не может импортировать React-компонент, но формат должен быть один. */
export function buildAllLinksText(links: PlatformLinks): string {
  return ORDER
    .filter(({ key }) => (links[key] || '').trim())
    .map(({ key, label }) => `${label}: ${(links[key] || '').trim()}`)
    .join('\n\n')
}

export function countLinks(links: PlatformLinks): number {
  return ORDER.filter(({ key }) => (links[key] || '').trim()).length
}

export default function CopyAllLinksButton({
  links,
  disabled,
  disabledHint,
  className,
  label = 'Скопировать все ссылки',
}: {
  links: PlatformLinks
  disabled?: boolean
  disabledHint?: string
  className?: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  const total = countLinks(links)

  // Одна площадка — отдельная кнопка «все ссылки» только путает.
  if (total < 2) return null

  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (disabled) {
      if (disabledHint) alert(disabledHint)
      return
    }
    try {
      await navigator.clipboard.writeText(buildAllLinksText(links))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (_) {
      /* буфер недоступен — молча, кнопка просто не даст подтверждения */
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={disabled ? disabledHint : `Скопировать ${total} ссылки одним текстом`}
      className={
        className ??
        `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          disabled
            ? 'text-gray-300 border-gray-200 cursor-not-allowed'
            : copied
              ? 'text-green-700 border-green-300 bg-green-50'
              : 'text-[#25455D] border-gray-300 bg-white hover:bg-gray-50'
        }`
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'Скопировано' : label}
    </button>
  )
}
