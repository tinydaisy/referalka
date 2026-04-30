'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Download, Search } from 'lucide-react'
import { api } from '@/lib/api'

export default function AnalyticsPage() {
  const { id } = useParams()
  const [event, setEvent] = useState<any>(null)
  const [analytics, setAnalytics] = useState<any>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    Promise.all([api.events.get(Number(id)), api.events.analytics(Number(id))])
      .then(([e, a]) => { setEvent(e.event); setAnalytics(a) })
  }, [id])

  const tabs = [
    { label: 'Обзор', href: `/dashboard/events/${id}` },
    { label: 'Аналитика', href: `/dashboard/events/${id}/analytics`, active: true },
    { label: 'Материалы', href: `/dashboard/events/${id}/materials` },
    ...(event?.module_slug === 'conference' ? [{ label: 'Конференция', href: `/dashboard/conferences/${id}` }] : []),
  ]

  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-6">
        <Link href="/dashboard" className="hover:text-gray-700">События</Link>
        <span>/</span>
        <Link href={`/dashboard/events/${id}`} className="hover:text-gray-700">{event?.title}</Link>
        <span>/</span>
        <span className="text-gray-700">Аналитика</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">{event?.title}</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 border-b border-gray-200">
        {tabs.map(tab => (
          <Link key={tab.href} href={tab.href}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab.active ? 'border-brand text-brand' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            style={tab.active ? { borderBottomColor: '#25455D', color: '#25455D' } : {}}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Участников', value: analytics?.participants_total || 0 },
          { label: 'Переходов', value: analytics?.clicks_total || 0 },
          { label: 'Конверсий (бесплатно)', value: analytics?.conversions_free || 0 },
          { label: 'Конверсий (платно)', value: analytics?.conversions_paid || 0 },
        ].map(({ label, value }) => (
          <div key={label} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <p className="text-sm text-gray-500 mb-2">{label}</p>
            <p className="text-3xl font-bold text-gray-900">{value}</p>
          </div>
        ))}
      </div>

      {/* Participants table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">Участники</h3>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text" placeholder="Поиск..." value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-brand/30"
              />
            </div>
            <button className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50">
              <Download size={14} /> Экспорт CSV
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                {['Telegram', 'Зарегистрировался', 'Приглашено', 'Баллы', 'Подарки'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {analytics?.top_referrers?.length > 0 ? analytics.top_referrers.map((r: any, i: number) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full gradient-bg flex items-center justify-center text-white text-xs font-bold">
                        {(r.contact_name || r.username || '?')[0]}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{r.contact_name || '—'}</p>
                        {r.username && <p className="text-xs text-gray-400">@{r.username.replace(/^@+/, '')}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm text-gray-600">—</td>
                  <td className="px-5 py-4">
                    <span className="text-sm font-semibold text-gray-900">{r.referrals_count}</span>
                  </td>
                  <td className="px-5 py-4 text-sm text-gray-600">{r.points_total}</td>
                  <td className="px-5 py-4 text-sm text-gray-600">0</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-gray-400 text-sm">
                    Участников пока нет. Активируйте событие и поделитесь ссылкой.
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
