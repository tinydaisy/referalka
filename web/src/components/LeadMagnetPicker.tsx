'use client'

/**
 * Выбор лид-магнита (и пакета) — ОДИН компонент на все экраны кабинета.
 *
 * ⚠️ Зачем появился: выбор был написан заново в каждом месте обычным
 * `<select>` — реф-программа, карточка спикера, «О проекте», анкеты,
 * Instagram-воронки. **Поиска не было нигде**, а у клиента магнитов десятки:
 * найти нужный в длинном списке нечем, приходится листать вслепую.
 *
 * ⚠️ Список — ОГРАНИЧЕННОЙ ВЫСОТЫ со скроллом (решение владельца 16.09.2026):
 * раскрытое полотно на весь экран перекрывает форму, в которой человек стоит,
 * и не видно ни поля, ни кнопки сохранения.
 *
 * ⚠️ Магниты и пакеты — РАЗНЫЕ сущности (разные таблицы и ссылки): магнит это
 * один материал, пакет — несколько под общей ссылкой. Показываем их разными
 * группами и отдаём наружу раздельно (`onPick(kind, id)`), чтобы вызывающий
 * экран не гадал, что ему выбрали.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, ChevronDown, Check } from 'lucide-react'
import { api } from '@/lib/api'

export type MagnetKind = 'magnet' | 'package'

export interface MagnetItem {
  id: number
  name: string
  kind: MagnetKind
}

/** Нормализация для поиска: регистр и «ё» не должны мешать найти. */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/ё/g, 'е').trim()
}

/**
 * Списки магнитов и пакетов, загруженные один раз на страницу.
 *
 * ⚠️ Кеш в памяти модуля: на одном экране пикер бывает в нескольких местах
 * (пороги реф-программы — по одному на каждый порог), и без кеша каждый
 * дёргал бы оба списка заново.
 */
let _cache: { magnets: MagnetItem[]; packages: MagnetItem[] } | null = null
let _pending: Promise<{ magnets: MagnetItem[]; packages: MagnetItem[] }> | null = null

async function loadAll() {
  if (_cache) return _cache
  if (_pending) return _pending
  _pending = (async () => {
    // ⚠️ Пакеты не роняют выбор, если их нет или раздел закрыт тарифом:
    // магниты важнее, и из-за пакетов список не должен остаться пустым.
    const [m, p] = await Promise.all([
      api.leadMagnets.list().catch(() => []),
      api.leadMagnetPackages.list().catch(() => []),
    ])
    _cache = {
      magnets: (Array.isArray(m) ? m : []).map((x: any) => ({
        id: x.id, name: x.name || 'Без названия', kind: 'magnet' as const,
      })),
      packages: (Array.isArray(p) ? p : []).map((x: any) => ({
        id: x.id, name: x.name || 'Без названия', kind: 'package' as const,
      })),
    }
    return _cache
  })()
  return _pending
}

/** Сбросить кеш — звать после создания/удаления магнита на этой же странице. */
export function resetMagnetCache() {
  _cache = null
  _pending = null
}

export interface LeadMagnetPickerProps {
  /** Что выбрано сейчас. */
  value?: { kind: MagnetKind; id: number } | null
  onPick: (value: { kind: MagnetKind; id: number } | null) => void
  /** Показывать ли пакеты. У некоторых экранов пакет не поддержан. */
  withPackages?: boolean
  placeholder?: string
  /** Можно ли снять выбор («— не выбран —»). */
  allowEmpty?: boolean
  disabled?: boolean
}

export default function LeadMagnetPicker({
  value, onPick, withPackages = true,
  placeholder = 'Выберите лид-магнит', allowEmpty = true, disabled,
}: LeadMagnetPickerProps) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [data, setData] = useState<{ magnets: MagnetItem[]; packages: MagnetItem[] } | null>(_cache)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { loadAll().then(setData) }, [])

  // Клик мимо — закрыть. Это НЕ модалка-форма, а выпадающий список: здесь
  // закрытие по клику снаружи привычно и ничего введённого не теряет.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const all: MagnetItem[] = useMemo(() => [
    ...(data?.magnets || []),
    ...(withPackages ? (data?.packages || []) : []),
  ], [data, withPackages])

  const current = value
    ? all.find(i => i.kind === value.kind && i.id === value.id) || null
    : null

  const filtered = useMemo(() => {
    const needle = norm(q)
    if (!needle) return all
    return all.filter(i => norm(i.name).includes(needle))
  }, [all, q])

  const magnets = filtered.filter(i => i.kind === 'magnet')
  const packages = filtered.filter(i => i.kind === 'package')

  const pick = (item: MagnetItem | null) => {
    onPick(item ? { kind: item.kind, id: item.id } : null)
    setOpen(false)
    setQ('')
  }

  const row = (item: MagnetItem) => {
    const active = current?.kind === item.kind && current?.id === item.id
    return (
      <button
        key={`${item.kind}-${item.id}`}
        type="button"
        onClick={() => pick(item)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 ${
          active ? 'bg-brand/5 font-medium text-brand' : 'text-gray-700'
        }`}
      >
        <span className="flex-1 truncate">{item.name}</span>
        {active && <Check size={15} className="shrink-0" />}
      </button>
    )
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
          disabled ? 'cursor-not-allowed bg-gray-50 text-gray-400 border-gray-200'
                   : 'border-gray-300 bg-white text-gray-800 hover:border-gray-400'
        }`}
      >
        <span className={`flex-1 truncate ${current ? '' : 'text-gray-400'}`}>
          {current
            ? (current.kind === 'package' ? `Пакет: ${current.name}` : current.name)
            : placeholder}
        </span>
        <ChevronDown size={16} className="shrink-0 text-gray-400" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Search size={15} className="shrink-0 text-gray-400" />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Поиск по названию…"
              className="w-full text-sm outline-none placeholder:text-gray-400"
            />
            {q && (
              <button type="button" onClick={() => setQ('')}
                      className="shrink-0 text-gray-400 hover:text-gray-600">
                <X size={15} />
              </button>
            )}
          </div>

          {/* ⚠️ Высота ОГРАНИЧЕНА: список на весь экран перекрывал бы форму,
              в которой человек стоит, — не видно ни поля, ни «Сохранить». */}
          <div className="max-h-64 overflow-y-auto">
            {allowEmpty && !q && (
              <button type="button" onClick={() => pick(null)}
                      className="w-full px-3 py-2 text-left text-sm text-gray-500 hover:bg-gray-50">
                — не выбран —
              </button>
            )}

            {!data && (
              <div className="px-3 py-3 text-sm text-gray-400">Загружаем…</div>
            )}

            {data && !filtered.length && (
              <div className="px-3 py-3 text-sm text-gray-500">
                {q ? 'Ничего не нашлось' : 'Пока нет лид-магнитов'}
              </div>
            )}

            {!!magnets.length && (
              <>
                {withPackages && !!packages.length && (
                  <div className="bg-gray-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    Лид-магниты
                  </div>
                )}
                {magnets.map(row)}
              </>
            )}

            {withPackages && !!packages.length && (
              <>
                <div className="bg-gray-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Пакеты
                </div>
                {packages.map(row)}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
