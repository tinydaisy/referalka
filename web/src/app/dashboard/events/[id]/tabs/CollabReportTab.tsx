'use client'
import { useEffect, useState } from 'react'
import { Users, TrendingUp, Info } from 'lucide-react'
import { api } from '@/lib/api'

/** Отчёт по привлечению в КОЛЛАБ-событии: кто из организаторов сколько привёл.
 *
 *  ⚠️ Видят все организаторы, и видят всех — в этом смысл Win-Win: обмен
 *  аудиториями честен, только когда вклад каждого на виду.
 *
 *  Считается вживую, по ходу события. Таблица hub_collab_history наполняется
 *  лишь при завершении коллабы, поэтому до финала по ней отчёт не построить.
 */

interface OrgRow {
  client_id: number
  name: string | null
  /** Привёл = пришёл по его реф-коду И зарегистрировался (одно правило с рейтингом Хаба). */
  brought: number
  /** Из чего складывается: пришли по ссылке (это и есть `brought`)… */
  by_ref: number
  /** …и пришли сами, будучи в его базе — в рейтинг НЕ идут. */
  self_came: number
  coefficient: number | null
  is_me: boolean
}

/** Поимённо: кто раздавал ссылки. Чаще всего это спикеры, а не организаторы. */
interface RefRow {
  contact_id: number
  name: string | null
  ref_code: string
  client_id: number | null
  client_name: string | null
  brought: number
  clicked: number
}

/** Цвет коэффициента: 1.0 — норма (вровень с партнёрами), выше — молодец. */
function coefColor(c: number | null): string {
  if (c === null) return 'text-gray-400'
  if (c >= 1.2) return 'text-green-700'
  if (c >= 0.8) return 'text-gray-800'
  return 'text-orange-600'
}

export default function CollabReportTab({ eventId }: { eventId: number }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<OrgRow[]>([])
  const [refs, setRefs] = useState<RefRow[]>([])
  const [total, setTotal] = useState(0)
  const [broughtTotal, setBroughtTotal] = useState(0)
  const [withoutRef, setWithoutRef] = useState(0)
  const [err, setErr] = useState('')

  useEffect(() => {
    setLoading(true)
    api.collabHub.attractionReport(eventId)
      .then((r: any) => {
        setRows(r.organizers || [])
        setRefs(r.referrers || [])
        setTotal(r.participants_total || 0)
        setBroughtTotal(r.brought_total || 0)
        setWithoutRef(r.without_referrer || 0)
      })
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить отчёт'))
      .finally(() => setLoading(false))
  }, [eventId])

  if (loading) return <div className="py-16 text-center text-gray-400">Загружаем…</div>
  if (err) return <div className="py-8 text-center text-red-600 text-sm">{err}</div>

  return (
    <div className="space-y-4">
      {/* Сводка */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-2xl font-bold text-gray-900">{total}</div>
          <div className="text-xs text-gray-500 mt-1">Всего участников</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-2xl font-bold text-gray-900">{broughtTotal}</div>
          <div className="text-xs text-gray-500 mt-1">Привели организаторы</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-2xl font-bold text-gray-400">{withoutRef}</div>
          <div className="text-xs text-gray-500 mt-1">Пришли без чьей-то ссылки</div>
        </div>
      </div>

      {/* ⚠️ РЕЙТИНГ КАЖДОГО — КРУПНО И СВЕРХУ. Раньше Win-Win стоял последним
          столбцом таблицы и терялся: главную цифру коллаборации приходилось
          выискивать глазами. Карточка на организатора, коэффициент — самым
          крупным шрифтом, своя карточка выделена. */}
      {rows.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map(r => (
            <div key={r.client_id}
                 className={`rounded-xl border p-4 ${r.is_me
                   ? 'bg-amber-50 border-amber-200'
                   : 'bg-white border-gray-100'}`}>
              <div className="text-xs text-gray-600 font-medium truncate"
                   title={r.name || ''}>
                {r.name || `Клиент #${r.client_id}`}
                {r.is_me && <span className="ml-1.5 text-gray-400">— вы</span>}
              </div>
              <div className={`text-3xl font-bold mt-1.5 ${coefColor(r.coefficient)}`}>
                {r.coefficient === null ? '—' : r.coefficient.toFixed(2)}
              </div>
              <div className="text-[11px] text-gray-500">Win-Win</div>
              <div className="text-xs text-gray-600 mt-2.5 pt-2.5 border-t border-gray-200/70">
                привёл <b className="text-gray-900">{r.brought}</b>
                {r.self_came > 0 && (
                  <span className="text-gray-400"> · сами из базы {r.self_came}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Таблица организаторов */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
          <Users size={17} className="text-gray-400" />
          <h3 className="font-semibold text-gray-800">Кто сколько привёл</h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium">Организатор</th>
                {/* ⚠️ Разложено на слагаемые: раньше стоял один итог, и было
                    непонятно, откуда он взялся. */}
                <th className="text-right px-4 py-3 font-medium">По реф-коду</th>
                <th className="text-right px-4 py-3 font-medium">Сами из базы</th>
                <th className="text-right px-4 py-3 font-medium">Итого</th>
                <th className="text-right px-5 py-3 font-medium">Win-Win</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.client_id} className={`border-t border-gray-50 ${r.is_me ? 'bg-amber-50/40' : ''}`}>
                  <td className="px-5 py-3 text-gray-800">
                    {r.name || `Клиент #${r.client_id}`}
                    {r.is_me && <span className="ml-2 text-xs text-gray-400">— вы</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">{r.by_ref ?? r.brought}</td>
                  <td className="px-4 py-3 text-right text-gray-400">{r.self_came ?? 0}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">{r.brought}</td>
                  <td className={`px-5 py-3 text-right font-bold ${coefColor(r.coefficient)}`}>
                    {r.coefficient === null ? '—' : r.coefficient.toFixed(2)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-gray-400">Организаторов пока нет</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-3 bg-gray-50/70 border-t border-gray-100 text-xs text-gray-500">
          ⚠️ В рейтинг идёт только столбец «По реф-коду» — то есть люди, пришедшие
          по ссылке. «Сами из базы» — те, кто уже был в базе организатора и зашёл
          без ссылки: из бота, из календаря событий. Приглашения не было, поэтому
          в Win-Win они не считаются.
        </div>
      </div>

      {/* ── Поимённо: кто раздавал ссылки ─────────────────────────────────
          ⚠️ Рефовод ≠ организатор. Чаще всего людей приводит СПИКЕР или
          обычный участник, а по итоговой цифре организатора этого не видно. */}
      {refs.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <TrendingUp size={17} className="text-gray-400" />
            <h3 className="font-semibold text-gray-800">Кто приводил людей</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-500 text-xs uppercase">
                  <th className="text-left px-5 py-3 font-medium">Рефовод</th>
                  <th className="text-left px-4 py-3 font-medium">Чья база</th>
                  <th className="text-right px-4 py-3 font-medium">Перешли</th>
                  <th className="text-right px-5 py-3 font-medium">Зарегистрировались</th>
                </tr>
              </thead>
              <tbody>
                {refs.map(r => (
                  <tr key={r.contact_id} className="border-t border-gray-50">
                    <td className="px-5 py-3 text-gray-800">
                      <a href={`/dashboard/clients?contact=${r.contact_id}`}
                         target="_blank" rel="noopener"
                         className="hover:text-[#25455D] hover:underline">
                        {r.name || `Контакт #${r.contact_id}`}
                      </a>
                      <span className="ml-2 text-[11px] text-gray-400 font-mono">{r.ref_code}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">
                      {r.client_name || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400">{r.clicked}</td>
                    <td className="px-5 py-3 text-right font-semibold text-gray-900">{r.brought}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-3 bg-gray-50/70 border-t border-gray-100 text-xs text-gray-500">
            «Чья база» — организатор, которому принадлежит контакт рефовода:
            его приведённые засчитываются этой команде. «Перешли» — открыли
            событие по ссылке; «Зарегистрировались» — дошли до регистрации,
            только они идут в рейтинг.
          </div>
        </div>
      )}

      {/* Пояснение принципа — без него цифра 1.0 читается непонятно */}
      <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-4 flex gap-3">
        <Info size={17} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm text-gray-700 space-y-1.5">
          <p>
            <b>Win-Win</b> показывает, как вы сработали относительно партнёров:
            ваши приведённые делятся на среднее по организаторам.
          </p>
          <p>
            <b>1.00</b> — привели столько же, сколько в среднем каждый.
            Больше единицы — вытянули коллабу на себе, меньше — есть куда расти.
            Число партнёров на коэффициент не влияет: вдвоём или вчетвером —
            справедливая доля всегда 1.00.
          </p>
          <p className="text-gray-500">
            «Привёл» — человек пришёл по вашей ссылке и <b>зарегистрировался</b>
            на событие. Просто открыл и ушёл — не считается.
            После завершения коллабы это значение попадёт в вашу карточку
            в Коллабораторной.
          </p>
        </div>
      </div>
    </div>
  )
}
