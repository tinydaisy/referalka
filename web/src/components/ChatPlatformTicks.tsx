'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import PlatformLogo from '@/components/PlatformLogo'

/**
 * Галочки площадок ПОД КАЖДЫМ видом чатов рассылки (миграция 520).
 *
 * «Каналы для отправки» управляют только личными сообщениями по базе, а у
 * чатов свои галочки: так можно отправить, например, только в ВК-чат события,
 * не трогая ни другие площадки, ни личку. По умолчанию все стоят.
 *
 * Значение — chat_platforms рассылки/шаблона:
 *   { event: ['telegram','vk'], common: [...], ... }
 * Нет ключа вида = все площадки. Снимая галочку, храним СПИСОК ОСТАВШИХСЯ из
 * всех площадок вида (а не только видимых): площадка, подключённая позже,
 * в старой рассылке окажется отмеченной, а не молча снятой.
 * Движок — backend/app/tasks/broadcast.py (_chat_platforms_for).
 */

export type ChatKind = 'private' | 'common' | 'event' | 'speakers'
export type ChatPlatforms = Partial<Record<ChatKind, string[]>>
export type ChatPlatformsAvailable = Record<ChatKind, string[]>

// Какие площадки бывают у вида. WhatsApp — только у общих чатов.
// Держать в согласии с KIND_PLATFORMS в services/broadcast_chat_platforms.py.
const KIND_PLATFORMS: Record<ChatKind, string[]> = {
  private: ['telegram', 'max', 'vk'],
  common: ['telegram', 'max', 'vk', 'whatsapp'],
  event: ['telegram', 'max', 'vk'],
  speakers: ['telegram', 'max', 'vk'],
}

const SHORT: Record<string, string> = { telegram: 'ТГ', max: 'MAX', vk: 'ВК', whatsapp: 'WhatsApp' }

/** Разбор chat_platforms с бэка (dict, строка JSON или null). */
export function parseChatPlatforms(v: any): ChatPlatforms {
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return {} } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

/** Площадки, подключённые у каждого вида. eventId не задан — общие рассылки клиента. */
export function useChatPlatformsAvailable(eventId?: number | null): ChatPlatformsAvailable | null {
  const [av, setAv] = useState<ChatPlatformsAvailable | null>(null)
  useEffect(() => {
    let alive = true
    const req = eventId ? api.conference.chatPlatforms(eventId) : api.broadcasts.chatPlatforms()
    req.then((r: any) => { if (alive) setAv(r) }).catch(() => {})
    return () => { alive = false }
  }, [eventId])
  return av
}

/** Для пилюли в очереди: ' (ТГ, ВК)', если часть площадок снята, иначе ''. */
export function chatPlatformsSuffix(kind: ChatKind, value: ChatPlatforms | null | undefined): string {
  const list = value?.[kind]
  if (!Array.isArray(list)) return ''
  if (!list.length) return ' (ни одной площадки)'
  return ` (${list.map(p => SHORT[p] || p).join(', ')})`
}

export default function ChatPlatformTicks(props: {
  kind: ChatKind
  value: ChatPlatforms
  onChange: (next: ChatPlatforms) => void
  available: ChatPlatformsAvailable | null
  /** Галочка вида снята — площадки показываем бледно, выбор сохраняется. */
  disabled?: boolean
}) {
  const shown = props.available?.[props.kind] || []
  if (!shown.length) return null
  const cur = props.value[props.kind]

  function toggle(p: string) {
    const base = Array.isArray(cur) ? cur : KIND_PLATFORMS[props.kind]
    const next = base.includes(p) ? base.filter(x => x !== p) : [...base, p]
    const all = KIND_PLATFORMS[props.kind]
    const out = { ...props.value }
    if (all.every(x => next.includes(x))) delete out[props.kind]
    else out[props.kind] = all.filter(x => next.includes(x))
    props.onChange(out)
  }

  return (
    <div className={`flex flex-wrap gap-x-3 gap-y-1 pl-7 -mt-1 ${props.disabled ? 'opacity-40' : ''}`}>
      {shown.map(p => {
        const on = !Array.isArray(cur) || cur.includes(p)
        return (
          <label key={p} className="flex items-center gap-1 text-[11px] text-gray-600 cursor-pointer select-none">
            <input type="checkbox" checked={on} onChange={() => toggle(p)}
              className="w-3.5 h-3.5 accent-[#25455D]" />
            <PlatformLogo slug={p} size={14} />
            <span>{SHORT[p] || p}</span>
          </label>
        )
      })}
    </div>
  )
}
