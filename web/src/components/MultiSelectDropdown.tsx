'use client'
import { useState, useEffect, useRef, useMemo } from 'react'
import { ChevronDown, Search, Check, X } from 'lucide-react'

export interface MultiSelectOption<T extends string | number> {
  value: T
  label: string
  hint?: string
}

interface Props<T extends string | number> {
  label: string
  options: MultiSelectOption<T>[]
  values: T[]
  onChange: (next: T[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Доп. пункт списка («Без привязки» для каналов). Сохраняется в булевом флаге снаружи. */
  extraToggle?: { label: string; checked: boolean; onToggle: (next: boolean) => void }
}

export function MultiSelectDropdown<T extends string | number>({
  label,
  options,
  values,
  onChange,
  placeholder = 'Любой',
  searchPlaceholder = 'Поиск…',
  emptyText = 'Ничего не найдено',
  extraToggle,
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  useEffect(() => { if (!open) setQuery('') }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o => o.label.toLowerCase().includes(q))
  }, [options, query])

  const selectedCount = values.length + (extraToggle?.checked ? 1 : 0)
  const summary = (() => {
    if (selectedCount === 0) return placeholder
    if (selectedCount === 1) {
      if (extraToggle?.checked && values.length === 0) return extraToggle.label
      const o = options.find(o => o.value === values[0])
      return o?.label || `${selectedCount}`
    }
    return `Выбрано: ${selectedCount}`
  })()

  function toggle(v: T) {
    if (values.includes(v)) onChange(values.filter(x => x !== v))
    else onChange([...values, v])
  }
  function selectAll() { onChange(options.map(o => o.value)) }
  function clearAll() {
    onChange([])
    extraToggle?.onToggle(false)
  }

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{label}</h3>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-sm text-left ${
            selectedCount > 0
              ? 'border-[#25455D] bg-white text-gray-900'
              : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
          }`}
        >
          <span className="truncate">{summary}</span>
          <div className="flex items-center gap-1 shrink-0">
            {selectedCount > 0 && (
              <span
                onClick={(e) => { e.stopPropagation(); clearAll() }}
                className="p-0.5 hover:bg-gray-100 rounded cursor-pointer"
                title="Очистить"
              >
                <X size={14} className="text-gray-400" />
              </span>
            )}
            <ChevronDown size={16} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </div>
        </button>

        {open && (
          <div className="absolute z-30 mt-1 w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-lg overflow-hidden">
            <div className="relative border-b border-gray-100">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full pl-9 pr-3 py-2 text-sm bg-white focus:outline-none"
              />
            </div>

            {options.length > 1 && (
              <div className="flex justify-between items-center px-3 py-1.5 border-b border-gray-100 text-xs">
                <button type="button" onClick={selectAll} className="text-blue-600 hover:underline">Выбрать все</button>
                <button type="button" onClick={() => onChange([])} className="text-gray-500 hover:text-red-500">Снять</button>
              </div>
            )}

            <div className="max-h-60 overflow-y-auto">
              {extraToggle && (
                <button
                  type="button"
                  onClick={() => extraToggle.onToggle(!extraToggle.checked)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 border-b border-gray-50"
                >
                  <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                    extraToggle.checked ? 'bg-[#25455D] border-[#25455D]' : 'border-gray-300'
                  }`}>
                    {extraToggle.checked && <Check size={12} className="text-white" />}
                  </span>
                  <span className="italic text-gray-700">{extraToggle.label}</span>
                </button>
              )}

              {filtered.length === 0 && !extraToggle && (
                <div className="text-center text-gray-400 text-sm py-4">{emptyText}</div>
              )}
              {filtered.map(o => {
                const checked = values.includes(o.value)
                return (
                  <button
                    key={String(o.value)}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50"
                  >
                    <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                      checked ? 'bg-[#25455D] border-[#25455D]' : 'border-gray-300'
                    }`}>
                      {checked && <Check size={12} className="text-white" />}
                    </span>
                    <span className="flex-1 truncate text-gray-800">{o.label}</span>
                    {o.hint && <span className="text-xs text-gray-400">{o.hint}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
