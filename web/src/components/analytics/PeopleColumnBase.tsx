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
import {
  ChevronDown, ChevronRight, ChevronLeft, ChevronRight as ChevronRightIcon,
  Loader2, Pencil, X,
} from 'lucide-react'

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
  /** Названия оплаченных тарифов события через запятую (CRM события). */
  paid_tariffs?: string | null
  /** Сколько человек заплатил всего, ₽. */
  paid_amount?: number | null
}

export default function PeopleColumnBase({
  title, count, percent, people, loading, hint, tone = 'dark',
  onExpand, footer, collapsedByDefault = false, hrefFor, onRename, onRemove,
  onMove, canMoveLeft, canMoveRight,
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
  /** Куда ведёт клик по человеку. По умолчанию — карточка контакта.
   *  В дашборде АНКЕТЫ ведём на его заполненную анкету: там разбирают
   *  ответы, и карточка контакта — лишний крюк. */
  hrefFor?: (p: ColumnPerson) => string
  /** Переименовать колонку. Не передан — карандашика нет. */
  onRename?: () => void
  /** Убрать колонку. Не передан — крестика нет. */
  onRemove?: () => void
  /** Подвинуть колонку влево/вправо. Стрелками, а не перетаскиванием:
   *  работают на телефоне и не конфликтуют с прокруткой ряда. */
  onMove?: (delta: -1 | 1) => void
  canMoveLeft?: boolean
  canMoveRight?: boolean
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
    <div className="flex w-[260px] shrink-0 grow basis-[260px] flex-col rounded-xl border border-gray-200 bg-white">
      {/* Шапка — всегда видна, по ней и сворачиваем. */}
      {/* ⚠️ Шапка — не <button>, а <div>: карандаш и крестик внутри неё,
          а кнопка внутри кнопки недопустима. Сворачивает клик по заголовку. */}
      <div className="rounded-t-xl px-3 py-2.5" style={head}>
        <div className="flex items-center justify-between gap-1">
          {/* ⚠️ Заголовок ПЕРЕНОСИТСЯ, а не обрезается: у названий вида
              «Консультация — регистрация» видно было только «Консультация …»,
              и колонки становились неразличимы. break-words — на случай
              одного длинного слова без пробелов. */}
          <button onClick={toggle} className="min-w-0 flex-1 text-left">
            <span className="block break-words text-sm font-semibold leading-snug">{title}</span>
          </button>
          {onMove && (
            <>
              <button onClick={() => onMove(-1)} disabled={!canMoveLeft}
                      title="Левее"
                      className="shrink-0 rounded p-1 opacity-70 hover:opacity-100 disabled:opacity-25">
                <ChevronLeft size={14} />
              </button>
              <button onClick={() => onMove(1)} disabled={!canMoveRight}
                      title="Правее"
                      className="shrink-0 rounded p-1 opacity-70 hover:opacity-100 disabled:opacity-25">
                <ChevronRightIcon size={14} />
              </button>
            </>
          )}
          {onRename && (
            <button onClick={onRename} title="Переименовать колонку"
                    className="shrink-0 rounded p-1 opacity-70 hover:opacity-100">
              <Pencil size={13} />
            </button>
          )}
          {onRemove && (
            <button onClick={onRemove} title="Убрать колонку"
                    className="shrink-0 rounded p-1 opacity-70 hover:opacity-100">
              <X size={14} />
            </button>
          )}
          <button onClick={toggle} className="shrink-0 rounded p-1">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>
        <button onClick={toggle} className="mt-1 flex w-full items-baseline gap-2 text-left">
          <span className="text-2xl font-bold tabular-nums">{count}</span>
          {typeof percent === 'number' && (
            <span className="text-sm opacity-90">{percent}%</span>
          )}
        </button>
        {hint && <div className="mt-0.5 text-[11px] opacity-80">{hint}</div>}
      </div>

      {/* ⚠️ Высота считается ОТ ЭКРАНА (`vh`), а не жёсткими пикселями: при
          420px на большом мониторе оставалось пустое место снизу, а список всё
          равно прокручивался внутри коробки. Вычитаем шапку страницы и
          заголовок колонки. */}
      {open && (
        <div className="max-h-[calc(100vh-320px)] min-h-[220px] overflow-y-auto scroll-visible p-2">
          {loading ? (
            <div className="flex items-center gap-2 p-3 text-sm text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Загружаем…
            </div>
          ) : !people.length ? (
            <p className="p-3 text-sm text-gray-400">Пусто</p>
          ) : (
            // ⚠️ Номер — ПОРЯДКОВЫЙ в списке, а не id контакта: человек считает
            // глазами «сколько уже просмотрел», и внутренний номер записи ему
            // ничего не говорит.
            people.map((p, i) => (
              <PersonRow key={p.id} person={p} hrefFor={hrefFor} num={i + 1} />
            ))
          )}
          {footer}
        </div>
      )}
    </div>
  )
}

/** Строка человека: имя ведёт в карточку контакта, под ним — ники площадок. */
function PersonRow({ person, hrefFor, num }: {
  person: ColumnPerson
  hrefFor?: (p: ColumnPerson) => string
  num?: number
}) {
  const nicks = [
    person.telegram && `TG ${at(person.telegram)}`,
    person.vk && `VK ${at(person.vk)}`,
    person.max_nick && `MAX ${at(person.max_nick)}`,
  ].filter(Boolean) as string[]

  return (
    <Link href={hrefFor ? hrefFor(person) : `/dashboard/clients?contact=${person.id}`}
          className="flex gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50">
      {/* ⚠️ Номер выровнен по правому краю и моноширинный (`tabular-nums`):
          иначе на двузначных именах колонка «прыгает». */}
      {num !== undefined && (
        <span className="w-6 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-gray-400">
          {num}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" style={{ color: DARK }}>
          {person.name || 'Без имени'}
        </span>
        {nicks.length > 0 && (
          <span className="block truncate text-[11px] text-gray-500">{nicks.join(' · ')}</span>
        )}
        {/* Купленный тариф — отдельной строкой и персиковым: платного
            участника надо отличать от зашедшего посмотреть с одного взгляда,
            звонят им по-разному. Сумма рядом, если она записана. */}
        {person.paid_tariffs && (
          <span className="block truncate text-[11px] font-medium" style={{ color: '#B57A3C' }}>
            {person.paid_tariffs}
            {person.paid_amount ? ` · ${person.paid_amount.toLocaleString('ru-RU')} ₽` : ''}
          </span>
        )}
      </span>
    </Link>
  )
}

/** Ник показываем с «собакой», числовой id — как есть. */
function at(v: string) {
  const s = String(v)
  return /^\d+$/.test(s) ? s : `@${s.replace(/^@/, '')}`
}
