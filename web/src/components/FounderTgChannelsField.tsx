'use client'
import { useState } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * Редактор списка TG-каналов основателя (миграция 114).
 *
 * Хранение: массив `social_links.telegram_channels` =
 *   [{ url, chat_id, name }, ...]
 *
 * Используется в:
 *   - /dashboard/mini-app → вкладка «Основатель» → секция «Telegram каналы основателя»
 *
 * Эти же каналы используются для:
 *   - проверки подписки в воронке лид-магнита (подписан на ВСЕ → выдаём материалы)
 *   - проверки подписки в чат-гейте (подписан на ВСЕ → пишет в чате)
 */
export interface FounderTgChannel {
  url:     string
  chat_id: string
  name:    string
}

interface Props {
  value: FounderTgChannel[]
  onChange: (next: FounderTgChannel[]) => void
  helpHref?: string
}

function normalizeChatIdInput(raw: string): string {
  if (!raw) return ''
  const t = raw.trim().replace(/[^\d-]/g, '')
  const sign = t.startsWith('-') ? '-' : ''
  const digits = t.replace(/-/g, '')
  return digits ? sign + digits : ''
}

function chatIdLooksValid(s: string): boolean {
  if (!s) return true
  return /^-100\d{6,}$/.test(s)
}

function emptyChannel(): FounderTgChannel {
  return { url: '', chat_id: '', name: '' }
}

export function FounderTgChannelsField({ value, onChange, helpHref = '/dashboard/settings#tg-chat-id' }: Props) {
  const [resolvingIndex, setResolvingIndex] = useState<number | null>(null)
  const [promptOpen, setPromptOpen] = useState<{ index: number } | null>(null)
  const [usernameDraft, setUsernameDraft] = useState('')

  function updateAt(i: number, patch: Partial<FounderTgChannel>) {
    const next = value.map((ch, idx) => idx === i ? { ...ch, ...patch } : ch)
    onChange(next)
  }

  function addChannel() {
    onChange([...(value || []), emptyChannel()])
  }

  function removeAt(i: number) {
    if (!confirm('Удалить этот канал? Проверка подписки на него больше идти не будет.')) return
    onChange(value.filter((_, idx) => idx !== i))
  }

  function moveUp(i: number) {
    if (i === 0) return
    const next = [...value]
    ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
    onChange(next)
  }

  function moveDown(i: number) {
    if (i >= value.length - 1) return
    const next = [...value]
    ;[next[i + 1], next[i]] = [next[i], next[i + 1]]
    onChange(next)
  }

  async function tryResolveFor(i: number, username?: string) {
    const ch = value[i]
    try {
      setResolvingIndex(i)
      const res: any = await api.miniApp.profile.resolveTelegramChatId(
        username ? { username } : { url: ch.url }
      )
      if (res?.chat_id) {
        updateAt(i, { chat_id: String(res.chat_id) })
        alert(`ID канала получен: ${res.chat_id}`)
        return true
      }
      return false
    } catch (e: any) {
      const msg = e?.message || ''
      if (msg === 'invite_only') {
        // Закрытый канал — попросим у пользователя @username вручную
        setPromptOpen({ index: i })
        return false
      }
      alert(msg || 'Не получилось получить ID')
      return false
    } finally {
      setResolvingIndex(null)
    }
  }

  async function handleResolveClick(i: number) {
    const link = value[i]?.url || ''
    const isInvite = /\/\+/.test(link) || !link
    if (!isInvite) {
      await tryResolveFor(i)
      return
    }
    setPromptOpen({ index: i })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {(value || []).map((ch, i) => {
          const valid = chatIdLooksValid(ch.chat_id || '')
          return (
            <div key={i} className="p-4 bg-white border border-gray-200 rounded-lg space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Канал {i + 1}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveUp(i)}
                    disabled={i === 0}
                    className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                    title="Выше"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDown(i)}
                    disabled={i >= value.length - 1}
                    className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                    title="Ниже"
                  >
                    <ChevronDown size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="p-1 text-gray-400 hover:text-red-600"
                    title="Удалить"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">Название (для удобства)</label>
                <input
                  type="text"
                  value={ch.name || ''}
                  onChange={e => updateAt(i, { name: e.target.value })}
                  placeholder="Например, «Личный блог»"
                  className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">Ссылка на канал</label>
                <input
                  type="url"
                  value={ch.url || ''}
                  onChange={e => updateAt(i, { url: e.target.value })}
                  placeholder="https://t.me/your_channel"
                  className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Полная ссылка через https. Для закрытого канала — инвайт-ссылка https://t.me/+abc…
                </p>
              </div>

              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  ID канала{' '}
                  <span className="text-gray-400">(нужен для проверки подписки)</span>
                </label>
                <div className="flex gap-2 items-stretch flex-wrap">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={ch.chat_id || ''}
                    onChange={e => updateAt(i, { chat_id: e.target.value })}
                    onBlur={e => updateAt(i, { chat_id: normalizeChatIdInput(e.target.value) })}
                    placeholder="-1001234567890"
                    className={`flex-1 min-w-0 px-3 py-1.5 text-sm font-mono bg-white border rounded focus:outline-none focus:border-[#25455D] ${
                      valid ? 'border-gray-200' : 'border-red-300'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => handleResolveClick(i)}
                    disabled={resolvingIndex === i}
                    className="px-3 py-1.5 text-xs rounded bg-[#25455D] text-white whitespace-nowrap disabled:opacity-50"
                  >
                    {resolvingIndex === i ? '...' : 'Получить автоматически'}
                  </button>
                </div>
                {!valid && (
                  <p className="text-xs text-red-600 mt-1">
                    ID должен начинаться с «-100» и содержать только цифры.
                  </p>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  Открытый канал — кнопка сделает всё за вас. Закрытый — впишите ID руками.{' '}
                  <a href={helpHref} className="text-[#25455D] underline">Как узнать ID канала</a>.
                </p>
              </div>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        onClick={addChannel}
        className="w-full px-4 py-3 text-sm font-medium border-2 border-dashed border-gray-300 rounded-lg text-gray-700 hover:border-[#25455D] hover:text-[#25455D] flex items-center justify-center gap-2"
      >
        <Plus size={18} />
        {(value?.length ?? 0) === 0 ? 'Добавить первый канал' : 'Добавить ещё канал'}
      </button>

      <p className="text-xs text-gray-500">
        Эти каналы используются для проверки подписки в воронках лид-магнитов и
        в гейтах чатов: участник должен быть подписан на ВСЕ каналы из списка.
      </p>

      {promptOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => { setPromptOpen(null); setUsernameDraft('') }}
        >
          <div className="bg-white rounded-xl max-w-md w-full p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900">Получить ID канала</h3>
            <p className="text-sm text-gray-700">
              У канала из ссылки нет публичного <code className="font-mono">@username</code> — это закрытый канал по инвайт-ссылке.
            </p>
            <p className="text-sm text-gray-700">
              <strong>Если у канала есть публичный @username</strong> — впишите его:
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
              <strong>Если @username нет</strong> — получите ID через бот:{' '}
              <a href={helpHref} className="text-[#25455D] underline font-medium">инструкция в Тех.поддержке</a>.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setPromptOpen(null); setUsernameDraft('') }}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={!usernameDraft}
                onClick={async () => {
                  const u = usernameDraft.trim().replace(/^@+/, '').split('/').pop() || ''
                  const idx = promptOpen.index
                  setPromptOpen(null); setUsernameDraft('')
                  if (u) await tryResolveFor(idx, u)
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
