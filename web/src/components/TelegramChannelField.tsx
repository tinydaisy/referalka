'use client'
import { useState } from 'react'
import { api } from '@/lib/api'

/**
 * Унифицированный блок «Telegram канал» с двумя полями (ссылка и ID канала)
 * и кнопкой автоматического получения ID через Bot API getChat.
 *
 * Используется:
 *   • визитка основателя (`/dashboard/mini-app`) — одна пара URL+ID
 *   • карточка коллаборатора                    — одна пара URL+ID
 *   • блок «Чат события» в мероприятии и конференции — URL + ID-ы через запятую
 *
 * Если `mode='multi'` — поле ID хранит несколько id через запятую (для рассылок
 * в дополнительные чаты). Получение через кнопку добавляет новый id в список.
 *
 * Сохранение делает родитель — компонент только редактирует значения через onChange.
 */
export interface TelegramChannelValue {
  url: string
  /** Один id (`-1001234567890`) для mode='single', либо CSV-строка для mode='multi'. */
  chatId: string
}

interface Props {
  title?: string
  value: TelegramChannelValue
  onChange: (next: TelegramChannelValue) => void
  mode?: 'single' | 'multi'
  /** Когда вызвать инструкцию на закрытый канал — куда вести пользователя. */
  helpHref?: string
}

function normalizeChatIdInput(raw: string, multi: boolean): string {
  if (multi) {
    // Несколько id через запятую, каждый: digits + один минус в начале
    return raw
      .split(',')
      .map(p => {
        const t = p.trim().replace(/[^\d-]/g, '')
        const sign = t.startsWith('-') ? '-' : ''
        const digits = t.replace(/-/g, '')
        return digits ? sign + digits : ''
      })
      .filter(Boolean)
      .join(',')
  }
  const t = raw.trim().replace(/[^\d-]/g, '')
  const sign = t.startsWith('-') ? '-' : ''
  const digits = t.replace(/-/g, '')
  return digits ? sign + digits : ''
}

function chatIdLooksValid(s: string, multi: boolean): boolean {
  if (!s) return true
  if (multi) {
    return s.split(',').every(p => /^-100\d{6,}$/.test(p.trim()))
  }
  return /^-100\d{6,}$/.test(s)
}

export function TelegramChannelField({
  title = 'Telegram канал',
  value,
  onChange,
  mode = 'single',
  helpHref = '/dashboard/settings#tg-chat-id',
}: Props) {
  const [usernameDraft, setUsernameDraft] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const valid = chatIdLooksValid(value.chatId || '', mode === 'multi')

  function appendId(newId: string | number) {
    const id = String(newId).trim()
    if (!id) return
    if (mode === 'multi') {
      const existing = (value.chatId || '').split(',').map(s => s.trim()).filter(Boolean)
      if (existing.includes(id)) {
        alert(`ID ${id} уже в списке`)
        return
      }
      onChange({ ...value, chatId: [...existing, id].join(',') })
    } else {
      onChange({ ...value, chatId: id })
    }
  }

  async function tryResolve(username?: string): Promise<boolean> {
    try {
      const res: any = await api.utils.resolveTgChatId(username ? { username } : { url: value.url })
      if (res?.chat_id) {
        appendId(res.chat_id)
        alert(`ID канала получен: ${res.chat_id}`)
        return true
      }
      return false
    } catch (e: any) {
      alert(e.message || 'Не получилось получить ID')
      return false
    }
  }

  async function handleResolveClick() {
    const link = value.url || ''
    const isInvite = /\/\+/.test(link) || !link
    if (!isInvite) {
      await tryResolve()
      return
    }
    setPromptOpen(true)
  }

  return (
    <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
      <label className="block text-sm font-semibold text-gray-800">{title}</label>

      <div>
        <label className="block text-xs text-gray-600 mb-1">Ссылка на канал</label>
        <input
          type="url"
          value={value.url}
          onChange={e => onChange({ ...value, url: e.target.value })}
          placeholder="https://t.me/your_channel"
          className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
        />
        <p className="text-xs text-gray-500 mt-1">
          Полная ссылка через https. Для закрытого канала — инвайт-ссылка вида https://t.me/+abcDEF…
        </p>
      </div>

      <div>
        <label className="block text-xs text-gray-600 mb-1">
          {mode === 'multi' ? 'ID каналов (через запятую)' : 'ID канала'}{' '}
          <span className="text-gray-400">(нужен для проверки подписки и рассылок)</span>
        </label>
        <div className="flex gap-2 items-stretch flex-wrap">
          <input
            type="text"
            inputMode={mode === 'multi' ? 'text' : 'numeric'}
            value={value.chatId || ''}
            onChange={e => onChange({ ...value, chatId: e.target.value })}
            onBlur={e => onChange({ ...value, chatId: normalizeChatIdInput(e.target.value, mode === 'multi') })}
            placeholder={mode === 'multi' ? '-1001234567890,-1009876543210' : '-1001234567890'}
            className={`flex-1 min-w-0 px-3 py-1.5 text-sm font-mono bg-white border rounded focus:outline-none focus:border-[#25455D] ${
              valid ? 'border-gray-200' : 'border-red-300'
            }`}
          />
          <button
            type="button"
            onClick={handleResolveClick}
            className="px-3 py-1.5 text-xs rounded bg-[#25455D] text-white whitespace-nowrap"
          >
            {mode === 'multi' ? 'Добавить ID автоматически' : 'Получить автоматически'}
          </button>
        </div>
        {!valid && (
          <p className="text-xs text-red-600 mt-1">
            ID должен начинаться с «-100» и содержать только цифры. Например: -1001234567890
          </p>
        )}
        <p className="text-xs text-gray-500 mt-1">
          Открытый канал — кнопка сделает всё за вас. Закрытый — впишите ID руками.{' '}
          <a href={helpHref} className="text-[#25455D] underline">
            Как узнать ID канала
          </a>
          .
        </p>
      </div>

      {promptOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => { setPromptOpen(false); setUsernameDraft('') }}
        >
          <div className="bg-white rounded-xl max-w-md w-full p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900">Получить ID канала</h3>
            <p className="text-sm text-gray-700">
              У канала из ссылки нет публичного <code className="font-mono">@username</code> — это закрытый канал по инвайт-ссылке.
            </p>
            <p className="text-sm text-gray-700">
              <strong>Если у канала есть публичный @username</strong> — впишите его (с @ или без):
            </p>
            <input
              type="text"
              autoFocus
              value={usernameDraft}
              onChange={e => setUsernameDraft(e.target.value.replace(/^@+/, '').trim())}
              placeholder="my_channel"
              className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
            />
            <p className="text-sm text-gray-700">
              <strong>Если @username нет</strong> — закройте окно и получите ID через бот:{' '}
              <a href={helpHref} className="text-[#25455D] underline font-medium">
                инструкция в Тех.поддержке
              </a>
              .
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setPromptOpen(false); setUsernameDraft('') }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={!usernameDraft}
                onClick={async () => {
                  const u = usernameDraft.trim().replace(/^@+/, '').split('/').pop() || ''
                  setPromptOpen(false); setUsernameDraft('')
                  if (u) await tryResolve(u)
                }}
                className="px-4 py-2 text-sm rounded-lg text-white font-medium disabled:opacity-50"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
              >
                Получить ID
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
