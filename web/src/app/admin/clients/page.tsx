'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Search, Users, BellOff, Calendar, Crown, UserCheck } from 'lucide-react'
import { api } from '@/lib/api'

interface Client {
  id: number
  name: string
  email: string
  phone: string | null
  telegram_username: string | null
  tariff_slug: string
  tariff_name: string | null
  features: string[] | null
  subscription_expires_at: string | null
  subscription_status: string | null
  trial_ends_at: string | null
  is_active: boolean
  created_at: string
  events_count: number
  contacts_count: number
  own_channels_count: number
  subscribers_count: number
  unsubscribed_count: number
  collaborators_count: number
}

export default function AdminClientsPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const q = search ? `search=${encodeURIComponent(search)}` : ''
    api.admin.clients(q).then((r: any) => { setClients(r.clients || []); setTotal(r.total || 0) }).catch(() => {})
  }, [search])

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Клиенты</h1>
          <p className="text-gray-500 mt-1">Всего: {total}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 p-5 border-b border-gray-100">
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text" placeholder="Поиск по имени или email"
              value={search} onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand/30"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                {['Клиент', 'Тариф', 'Событий', 'Контактов', 'Подписчиков', 'Своих ботов', 'Коллаб.', 'Зарег.'].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {clients.length > 0 ? clients.map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-3 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0">
                        {c.name[0]}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 text-sm truncate">{c.name}</span>
                          {!c.is_active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">не активен</span>}
                        </div>
                        <div className="text-xs text-gray-400 truncate">{c.email}</div>
                        {(c.phone || c.telegram_username) && (
                          <div className="text-xs text-gray-400 truncate">
                            {c.phone && <span>{c.phone}</span>}
                            {c.phone && c.telegram_username && <span> · </span>}
                            {c.telegram_username && <span>@{c.telegram_username}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-4">
                    <div className="flex items-center gap-1.5">
                      {(c.features || []).includes('channels') && <Crown size={12} className="text-amber-500" />}
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                        c.tariff_slug === 'vip' ? 'bg-amber-50 text-amber-700'
                        : c.tariff_slug === 'pro' ? 'bg-blue-50 text-blue-700'
                        : c.tariff_slug === 'start' ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-gray-100 text-gray-600'
                      }`}>
                        {c.tariff_name || c.tariff_slug}
                      </span>
                    </div>
                    {c.subscription_expires_at ? (
                      <div className={`text-[10px] mt-1 ${c.subscription_status === 'expired' ? 'text-red-500' : 'text-gray-400'}`}>
                        {c.subscription_status === 'expired' ? 'истекла ' : 'до '}
                        {new Date(c.subscription_expires_at).toLocaleDateString('ru')}
                      </div>
                    ) : c.trial_ends_at && (
                      <div className="text-[10px] text-gray-400 mt-1">
                        пробный до {new Date(c.trial_ends_at).toLocaleDateString('ru')}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center">{c.events_count}</td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center">{c.contacts_count}</td>
                  <td className="px-3 py-4 text-sm">
                    <div className="flex items-center gap-1 text-green-600 justify-center" title="Подписаны">
                      <Users size={12} /><span>{c.subscribers_count}</span>
                    </div>
                    {c.unsubscribed_count > 0 && (
                      <div className="flex items-center gap-1 text-red-400 text-xs justify-center mt-0.5" title="Отписались">
                        <BellOff size={10} /><span>{c.unsubscribed_count}</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center" title="Свои не-системные каналы">
                    {c.own_channels_count}
                  </td>
                  <td className="px-3 py-4 text-sm text-gray-700 text-center">{c.collaborators_count}</td>
                  <td className="px-3 py-4 text-xs text-gray-400 whitespace-nowrap">
                    <Calendar size={11} className="inline mr-1" />
                    {new Date(c.created_at).toLocaleDateString('ru')}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-sm text-gray-400">
                    {search ? 'Ничего не найдено' : 'Клиентов пока нет'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-gray-400 mt-4">
        💡 Колонки «дата продления», «выручка» и история тарифов появятся когда подключим тарифную архитектуру (отдельная задача).
      </p>
    </div>
  )
}
