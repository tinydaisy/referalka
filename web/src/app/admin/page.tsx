'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Users, Calendar, TrendingUp, Zap, CreditCard, ArrowRight } from 'lucide-react'
import { api } from '@/lib/api'

const STATUS: Record<string, { label: string; cls: string }> = {
  created:   { label: 'Создан, ждём оплату', cls: 'bg-amber-100 text-amber-800' },
  paid:      { label: 'Оплачен',              cls: 'bg-green-100 text-green-800' },
  failed:    { label: 'Ошибка оплаты',         cls: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Отменён',               cls: 'bg-gray-100 text-gray-600' },
}

export default function AdminOverviewPage() {
  const [stats, setStats] = useState<any>(null)
  const [orders, setOrders] = useState<any[]>([])
  const [summary, setSummary] = useState<any>({})

  useEffect(() => {
    api.admin.stats().then(setStats).catch(() => {})
    api.adminOrders.list({ limit: 10 }).then((r: any) => {
      setOrders(r.orders || [])
      setSummary(r.summary || {})
    }).catch(() => {})
  }, [])

  const cards = [
    { label: 'Клиентов', value: stats?.clients_total || 0, icon: Users, color: 'text-blue-500' },
    { label: 'Событий активных', value: stats?.events_active || 0, icon: Calendar, color: 'text-green-500' },
    { label: 'Участников всего', value: stats?.participants_total || 0, icon: TrendingUp, color: 'text-purple-500' },
    { label: 'Конверсий', value: stats?.conversions_total || 0, icon: Zap, color: 'text-amber-500' },
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Обзор платформы</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-500">{label}</span>
              <Icon size={20} className={color} />
            </div>
            <p className="text-3xl font-bold text-gray-900">{value}</p>
          </div>
        ))}
      </div>

      {/* Сводка по оплатам подписок */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800 flex items-center gap-2">
            <CreditCard size={18} /> Оплаты подписок
          </h3>
          <Link href="/admin/orders" className="text-xs text-[#25455D] font-medium hover:underline flex items-center gap-1">
            Все оплаты <ArrowRight size={12} />
          </Link>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-500">Оплачено</div>
            <div className="text-xl font-bold text-gray-900">{summary.paid_count || 0}</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-500">Получено картой</div>
            <div className="text-xl font-bold text-emerald-700">
              {((summary.total_card_paid || 0) / 100).toLocaleString('ru-RU')} ₽
            </div>
          </div>
          <div className="bg-gray-50 rounded-xl p-3">
            <div className="text-xs text-gray-500">Бонусами</div>
            <div className="text-xl font-bold text-amber-700">
              {((summary.total_bonus_paid || 0) / 100).toLocaleString('ru-RU')} ₽
            </div>
          </div>
          <div className="bg-amber-50 rounded-xl p-3">
            <div className="text-xs text-amber-700">Ждут оплаты</div>
            <div className="text-xl font-bold text-amber-900">{summary.pending_count || 0}</div>
          </div>
        </div>

        {orders.length === 0 ? (
          <p className="text-sm text-gray-400">Ни одного заказа ещё нет.</p>
        ) : (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase">
                  <th className="px-2 py-2 font-medium">Дата</th>
                  <th className="px-2 py-2 font-medium">Клиент</th>
                  <th className="px-2 py-2 font-medium">Тариф / модуль</th>
                  <th className="px-2 py-2 font-medium text-right">Сумма</th>
                  <th className="px-2 py-2 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o: any) => {
                  const st = STATUS[o.status] || { label: o.status, cls: 'bg-gray-100 text-gray-600' }
                  const date = o.paid_at || o.created_at
                  return (
                    <tr key={`${o.kind || 'sub'}-${o.id}`} className="border-t border-gray-50">
                      <td className="px-2 py-2 text-gray-600 whitespace-nowrap">
                        {new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}{' '}
                        <span className="text-gray-400">
                          {new Date(date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <div className="font-medium text-gray-900">{o.client_name}</div>
                        <div className="text-xs text-gray-500">{o.client_email}</div>
                      </td>
                      <td className="px-2 py-2 text-gray-700">
                        {o.item_name || o.tariff_name}
                        {o.kind === 'addon' && (
                          <span className="ml-1 text-[9px] font-semibold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700">
                            МОДУЛЬ
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-gray-900 whitespace-nowrap">
                        {((o.amount_total_kopecks || 0) / 100).toLocaleString('ru-RU')} ₽
                      </td>
                      <td className="px-2 py-2">
                        <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded ${st.cls} whitespace-nowrap`}>
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
