'use client'
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'

type Status = 'draft' | 'published' | 'ended'

interface Props {
  eventId: number
  status: Status | string
  onChange: (next: Status) => void
}

// Кнопка-переключатель статуса события.
// Черновик: акцентная кнопка «Опубликовать» (золото) — действие очевидно.
// Опубликовано: зелёный статус + тонкая ссылка «вернуть в черновик».
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

  if (isDraft) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400" />
          Черновик
        </span>
        <button
          onClick={toggle}
          disabled={busy}
          title="Опубликовать — событие появится в Mini App у участников"
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors whitespace-nowrap border-2 disabled:opacity-50"
          style={{
            background: '#FFCFA4',
            color: '#25455D',
            borderColor: '#FFCFA4',
          }}
        >
          <Eye size={16} />
          {busy ? 'Публикуем…' : 'Опубликовать'}
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 whitespace-nowrap">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Опубликовано
      </span>
      <button
        onClick={toggle}
        disabled={busy}
        title="Скрыть — событие пропадёт из Mini App"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors whitespace-nowrap disabled:opacity-50"
      >
        <EyeOff size={13} />
        {busy ? 'Скрываем…' : 'В черновик'}
      </button>
    </div>
  )
}
