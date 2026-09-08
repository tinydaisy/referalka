'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import { BarChart3, TrendingUp, Users, LayoutGrid } from 'lucide-react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { useUrlTab } from '@/hooks/useUrlTab'
import { useMe } from '@/hooks/useMe'
import DashboardView from '@/components/analytics/DashboardView'

const DARK = '#25455D'
const PEACH = '#FFCFA4'

// Метки, по которым можно группировать воронку.
const GROUP_OPTIONS: { key: string; label: string }[] = [
  { key: 'utm_source', label: 'Источник (utm_source)' },
  { key: 'utm_medium', label: 'Канал (utm_medium)' },
  { key: 'utm_campaign', label: 'Кампания (utm_campaign)' },
  { key: 'utm_content', label: 'Объявление (utm_content)' },
  { key: 'utm_term', label: 'Ключ (utm_term)' },
]

interface FunnelRow {
  source: string
  started: number      // зашло в бот
  delivered: number    // получили файл
  conversion: number   // %
}
interface ContactSource {
  source: string
  count: number
  share: number
}
interface UtmResponse {
  group_by: string
  funnel: FunnelRow[]
  totals: { started: number; delivered: number; conversion: number }
  contacts_by_source: ContactSource[]
  contacts_total: number
  lead_magnets: { id: number; name: string }[]
  packages: { id: number; name: string }[]
}

type SubTab = 'dashboard' | 'media' | 'utm'
// ⚠️ Держать в синхроне с типом: по списку useUrlTab отсеивает мусор в ?sub=
const SUB_TABS: readonly SubTab[] = ['dashboard', 'media', 'utm']

function AnalyticsPageInner() {
  const { me } = useMe()
  const [data, setData] = useState<UtmResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // ⚠️ Вкладка живёт в адресе через общий useUrlTab: с обычным useState
  // обновление страницы (F5) сбрасывало выбор на «Дашборд».
  const [sub, setSub] = useUrlTab<SubTab>('sub', 'dashboard', SUB_TABS)

  const [groupBy, setGroupBy] = useState('utm_source')
  // Фильтр по источнику: '' = все, 'm:<id>' = лид-магнит, 'p:<id>' = пакет.
  const [scope, setScope] = useState('')

  // Дашборды — Экстра и админ. Сводка по UTM остаётся доступна всем.
  const hasDashboards = (me?.features || []).includes('analytics_dashboard')

  const load = useCallback(async () => {
    // Пока открыт дашборд, сводку по UTM не тянем — лишний запрос.
    if (sub !== 'utm') return
    setLoading(true)
    setErr(null)
    try {
      const params: any = { group_by: groupBy }
      if (scope.startsWith('m:')) params.lead_magnet_id = Number(scope.slice(2))
      if (scope.startsWith('p:')) params.package_id = Number(scope.slice(2))
      const res = await api.analytics.utm(params)
      setData(res)
    } catch (e: any) {
      setErr(e?.message || 'Не удалось загрузить аналитику')
    } finally {
      setLoading(false)
    }
  }, [groupBy, scope, sub])

  useEffect(() => { load() }, [load])

  const funnel = data?.funnel || []
  const maxStarted = Math.max(1, ...funnel.map(r => r.started))
  const contacts = data?.contacts_by_source || []
  const maxShare = Math.max(1, ...contacts.map(c => c.share))

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-2.5 mb-1">
        <BarChart3 size={26} style={{ color: DARK }} />
        <h1 className="text-2xl font-bold text-gray-900">Аналитика</h1>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        {sub === 'dashboard'
          ? 'Свои срезы базы: разрез по полю контакта или вопросу анкеты, с пересечением условий.'
          : 'Откуда приходят люди и какой источник даёт лучшую конверсию. Данные — из воронок лид-магнитов и базы контактов.'}
      </p>

      {/* ── Подвкладки ── */}
      <div className="mb-5 flex gap-2 border-b border-gray-200">
        <button
          onClick={() => setSub('dashboard')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm ${
            sub === 'dashboard'
              ? 'border-b-2 font-semibold text-[#25455D]'
              : 'text-gray-500 hover:text-gray-700'
          }`}
          style={sub === 'dashboard' ? { borderColor: DARK } : undefined}
        >
          <LayoutGrid size={15} /> Дашборд
        </button>
        {/* ⚠️ Медийные активы — ОТДЕЛЬНЫЙ раздел, БЕЗ гейта по тарифу.
            Дашборд доступен только на Экстра, а эти цифры система считает
            сама и они нужны каждому: понять свой охват и где он сосредоточен. */}
        <button
          onClick={() => setSub('media')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm ${
            sub === 'media'
              ? 'border-b-2 font-semibold text-[#25455D]'
              : 'text-gray-500 hover:text-gray-700'
          }`}
          style={sub === 'media' ? { borderColor: DARK } : undefined}
        >
          <Users size={15} /> Медийные активы
        </button>
        <button
          onClick={() => setSub('utm')}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm ${
            sub === 'utm'
              ? 'border-b-2 font-semibold text-[#25455D]'
              : 'text-gray-500 hover:text-gray-700'
          }`}
          style={sub === 'utm' ? { borderColor: DARK } : undefined}
        >
          <TrendingUp size={15} /> Источники (UTM)
        </button>
      </div>

      {sub === 'media' && <PlatformsBlock />}

      {sub === 'dashboard' && (
        hasDashboards ? (
          <DashboardView />
        ) : (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center">
            <div className="mb-2 text-lg font-semibold text-[#25455D]">
              Дашборды — на тарифе Экстра
            </div>
            <p className="mx-auto mb-4 max-w-md text-sm text-gray-500">
              Соберите свои срезы базы: сколько людей с каким доходом, кто готов
              работать с наставником, и как одно пересекается с другим.
            </p>
            <Link href="/dashboard/subscription" className="btn-gold inline-block px-4 py-2">
              Посмотреть тариф
            </Link>
          </div>
        )
      )}

      {sub === 'utm' && (
      <>
      {/* ── Фильтры ── */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Группировать по</label>
          <select
            value={groupBy}
            onChange={e => setGroupBy(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"
          >
            {GROUP_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Лид-магнит / пакет</label>
          <select
            value={scope}
            onChange={e => setScope(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 max-w-[280px]"
          >
            <option value="">Все лид-магниты</option>
            {(data?.lead_magnets || []).length > 0 && (
              <optgroup label="Лид-магниты">
                {data!.lead_magnets.map(m => <option key={`m${m.id}`} value={`m:${m.id}`}>{m.name}</option>)}
              </optgroup>
            )}
            {(data?.packages || []).length > 0 && (
              <optgroup label="Пакеты">
                {data!.packages.map(p => <option key={`p${p.id}`} value={`p:${p.id}`}>{p.name}</option>)}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      {err && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{err}</div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm py-10 text-center">Загрузка…</div>
      ) : (
        <>
          {/* ── Сводка воронки ── */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            <StatTile label="Зашло в бот" value={data?.totals.started ?? 0} />
            <StatTile label="Получили файл" value={data?.totals.delivered ?? 0} />
            <StatTile label="Конверсия" value={`${data?.totals.conversion ?? 0}%`} accent />
          </div>

          {/* ── Таблица по источникам (воронка лид-магнитов) ── */}
          <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden mb-8">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <TrendingUp size={18} style={{ color: DARK }} />
              <h2 className="font-semibold text-gray-900 text-sm">Воронка по источникам</h2>
            </div>
            {funnel.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                Пока нет заходов по лид-магнитам с UTM-метками. Раздайте ссылки с параметрами
                <code className="mx-1 px-1 bg-gray-100 rounded">?utm_source=...</code> — данные появятся здесь.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="px-4 py-2 font-medium">Источник</th>
                      <th className="px-4 py-2 font-medium">Зашло в бот</th>
                      <th className="px-4 py-2 font-medium">Получили</th>
                      <th className="px-4 py-2 font-medium">Конверсия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.map((r, i) => (
                      <tr key={i} className="border-b border-gray-50 last:border-0">
                        <td className="px-4 py-2.5 text-gray-800">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate max-w-[160px]" title={r.source}>{r.source}</span>
                          </div>
                          <div className="h-1.5 rounded-full mt-1 bg-gray-100 overflow-hidden max-w-[220px]">
                            <div className="h-full rounded-full" style={{ width: `${Math.round(r.started / maxStarted * 100)}%`, background: DARK }} />
                          </div>
                        </td>
                        <td className="px-4 py-2.5 font-medium text-gray-900">{r.started}</td>
                        <td className="px-4 py-2.5 text-gray-700">{r.delivered}</td>
                        <td className="px-4 py-2.5">
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold"
                            style={{ background: r.conversion >= 30 ? '#dcfce7' : r.conversion > 0 ? '#fef9c3' : '#f3f4f6', color: r.conversion >= 30 ? '#166534' : r.conversion > 0 ? '#854d0e' : '#6b7280' }}>
                            {r.conversion}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── База контактов по utm_source ── */}
          <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <Users size={18} style={{ color: DARK }} />
              <h2 className="font-semibold text-gray-900 text-sm">Вся база контактов по источникам</h2>
              <span className="ml-auto text-xs text-gray-400">всего {data?.contacts_total ?? 0}</span>
            </div>
            {contacts.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">Нет контактов.</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {contacts.map((c, i) => (
                  <div key={i} className="px-4 py-2.5 flex items-center gap-3">
                    <span className="text-sm text-gray-800 truncate max-w-[180px]" title={c.source}>{c.source}</span>
                    <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.round(c.share / maxShare * 100)}%`, background: PEACH }} />
                    </div>
                    <span className="text-sm font-medium text-gray-900 w-12 text-right">{c.count}</span>
                    <span className="text-xs text-gray-400 w-10 text-right">{c.share}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      </>
      )}
    </div>
  )
}

// ⚠️⚠️ Обёртка ОБЯЗАТЕЛЬНА: useUrlTab внутри зовёт useSearchParams, а у
// страницы нет динамического сегмента — Next пререндерит такие на сборке и
// падает целиком «useSearchParams() should be wrapped in a suspense boundary».
// ⚠️ tsc эту ошибку НЕ видит — проверять только сборкой.
export default function AnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsPageInner />
    </Suspense>
  )
}


function StatTile({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className="rounded-2xl px-4 py-4 border" style={accent
      ? { background: `linear-gradient(45deg, ${DARK}, #0a1520)`, borderColor: 'transparent' }
      : { background: '#fff', borderColor: '#e5e7eb' }}>
      <div className={`text-2xl font-bold ${accent ? '' : 'text-gray-900'}`} style={accent ? { color: PEACH } : {}}>{value}</div>
      <div className={`text-xs mt-0.5 ${accent ? 'text-white/70' : 'text-gray-500'}`}>{label}</div>
    </div>
  )
}


/**
 * Медийные активы: сколько людей на каждой площадке и сколько из них подписано.
 *
 * ⚠️ Одно общее число контактов ничего не говорит: за ним и почта, и три бота,
 * причём один человек часто есть сразу в нескольких — поэтому сумма по
 * площадкам БОЛЬШЕ числа людей, и это не ошибка (внизу поясняем прямо).
 * Ценность блока в разрыве «всего → подписано»: он показывает, где база живая,
 * а где половина отписалась.
 */
/**
 * Раздел «Медийные активы»: весь охват по площадкам.
 *
 * ⚠️ Считается по РЕАЛЬНОЙ базе (platform_users), а не по заявленным цифрам:
 * подписчики ботов и почты, за вычетом отписавшихся. Партнёр видит правду,
 * а не обещание.
 *
 * Два вида на выбор: полосы (видно, где сосредоточен охват) и список (точные
 * числа рядом). Разным людям удобнее разное, а данные одни и те же.
 */
function PlatformsBlock() {
  const [data, setData] = useState<any>(null)
  const [view, setView] = useState<'chart' | 'list'>('chart')
  useEffect(() => { api.analytics.platforms().then(setData).catch(() => {}) }, [])

  const rows: any[] = data?.platforms || []
  const groups: any[] = data?.groups || []
  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
        Пока нет данных: подключите бота или почту в разделе «Каналы».
      </div>
    )
  }

  const total = rows.reduce((s, p) => s + p.subscribed, 0) || 1
  const pct = (n: number) => Math.round(n * 100 / total)
  const COLORS = ['#25455D', '#3E6C8F', '#FFCFA4', '#C77B3B', '#8FAFC4', '#B9CEDD']

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold" style={{ color: DARK }}>Медийные активы</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Подписчики ваших ботов и почты в ПЛЮСОНе, без отписавшихся.
          </p>
        </div>
        <div className="flex rounded-lg border border-gray-200 p-0.5 text-xs">
          {([['chart', 'График'], ['list', 'Список']] as const).map(([k, t]) => (
            <button key={k} onClick={() => setView(k)}
              className={`px-3 py-1.5 rounded-md ${view === k ? 'text-white' : 'text-gray-500'}`}
              style={view === k ? { background: DARK } : undefined}>{t}</button>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-xl bg-gray-50 p-3">
        <span className="text-xs text-gray-500">Всего подписчиков</span>
        <div className="text-2xl font-bold" style={{ color: DARK }}>
          {total.toLocaleString('ru')}
        </div>
        <p className="mt-0.5 text-xs text-gray-400">
          Людей в базе: {(data?.unique_total || 0).toLocaleString('ru')} — один человек может быть
          сразу в нескольких площадках, но считается один раз.
        </p>
      </div>

      {view === 'chart' ? (
        <>
          {/* ⚠️ Полоса и легенда — ПО ПЛОЩАДКАМ (Telegram = бот + канал):
              «сколько у меня в телеграме» это один вопрос, а раздельные строки
              заставляли складывать в уме. Детализация — ниже, отдельным
              блоком. */}
          <div className="mb-3 flex h-4 overflow-hidden rounded-full">
            {groups.map((g, i) => (
              <div key={g.title} style={{ width: `${pct(g.subscribed)}%`, background: COLORS[i % COLORS.length] }}
                   title={`${g.title}: ${g.subscribed.toLocaleString('ru')}`} />
            ))}
          </div>
          <div className="space-y-2">
            {groups.map((g, i) => (
              <div key={g.title}>
                <div className="flex items-center gap-2 text-sm">
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: COLORS[i % COLORS.length] }} />
                  <span className="flex-1 font-medium text-gray-800">{g.title}</span>
                  <span className="font-semibold" style={{ color: DARK }}>{g.subscribed.toLocaleString('ru')}</span>
                  <span className="w-12 text-right text-gray-400">{pct(g.subscribed)}%</span>
                </div>
                {/* Из чего сложилось — чтобы цифра не была «чёрным ящиком». */}
                {g.parts?.length > 1 && (
                  <div className="ml-5 mt-0.5 space-y-0.5">
                    {g.parts.map((pt: any) => (
                      <div key={pt.title} className="flex items-center gap-2 text-xs text-gray-500">
                        <span className="flex-1">{pt.title}</span>
                        <span>{pt.subscribed.toLocaleString('ru')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="py-2 font-medium">Площадка</th>
                <th className="py-2 font-medium">Подписано</th>
                <th className="py-2 font-medium">Всего</th>
                <th className="py-2 font-medium">Отписались</th>
                <th className="py-2 font-medium">Доля</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.slug} className="border-b border-gray-50 last:border-0">
                  <td className="py-2 text-gray-700">{p.title}</td>
                  <td className="py-2 font-medium" style={{ color: DARK }}>{p.subscribed.toLocaleString('ru')}</td>
                  <td className="py-2 text-gray-500">{p.total.toLocaleString('ru')}</td>
                  <td className="py-2 text-gray-400">{p.unsubscribed.toLocaleString('ru')}</td>
                  <td className="py-2 text-gray-500">{pct(p.subscribed)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
