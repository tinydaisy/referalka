'use client'

/**
 * Группа-раздел внутри страницы: персиковая шапка + раскрытие по стрелке.
 *
 * ⚠️⚠️ ЕДИНЫЙ СТИЛЬ ВСЕХ ГРУППИРОВОК В ПРОЕКТЕ (правило владельца 20.09.2026).
 * Заголовок группы — ВСЕГДА персиковый (`#FFCFA4`), у всех групп на экране
 * одинаково. Красить одну группу персиковым, а соседнюю серым нельзя: разный
 * цвет читается как разная важность, хотя это просто два раздела одного
 * списка. Ровно так и вышло на лид-магнитах — «партнёрские» персиковым,
 * «ваши» серым, и вторая группа выглядела второсортной.
 *
 * ⚠️ Персиковый — ФОН, текст на нём тёмный (`#25455D`). Персиковым ПО белому
 * не пишем, не читается.
 *
 * ⚠️ Компонент общий, а не разметка на месте: иначе следующая страница с
 * группами сделает «примерно такую же» шапку, и через месяц их будет пять
 * разных. Появилась новая группировка — берём этот компонент.
 */

import { useState, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export default function CollapsibleGroup({
  title, count, defaultOpen = true, children,
}: {
  title: string
  /** Сколько элементов внутри — показывается цифрой в шапке. */
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    // ⚠️ Граница заметная (`#25455D` в четверть силы), а не `gray-200`:
    // бледная рамка на белом фоне просто не видна, и группы сливались в одно
    // полотно. `overflow-hidden` — чтобы персиковая шапка обрезалась по
    // скруглению и не торчала углами.
    <div className="rounded-xl border-2 border-[#25455D]/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-[#FFCFA4] text-[#25455D] text-sm font-semibold text-left hover:brightness-[0.97] transition"
      >
        <ChevronDown
          size={16}
          className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <span className="flex-1 min-w-0">{title}</span>
        {typeof count === 'number' && (
          <span className="shrink-0 px-2 py-0.5 rounded-md bg-[#25455D]/10 text-xs tabular-nums">
            {count}
          </span>
        )}
      </button>
      {open && <div className="bg-white">{children}</div>}
    </div>
  )
}
