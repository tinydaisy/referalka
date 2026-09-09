'use client'
import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Переход к соседнему материалу.
 *
 * ⚠️ ОДИН КОМПОНЕНТ НА ТРИ МЕСТА: кабинет покупателя, база материалов модуля и
 * кабинет владельца. Раньше это были три копии одной вёрстки, и они уже начали
 * расходиться — где-то длинное название обрезалось, где-то ломало ряд.
 *
 * ⚠️⚠️ НА КНОПКЕ — ТОЛЬКО СЛОВА, без названия материала. Название бывает в
 * несколько строк, и кнопка с ним разносит ряд: одна занимает всю ширину, вторая
 * уезжает под неё. Название уходит в подсказку при наведении.
 *
 * ⚠️ Кнопки — фирменным классом `.btn-gold` (персиковый #FFCFA4), а не своим
 * набором цветов: смысл единой точки настройки в том и есть, что цвет меняется в
 * globals.css, а не в двадцати файлах.
 *
 * ⚠️ Стоит ДВАЖДЫ — над названием и под содержимым. Сверху видно сразу, что
 * материал не последний; снизу — когда дочитал и надо идти дальше.
 *
 * ⚠️ У первого материала нет «предыдущего», у последнего — «следующего»: кнопки
 * в никуда быть не должно. Когда есть только «следующий», он прижимается
 * вправо — иначе одинокая кнопка выглядит как «назад».
 */
export default function MaterialNav({ prev, next, compact = false }: {
  /** `title` идёт только в подсказку при наведении, на кнопку — нет. */
  prev?: { href: string; title?: string } | null
  next?: { href: string; title?: string } | null
  /** Вверху страницы: кнопки помельче. */
  compact?: boolean
}) {
  if (!prev && !next) return null

  const size = compact ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
  const icon = compact ? 14 : 15

  const buttons = (
    <>
      {prev ? (
        <Link href={prev.href} title={prev.title} className={`btn-gold ${size}`}>
          <ChevronLeft size={icon} /> Смотреть предыдущий
        </Link>
      ) : <span />}
      {next && (
        <Link href={next.href} title={next.title} className={`btn-gold ${size}`}>
          Перейти к следующему <ChevronRight size={icon} />
        </Link>
      )}
    </>
  )

  return compact
    ? <div className="flex items-center gap-2">{buttons}</div>
    : <div className="mt-6 flex items-center justify-between gap-3">{buttons}</div>
}
