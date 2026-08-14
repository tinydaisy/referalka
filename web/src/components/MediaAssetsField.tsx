'use client'
import { Plus, X, ChevronUp, ChevronDown } from 'lucide-react'

export type MediaAsset = { platform: string; subscribers: number }

const PLATFORMS: { slug: string; label: string; auto?: boolean }[] = [
  // ⚠️ Площадки ПЛЮСОНа — ПЕРВЫМИ в списке: их цифры считает система, они
  // подтверждённые, и предлагать их надо раньше заявленных вручную.
  { slug: 'plusson_tg',    label: 'Telegram-бот в ПЛЮСОН', auto: true },
  { slug: 'plusson_email', label: 'Email в ПЛЮСОН',        auto: true },
  { slug: 'plusson_max',   label: 'MAX-бот в ПЛЮСОН',      auto: true },
  { slug: 'plusson_vk',    label: 'ВК-бот в ПЛЮСОН',       auto: true },
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
  /** Реальные размеры баз ПЛЮСОНа по площадкам: {plusson_tg: 3745, …}.
   *  Считает бэкенд — эти строки не редактируются, показывают правду. */
  autoCounts?: Record<string, number>
}

/** Градация охвата — те же пороги, что на бэкенде (_media_tier). */
function tierLabel(total: number): string {
  if (total >= 10000) return 'выше 10 тыс'
  if (total >= 5000) return '5–10 тыс'
  if (total >= 1000) return 'до 5 000'
  if (total > 0) return 'до 1 000'
  return 'охват не указан'
}

export default function MediaAssetsField({ value, onChange, autoCounts = {} }: Props) {
  // ⚠️ Заявленные активы вводятся в ТЫСЯЧАХ («1.8» = 1800), а базы ПЛЮСОНа
  // считаются в штуках — при сложении первые умножаем на 1000, иначе охват
  // выходил в тысячи раз меньше реального.
  const totalReach = (value || []).reduce((sum, a) => {
    const auto = PLATFORMS.find(p => p.slug === a.platform)?.auto
    return sum + (auto ? (autoCounts[a.platform] ?? 0) : Math.round((a.subscribers || 0) * 1000))
  }, 0)
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
  /** Порядок задаёт сам клиент: первым он ставит площадку, которой гордится
   *  больше всего, — в карточке каталога активы показываются в этом порядке. */
  function move(i: number, dir: -1 | 1) {
    const list = [...(value || [])]
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    onChange(list)
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
        const isAuto = !!PLATFORMS.find(p => p.slug === asset.platform)?.auto
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
            {isAuto ? (
              /* ⚠️ Цифру считает система — поля ввода нет. Показываем реальное
                 число подписанных (без отписавшихся) целиком, а не в тысячах:
                 «3 745» понятнее, чем «3.7к», и подчёркивает, что это точные
                 данные, а не заявленная оценка. */
              <div className="flex-1 px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-sm text-gray-700">
                {(autoCounts[asset.platform] ?? 0).toLocaleString('ru')}
                <span className="ml-2 text-xs text-gray-400">считает система</span>
              </div>
            ) : (
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
            )}
            <div className="flex flex-col">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                      title="Выше"
                      className="px-1.5 rounded-t-lg border border-gray-200 text-gray-400 hover:text-brand disabled:opacity-30">
                <ChevronUp size={13} />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === (value || []).length - 1}
                      title="Ниже"
                      className="px-1.5 rounded-b-lg border border-t-0 border-gray-200 text-gray-400 hover:text-brand disabled:opacity-30">
                <ChevronDown size={13} />
              </button>
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
      {/* ⚠️ ИТОГ по всем активам — та самая цифра, по которой каталог считает
          градацию охвата («до 1 000», «5–10 тыс»). Без неё непонятно, почему
          в карточке стоит «меньше 1 000», когда в полях введены тысячи:
          заявленные активы вводятся в ТЫСЯЧАХ, а базы ПЛЮСОНа — в штуках. */}
      {(value || []).length > 0 && (
        <div className="rounded-xl bg-gray-50 border border-gray-100 px-3 py-2 text-sm">
          <span className="text-gray-500">Суммарный охват: </span>
          <b style={{ color: '#25455D' }}>{totalReach.toLocaleString('ru')}</b>
          <span className="text-gray-500"> — в каталоге это «{tierLabel(totalReach)}»</span>
        </div>
      )}
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
