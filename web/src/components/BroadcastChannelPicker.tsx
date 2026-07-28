'use client'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { api } from '@/lib/api'

type Channel = {
  id: number
  platform_slug: string
  display_name: string | null
  handle: string | null
  is_system: boolean
  is_active: boolean
  subscribers: number | string
  platform_display_name?: string | null
}

/**
 * Площадки, скрытые из выбора каналов рассылки (общей и событийной).
 * WhatsApp — рассылки через мост не идут, скрыт всегда.
 * Email — только по фиче `email_broadcasts` (см. EMAIL_FEATURE ниже).
 */
const HIDDEN_PLATFORMS = new Set(['whatsapp'])

/**
 * Фича «Рассылки по email». Есть у клиента → площадка Email показывается в
 * выборе каналов; нет → скрыта и никогда не отмечается галочкой.
 *
 * ⚠️ Гейтим ПО ФИЧЕ, не по tariff_slug. Движок рассылки email умеет всегда
 * (`_send_broadcast_email_part` в tasks/broadcast.py) — ограничение только здесь.
 */
const EMAIL_FEATURE = 'email_broadcasts'

const PLATFORM_TITLE: Record<string, string> = {
  telegram: 'Telegram',
  vk: 'VK',
  max: 'MAX',
  email: 'Email',
}

const PLATFORM_EMOJI: Record<string, string> = {
  telegram: '📨',
  vk: '🔵',
  max: '🟠',
  email: '✉️',
}

type Props = {
  /**
   * Текущее значение. null = «слать по всем каналам» (default).
   * Массив = выбраны только указанные channel_id.
   */
  value: number[] | null
  /**
   * Возвращает массив channel_id. Если выбраны все каналы — вернёт полный
   * список (фронт всегда отдаёт массив).
   */
  onChange: (next: number[]) => void
}

export default function BroadcastChannelPicker({ value, onChange }: Props) {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    // Каналы и фичи клиента грузим вместе: без фич не решить, показывать ли Email.
    Promise.all([api.channels.list(), api.auth.me()]).then(([res, me]: any[]) => {
      if (cancelled) return
      // WhatsApp (с 2026-07-10) скрыт всегда, Email — только без фичи
      // email_broadcasts. Отфильтровываем ДО onChange, чтобы скрытая площадка не
      // рисовалась секцией и не попадала в target_channel_ids (иначе галочка
      // встала бы сама при инициализации «выбрать все»).
      const hasEmail = !!(me?.features || []).includes(EMAIL_FEATURE)
      const items: Channel[] = (res?.items || []).filter((c: Channel) => {
        if (HIDDEN_PLATFORMS.has(c.platform_slug)) return false
        if (c.platform_slug === 'email' && !hasEmail) return false
        return true
      })
      setChannels(items)
      // Первая инициализация: NULL → выбрать все каналы (поведение по умолчанию).
      // ⚠️ Email — ИСКЛЮЧЕНИЕ: по умолчанию галочка всегда СНЯТА, даже когда фича
      // есть и площадка показывается. Отправка по почте — осознанный выбор
      // клиента на каждую рассылку, сама собой не включается.
      if (value === null) {
        onChange(items.filter(c => c.platform_slug !== 'email').map(c => c.id))
      }
    }).catch((e: any) => {
      if (cancelled) return
      setLoadErr(e?.message || 'Не удалось загрузить список каналов')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Закрытие по клику вне dropdown.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (loadErr) {
    return (
      <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
        {loadErr}
      </div>
    )
  }
  if (channels === null) {
    return (
      <div>
        <label className="text-xs text-gray-500 mb-1 block">Каналы для отправки</label>
        <div className="text-xs text-gray-400 px-3 py-2">Загружаю каналы…</div>
      </div>
    )
  }
  if (channels.length === 0) {
    return (
      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        У вас пока нет ни одного канала — настройте их в разделе «Каналы».
      </div>
    )
  }

  const selected = new Set<number>(value || channels.map(c => c.id))
  const allSelected = channels.every(c => selected.has(c.id))
  const noneSelected = selected.size === 0

  function toggle(id: number) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    onChange(Array.from(next))
  }
  function toggleAll() {
    if (allSelected) onChange([])
    else onChange(channels!.map(c => c.id))
  }

  // Группировка по платформе
  const grouped: Record<string, Channel[]> = {}
  for (const ch of channels) {
    const k = ch.platform_slug
    if (!grouped[k]) grouped[k] = []
    grouped[k].push(ch)
  }
  const platformOrder = ['telegram', 'vk', 'max', 'email']
  const platforms = platformOrder.filter(p => grouped[p]).concat(
    Object.keys(grouped).filter(p => !platformOrder.includes(p))
  )

  // Краткое описание в свёрнутом виде
  let summary: string
  if (allSelected) {
    summary = `Все каналы (${channels.length})`
  } else if (noneSelected) {
    summary = 'Ни один канал не выбран'
  } else {
    // Если внутри платформы выбраны все — пишем название платформы, иначе «N из M»
    const parts: string[] = []
    for (const p of platforms) {
      const all = grouped[p]
      const inSel = all.filter(c => selected.has(c.id)).length
      if (inSel === 0) continue
      if (inSel === all.length) parts.push(PLATFORM_TITLE[p] || p)
      else parts.push(`${PLATFORM_TITLE[p] || p} (${inSel}/${all.length})`)
    }
    summary = parts.join(', ')
  }

  return (
    <div ref={wrapperRef} className="relative">
      <label className="text-xs text-gray-500 mb-1 block">Каналы для отправки</label>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 border rounded-lg text-sm bg-white text-left
          ${noneSelected ? 'border-red-300 text-red-600' : 'border-gray-200 text-gray-700'}
          hover:border-gray-300`}>
        <span className="truncate">{summary}</span>
        <ChevronDown
          size={16}
          className={`text-gray-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg max-h-80 overflow-y-auto">
          <button
            type="button"
            onClick={toggleAll}
            className="w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-gray-50 text-xs text-indigo-600 font-medium">
            {allSelected ? 'Снять все галочки' : 'Выбрать все каналы'}
          </button>
          {platforms.map(platform => (
            <div key={platform} className="px-2 py-1.5 border-b border-gray-100 last:border-b-0">
              <div className="text-[11px] uppercase tracking-wide text-gray-400 px-2 py-1">
                {PLATFORM_EMOJI[platform] || ''} {PLATFORM_TITLE[platform] || platform}
              </div>
              {grouped[platform].map(ch => {
                const checked = selected.has(ch.id)
                const subs = typeof ch.subscribers === 'string' ? parseInt(ch.subscribers) : ch.subscribers
                return (
                  <label
                    key={ch.id}
                    className="flex items-center gap-2 cursor-pointer text-sm px-2 py-1.5 rounded-lg hover:bg-gray-50">
                    <span className={`w-4 h-4 flex items-center justify-center rounded border ${checked ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300 bg-white'}`}>
                      {checked && <Check size={11} className="text-white" strokeWidth={3} />}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() => toggle(ch.id)}
                    />
                    <span className={`flex-1 truncate ${checked ? 'text-gray-800' : 'text-gray-400'}`}>
                      {ch.display_name || ch.handle || `Канал #${ch.id}`}
                      {ch.is_system && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">сист.</span>
                      )}
                    </span>
                    <span className="text-[11px] text-gray-400 shrink-0">
                      {Number.isFinite(subs) ? `${subs} подп.` : ''}
                    </span>
                  </label>
                )
              })}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-gray-400 mt-1">
        По умолчанию — все каналы. Снимите галочку, чтобы пропустить канал.
      </p>
    </div>
  )
}
