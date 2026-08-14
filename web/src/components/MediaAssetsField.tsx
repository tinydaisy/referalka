'use client'
import { Plus, X } from 'lucide-react'

export type MediaAsset = { platform: string; subscribers: number }

const PLATFORMS: { slug: string; label: string }[] = [
  { slug: 'tg',        label: 'Telegram' },
  { slug: 'youtube',   label: 'YouTube' },
  { slug: 'vk',        label: 'VK' },
  { slug: 'tiktok',    label: 'TikTok' },
  { slug: 'instagram', label: 'Instagram' },
  { slug: 'max',       label: 'MAX' },
  { slug: 'rutube',    label: 'RuTube' },
  { slug: 'chatbots',  label: 'Чат-боты' },
  { slug: 'database',  label: 'База' },
  { slug: 'total',     label: 'Суммарно' },
]

function labelFor(slug: string): string {
  return PLATFORMS.find(p => p.slug === slug)?.label || slug
}

interface Props {
  value: MediaAsset[]
  onChange: (next: MediaAsset[]) => void
}

export default function MediaAssetsField({ value, onChange }: Props) {
  const used = new Set((value || []).map(a => a.platform))
  const available = PLATFORMS.filter(p => !used.has(p.slug))
  const allUsed = available.length === 0

  function add() {
    if (allUsed) return
    onChange([...(value || []), { platform: available[0].slug, subscribers: 0 }])
  }
  function update(i: number, patch: Partial<MediaAsset>) {
    onChange((value || []).map((a, k) => (k === i ? { ...a, ...patch } : a)))
  }
  function remove(i: number) {
    onChange((value || []).filter((_, k) => k !== i))
  }

  return (
    <div className="space-y-2">
      {(value || []).length === 0 && (
        <p className="text-xs text-gray-500">
          Подписчики в соцсетях и медиа. Вводите цифру в <b>тысячах</b>: «19.9» = 19.9к.
          Можно ставить десятичные. Лендинг события покажет ваш совокупный охват.
        </p>
      )}
      {(value || []).map((asset, i) => {
        // в селекте показываем уже занятые на других строках, чтобы не дать дубль
        const usedByOthers = new Set(
          (value || []).filter((_, k) => k !== i).map(a => a.platform)
        )
        const options = PLATFORMS.filter(p => !usedByOthers.has(p.slug))
        return (
          <div key={i} className="flex gap-2 items-center">
            <select
              value={asset.platform}
              onChange={e => update(i, { platform: e.target.value })}
              className="px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand"
            >
              {options.map(p => (
                <option key={p.slug} value={p.slug}>{p.label}</option>
              ))}
            </select>
            <div className="flex-1 relative">
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                value={asset.subscribers === 0 ? '' : asset.subscribers}
                placeholder="19.9"
                onChange={e => {
                  const v = e.target.value
                  if (v === '') return update(i, { subscribers: 0 })
                  // ⚠️ Принимаем и точку, и ЗАПЯТУЮ: на русской раскладке
                  // человек набирает «1,8», а parseFloat такую запись не
                  // понимает — значение молча становилось нулём.
                  const n = parseFloat(v.replace(',', '.'))
                  update(i, { subscribers: isNaN(n) || n < 0 ? 0 : n })
                }}
                className="w-full pr-8 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm font-medium pointer-events-none select-none">
                к
              </span>
            </div>
            <button
              type="button"
              onClick={() => remove(i)}
              className="p-2 rounded-xl border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200"
              title="Удалить"
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={add}
        disabled={allUsed}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-gray-300 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Plus size={14} />
        {allUsed ? 'Все платформы добавлены' : 'Добавить актив'}
      </button>
    </div>
  )
}

export { labelFor as mediaPlatformLabel }
