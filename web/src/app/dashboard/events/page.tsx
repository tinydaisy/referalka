'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Calendar, Plus, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'

interface EventItem {
  id: number
  slug: string
  title: string
  module_slug: string
  status: string
  poster_url: string | null
  participants_count: number
  created_at: string
}

export default function EventsPage() {
  const [items, setItems] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await api.events.list()
      // «Мероприятия» — всё КРОМЕ конференций (у конференций свой раздел)
      const filtered = (res.events || []).filter((e: EventItem) => e.module_slug !== 'conference')
      setItems(filtered)
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Не получилось загрузить')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: '#25455D' }}>
            <Calendar size={24} /> Мероприятия
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Вебинары, уроки в записи, нетворкинги, эфиры, мастер-классы.
            Конференции — в отдельном разделе.
          </p>
        </div>
        <Link
          href="/dashboard/events/new"
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
        >
          <Plus size={18} /> Создать
        </Link>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <Calendar className="mx-auto mb-3 text-gray-300" size={40} />
          <p className="text-gray-500 text-sm mb-4">У вас пока нет мероприятий</p>
          <Link href="/dashboard/events/new"
                className="text-sm underline" style={{ color: '#25455D' }}>
            Создать первое
          </Link>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(e => (
            <Link
              key={e.id}
              href={`/dashboard/events/${e.id}`}
              className="block bg-white rounded-xl border border-gray-200 hover:border-gray-400 transition overflow-hidden"
            >
              {e.poster_url ? (
                <div className="aspect-video bg-gray-100">
                  <img src={e.poster_url} alt={e.title}
                       className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="aspect-video flex items-center justify-center"
                     style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                  <Calendar size={36} className="text-white/40" />
                </div>
              )}
              <div className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-gray-900 line-clamp-2">{e.title}</h3>
                  <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded ${
                    e.status === 'active' ? 'bg-green-100 text-green-700' :
                    e.status === 'draft' ? 'bg-gray-100 text-gray-500' :
                    'bg-gray-100 text-gray-700'
                  }`}>
                    {e.status === 'active' ? 'активно' : e.status === 'draft' ? 'черновик' : e.status}
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-2 flex items-center gap-3">
                  <span>{e.participants_count} {e.participants_count === 1 ? 'участник' : 'участников'}</span>
                  <span className="text-gray-300">·</span>
                  <span className="font-mono text-[10px] text-gray-400">/{e.slug}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
