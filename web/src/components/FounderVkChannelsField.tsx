'use client'
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react'

/**
 * Редактор списка VK-сообществ основателя.
 *
 * Хранение: массив `social_links.vk_channels` = [{ url, group_id, name }, ...]
 *
 * Используется в /dashboard/mini-app → вкладка «Основатель». Эти сообщества —
 * для проверки подписки в VK-воронке лид-магнита (подписан на ВСЕ → выдаём).
 *
 * group_id (числовой id сообщества для groups.isMember) резолвится АВТОМАТИЧЕСКИ
 * из ссылки на бэке при сохранении профиля (utils.resolveScreenName) — клиенту
 * вводить его не нужно, поле показываем только для информации (если уже задан).
 */
export interface FounderVkChannel {
  url:      string
  group_id: string
  name:     string
}

interface Props {
  value: FounderVkChannel[]
  onChange: (next: FounderVkChannel[]) => void
}

function emptyChannel(): FounderVkChannel {
  return { url: '', group_id: '', name: '' }
}

export function FounderVkChannelsField({ value, onChange }: Props) {
  function updateAt(i: number, patch: Partial<FounderVkChannel>) {
    onChange(value.map((ch, idx) => idx === i ? { ...ch, ...patch } : ch))
  }
  function addChannel() { onChange([...(value || []), emptyChannel()]) }
  function removeAt(i: number) {
    if (!confirm('Удалить это VK-сообщество? Проверка подписки на него больше идти не будет.')) return
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

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {(value || []).map((ch, i) => (
          <div key={i} className="p-4 bg-white border border-gray-200 rounded-lg space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                VK-сообщество {i + 1}
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
                placeholder="Например, «Моё VK-сообщество»"
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]" />
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">Ссылка на VK-сообщество</label>
              <input type="url" value={ch.url || ''}
                onChange={e => updateAt(i, { url: e.target.value })}
                placeholder="https://vk.com/club123 или https://vk.com/screenname"
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-[#25455D]" />
              <p className="text-xs text-gray-500 mt-1">
                ID сообщества для проверки подписки определится автоматически при сохранении.
                {ch.group_id ? <> Сейчас: <span className="font-mono">{ch.group_id}</span></> : null}
              </p>
            </div>
          </div>
        ))}
      </div>

      <button type="button" onClick={addChannel}
        className="w-full px-4 py-3 text-sm font-medium border-2 border-dashed border-gray-300 rounded-lg text-gray-700 hover:border-[#25455D] hover:text-[#25455D] flex items-center justify-center gap-2">
        <Plus size={18} />
        {(value?.length ?? 0) === 0 ? 'Добавить VK-сообщество' : 'Добавить ещё VK-сообщество'}
      </button>

      <p className="text-xs text-gray-500">
        VK-сообщества используются для проверки подписки в воронках лид-магнитов в VK:
        участник должен быть подписан на ВСЕ сообщества из списка.
      </p>
    </div>
  )
}
