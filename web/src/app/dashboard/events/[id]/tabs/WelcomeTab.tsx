'use client'

/**
 * Вкладка «Приветствие» — контейнер с двумя подвкладками:
 *  - «На почту»  — приветственное письмо при регистрации (WelcomeEmailTab)
 *  - «В чатах»   — ответ ботом на кодовое слово в чатах события (ChatGreetingTab)
 */
import { useState } from 'react'
import WelcomeEmailTab from './WelcomeEmailTab'
import ChatGreetingTab from './ChatGreetingTab'

interface Props {
  event: any
  eventId: number
  onReload: () => void
}

export default function WelcomeTab({ event, eventId, onReload }: Props) {
  const [sub, setSub] = useState<'email' | 'chat'>('email')

  const subTabs: { key: 'email' | 'chat'; label: string }[] = [
    { key: 'email', label: 'На почту' },
    { key: 'chat',  label: 'В чатах' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-gray-200">
        {subTabs.map(t => (
          <button key={t.key} onClick={() => setSub(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              sub === t.key
                ? 'border-brand text-brand'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {sub === 'email' && <WelcomeEmailTab event={event} eventId={eventId} onReload={onReload} />}
      {sub === 'chat'  && <ChatGreetingTab event={event} eventId={eventId} onReload={onReload} />}
    </div>
  )
}
