'use client'
import { useEffect, useState } from 'react'
import { Users, Calendar, TrendingUp, Zap } from 'lucide-react'
import { api } from '@/lib/api'

export default function AdminOverviewPage() {
  const [stats, setStats] = useState<any>(null)

  useEffect(() => {
    api.admin.stats().then(setStats).catch(() => {})
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

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-3">Первый клиент</h3>
        <div className="p-4 bg-gray-50 rounded-xl">
          <p className="font-medium text-gray-900">Маргарита Владимировна</p>
          <p className="text-sm text-gray-500">margarita.vl2011@gmail.com · @margo_forbs</p>
          <p className="text-sm text-gray-500 mt-1">Тариф: Бесплатный (Beta) · 12 месяцев</p>
        </div>
      </div>
    </div>
  )
}
