'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus, Calendar, Users, TrendingUp, Clock, ChevronRight, Zap } from 'lucide-react'
import { api } from '@/lib/api'

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  draft:  { label: 'Черновик', cls: 'badge-draft' },
  active: { label: 'Активно',  cls: 'badge-active' },
  ended:  { label: 'Завершено', cls: 'badge-ended' },
}

const MODULE_LABELS: Record<string, string> = {
  base: 'Базовый', conference: 'Конференция',
  webinar: 'Вебинар', training: 'Тренинг', promo: 'Промо',
}

export default function DashboardPage() {
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.events.list()
      .then(r => setEvents(r.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Мои события</h1>
          <p className="text-gray-500 mt-1">Управляйте реферальными программами</p>
        </div>
        <Link
          href="/dashboard/events/new"
          className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2"
        >
          <Plus size={16} /> Создать событие
        </Link>
      </div>

      {events.length === 0 ? (
        /* Empty state */
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-20 h-20 rounded-full gradient-bg flex items-center justify-center mx-auto mb-6">
            <Zap size={36} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">Создайте первое событие</h2>
          <p className="text-gray-500 mb-8 max-w-sm mx-auto">
            Запустите реферальную программу и начните привлекать участников через своих же подписчиков.
          </p>
          <Link
            href="/dashboard/events/new"
            className="btn-gold inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold"
          >
            <Plus size={16} /> Создать первое событие
          </Link>
          <p className="mt-4 text-sm text-gray-400">Займёт 5–10 минут. Всё бесплатно.</p>
        </div>
      ) : (
        /* Events grid */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {events.map(event => {
            const status = STATUS_LABELS[event.status] || STATUS_LABELS.draft
            return (
              <Link
                key={event.id}
                href={`/dashboard/events/${event.id}`}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden group"
              >
                {/* Banner */}
                <div className="gradient-bg h-28 flex items-end p-4 relative">
                  {event.poster_url && (
                    <img src={event.poster_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />
                  )}
                  <span className={`badge text-xs px-2.5 py-1 rounded-full ${status.cls}`}>
                    {status.label}
                  </span>
                </div>

                {/* Content */}
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="font-semibold text-gray-900 leading-snug flex-1 mr-2 group-hover:text-brand transition-colors">
                      {event.title}
                    </h3>
                    <ChevronRight size={16} className="text-gray-400 shrink-0 mt-0.5" />
                  </div>

                  <p className="text-xs text-gray-400 mb-4">
                    Модуль: {MODULE_LABELS[event.module_slug] || event.module_slug}
                  </p>

                  <div className="flex items-center gap-4 text-sm text-gray-600">
                    <span className="flex items-center gap-1.5">
                      <Users size={14} className="text-gray-400" />
                      {event.participants_count || 0}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <TrendingUp size={14} className="text-gray-400" />
                      0 рефералов
                    </span>
                  </div>
                </div>
              </Link>
            )
          })}

          {/* Add new card */}
          <Link
            href="/dashboard/events/new"
            className="bg-white rounded-2xl border-2 border-dashed border-gray-200 hover:border-brand hover:shadow-sm transition-all flex flex-col items-center justify-center p-10 text-gray-400 hover:text-brand group"
          >
            <div className="w-12 h-12 rounded-full border-2 border-dashed border-gray-300 group-hover:border-brand flex items-center justify-center mb-3 transition-colors">
              <Plus size={20} />
            </div>
            <span className="text-sm font-medium">Новое событие</span>
          </Link>
        </div>
      )}
    </div>
  )
}
