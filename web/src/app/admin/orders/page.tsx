'use client'
import { useEffect, useState } from 'react'
import { CreditCard, Search, Wallet, TrendingUp } from 'lucide-react'
import { api } from '@/lib/api'

const STATUS: Record<string, { label: string; cls: string }> = {
  created:   { label: 'Создан, ждём оплату', cls: 'bg-amber-100 text-amber-800' },
  paid:      { label: 'Оплачен',              cls: 'bg-green-100 text-green-800' },
  failed:    { label: 'Ошибка оплаты',         cls: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Отменён',               cls: 'bg-gray-100 text-gray-600' },
}

// Все ники клиента (TG/VK/MAX) — резолвятся на бэке через email клиента.
const PLATFORM_LABELS: Record<string, string> = { telegram: 'TG', vk: 'VK', max: 'MAX' }
const PLATFORM_COLORS: Record<string, string> = { telegram: '#0088CC', vk: '#0077FF', max: '#5B2FC0' }

function ClientIdentities({ order }: { order: any }) {
  const ids: { platform: string; username?: string | null; platform_user_id?: string }[] = order.identities || []
  // Фолбэк на старое поле, если по email ничего не нашлось
  if (ids.length === 0) {
    if (order.telegram_username) {
      return <div className="text-xs text-gray-400">@{order.telegram_username}</div>
    }
    return null
  }
  return (
    <div className="flex flex-wrap gap-1 mt-0.5">
      {ids.map((it, i) => {
        const label = PLATFORM_LABELS[it.platform] || it.platform.toUpperCase()
        const shown = it.username ? `@${it.username}` : `id${it.platform_user_id}`
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-gray-50 border border-gray-100"
            title={`${label}: ${shown}`}
          >
            <span className="font-semibold" style={{ color: PLATFORM_COLORS[it.platform] || '#6B7280' }}>{label}</span>
            <span className="text-gray-500">{shown}</span>
          </span>
        )
      })}
    </div>
  )
}

export default function AdminOrdersPage() {
  const [list, setList] = useState<any[]>([])
  const [summary, setSummary] = useState<any>({})
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'paid' | 'created' | 'failed' | 'cancelled' | 'all'>('all')
  const [search, setSearch] = useState('')

  function load() {
    setLoading(true)
    api.adminOrders.list({
      status: filter === 'all' ? undefined : filter,
      search: search.trim() || undefined,
      limit: 200,
    })
      .then((r: any) => {
        setList(r.orders || [])
        setSummary(r.summary || {})
        setTotal(r.total || 0)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter])

  function fmtMoney(kopecks: number) {
    return (kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <CreditCard size={22} /> Оплаты подписок
        </h1>
      </div>

      {/* Сводка */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-2xl border card-border p-4">
          <div className="text-xs text-gray-500">Оплачено заказов</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{summary.paid_count || 0}</div>
        </div>
        <div className="bg-white rounded-2xl border card-border p-4">
          <div className="text-xs text-gray-500">Получено картой</div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">
            {fmtMoney(summary.total_card_paid || 0)} ₽
          </div>
        </div>
        <div className="bg-white rounded-2xl border card-border p-4">
          <div className="text-xs text-gray-500">Списано бонусами</div>
          <div className="text-2xl font-bold text-amber-700 mt-1">
            {fmtMoney(summary.total_bonus_paid || 0)} ₽
          </div>
        </div>
        <div className="bg-white rounded-2xl border card-border p-4">
          <div className="text-xs text-gray-500">Заказов в ожидании</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{summary.pending_count || 0}</div>
        </div>
      </div>

      {/* Фильтры */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="flex gap-1">
          {(['paid', 'created', 'failed', 'cancelled', 'all'] as const).map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filter === s ? 'bg-[#25455D] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s === 'all' ? 'Все' : STATUS[s].label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs ml-auto">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Поиск по имени или email"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()}
            onBlur={load}
            className="w-full pl-9 pr-3 py-1.5 border border-gray-200 rounded-lg text-sm"
          />
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-2">Найдено: {total}</div>

      {loading ? (
        <div className="text-gray-500">Загрузка…</div>
      ) : list.length === 0 ? (
        <div className="bg-white rounded-2xl border card-border p-12 text-center">
          <CreditCard size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">Заказов нет</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border card-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3 font-semibold">#</th>
                  <th className="px-4 py-3 font-semibold">Дата</th>
                  <th className="px-4 py-3 font-semibold">Клиент</th>
                  <th className="px-4 py-3 font-semibold">Тариф / модуль</th>
                  <th className="px-4 py-3 font-semibold text-right">Сумма</th>
                  <th className="px-4 py-3 font-semibold">Статус</th>
                  <th className="px-4 py-3 font-semibold">Привёл</th>
                  <th className="px-4 py-3 font-semibold">Prodamus</th>
                </tr>
              </thead>
              <tbody>
                {list.map(o => {
                  const st = STATUS[o.status] || { label: o.status, cls: 'bg-gray-100 text-gray-600' }
                  const date = o.paid_at || o.created_at
                  const cardRub = (o.amount_paid_card_kopecks || 0) / 100
                  const bonusRub = (o.amount_paid_bonus_kopecks || 0) / 100
                  const totalRub = (o.amount_total_kopecks || 0) / 100
                  return (
                    <tr key={`${o.kind || 'sub'}-${o.id}`} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-3 text-gray-500">#{o.id}</td>
                      <td className="px-4 py-3">
                        <div className="text-gray-800">
                          {new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </div>
                        <div className="text-xs text-gray-400">
                          {new Date(date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{o.client_name}</div>
                        <div className="text-xs text-gray-500">{o.client_email}</div>
                        <ClientIdentities order={o} />
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        <div className="flex items-center gap-1.5">
                          <span>{o.item_name || o.tariff_name}</span>
                          {o.kind === 'addon' && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">
                              МОДУЛЬ
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="font-semibold text-gray-900">
                          {totalRub.toLocaleString('ru-RU')} ₽
                        </div>
                        {bonusRub > 0 && (
                          <div className="text-xs text-amber-700">
                            бонусами: {bonusRub.toLocaleString('ru-RU')} ₽
                          </div>
                        )}
                        {cardRub > 0 && bonusRub > 0 && (
                          <div className="text-xs text-emerald-700">
                            картой: {cardRub.toLocaleString('ru-RU')} ₽
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded ${st.cls}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {o.referrer_name ? (
                          <span className="text-xs text-gray-700">{o.referrer_name}</span>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {o.prodamus_order_num && (
                          <div>#{o.prodamus_order_num}</div>
                        )}
                        {o.prodamus_payment_type && (
                          <div className="text-gray-400">{o.prodamus_payment_type}</div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
