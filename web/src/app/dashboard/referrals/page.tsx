'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus, Users, TrendingUp, ChevronRight, Link2 } from 'lucide-react'
import { api } from '@/lib/api'

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  draft:  { label: 'Черновик', cls: 'badge-draft' },
  active: { label: 'Активно',  cls: 'badge-active' },
  ended:  { label: 'Завершено', cls: 'badge-ended' },
}

export default function ReferralsPage() {
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.events.list('base')
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
          <h1 className="text-2xl font-bold text-gray-900">Реферальные кампании</h1>
          <p className="text-gray-500 mt-1">Запускайте реферальные программы и привлекайте участников</p>
        </div>
        <Link
          href="/dashboard/events/new?module=base"
          className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2"
        >
          <Plus size={16} /> Новая кампания
        </Link>
      </div>

      {events.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-20 h-20 rounded-full gradient-bg flex items-center justify-center mx-auto mb-6">
            <Link2 size={36} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">Создайте первую кампанию</h2>
          <p className="text-gray-500 mb-8 max-w-sm mx-auto">
            Участники получат реферальные ссылки и начнут приглашать друзей за ценные подарки.
          </p>
          <Link
            href="/dashboard/events/new?module=base"
            className="btn-gold inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold"
          >
            <Plus size={16} /> Создать кампанию
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {events.map(event => {
            const status = STATUS_LABELS[event.status] || STATUS_LABELS.draft
            return (
              <Link
                key={event.id}
                href={`/dashboard/events/${event.id}`}
                className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden group"
              >
                <div className="gradient-bg h-24 flex items-end p-4 relative">
                  {event.poster_url && (
                    <img src={event.poster_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />
                  )}
                  <span className={`badge text-xs px-2.5 py-1 rounded-full ${status.cls}`}>
                    {status.label}
                  </span>
                </div>
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="font-semibold text-gray-900 leading-snug flex-1 mr-2 group-hover:text-brand transition-colors">
                      {event.title}
                    </h3>
                    <ChevronRight size={16} className="text-gray-400 shrink-0 mt-0.5" />
                  </div>
                  <div className="flex items-center gap-4 text-sm text-gray-600">
                    <span className="flex items-center gap-1.5">
                      <Users size={14} className="text-gray-400" />
                      {event.participants_count || 0} участников
                    </span>
                    <span className="flex items-center gap-1.5">
                      <TrendingUp size={14} className="text-gray-400" />
                      {event.points_free || 1} балл/реферал
                    </span>
                  </div>
                </div>
              </Link>
            )
          })}

          <Link
            href="/dashboard/events/new?module=base"
            className="bg-white rounded-2xl border-2 border-dashed border-gray-200 hover:border-brand hover:shadow-sm transition-all flex flex-col items-center justify-center p-10 text-gray-400 hover:text-brand group"
          >
            <div className="w-12 h-12 rounded-full border-2 border-dashed border-gray-300 group-hover:border-brand flex items-center justify-center mb-3 transition-colors">
              <Plus size={20} />
            </div>
            <span className="text-sm font-medium">Новая кампания</span>
          </Link>
        </div>
      )}
    </div>
  )
}
