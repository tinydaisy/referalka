'use client'
import { useState } from 'react'
import { api } from '@/lib/api'

type Status = 'draft' | 'published' | 'ended'

interface Props {
  eventId: number
  status: Status | string
  onChange: (next: Status) => void
}

// Кнопка-переключатель статуса события: «Черновик» ↔ «Опубликовано».
// Черновик не показывается в Mini App. Опубликованное — видно всем.
export function EventStatusToggle({ eventId, status, onChange }: Props) {
  const [busy, setBusy] = useState(false)
  const isDraft = status === 'draft'

  async function toggle() {
    if (busy) return
    const next: Status = isDraft ? 'published' : 'draft'
    setBusy(true)
    try {
      await api.events.update(eventId, { status: next })
      onChange(next)
    } catch {
      alert('Не удалось обновить статус')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      title={isDraft
        ? 'Сейчас черновик — событие не показывается в Mini App. Кликните, чтобы опубликовать.'
        : 'Опубликовано — событие видно в Mini App. Кликните, чтобы вернуть в черновик.'}
      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap border disabled:opacity-50 ${
        isDraft
          ? 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
          : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
      }`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${isDraft ? 'bg-gray-400' : 'bg-emerald-500'}`} />
      {isDraft ? 'Черновик' : 'Опубликовано'}
    </button>
  )
}
