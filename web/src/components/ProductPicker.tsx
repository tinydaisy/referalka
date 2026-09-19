'use client'
/**
 * Выбор продукта — ОДИН компонент на все экраны (19.09.2026).
 *
 * ⚠️⚠️ ЗАВОДИТЬ СВОЙ `<select>` С ПРОДУКТАМИ НА КАЖДОМ ЭКРАНЕ НЕЛЬЗЯ — они
 * разъезжаются по поведению. К моменту появления этого компонента в проекте
 * было ТРИ независимых селектора продукта (кнопка Mini App, Instagram-воронки,
 * промокоды), и ни один не отбирал опубликованные: человек мог выбрать
 * черновик, а зритель по ссылке получал «страница не найдена». Рядом в тех же
 * воронках события при этом фильтровались — то есть правило знали, но
 * применяли не везде. Ровно это и лечит единый компонент.
 *
 * ⚠️ По умолчанию показываются ТОЛЬКО опубликованные (`onlyPublished`). Там,
 * где выбор не ведёт человека на витрину (например фильтр списка), можно
 * передать `onlyPublished={false}` — тогда рядом с черновиком рисуется
 * пометка, чтобы выбор был осознанным.
 *
 * Сделан по образцу LeadMagnetPicker/StagePicker: поиск, закрытие по клику
 * вне и по Esc, общий кеш на страницу.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, ChevronDown, Check } from 'lucide-react'
import { api } from '@/lib/api'

export type ProductItem = {
  id: number
  title: string
  slug?: string | null
  status?: string | null
}

// Кеш на страницу: селекторов может быть несколько (например в списке блоков),
// и каждый не должен ходить за одним и тем же списком.
let _cache: { key: string; items: ProductItem[] } | null = null
let _pending: Promise<ProductItem[]> | null = null

export function resetProductCache() { _cache = null; _pending = null }

async function loadProducts(onlyPublished: boolean): Promise<ProductItem[]> {
  const key = onlyPublished ? 'published' : 'all'
  if (_cache && _cache.key === key) return _cache.items
  if (_pending) return _pending
  _pending = (async () => {
    try {
      const r: any = await api.products.list(onlyPublished ? 'published' : undefined)
      // ⚠️ Ключ ответа — `products`, НЕ `items`: на этом уже спотыкались
      // другие экраны, поэтому принимаем оба написания.
      const items: ProductItem[] = r?.products || r?.items || []
      _cache = { key, items }
      return items
    } finally { _pending = null }
  })()
  return _pending
}

// Поиск без оглядки на регистр и «ё».
const norm = (s: string) => (s || '').toLowerCase().replace(/ё/g, 'е').trim()

export default function ProductPicker({
  value, onChange, onlyPublished = true, placeholder = 'Выберите продукт',
  allowEmpty = false, emptyLabel = '— не выбран —', disabled = false,
}: {
  value: number | null
  onChange: (id: number | null) => void
  /** Показывать только опубликованные. По умолчанию да — см. шапку файла. */
  onlyPublished?: boolean
  placeholder?: string
  allowEmpty?: boolean
  emptyLabel?: string
  disabled?: boolean
}) {
  const [items, setItems] = useState<ProductItem[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    loadProducts(onlyPublished)
      .then(list => { if (alive) setItems(list) })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [onlyPublished])

  // Закрытие по клику вне и по Esc — как у остальных пикеров проекта.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => { if (open) searchRef.current?.focus() }, [open])

  const filtered = useMemo(() => {
    const nq = norm(q)
    if (!nq) return items
    return items.filter(p => norm(p.title).includes(nq))
  }, [items, q])

  const current = items.find(p => p.id === value) || null

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className="input w-full flex items-center justify-between gap-2 text-left disabled:opacity-60"
      >
        <span className={current ? 'text-gray-900' : 'text-gray-400'}>
          {loading ? 'Загружаем…' : current ? current.title : placeholder}
        </span>
        <ChevronDown size={16} className="text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="p-2 border-b border-gray-100 flex items-center gap-2">
            <Search size={14} className="text-gray-400 shrink-0" />
            <input
              ref={searchRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Поиск по названию"
              className="flex-1 text-sm outline-none"
            />
            {q && (
              <button type="button" onClick={() => setQ('')} className="text-gray-400 hover:text-gray-600">
                <X size={14} />
              </button>
            )}
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {allowEmpty && (
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false) }}
                className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 flex items-center justify-between"
              >
                {emptyLabel}
                {value == null && <Check size={14} className="text-brand" />}
              </button>
            )}

            {filtered.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onChange(p.id); setOpen(false) }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  {p.title}
                  {/* Пометка нужна только когда черновики вообще показываются. */}
                  {!onlyPublished && p.status !== 'published' && (
                    <span className="text-gray-400"> — черновик</span>
                  )}
                </span>
                {value === p.id && <Check size={14} className="text-brand shrink-0" />}
              </button>
            ))}

            {!loading && filtered.length === 0 && (
              <p className="px-3 py-3 text-sm text-gray-500">
                {items.length === 0
                  ? (onlyPublished
                      ? 'Опубликованных продуктов нет. Опубликуйте продукт в разделе «Продукты и услуги».'
                      : 'Продуктов пока нет.')
                  : 'Ничего не нашлось.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
