'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Users, CheckCircle2, Wallet, ChevronRight, Search, ArrowUp, ArrowDown } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
// Общий показ площадок — тот же компонент, что в карточке рефовода.
import PlatformList from '@/components/PlatformList'

/**
 * Отчёт по рефералам события: кто сколько привёл.
 *
 * ⚠️ Не путать с «Отчётом» конференции — тот про клики по карточкам спикеров
 * и снимки на дату. Здесь живой срез по `event_participants.referrer_ref_code`.
 *
 * ⚠️ Грузится СРАЗУ при заходе на подвкладку, без кнопки «построить отчёт»
 * (решение владельца 09.09.2026): это экран наблюдения, а не документ.
 *
 * ⚠️ В списке только те, у кого есть хотя бы один приведённый: отчёт строится
 * от факта прихода, а не от списка контактов — иначе таблица была бы длиной
 * во всю базу и работающих людей в ней было бы не найти.
 */

interface Row {
  contact_id: number
  name: string | null
  /** Рефовод — спикер этого события (22.09.2026): имя тогда идёт
   *  с фамилией из карточки спикера, у контакта фамилии нет вовсе. */
  is_speaker?: boolean
  ref_code: string | null
  email: string | null
  phone: string | null
  tg_username: string | null
  tg_id: string | null
  vk_username: string | null
  vk_id: string | null
  max_username: string | null
  max_id: string | null
  self_registered: boolean
  self_participant: boolean
  brought: number
  registered: number
  paid_count: number
  paid_sum: number
}

function money(v: number): string {
  return `${Number(v || 0).toLocaleString('ru-RU')} ₽`
}

type SortKey = 'name' | 'email' | 'phone' | 'ref_code' | 'self'
  | 'brought' | 'registered' | 'paid_count' | 'paid_sum'

/** Текстовые колонки сортируются от А, числовые — от большего. */
const TEXT_KEYS: SortKey[] = ['name', 'email', 'phone', 'ref_code']

/** Заголовок-кнопка: клик сортирует по этой колонке, повторный — разворачивает. */
function Th({ label, k, sortKey, sortDir, onSort, align = 'left', className = '' }: {
  label: React.ReactNode
  k: SortKey
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (k: SortKey) => void
  align?: 'left' | 'right' | 'center'
  className?: string
}) {
  const active = sortKey === k
  const just = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  return (
    <th className={`text-${align} px-2 py-2.5 font-medium ${className}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        title="Сортировать по этой колонке"
        className={`inline-flex items-center gap-1 w-full ${just} uppercase tracking-wide hover:text-[#25455D] ${
          active ? 'text-[#25455D] font-semibold' : ''
        }`}
      >
        {label}
        {/* Стрелка только у активной колонки — иначе шапка рябит. */}
        {active && (sortDir === 'desc' ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
      </button>
    </th>
  )
}

function StatCard({ icon: Icon, label, value, hint, accent }: {
  icon: any; label: string; value: string; hint?: string; accent?: boolean
}) {
  return (
    <div
      className="rounded-xl border px-4 py-3 flex items-center gap-3"
      style={accent
        ? { borderColor: '#FFCFA4', background: '#FFF8F1' }
        : { borderColor: '#e5e7eb', background: '#fff' }}
    >
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
           style={{ background: accent ? '#FFCFA4' : '#F1F6FA', color: '#25455D' }}>
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
        <p className="text-lg font-bold text-gray-900 leading-tight">{value}</p>
        {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
      </div>
    </div>
  )
}

/** Раздел кабинета, в который вернёт кнопка «назад» с карточки рефовода.
 *
 *  ⚠️ Берём из ТЕКУЩЕГО адреса, а не из `module_slug`: турнир открывается по
 *  `/dashboard/tournaments/{id}`, но это лишь обёртка над страницей
 *  конференции — по типу события мы вернули бы человека в «Конференции»,
 *  то есть в другой раздел меню. Вкладка реф-программы общая на четыре
 *  раздела, и возврат обязан вести туда, откуда пришли. */
const KNOWN_SECTIONS = ['events', 'conferences', 'tournaments', 'contests']

function sectionFromPath(pathname: string | null): string {
  const seg = (pathname || '').split('/')[2] || ''
  return KNOWN_SECTIONS.includes(seg) ? seg : 'events'
}

/** Пояснение: здесь ТОЛЬКО зрители, остальные — в другом отчёте.
 *
 * ⚠️ Без этой подписи отчёт читался бы как «все, кто привёл», и пропажа
 * спикеров выглядела бы потерей данных: у события 89 из 28 строк 16 были
 * коллабораторы. Сразу даём ссылку туда, где их привлечение и считается.
 */
function OnlyViewersNotice({ eventId }: { eventId: number }) {
  const section = sectionFromPath(usePathname())
  return (
    <div className="mb-4 rounded-xl border p-3 text-sm leading-relaxed"
         style={{ borderColor: '#FFCFA4', background: '#FFF8F1', color: '#25455D' }}>
      Здесь показывается отчёт по привлечению <b>только от зрителей</b>.
      {' '}Отчёт по привлечению спикеров, партнёров и организаторов смотрите в разделе{' '}
      <a href={`/dashboard/${section}/${eventId}?tab=report`}
         className="font-semibold underline hover:opacity-80">
        Отслеживания → Отчёт по привлечению
      </a>.
    </div>
  )
}

export default function ReferralReportSection({ eventId, moduleSlug }: {
  eventId: number
  moduleSlug?: string
}) {
  const pathname = usePathname()
  const from = sectionFromPath(pathname)
  const personHref = (contactId: number) =>
    `/dashboard/events/${eventId}/referrals/${contactId}?from=${from}`
  const [rows, setRows] = useState<Row[] | null>(null)
  const [totals, setTotals] = useState<any>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  // По умолчанию — деньги сверху (решение владельца 09.09.2026).
  const [sortKey, setSortKey] = useState<SortKey>('paid_sum')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  function toggleSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(k)
      // Цифры логичнее смотреть от большего, имена — от А.
      setSortDir(TEXT_KEYS.includes(k) ? 'asc' : 'desc')
    }
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.referralProgram.report(eventId)
      .then((r: any) => {
        if (!alive) return
        setRows(r?.items || [])
        setTotals(r?.totals || {})
      })
      .catch((e: any) => { if (alive) setErr(e?.message || 'Не удалось загрузить отчёт') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [eventId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }
  if (err) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
    )
  }

  const all = rows || []
  const needle = q.trim().toLowerCase()
  const filtered = needle
    ? all.filter(r =>
        (r.name || '').toLowerCase().includes(needle) ||
        (r.email || '').toLowerCase().includes(needle) ||
        (r.phone || '').toLowerCase().includes(needle) ||
        (r.tg_username || '').toLowerCase().includes(needle) ||
        (r.ref_code || '').toLowerCase().includes(needle))
    : all

  // Сколько рефоводов с оплатами, но без вписанных сумм — из-за них итог занижен.
  const noAmountReferrers = all.filter(r => r.paid_count > 0 && !(r.paid_sum > 0)).length

  // ⚠️ ПОРЯДОК ПО УМОЛЧАНИЮ: сумма оплат ↓, затем регистрации ↓, затем имя
  // (решение владельца 09.09.2026) — «у кого есть деньги, тот и выше».
  // Клик по заголовку колонки переключает сортировку по ней.
  const list = [...filtered].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    const num = (r: Row) => {
      switch (sortKey) {
        case 'paid_sum': return r.paid_sum
        case 'paid_count': return r.paid_count
        case 'registered': return r.registered
        case 'brought': return r.brought
        case 'self': return r.self_registered ? 1 : 0
        default: return 0
      }
    }
    if (sortKey === 'name' || sortKey === 'email' || sortKey === 'phone' || sortKey === 'ref_code') {
      const s = (r: Row) => String(
        sortKey === 'name' ? (r.name || '') :
        sortKey === 'email' ? (r.email || '') :
        sortKey === 'phone' ? (r.phone || '') : (r.ref_code || ''))
      return s(a).localeCompare(s(b), 'ru') * dir
    }
    const d = (num(a) - num(b)) * dir
    if (d !== 0) return d
    // Тай-брейкеры того же порядка, что и по умолчанию: деньги → регистрации → имя.
    if (b.paid_sum !== a.paid_sum) return b.paid_sum - a.paid_sum
    if (b.registered !== a.registered) return b.registered - a.registered
    return String(a.name || '').localeCompare(String(b.name || ''), 'ru')
  })

  if (all.length === 0) {
    return (
      <div>
        <OnlyViewersNotice eventId={eventId} />
        <div className="bg-white rounded-2xl border card-border shadow-sm p-8 text-center">
          <Users size={28} className="mx-auto text-gray-300 mb-3" />
          <p className="font-medium text-gray-700">Пока никто из зрителей никого не привёл</p>
          <p className="text-sm text-gray-500 mt-1">
            Как только человек придёт по реферальной ссылке зрителя, здесь появится тот, кто его привёл.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <OnlyViewersNotice eventId={eventId} />
      <div className="grid gap-3 mb-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="Рефоводов" value={String(totals.referrers ?? 0)}
                  hint="у кого есть приведённые" />
        <StatCard icon={Users} label="Пришло по ссылкам" value={String(totals.brought ?? 0)}
                  hint={totals.participants_total
                    ? `из ${totals.participants_total} участников события`
                    : undefined} />
        <StatCard icon={CheckCircle2} label="Из них зарегистрировалось" value={String(totals.registered ?? 0)} />
        <StatCard icon={Wallet} label="Сумма оплат" value={money(totals.paid_sum ?? 0)}
                  hint={`оплатили ${totals.paid_count ?? 0} чел.`} accent />
      </div>

      {/* ⚠️ Итог занижен, если у части оплат сумма не вписана. Молча показывать
          неполную цифру нельзя — по ней принимают решения. */}
      {noAmountReferrers > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 mb-4 -mt-2">
          Сумма неполная: у <b>{noAmountReferrers}</b> рефовод(ов) есть оплаты, но сумма по ним не заполнена —
          такие оплаты в итог не попали. Впишите суммы в «Платежи/Заявки» → «Заказы»
          (или <b>0</b>, если человек прошёл бесплатно).
        </div>
      )}

      {all.length > 8 && (
        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Поиск по имени, почте, телефону, @нику, реф-коду"
            className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#25455D]"
          />
        </div>
      )}

      <div className="bg-white rounded-2xl border card-border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1180px]">
            {/* ⚠️ КАЖДОЕ ПОЛЕ — СВОЯ КОЛОНКА (требование владельца 09.09.2026).
                Почта, телефон и реф-код были свалены мелким текстом под именем:
                строка раздувалась, а цифры уезжали за край экрана. */}
            <thead className="text-[11px] text-gray-400 uppercase tracking-wide bg-gray-50">
              <tr>
                {/* ⚠️ Имя ЗАКРЕПЛЕНО при горизонтальной прокрутке (sticky
                    left-0): таблица широкая, и, доехав до «Суммы оплат», не
                    видно, чья это строка. Фон обязателен — иначе сквозь
                    закреплённую ячейку просвечивают уезжающие под неё. */}
                <Th label="Имя" k="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}
                    className="sticky left-0 z-20 bg-gray-50 min-w-[180px] px-4" />
                <Th label="Email" k="email" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label="Телефон" k="phone" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                {/* Площадки не сортируем: у человека их может быть несколько. */}
                <th className="text-left px-2 py-2.5 font-medium">Площадки</th>
                <Th label="Реф-код" k="ref_code" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label={<>Сам<br/>зареган</>} k="self" align="center"
                    sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label="Привёл" k="brought" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label="Зарегались" k="registered" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label="Оплатили" k="paid_count" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <Th label="Сумма оплат" k="paid_sum" align="right" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <th className="w-10 px-2 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.contact_id} className="border-t border-gray-50 group">
                  {/* ⚠️ Фон непрозрачный (bg-white), иначе при прокрутке под
                      закреплённой колонкой видно уезжающий текст.
                      Подсветку строки поэтому красим и здесь через group-hover,
                      а не одним `hover:bg-gray-50/60` на строке. */}
                  <td className="px-4 py-3 sticky left-0 z-10 bg-white group-hover:bg-gray-50 min-w-[180px]">
                    {/* Имя ведёт на карточку рефовода со списком его людей. */}
                    <Link href={personHref(r.contact_id)}
                          className="font-medium text-gray-900 hover:text-[#25455D] hover:underline">
                      {r.name || 'Без имени'}
                    </Link>
                    {/* Пометка «спикер» — в списке привлечения полезно сразу
                        видеть, кто из рефоводов выступает на событии. */}
                    {r.is_speaker && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-semibold align-middle"
                            style={{ background: '#FFCFA4', color: '#25455D' }}>
                        спикер
                      </span>
                    )}
                  </td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-xs text-gray-600">
                    {r.email || <span className="text-gray-300">—</span>}
                  </td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-xs text-gray-600 whitespace-nowrap">
                    {r.phone || <span className="text-gray-300">—</span>}
                  </td>
                  {/* Площадки — иконка + ник, по одной на строку. */}
                  <td className="group-hover:bg-gray-50 px-2 py-3"><PlatformList p={r} /></td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-xs font-mono text-gray-500">{r.ref_code}</td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-center">
                    {r.self_registered ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
                        <CheckCircle2 size={12} /> Да
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">
                        {r.self_participant ? 'Нет' : '—'}
                      </span>
                    )}
                  </td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-right font-semibold text-gray-900">{r.brought}</td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-right text-gray-700">{r.registered}</td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-right text-gray-700">{r.paid_count}</td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-right font-semibold text-gray-900 whitespace-nowrap">
                    {/* ⚠️ Есть оплаты, но сумма нулевая — это НЕ «ничего не
                        купили»: у самих оплат поле суммы не заполнено (их
                        отмечали вручную, когда форма сумму не спрашивала).
                        Прочерк здесь читался как «денег нет вовсе». */}
                    {r.paid_sum > 0 ? money(r.paid_sum)
                      : r.paid_count > 0 ? (
                        <span className="text-amber-600 text-xs font-medium whitespace-nowrap"
                              title={`${r.paid_count} оплат без вписанной суммы — впишите её в «Платежи/Заявки» → «Заказы»`}>
                          сумма не указана
                        </span>
                      ) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="group-hover:bg-gray-50 px-2 py-3 text-right">
                    <Link href={personHref(r.contact_id)}
                          title="Открыть карточку и список приведённых"
                          className="inline-flex w-7 h-7 rounded-md items-center justify-center text-gray-400 hover:text-[#25455D] hover:bg-gray-100">
                      <ChevronRight size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold text-gray-900">
                {/* Итог занимает первые 6 колонок (имя…сам зареган) — по ним
                    суммировать нечего, а цифры должны встать под своими. */}
                <td className="px-4 py-3" colSpan={6}>
                  Итого{needle ? ' (по всем, не только найденным)' : ''}
                </td>
                <td className="px-2 py-3 text-right">{totals.brought ?? 0}</td>
                <td className="px-2 py-3 text-right">{totals.registered ?? 0}</td>
                <td className="px-2 py-3 text-right">{totals.paid_count ?? 0}</td>
                <td className="px-2 py-3 text-right whitespace-nowrap">{money(totals.paid_sum ?? 0)}</td>
                <td className="px-2 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-400 mt-3">
        Считается вживую по реферальным ссылкам события. «Привёл» — сколько человек
        пришло по его ссылке, «Зарегались» — сколько из них завершили регистрацию.
        Нажмите на имя, чтобы увидеть список приведённых.
      </p>
    </div>
  )
}
