'use client'

/**
 * CRM клиентов платформы — ВОРОНКА по статусам (23.09.2026).
 *
 * ⚠️⚠️ ЭТО НЕ «КЛИЕНТЫ» (`/admin/clients`). Два разных экрана, и путать их
 * нельзя:
 *   • «Клиенты» — КАРТОЧКА клиента: события, боты, подписчики, вебинары,
 *     коллаборации, тариф, когда зарегался. Отвечает «что у него есть».
 *   • «CRM» (этот) — ВОРОНКА: триал → активирован → удержан → оживлён →
 *     отвалился. Отвечает «где он в пути и что с ним делать дальше».
 * Логика у них разная, поэтому и пункты меню разные.
 *
 * ⚠️ Два вида показа — БЛОКАМИ (колонки-этапы, как в CRM события у помощников)
 * и СПИСКОМ. Блоками видно перекос воронки с одного взгляда, списком удобнее
 * искать конкретного человека. Выбор живёт в адресе, как и фильтры.
 *
 * ⚠️ Отдельная СТРАНИЦА, а не всплывающее окно: в окне нет адреса, его нельзя
 * дать ссылкой и нельзя вернуться назад. Фильтр живёт в адресе (`?spec=<id>`),
 * поэтому из карточки внедренца сюда приходят уже отфильтрованными.
 *
 * ⚠️ Воронку и статусы считает СЕРВЕР теми же выражениями, что и деньги
 * (`services/tech_accruals`). Здесь только показ: своя арифметика на фронте
 * разошлась бы с начислениями.
 */
import { useEffect, useState, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { api } from '@/lib/api'

const PAGE = 50

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

const dt = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—'

// ⚠️ Порядок — это путь клиента: триал → активирован → удержан → оживлён.
// Отвалившиеся в конце, но не спрятаны: с ними и работают ради оживления.
const STATUSES: { id: string; label: string }[] = [
  { id: '', label: 'Все' },
  { id: 'trial', label: 'Триал' },
  { id: 'activated', label: 'Активированные' },
  { id: 'retained', label: 'Удержанные' },
  { id: 'revived', label: 'Оживлённые' },
  { id: 'churned', label: 'Отвалившиеся' },
  { id: 'lead', label: 'Лиды' },
]

const CRM_LABEL: Record<string, { label: string; cls: string }> = {
  trial: { label: 'Триал', cls: 'bg-gray-100 text-gray-600' },
  activated: { label: 'Активирован', cls: 'bg-blue-50 text-blue-700' },
  retained: { label: 'Удержан', cls: 'bg-green-50 text-green-700' },
  revived: { label: 'Оживлён', cls: 'bg-amber-50 text-amber-700' },
  churned: { label: 'Отвалился', cls: 'bg-red-50 text-red-700' },
  lead: { label: 'Лид', cls: 'bg-gray-100 text-gray-400' },
}

// ⚠️ `useSearchParams` на пререндеренной странице требует <Suspense>, иначе
// падает сборка ВСЕЙ ветки — уже ловили это на соседнем экране.
export default function AdminCrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmScreen />
    </Suspense>
  )
}

function CrmScreen() {
  const params = useSearchParams()
  const router = useRouter()
  // ⚠️ Фильтр по внедренцу читается ИЗ АДРЕСА: так ссылка «клиенты Ирины»
  // остаётся рабочей и переживает обновление страницы.
  const specFromUrl = params.get('spec')

  const [specs, setSpecs] = useState<any[]>([])
  const [specId, setSpecId] = useState<number | null>(
    specFromUrl ? Number(specFromUrl) : null)
  // ⚠️ Вид показа — в адресе: выбранный вид должен пережить обновление
  // страницы, иначе человек каждый раз переключает его заново.
  const [view, setView] = useState<'board' | 'list'>(
    params.get('view') === 'list' ? 'list' : 'board')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<any[]>([])
  const [board, setBoard] = useState<Record<string, any[]>>({})
  const [funnel, setFunnel] = useState<any>({})
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.adminTech.specialists()
      .then((r: any) => setSpecs(r.specialists || []))
      .catch(() => setSpecs([]))
  }, [])

  // Смена любого фильтра — на первую страницу: иначе человек фильтрует и
  // попадает в пустоту, на страницу, которой больше нет.
  useEffect(() => { setOffset(0) }, [specId, status, q])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      api.adminTech.crm({ spec_id: specId, status, q, limit: PAGE, offset })
        .then((r: any) => {
          if (!alive) return
          setItems(r.clients || [])
          setTotal(r.total || 0)
          setFunnel(r.funnel || {})
          setBoard(r.board || {})
        })
        .catch(() => {
          if (alive) { setItems([]); setTotal(0); setFunnel({}); setBoard({}) }
        })
        .finally(() => { if (alive) setLoading(false) })
    }, q ? 350 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [specId, status, q, offset])

  /** Меняем фильтр и адрес вместе — чтобы ссылку можно было отдать. */
  /** Фильтр и вид живут в адресе — чтобы ссылку можно было отдать. */
  function syncUrl(nextSpec: number | null, nextView: 'board' | 'list') {
    const s = new URLSearchParams()
    if (nextSpec) s.set('spec', String(nextSpec))
    if (nextView === 'list') s.set('view', 'list')
    const qs = s.toString()
    router.replace(`/admin/tech/crm${qs ? `?${qs}` : ''}`)
  }

  function pickSpec(v: number | null) { setSpecId(v); syncUrl(v, view) }
  function pickView(v: 'board' | 'list') { setView(v); syncUrl(specId, v) }

  const current = specs.find((s: any) => s.id === specId)

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">CRM клиентов</h1>
      <p className="mt-1 text-sm text-gray-500">
        {current
          ? <>Клиенты внедренца <b>{current.name || current.email}</b> — закреплённые и приведённые им лично.</>
          : 'Все клиенты платформы. Выберите внедренца, чтобы увидеть только его.'}
      </p>

      {/* Сводка по воронке — из чего складывается выбранный срез. */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {[
          ['Всего', funnel.total], ['Платят', funnel.paying],
          ['Триал', funnel.trial], ['Активированы', funnel.activated],
          ['Удержаны', funnel.retained], ['Оживлены', funnel.revived],
          ['Отвалились', funnel.churned],
        ].map(([label, v]: any) => (
          <div key={label} className="rounded-xl bg-white p-3 shadow-sm">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="text-xl font-bold text-gray-900">{v ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl bg-white shadow-sm">
        <div className="border-b border-gray-100 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select value={specId ?? ''}
                    onChange={e => pickSpec(e.target.value ? Number(e.target.value) : null)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">Все внедренцы</option>
              {specs.map((s: any) => (
                <option key={s.id} value={s.id}>{s.name || s.email}</option>
              ))}
            </select>

            {/* ⚠️ Фильтр по статусу только в СПИСКЕ: в блоках этапы и так
                разложены по колонкам, и фильтр оставил бы одну из них. */}
            {view === 'list' && (
              <select value={status} onChange={e => setStatus(e.target.value)}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
                {STATUSES.map(s => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            )}

            {/* Вид показа: блоками — видно перекос воронки, списком — удобнее
                искать конкретного человека. */}
            <div className="flex overflow-hidden rounded-lg border border-gray-300">
              {([['board', 'Блоками'], ['list', 'Списком']] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => pickView(id)}
                        className={`px-3 py-1.5 text-sm ${
                          view === id ? 'bg-[#25455D] text-white'
                                      : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
                  {label}
                </button>
              ))}
            </div>

            <div className="relative min-w-[240px] flex-1">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={q} onChange={e => setQ(e.target.value)}
                     placeholder="Поиск: имя, фамилия, почта, телеграм"
                     className="w-full rounded-lg border border-gray-300 py-1.5 pl-9 pr-3 text-sm" />
            </div>
          </div>

          <div className="mt-2 text-sm font-semibold text-gray-800">
            {loading ? 'Загружаем…'
              : view === 'board' ? `Всего — ${total}`
              : total > items.length
                ? `Найдено — ${total}, показаны ${offset + 1}–${Math.min(offset + PAGE, total)}`
                : `Показано — ${items.length}`}
          </div>
        </div>

        {view === 'board' ? (
          /* ⚠️ Колонки — ЭТАПЫ ПУТИ, порядок не произвольный: триал →
             активирован → удержан → оживлён → отвалился. Лиды в конце: это
             те, кто ещё ничего не сделал. */
          <div className="flex gap-3 overflow-x-auto p-4">
            {STATUSES.filter(s => s.id).map(s => {
              const people = board[s.id] || []
              const cnt = funnel[s.id] ?? people.length
              const st = CRM_LABEL[s.id]
              return (
                <div key={s.id} className="w-64 shrink-0 rounded-xl border border-gray-200">
                  <div className="rounded-t-xl px-3 py-2"
                       style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                    <div className="text-sm font-semibold text-white">{st.label}</div>
                    <div className="text-lg font-bold" style={{ color: '#FFCFA4' }}>
                      {cnt}
                      {funnel.total > 0 && (
                        <span className="ml-1 text-xs font-normal text-white/60">
                          {Math.round(cnt * 100 / funnel.total)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="max-h-[460px] space-y-1 overflow-y-auto p-2">
                    {!people.length && (
                      <div className="px-1 py-2 text-xs text-gray-400">Пусто</div>
                    )}
                    {people.map((c: any) => (
                      <div key={c.id} className="rounded-lg border border-gray-100 p-2">
                        <div className="truncate text-sm font-medium text-gray-900">
                          {[c.name, c.last_name].filter(Boolean).join(' ') || 'Без имени'}
                        </div>
                        <div className="truncate text-[11px] text-gray-400">{c.email}</div>
                        <div className="mt-0.5 truncate text-[11px] text-gray-500">
                          {c.tariff_name || 'без тарифа'}
                          {c.payments_count > 0 && ` · оплат: ${c.payments_count}`}
                        </div>
                        {c.owner_name && (
                          <div className="truncate text-[11px] text-gray-500">
                            ведёт: {c.owner_name}
                          </div>
                        )}
                      </div>
                    ))}
                    {/* Честно говорим, что список блока обрезан: счётчик
                        сверху полный, а карточек показано меньше. */}
                    {cnt > people.length && (
                      <div className="px-1 py-2 text-[11px] text-gray-400">
                        …и ещё {cnt - people.length}. Откройте «Списком», чтобы найти нужного.
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : !items.length && !loading ? (
          <div className="p-8 text-center text-sm text-gray-500">
            {q || status || specId ? 'Никого не нашли — смягчите фильтры.' : 'Клиентов пока нет.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                  <th className="px-4 py-2 font-medium">Клиент</th>
                  <th className="px-4 py-2 font-medium">Статус</th>
                  <th className="px-4 py-2 font-medium">Тариф</th>
                  <th className="px-4 py-2 font-medium">Оплат</th>
                  <th className="px-4 py-2 font-medium">Заплатил</th>
                  <th className="px-4 py-2 font-medium">Ведёт</th>
                  <th className="px-4 py-2 font-medium">Привёл</th>
                </tr>
              </thead>
              <tbody>
                {items.map(c => {
                  const st = CRM_LABEL[c.crm_status] || CRM_LABEL.lead
                  return (
                    <tr key={c.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-4 py-3">
                        {/* ⚠️ Имя И фамилия: у клиента они лежат раздельно. */}
                        <div className="font-medium text-gray-900">
                          {[c.name, c.last_name].filter(Boolean).join(' ') || 'Без имени'}
                        </div>
                        <div className="text-xs text-gray-400">{c.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {c.tariff_name || '—'}
                        {c.expires_at && (
                          <div className="text-xs text-gray-400">до {dt(c.expires_at)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{c.payments_count}</td>
                      <td className="px-4 py-3 text-gray-600">{rub(c.total_paid_kopecks)}</td>
                      {/* ⚠️ «Ведёт» и «Привёл» — РАЗНЫЕ люди и разные деньги:
                          первому идёт фикс за обслуживание, второму 10 %. */}
                      <td className="px-4 py-3 text-gray-600">
                        {c.owner_name || <span className="text-gray-300">ничей</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {c.referrer_name || <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Страницы — только в списке: в блоках прокрутка внутри колонок. */}
        {view === 'list' && total > PAGE && (
          <div className="flex items-center justify-between gap-3 border-t border-gray-100 p-4">
            <button type="button" disabled={offset === 0 || loading}
                    onClick={() => setOffset(Math.max(0, offset - PAGE))}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              ← Назад
            </button>
            <span className="text-sm text-gray-500">
              {offset + 1}–{Math.min(offset + PAGE, total)} из {total}
            </span>
            <button type="button" disabled={offset + PAGE >= total || loading}
                    onClick={() => setOffset(offset + PAGE)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              Вперёд →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
