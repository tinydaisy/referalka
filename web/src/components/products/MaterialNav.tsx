'use client'
import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Переход к соседнему материалу — «предыдущий» и «следующий».
 *
 * ⚠️ ОДИН КОМПОНЕНТ НА ТРИ МЕСТА: кабинет покупателя, база материалов модуля и
 * кабинет владельца. Раньше это были три копии одной вёрстки, и они уже начали
 * расходиться — где-то длинное название обрезалось, где-то ломало ряд.
 *
 * ⚠️ У первого материала нет «предыдущего», у последнего — «следующего»: кнопки
 * в никуда быть не должно. Когда есть только «дальше», он прижимается вправо —
 * иначе одинокая кнопка выглядит как «назад».
 *
 * ⚠️ Название обрезается (`truncate`): у материалов бывают длинные заголовки, и
 * без этого кнопка растягивается на всю строку, а вторая уезжает под неё.
 */
export default function MaterialNav({ prev, next }: {
  prev?: { href: string; title: string } | null
  next?: { href: string; title: string } | null
}) {
  if (!prev && !next) return null

  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      {prev ? (
        <Link href={prev.href}
              className="inline-flex min-w-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition hover:border-gray-300">
          <ChevronLeft size={15} className="shrink-0" />
          <span className="truncate">{prev.title}</span>
        </Link>
      ) : <span />}
      {next && (
        <Link href={next.href}
              className="inline-flex min-w-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition hover:border-gray-300">
          <span className="truncate">{next.title}</span>
          <ChevronRight size={15} className="shrink-0" />
        </Link>
      )}
    </div>
  )
}
