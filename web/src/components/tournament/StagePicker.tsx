'use client'

/**
 * Выбор номинации/тура/этапа — СПИСОК С ПОИСКОМ, а не вкладки и не <select>.
 *
 * Зачем. У премии номинаций бывает 70. Вкладками в строку их не пролистать,
 * а обычный <select> на 70 позиций — это скролл вслепую, без поиска по названию.
 * Здесь: строка поиска, группировка по категориям, алфавитный порядок.
 *
 * ⚠️ Один компонент на ВСЕ турнирные экраны (критерии, распределение, оценки
 *    жюри, таблица, привязка людей). Заводить свой селектор на каждом экране
 *    нельзя — они разъедутся по поведению, как уже было с вкладками.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'

export interface StageOption {
  id: number
  title: string
  category_id?: number | null
}
export interface StageCategoryOption {
  id: number
  title: string
}

export default function StagePicker({
  stages, categories = [], value, onChange,
  label = 'Номинация/тур/этап', placeholder = 'Выберите…', className = '',
}: {
  stages: StageOption[]
  categories?: StageCategoryOption[]
  value: number | null
  onChange: (id: number) => void
  label?: string
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [catFilter, setCatFilter] = useState<number | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Закрытие по клику вне и по Esc.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30) }, [open])

  const current = stages.find(s => s.id === value) || null
  const catTitle = (id?: number | null) => categories.find(c => c.id === id)?.title || ''

  // Поиск идёт и по названию номинации, и по названию её категории —
  // «медицина» находит все номинации раздела, даже если слова в них нет.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return stages.filter(s => {
      if (catFilter !== null && (s.category_id ?? null) !== catFilter) return false
      if (!needle) return true
      return (s.title || '').toLowerCase().includes(needle)
        || catTitle(s.category_id).toLowerCase().includes(needle)
    })
  }, [stages, q, catFilter, categories])

  // Группировка: категории по порядку, «без категории» — в конец.
  const groups = useMemo(() => {
    const byCat = new Map<number | null, StageOption[]>()
    for (const s of filtered) {
      const k = s.category_id ?? null
      if (!byCat.has(k)) byCat.set(k, [])
      byCat.get(k)!.push(s)
    }
    for (const list of byCat.values()) list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'))
    const out: { key: number | null; title: string; items: StageOption[] }[] = []
    for (const c of categories) {
      const items = byCat.get(c.id)
      if (items?.length) out.push({ key: c.id, title: c.title, items })
    }
    const orphan = byCat.get(null)
    if (orphan?.length) out.push({ key: null, title: categories.length ? 'Без категории' : '', items: orphan })
    return out
  }, [filtered, categories])

  return (
    <div className={`relative ${className}`} ref={boxRef}>
      {label && <div className="text-xs text-gray-500 mb-1">{label}</div>}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-white border rounded-lg text-left hover:border-gray-400 transition"
      >
        <span className={`truncate text-sm ${current ? 'text-gray-900' : 'text-gray-400'}`}>
          {current ? current.title : placeholder}
          {current && catTitle(current.category_id) && (
            <span className="text-gray-400"> · {catTitle(current.category_id)}</span>
          )}
        </span>
        <ChevronDown size={16} className={`shrink-0 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white border rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b bg-gray-50">
            <div className="relative">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Поиск по названию…"
                className="w-full pl-7 pr-7 py-1.5 text-sm border rounded-md"
              />
              {q && (
                <button type="button" onClick={() => setQ('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X size={14} />
                </button>
              )}
            </div>
            {categories.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                <button type="button" onClick={() => setCatFilter(null)}
                  className={`px-2 py-0.5 text-xs rounded-full border ${catFilter === null ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600'}`}>
                  Все
                </button>
                {categories.map(c => (
                  <button key={c.id} type="button" onClick={() => setCatFilter(c.id)}
                    className={`px-2 py-0.5 text-xs rounded-full border ${catFilter === c.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600'}`}>
                    {c.title}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {groups.length === 0 && (
              <div className="px-3 py-4 text-sm text-gray-400 text-center">Ничего не найдено</div>
            )}
            {groups.map(g => (
              <div key={String(g.key)}>
                {g.title && (
                  <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-gray-400 bg-gray-50 sticky top-0">
                    {g.title}
                  </div>
                )}
                {g.items.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { onChange(s.id); setOpen(false); setQ('') }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition ${s.id === value ? 'bg-blue-50 font-medium' : ''}`}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {stages.length > 12 && (
            <div className="px-3 py-1.5 text-[11px] text-gray-400 border-t bg-gray-50">
              Всего: {stages.length}
              {filtered.length !== stages.length && ` · найдено: ${filtered.length}`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
