'use client'
import { useState } from 'react'
import { api } from '@/lib/api'

/**
 * Блок «Чаты события» — 3 ссылки на чаты (Telegram / ВКонтакте / MAX) +
 * radio «какой главный». Используется в Основном таб мероприятия, Настройках
 * конференции и Конкурсе. Главный чат показывается участникам выделенной
 * крупной кнопкой, остальные — как «резервные».
 *
 * Для TG дополнительно есть поле «ID каналов через запятую» (для проверки
 * подписки и рассылок) — это поле events.telegram_chat_ids.
 *
 * Родитель хранит value/onChange, сам собирает diff и шлёт PATCH.
 */

export type ChatPlatform = 'telegram' | 'vk' | 'max'

export interface EventChatsValue {
  tg: string                 // events.chat_url_tg
  vk: string                 // events.chat_url_vk
  max: string                // events.chat_url_max
  primary: ChatPlatform | null  // events.primary_chat_platform
  chatIds: string            // events.telegram_chat_ids (CSV — только TG)
}

interface Props {
  value: EventChatsValue
  onChange: (next: EventChatsValue) => void
  /** Куда вести из «Как узнать ID канала». */
  helpHref?: string
}

const PLATFORM_META: Record<ChatPlatform, { label: string; badge: string; color: string; placeholder: string }> = {
  telegram: { label: 'Telegram',  badge: 'TG',  color: '#229ED9', placeholder: 'https://t.me/your_chat' },
  vk:       { label: 'ВКонтакте', badge: 'VK',  color: '#0077FF', placeholder: 'https://vk.com/your_chat' },
  max:      { label: 'MAX',       badge: 'MAX', color: '#F45D22', placeholder: 'https://max.ru/your_chat' },
}

function normalizeChatIdInput(raw: string): string {
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

function chatIdLooksValid(s: string): boolean {
  if (!s) return true
  return s.split(',').every(p => /^-100\d{6,}$/.test(p.trim()))
}

export default function EventChatsField({ value, onChange, helpHref = '/dashboard/settings#tg-chat-id' }: Props) {
  const [usernameDraft, setUsernameDraft] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const idsValid = chatIdLooksValid(value.chatIds || '')

  // Если primary не выбран, но какая-то ссылка есть — подсветим первую
  // заполненную в подсказке (UI), не записывая в value (это сделает родитель).
  const filledPlatforms: ChatPlatform[] = (['telegram', 'vk', 'max'] as const).filter(p => {
    const k = p === 'telegram' ? 'tg' : p
    return !!(value as any)[k]?.trim()
  })

  function setUrl(platform: ChatPlatform, url: string) {
    const key = platform === 'telegram' ? 'tg' : platform
    const next = { ...value, [key]: url }
    // Авто-выбор primary: если primary ещё не выбран и юзер только что заполнил
    // первое поле — ставим primary на эту платформу.
    if (!next.primary && url.trim()) {
      next.primary = platform
    }
    // Если очищена ссылка которая была primary — снимаем primary, выбираем
    // следующую заполненную (если есть).
    if (next.primary === platform && !url.trim()) {
      const others = (['telegram', 'vk', 'max'] as const).filter(p => p !== platform)
      const newPrimary = others.find(p => {
        const k = p === 'telegram' ? 'tg' : p
        return !!(next as any)[k]?.trim()
      })
      next.primary = newPrimary || null
    }
    onChange(next)
  }

  function setPrimary(platform: ChatPlatform) {
    const key = platform === 'telegram' ? 'tg' : platform
    if (!(value as any)[key]?.trim()) {
      // Нельзя выбрать главным пустое поле
      return
    }
    onChange({ ...value, primary: platform })
  }

  function appendChatId(newId: string | number) {
    const id = String(newId).trim()
    if (!id) return
    const existing = (value.chatIds || '').split(',').map(s => s.trim()).filter(Boolean)
    if (existing.includes(id)) {
      alert(`ID ${id} уже в списке`)
      return
    }
    onChange({ ...value, chatIds: [...existing, id].join(',') })
  }

  async function tryResolve(username?: string): Promise<boolean> {
    try {
      const res: any = await api.utils.resolveTgChatId(username ? { username } : { url: value.tg })
      if (res?.chat_id) {
        appendChatId(res.chat_id)
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
    const link = value.tg || ''
    const isInvite = /\/\+/.test(link) || !link
    if (!isInvite) {
      await tryResolve()
      return
    }
    setPromptOpen(true)
  }

  return (
    <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-3">
      <div>
        <label className="block text-sm font-semibold text-gray-800">Чаты события</label>
        <p className="text-xs text-gray-500 mt-1">
          Заполните ссылки на чаты для тех площадок, которые планируете использовать. Радио-кнопкой выберите <b>главный чат</b>: его участники увидят первым после проверки подписки, остальные — как «резервные».
        </p>
      </div>

      {(['telegram', 'vk', 'max'] as const).map(platform => {
        const meta = PLATFORM_META[platform]
        const key = platform === 'telegram' ? 'tg' : platform
        const url = (value as any)[key] as string
        const isPrimary = value.primary === platform
        const canBePrimary = !!url?.trim()
        return (
          <div key={platform} className="bg-white border border-gray-200 rounded p-3">
            <div className="flex items-center gap-3 mb-2">
              <input
                type="radio"
                name="primary_chat_platform"
                checked={isPrimary}
                onChange={() => setPrimary(platform)}
                disabled={!canBePrimary}
                className="w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
                style={{ accentColor: '#25455D' }}
                title={canBePrimary ? 'Сделать главным чатом' : 'Сначала заполните ссылку'}
              />
              <span
                className="inline-flex items-center justify-center w-9 h-7 rounded text-[10px] font-bold text-white shrink-0"
                style={{ background: meta.color }}
              >
                {meta.badge}
              </span>
              <span className="text-sm font-medium text-gray-800">{meta.label}</span>
              {isPrimary && (
                <span className="ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                      style={{ background: '#FFCFA4', color: '#25455D' }}>
                  Главный
                </span>
              )}
            </div>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(platform, e.target.value)}
              placeholder={meta.placeholder}
              className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
            />
            {platform === 'telegram' && (
              <p className="text-[11px] text-gray-500 mt-1">
                Для закрытого канала — инвайт-ссылка вида https://t.me/+abcDEF…
              </p>
            )}
          </div>
        )
      })}

      {filledPlatforms.length === 0 && (
        <p className="text-xs text-gray-400 italic">
          Если ни одной ссылки не задано — плитка «Чат» в Mini App у участников не покажется.
        </p>
      )}

      {/* ID каналов — только для TG, для проверки подписки и рассылок */}
      <div className="pt-3 mt-2 border-t border-gray-200">
        <label className="block text-xs text-gray-600 mb-1">
          ID Telegram-каналов (через запятую){' '}
          <span className="text-gray-400">— нужен для рассылок в этот чат</span>
        </label>
        <div className="flex gap-2 items-stretch flex-wrap">
          <input
            type="text"
            inputMode="text"
            value={value.chatIds || ''}
            onChange={e => onChange({ ...value, chatIds: e.target.value })}
            onBlur={e => onChange({ ...value, chatIds: normalizeChatIdInput(e.target.value) })}
            placeholder="-1001234567890,-1009876543210"
            className={`flex-1 min-w-0 px-3 py-1.5 text-sm font-mono bg-white border rounded focus:outline-none focus:border-[#25455D] ${
              idsValid ? 'border-gray-200' : 'border-red-300'
            }`}
          />
          <button
            type="button"
            onClick={handleResolveClick}
            className="px-3 py-1.5 text-xs rounded bg-[#25455D] text-white whitespace-nowrap"
          >
            Добавить ID автоматически
          </button>
        </div>
        {!idsValid && (
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
