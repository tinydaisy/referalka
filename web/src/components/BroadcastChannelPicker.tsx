'use client'
import { useEffect, useState } from 'react'
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
   * Возвращает массив всех channel_id если выбраны все, либо подмножество.
   * null не возвращаем — фронт всегда явно отдаёт массив.
   */
  onChange: (next: number[]) => void
}

export default function BroadcastChannelPicker({ value, onChange }: Props) {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.channels.list().then((res: any) => {
      if (cancelled) return
      const items: Channel[] = res?.items || []
      setChannels(items)
      // Первая инициализация: если value === null (вообще ничего не выбрано
      // от пользователя), выставляем «все каналы» — таково поведение по
      // умолчанию по требованию. Если value уже массив — оставляем.
      if (value === null) {
        onChange(items.map(c => c.id))
      }
    }).catch((e: any) => {
      if (cancelled) return
      setLoadErr(e?.message || 'Не удалось загрузить список каналов')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loadErr) {
    return (
      <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
        {loadErr}
      </div>
    )
  }
  if (channels === null) {
    return <div className="text-xs text-gray-400">Загружаю каналы…</div>
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs text-gray-500">Каналы для отправки</label>
        <button type="button" onClick={toggleAll}
          className="text-[11px] text-indigo-600 hover:text-indigo-800">
          {allSelected ? 'Снять всё' : 'Выбрать все'}
        </button>
      </div>
      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
        {platforms.map(platform => (
          <div key={platform} className="px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1.5">
              {PLATFORM_EMOJI[platform] || ''} {PLATFORM_TITLE[platform] || platform}
            </div>
            <div className="space-y-1.5">
              {grouped[platform].map(ch => {
                const checked = selected.has(ch.id)
                const subs = typeof ch.subscribers === 'string' ? parseInt(ch.subscribers) : ch.subscribers
                return (
                  <label key={ch.id}
                    className="flex items-center gap-2 cursor-pointer text-sm py-0.5 group">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(ch.id)}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className={checked ? 'text-gray-800' : 'text-gray-400'}>
                      {ch.display_name || ch.handle || `Канал #${ch.id}`}
                      {ch.is_system && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">сист.</span>
                      )}
                    </span>
                    <span className="ml-auto text-[11px] text-gray-400">
                      {Number.isFinite(subs) ? `${subs} подп.` : ''}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-400">
        По умолчанию рассылка уходит по всем каналам. Снимите галочку — этот канал будет пропущен.
      </p>
    </div>
  )
}
