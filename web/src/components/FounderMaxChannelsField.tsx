'use client'
import { useState } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * Редактор списка MAX-каналов основателя.
 *
 * Хранение: массив `social_links.max_channels` = [{ url, chat_id, name }, ...]
 *
 * Используется в /dashboard/mini-app → вкладка «Основатель» → секция
 * «MAX каналы основателя». Эти каналы — для проверки подписки в MAX-воронке
 * лид-магнита (подписан на ВСЕ → выдаём материалы).
 *
 * ID канала MAX нельзя получить по username (как в TG getChat) — MAX отдаёт
 * chat_id только боту-админу. Поэтому кнопка «Получить автоматически» работает,
 * ТОЛЬКО если бот (VIP-бот клиента или системный @pluson MAX-бот) добавлен
 * АДМИНОМ в этот MAX-канал. Тогда бэк находит канал по ссылке через GET /chats.
 */
export interface FounderMaxChannel {
  url:     string
  chat_id: string
  name:    string
}

interface Props {
  value: FounderMaxChannel[]
  onChange: (next: FounderMaxChannel[]) => void
}

function emptyChannel(): FounderMaxChannel {
  return { url: '', chat_id: '', name: '' }
}

export function FounderMaxChannelsField({ value, onChange }: Props) {
  const [resolvingIndex, setResolvingIndex] = useState<number | null>(null)

  function updateAt(i: number, patch: Partial<FounderMaxChannel>) {
    onChange(value.map((ch, idx) => idx === i ? { ...ch, ...patch } : ch))
  }
  function addChannel() { onChange([...(value || []), emptyChannel()]) }
  function removeAt(i: number) {
    if (!confirm('Удалить этот MAX-канал? Проверка подписки на него больше идти не будет.')) return
    onChange(value.filter((_, idx) => idx !== i))
  }
  function moveUp(i: number) {
    if (i === 0) return
    const next = [...value]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(next)
  }
  function moveDown(i: number) {
    if (i >= value.length - 1) return
    const next = [...value]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; onChange(next)
  }

  async function handleResolveClick(i: number) {
    const ch = value[i]
    if (!ch?.url?.trim()) { alert('Сначала впишите ссылку на MAX-канал'); return }
    try {
      setResolvingIndex(i)
      const res: any = await api.miniApp.profile.resolveMaxChatId({ url: ch.url })
      if (res?.chat_id) {
        updateAt(i, { chat_id: String(res.chat_id) })
        alert(`ID канала получен: ${res.chat_id}`)
      }
    } catch (e: any) {
      const msg = e?.message || ''
      if (msg === 'not_found') {
        alert('Не нашёл этот канал у бота. Добавьте бота (VIP-бот или системный @pluson MAX-бот) АДМИНИСТРАТОРОМ в этот MAX-канал и попробуйте снова.')
      } else {
        alert(msg || 'Не получилось получить ID')
      }
    } finally {
      setResolvingIndex(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {(value || []).map((ch, i) => (
          <div key={i} className="p-4 bg-white border border-gray-200 rounded-lg space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                MAX-канал {i + 1}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <button type="button" onClick={() => moveUp(i)} disabled={i === 0}
                  className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Выше">
                  <ChevronUp size={16} />
                </button>
                <button type="button" onClick={() => moveDown(i)} disabled={i >= value.length - 1}
                  className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30" title="Ниже">
                  <ChevronDown size={16} />
                </button>
                <button type="button" onClick={() => removeAt(i)}
                  className="p-1 text-gray-400 hover:text-red-600" title="Удалить">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">Название (для удобства)</label>
              <input type="text" value={ch.name || ''}
                onChange={e => updateAt(i, { name: e.target.value })}
                placeholder="Например, «Мой MAX-канал»"
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]" />
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">Ссылка на MAX-канал</label>
              <input type="url" value={ch.url || ''}
                onChange={e => updateAt(i, { url: e.target.value })}
                placeholder="https://max.ru/id890306512862_biz"
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]" />
              <p className="text-xs text-gray-500 mt-1">Полная ссылка на канал в MAX.</p>
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">
                ID канала <span className="text-gray-400">(нужен для проверки подписки)</span>
              </label>
              <div className="flex gap-2 items-stretch flex-wrap">
                <input type="text" value={ch.chat_id || ''}
                  onChange={e => updateAt(i, { chat_id: e.target.value })}
                  placeholder="-71606981728842"
                  className="flex-1 min-w-0 px-3 py-1.5 text-sm font-mono bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]" />
                <button type="button" onClick={() => handleResolveClick(i)}
                  disabled={resolvingIndex === i}
                  className="px-3 py-1.5 text-xs rounded bg-[#25455D] text-white whitespace-nowrap disabled:opacity-50">
                  {resolvingIndex === i ? '...' : 'Получить автоматически'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Чтобы кнопка сработала — добавьте бота <strong>администратором</strong> в этот
                MAX-канал (свой VIP-бот или системный @pluson MAX-бот). Без бота-админа MAX не
                отдаёт ID канала.
              </p>
            </div>
          </div>
        ))}
      </div>

      <button type="button" onClick={addChannel}
        className="w-full px-4 py-3 text-sm font-medium border-2 border-dashed border-gray-300 rounded-lg text-gray-700 hover:border-[#25455D] hover:text-[#25455D] flex items-center justify-center gap-2">
        <Plus size={18} />
        {(value?.length ?? 0) === 0 ? 'Добавить MAX-канал' : 'Добавить ещё MAX-канал'}
      </button>

      <p className="text-xs text-gray-500">
        MAX-каналы используются для проверки подписки в воронках лид-магнитов в MAX:
        участник должен быть подписан на ВСЕ каналы из списка.
      </p>
    </div>
  )
}
