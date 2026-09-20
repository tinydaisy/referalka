'use client'

/**
 * Мои клиенты — главный экран внедренца.
 *
 * ⚠️ Фильтрует БЭКЕНД по `tech_specialist_id` из токена. Здесь фильтра «только
 * свои» нет и быть не должно: он обходится прямым запросом.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Search, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { useUrlTab } from '@/hooks/useUrlTab'

const rub = (kop?: number | null) =>
  `${Math.round((kop || 0) / 100).toLocaleString('ru-RU')} ₽`

const dt = (v?: string | null) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—'

// Разрезы. ⚠️ «Остывшие» показываем НАРАВНЕ с платящими, а не прячем: именно с
// ними и работают ради оживления, а спрятанные они выпадут из внимания.
const TABS: { id: string; label: string }[] = [
  { id: '', label: 'Все' },
  // ⚠️⚠️ CRM-ВОРОНКА — порядок НЕ произвольный, это путь клиента:
  // триал → активирован (первая оплата) → удержан (вторая) → оживлён.
  // Отвалившиеся в конце, но не спрятаны: с ними и работают ради оживления.
  { id: 'trial', label: 'Триал' },
  { id: 'activated', label: 'Активированные' },
  { id: 'retained', label: 'Удержанные' },
  { id: 'revived', label: 'Оживлённые' },
  { id: 'churned', label: 'Отвалившиеся' },
  // ⚠️ Разрезы по происхождению: «за кого мне идёт процент» и «кого просто
  // дали вести» — разные деньги, и смотрят их отдельно.
  { id: 'mine', label: 'Привёл лично' },
  { id: 'level2', label: '2-й уровень' },
  { id: 'assigned', label: 'Назначенные' },
]

const CRM_SERVER = ['trial', 'activated', 'retained', 'revived', 'churned',
                    'paying', 'cold']

const CRM_LABEL: Record<string, { label: string; cls: string }> = {
  trial: { label: 'Триал', cls: 'bg-gray-100 text-gray-600' },
  activated: { label: 'Активирован', cls: 'bg-blue-50 text-blue-700' },
  retained: { label: 'Удержан', cls: 'bg-green-50 text-green-700' },
  revived: { label: 'Оживлён', cls: 'bg-amber-50 text-amber-700' },
  churned: { label: 'Отвалился', cls: 'bg-red-50 text-red-700' },
  lead: { label: 'Лид', cls: 'bg-gray-100 text-gray-400' },
}

function SumCard({ label, value, accent }: {
  label: string; value: number; accent?: boolean
}) {
  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold"
           style={{ color: accent ? '#25455D' : '#111827' }}>
        {value ?? 0}
      </div>
    </div>
  )
}

export default function TechClientsPage() {
  const [items, setItems] = useState<any[]>([])
  // ⚠️ Вкладка в адресе, а не в useState: обновление страницы не должно
  // сбрасывать выбранный разрез на «Все» — правило проекта.
  const [status, setStatus] = useUrlTab<string>('status', '')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [funnel, setFunnel] = useState<any>(null)

  useEffect(() => {
    api.tech.funnel().then(setFunnel).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    const t = setTimeout(() => {
      // Разрезы по уровню считаются здесь же, серверу их слать незачем.
      const serverStatus = CRM_SERVER.includes(status) ? status : undefined
      api.tech.clients({ search: search || undefined, status: serverStatus })
        .then((r: any) => setItems(r.clients || []))
        .catch(() => {})
        .finally(() => setLoading(false))
    }, search ? 350 : 0)   // поиск не дёргает сервер на каждую букву
    return () => clearTimeout(t)
  }, [status, search])

  const paying = items.filter(i => i.is_paying).length
  // ⚠️ Фильтр по уровню — на фронте, а не запросом: список уже загружен целиком
  // и ограничен бэкендом «только мои», лишний поход на сервер тут ни к чему.
  const shown = status === 'mine' ? items.filter(i => i.referral_level === 1)
    : status === 'level2' ? items.filter(i => i.referral_level === 2)
    : status === 'assigned' ? items.filter(i => !i.referral_level)
    : items

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Мои клиенты</h1>
      <p className="mb-4 text-sm text-gray-500">
        Вся база: кто на каком шаге и откуда пришёл.
      </p>

      {/* Сводка по базе. ⚠️ Считает БЭКЕНД тем же выражением, что и статус в
          списке — иначе в сводке «удержанных 5», а в списке их четыре. */}
      {funnel && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <SumCard label="Всего в базе" value={funnel.summary.total} />
          <SumCard label="Свои" value={funnel.summary.own} accent />
          <SumCard label="Из базы ПЛЮСОНА" value={funnel.summary.from_pluson} />
          <SumCard label="Действующих" value={funnel.summary.active_now} />
          <SumCard label="Отвалившихся" value={funnel.summary.churned} />
        </div>
      )}

      {/* Движение по месяцам — из начислений: там записан ФАКТ события с
          датой. По текущему состоянию подписки «когда активировался» уже не
          восстановить. */}
      {funnel?.months?.length > 0 && (
        <div className="mb-5 overflow-x-auto rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-gray-700">По месяцам</div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="py-1.5 pr-4">Месяц</th>
                <th className="py-1.5 pr-4">Активаций</th>
                <th className="py-1.5 pr-4">Удержаний</th>
                <th className="py-1.5">Оживлений</th>
              </tr>
            </thead>
            <tbody>
              {funnel.months.map((m: any) => (
                <tr key={m.month} className="border-t border-gray-50">
                  <td className="py-1.5 pr-4 text-gray-600">{m.month}</td>
                  <td className="py-1.5 pr-4 font-medium">{m.activated}</td>
                  <td className="py-1.5 pr-4 font-medium">{m.retained}</td>
                  <td className="py-1.5 font-medium">{m.revived}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setStatus(t.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    status === t.id ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {t.label}
          </button>
        ))}
        <div className="relative ml-auto">
          <Search size={15} className="absolute left-3 top-2.5 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder="Имя, почта, ник"
                 className="rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm" />
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-400">Загружаем…</div>
      ) : !shown.length ? (
        <div className="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow-sm">
          Здесь пока никого. Клиентов закрепляет владелец платформы.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-3">Клиент</th>
                <th className="px-4 py-3">Статус</th>
                <th className="px-4 py-3">Тариф</th>
                <th className="px-4 py-3">Оплат</th>
                <th className="px-4 py-3">Последняя</th>
                <th className="px-4 py-3">Всего</th>
                <th className="px-4 py-3">Связь</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(c => (
                <tr key={c.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/tech/clients/${c.id}`}
                          className="font-medium text-gray-900 hover:underline">
                      {c.name || 'Без имени'}
                    </Link>
                    <div className="text-xs text-gray-400">{c.email}</div>
                    {/* ⚠️ Уровень видно сразу: за приведённого лично идёт
                        процент, за второй уровень — по своей ставке, а за
                        назначенного только фикс. Без пометки в списке эти
                        случаи неразличимы. */}
                    {c.referral_level === 1 && (
                      <span className="mt-0.5 inline-block rounded bg-[#FFCFA4] px-1.5 py-0.5 text-[10px] font-semibold text-[#0a1520]">
                        привёл лично
                      </span>
                    )}
                    {c.referral_level === 2 && (
                      <span className="mt-0.5 inline-block rounded bg-[#25455D] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        2-й уровень
                      </span>
                    )}
                    {!c.referral_level && (
                      <span className="mt-0.5 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                        назначен
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.crm_status && (
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                        (CRM_LABEL[c.crm_status] || CRM_LABEL.lead).cls}`}>
                        {(CRM_LABEL[c.crm_status] || CRM_LABEL.lead).label}
                      </span>
                    )}
                    <div className="mt-1 text-[11px] text-gray-400">
                      {c.is_own ? 'свой' : 'из базы ПЛЮСОНА'}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{c.tariff_name || '—'}</div>
                    <div className="text-xs text-gray-400">
                      {c.is_paying ? `платит до ${dt(c.expires_at)}`
                        : c.sub_source && c.sub_source !== 'paid' ? 'пробный'
                        : 'не платит'}
                    </div>
                  </td>
                  <td className="px-4 py-3">{c.payments_count || 0}</td>
                  <td className="px-4 py-3 text-gray-600">{dt(c.last_paid_at)}</td>
                  <td className="px-4 py-3">{rub(c.total_paid_kopecks)}</td>
                  <td className="px-4 py-3">
                    {/* Написать человеку напрямую: ради этого ник и телефон и
                        показываются — иначе связаться с клиентом нечем. */}
                    {c.telegram_username ? (
                      <a href={`https://telegram.me/${String(c.telegram_username).replace('@', '')}`}
                         target="_blank" rel="noreferrer"
                         className="inline-flex items-center gap-1 text-[#25455D] hover:underline">
                        Telegram <ExternalLink size={12} />
                      </a>
                    ) : c.phone ? (
                      <a href={`tel:${c.phone}`} className="text-[#25455D] hover:underline">
                        {c.phone}
                      </a>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
