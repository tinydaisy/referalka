'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Plus, Users, Calendar, ChevronRight, Mic, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'

export default function ConferencesPage() {
  const { t } = useLang()
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<number | null>(null)

  const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
    draft:  { label: t.status.draft,  cls: 'badge-draft' },
    active: { label: t.status.active, cls: 'badge-active' },
    ended:  { label: t.status.ended,  cls: 'badge-ended' },
  }

  useEffect(() => {
    api.events.list('conference')
      .then(r => setEvents(r.events || []))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false))
  }, [])

  async function handleDelete(e: React.MouseEvent, id: number, title: string) {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(t.conferences.deleteConfirm(title))) return
    setDeleting(id)
    try {
      await api.events.delete(id)
      setEvents(ev => ev.filter(e => e.id !== id))
    } catch (err: any) {
      alert(err.message)
    } finally {
      setDeleting(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.conferences.title}</h1>
          <p className="text-gray-500 mt-1">{t.conferences.subtitle}</p>
        </div>
        <Link
          href="/dashboard/conferences/new"
          className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2"
        >
          <Plus size={16} /> {t.conferences.addNew}
        </Link>
      </div>

      {events.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-20 h-20 rounded-full gradient-bg flex items-center justify-center mx-auto mb-6">
            <Mic size={36} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">{t.conferences.empty.title}</h2>
          <p className="text-gray-500 mb-8 max-w-sm mx-auto">{t.conferences.empty.subtitle}</p>
          <Link
            href="/dashboard/conferences/new"
            className="btn-gold inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold"
          >
            <Plus size={16} /> {t.conferences.empty.btn}
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {events.map(event => {
            const status = STATUS_LABELS[event.status] || STATUS_LABELS.draft
            const isDeleting = deleting === event.id
            return (
              <div key={event.id} className="relative group">
                <Link
                  href={`/dashboard/conferences/${event.id}`}
                  className={`block bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                >
                  <div className="gradient-bg h-24 flex items-end p-4 relative">
                    {event.poster_url && (
                      <img src={event.poster_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />
                    )}
                    {event.status && event.status !== 'draft' && (
                      <span className={`badge text-xs px-2.5 py-1 rounded-full ${status.cls}`}>
                        {status.label}
                      </span>
                    )}
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
                        {event.participants_count || 0} {t.conferences.participants}
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Calendar size={14} className="text-gray-400" />
                        {event.slug}
                      </span>
                    </div>
                  </div>
                </Link>

                <button
                  onClick={(e) => handleDelete(e, event.id, event.title)}
                  disabled={isDeleting}
                  className="absolute top-3 right-3 p-1.5 rounded-lg bg-black/30 text-white opacity-0 group-hover:opacity-100 hover:bg-red-500 transition-all disabled:opacity-50"
                  title={t.common.delete}
                >
                  {isDeleting ? (
                    <div className="w-4 h-4 border-2 border-white rounded-full border-t-transparent animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
            )
          })}

          <Link
            href="/dashboard/conferences/new"
            className="bg-white rounded-2xl border-2 border-dashed border-gray-200 hover:border-brand hover:shadow-sm transition-all flex flex-col items-center justify-center p-10 text-gray-400 hover:text-brand group"
          >
            <div className="w-12 h-12 rounded-full border-2 border-dashed border-gray-300 group-hover:border-brand flex items-center justify-center mb-3 transition-colors">
              <Plus size={20} />
            </div>
            <span className="text-sm font-medium">{t.conferences.addNew}</span>
          </Link>
        </div>
      )}
    </div>
  )
}
