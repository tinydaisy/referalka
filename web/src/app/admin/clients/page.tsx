'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Search, Filter } from 'lucide-react'
import { api } from '@/lib/api'

export default function AdminClientsPage() {
  const [clients, setClients] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const q = search ? `search=${encodeURIComponent(search)}` : ''
    api.admin.clients(q).then(r => { setClients(r.clients || []); setTotal(r.total || 0) }).catch(() => {})
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
                {['Клиент', 'Email', 'Телефон', 'Telegram', 'Тариф', 'Событий', 'Дата'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {clients.length > 0 ? clients.map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-sm font-bold shrink-0">
                        {c.name[0]}
                      </div>
                      <span className="font-medium text-gray-900 text-sm">{c.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm text-gray-600">{c.email}</td>
                  <td className="px-5 py-4 text-sm text-gray-600">{c.phone || '—'}</td>
                  <td className="px-5 py-4 text-sm text-gray-600">{c.telegram_username ? `@${c.telegram_username}` : '—'}</td>
                  <td className="px-5 py-4">
                    <span className="px-2.5 py-1 bg-green-50 text-green-700 text-xs rounded-full font-medium">{c.tariff_slug}</span>
                  </td>
                  <td className="px-5 py-4 text-sm text-gray-600 text-center">{c.events_count || 0}</td>
                  <td className="px-5 py-4 text-sm text-gray-400">
                    {new Date(c.created_at).toLocaleDateString('ru')}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-sm text-gray-400">
                    {search ? 'Ничего не найдено' : 'Клиентов пока нет'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
