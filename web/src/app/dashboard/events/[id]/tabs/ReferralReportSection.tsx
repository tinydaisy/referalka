'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { Users, CheckCircle2, Wallet, ChevronRight, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

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
  ref_code: string | null
  email: string | null
  phone: string | null
  tg_username: string | null
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
  const list = needle
    ? all.filter(r =>
        (r.name || '').toLowerCase().includes(needle) ||
        (r.email || '').toLowerCase().includes(needle) ||
        (r.phone || '').toLowerCase().includes(needle) ||
        (r.tg_username || '').toLowerCase().includes(needle) ||
        (r.ref_code || '').toLowerCase().includes(needle))
    : all

  if (all.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 text-center">
        <Users size={28} className="mx-auto text-gray-300 mb-3" />
        <p className="font-medium text-gray-700">Пока никто никого не привёл</p>
        <p className="text-sm text-gray-500 mt-1">
          Как только человек придёт по чьей-то реферальной ссылке, здесь появится тот, кто его привёл.
        </p>
      </div>
    )
  }

  return (
    <div>
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

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="text-[11px] text-gray-400 uppercase tracking-wide bg-gray-50">
              <tr>
                <th className="text-left px-5 py-2.5 font-medium">Реферал</th>
                <th className="text-left px-3 py-2.5 font-medium">Сам зареган</th>
                <th className="text-right px-3 py-2.5 font-medium">Привёл</th>
                <th className="text-right px-3 py-2.5 font-medium">Зарегались</th>
                <th className="text-right px-3 py-2.5 font-medium">Оплатили</th>
                <th className="text-right px-3 py-2.5 font-medium">Сумма оплат</th>
                <th className="w-8 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.contact_id} className="border-t border-gray-50 hover:bg-gray-50/60">
                  <td className="px-5 py-3">
                    {/* Имя ведёт на карточку рефовода со списком его людей. */}
                    <Link href={personHref(r.contact_id)}
                          className="font-medium text-gray-900 hover:text-[#25455D] hover:underline">
                      {r.name || 'Без имени'}
                    </Link>
                    <div className="text-xs text-gray-400 flex items-center gap-2 flex-wrap mt-0.5">
                      {r.tg_username && <span>@{String(r.tg_username).replace(/^@+/, '')}</span>}
                      {r.email && <span>{r.email}</span>}
                      <span className="font-mono">{r.ref_code}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
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
                  <td className="px-3 py-3 text-right font-semibold text-gray-900">{r.brought}</td>
                  <td className="px-3 py-3 text-right text-gray-700">{r.registered}</td>
                  <td className="px-3 py-3 text-right text-gray-700">{r.paid_count}</td>
                  <td className="px-3 py-3 text-right font-semibold text-gray-900 whitespace-nowrap">
                    {r.paid_sum > 0 ? money(r.paid_sum) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-3 text-right">
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
                <td className="px-5 py-3">
                  Итого{needle ? ' (по всем, не только найденным)' : ''}
                </td>
                <td className="px-3 py-3" />
                <td className="px-3 py-3 text-right">{totals.brought ?? 0}</td>
                <td className="px-3 py-3 text-right">{totals.registered ?? 0}</td>
                <td className="px-3 py-3 text-right">{totals.paid_count ?? 0}</td>
                <td className="px-3 py-3 text-right whitespace-nowrap">{money(totals.paid_sum ?? 0)}</td>
                <td className="px-3 py-3" />
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
