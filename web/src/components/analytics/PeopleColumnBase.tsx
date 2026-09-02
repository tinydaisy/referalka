'use client'

/**
 * Колонка со списком людей — общий вид для трёх мест:
 *   · дашборд в режиме «колонками»,
 *   · CRM события («Отслеживания» → CRM),
 *   · CRM лид-магнита.
 *
 * ⚠️ Одна реализация на всех: иначе колонки разъедутся по виду и поведению,
 * как это уже было с карточками спикеров.
 *
 * ⚠️ Сворачивается СПИСОК, шапка с цифрой остаётся на месте (требование
 * владельца) — на телефоне иначе до соседней колонки пришлось бы
 * прокручивать сотни строк.
 */

import { ReactNode, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

const DARK = '#25455D'
const PEACH = '#FFCFA4'

export interface ColumnPerson {
  id: number
  name?: string | null
  telegram?: string | null
  vk?: string | null
  max_nick?: string | null
  email?: string | null
  phone?: string | null
}

export default function PeopleColumnBase({
  title, count, percent, people, loading, hint, tone = 'dark',
  onExpand, footer, collapsedByDefault = false,
}: {
  title: string
  count: number
  percent?: number | null
  people: ColumnPerson[]
  loading?: boolean
  hint?: string
  tone?: 'dark' | 'peach'
  /** Зовём при первом раскрытии — список подгружается лениво. */
  onExpand?: () => void
  footer?: ReactNode
  collapsedByDefault?: boolean
}) {
  const [open, setOpen] = useState(!collapsedByDefault)
  const [everOpened, setEverOpened] = useState(false)

  // ⚠️ Колонка открыта сразу, поэтому список надо запросить при первой
  // отрисовке, а не только по клику: иначе раскрытая колонка показывала
  // «Пусто», хотя люди есть.
  useEffect(() => {
    if (open && !everOpened) { setEverOpened(true); onExpand?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = () => setOpen(v => !v)

  const head = tone === 'peach'
    ? { background: PEACH, color: DARK }
    : { background: DARK, color: '#fff' }

  // ⚠️ Колонки делят ширину поровну (`flex-1`), а не стоят фиксированной
  // шириной: на широком экране две колонки жались слева, а справа оставалось
  // пустое место. Минимум 240px — чтобы на телефоне они прокручивались вбок,
  // а не сжимались в нечитаемые полоски.
  return (
    <div className="flex min-w-[240px] flex-1 flex-col rounded-xl border border-gray-200 bg-white">
      {/* Шапка — всегда видна, по ней и сворачиваем. */}
      <button onClick={toggle} className="rounded-t-xl px-3 py-2.5 text-left" style={head}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums">{count}</span>
          {typeof percent === 'number' && (
            <span className="text-sm opacity-90">{percent}%</span>
          )}
        </div>
        {hint && <div className="mt-0.5 text-[11px] opacity-80">{hint}</div>}
      </button>

      {open && (
        <div className="max-h-[420px] overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center gap-2 p-3 text-sm text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Загружаем…
            </div>
          ) : !people.length ? (
            <p className="p-3 text-sm text-gray-400">Пусто</p>
          ) : (
            people.map(p => <PersonRow key={p.id} person={p} />)
          )}
          {footer}
        </div>
      )}
    </div>
  )
}

/** Строка человека: имя ведёт в карточку контакта, под ним — ники площадок. */
function PersonRow({ person }: { person: ColumnPerson }) {
  const nicks = [
    person.telegram && `TG ${at(person.telegram)}`,
    person.vk && `VK ${at(person.vk)}`,
    person.max_nick && `MAX ${at(person.max_nick)}`,
  ].filter(Boolean) as string[]

  return (
    <Link href={`/dashboard/clients?contact=${person.id}`}
          className="block rounded-lg px-2 py-1.5 hover:bg-gray-50">
      <div className="truncate text-sm font-medium" style={{ color: DARK }}>
        {person.name || 'Без имени'}
      </div>
      {nicks.length > 0 && (
        <div className="truncate text-[11px] text-gray-500">{nicks.join(' · ')}</div>
      )}
    </Link>
  )
}

/** Ник показываем с «собакой», числовой id — как есть. */
function at(v: string) {
  const s = String(v)
  return /^\d+$/.test(s) ? s : `@${s.replace(/^@/, '')}`
}
