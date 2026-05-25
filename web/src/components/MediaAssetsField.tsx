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
          Подписчики в соцсетях и медиа. Добавьте каналы и впишите число подписчиков —
          лендинг события сможет показать ваш совокупный охват.
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
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={asset.subscribers === 0 && asset.platform ? '' : asset.subscribers}
              placeholder="Подписчики"
              onChange={e => {
                const n = parseInt(e.target.value || '0', 10)
                update(i, { subscribers: isNaN(n) || n < 0 ? 0 : n })
              }}
              className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
            />
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
