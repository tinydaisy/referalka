'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Users, Calendar, ChevronRight, Mic, Trash2, Copy } from 'lucide-react'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'
import ViewToggle, { ViewMode } from '@/components/ViewToggle'

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function ConferencesPage() {
  const { t } = useLang()
  const router = useRouter()
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [copyingId, setCopyingId] = useState<number | null>(null)
  const [view, setView] = useState<ViewMode>('list')

  const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
    active: { label: t.status.active, cls: 'bg-green-100 text-green-700' },
    ended:  { label: t.status.ended,  cls: 'bg-red-50 text-red-600' },
    // 'draft' не показываем
  }

  useEffect(() => {
    const saved = localStorage.getItem('plusson_conferences_view') as ViewMode | null
    if (saved === 'grid' || saved === 'list') setView(saved)
  }, [])

  function setViewPersist(v: ViewMode) {
    setView(v)
    localStorage.setItem('plusson_conferences_view', v)
  }

  async function load() {
    setLoading(true)
    try {
      const r = await api.events.list('conference')
      setEvents(r.events || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function handleDelete(e: React.MouseEvent | null, id: number, title: string) {
    e?.preventDefault(); e?.stopPropagation()
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

  async function handleCopy(id: number) {
    setCopyingId(id)
    try {
      const res = await api.events.copy(id)
      router.push(`/dashboard/conferences/${res.event.id}`)
    } catch (e: any) {
      alert(e.message || 'Ошибка копирования')
      setCopyingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 rounded-full border-t-transparent animate-spin"
             style={{ borderColor: '#25455D', borderTopColor: 'transparent' }} />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: '#25455D' }}>
            <Mic size={24} /> {t.conferences.title}
          </h1>
          <p className="text-gray-500 mt-1 text-sm">{t.conferences.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} onChange={setViewPersist} />
          <Link href="/dashboard/conferences/new"
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Plus size={16} /> {t.conferences.addNew}
          </Link>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-16 text-center">
          <div className="w-20 h-20 rounded-full mx-auto mb-6 flex items-center justify-center"
               style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Mic size={36} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">{t.conferences.empty.title}</h2>
          <p className="text-gray-500 mb-8 max-w-sm mx-auto">{t.conferences.empty.subtitle}</p>
          <Link href="/dashboard/conferences/new"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Plus size={16} /> {t.conferences.empty.btn}
          </Link>
        </div>
      ) : view === 'list' ? (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {events.map(e => {
            const st = STATUS_LABELS[e.status]
            const dateLabel = formatDate(e.effective_start_at || e.start_at || e.created_at)
            return (
              <div key={e.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
                <Link href={`/dashboard/conferences/${e.id}`} className="flex-1 min-w-0 flex items-center gap-3">
                  {e.poster_url ? (
                    <img src={e.poster_url} alt="" className="w-10 h-10 rounded object-cover bg-gray-100" />
                  ) : (
                    <div className="w-10 h-10 rounded flex items-center justify-center"
                         style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                      <Mic size={16} className="text-white/60" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 truncate">{e.title}</div>
                    <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                      <span>{dateLabel}</span>
                      <span>·</span>
                      <span>{e.participants_count || 0} {t.conferences.participants}</span>
                    </div>
                  </div>
                  {st && (
                    <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded shrink-0 ${st.cls}`}>
                      {st.label}
                    </span>
                  )}
                </Link>
                <button onClick={() => handleCopy(e.id)} disabled={copyingId === e.id}
                        className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"
                        title="Скопировать конференцию">
                  <Copy size={16} />
                </button>
                <button onClick={() => handleDelete(null, e.id, e.title)} disabled={deleting === e.id}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                        title={t.common.delete}>
                  <Trash2 size={16} />
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {events.map(event => {
            const status = STATUS_LABELS[event.status]
            const isDeleting = deleting === event.id
            const dateLabel = formatDate(event.effective_start_at || event.start_at || event.created_at)
            return (
              <div key={event.id} className="relative group">
                <Link
                  href={`/dashboard/conferences/${event.id}`}
                  className={`block bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                >
                  <div className="h-24 flex items-end p-4 relative" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                    {event.poster_url && (
                      <img src={event.poster_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />
                    )}
                    {status && (
                      <span className={`text-xs px-2.5 py-1 rounded-full relative z-10 ${status.cls}`}>
                        {status.label}
                      </span>
                    )}
                  </div>
                  <div className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <h3 className="font-semibold text-gray-900 leading-snug flex-1 mr-2">
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
                        {dateLabel}
                      </span>
                    </div>
                  </div>
                </Link>

                <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition">
                  <button onClick={() => handleCopy(event.id)} disabled={copyingId === event.id}
                          className="p-1.5 rounded-lg bg-white/90 text-gray-600 hover:bg-white shadow-sm disabled:opacity-50"
                          title="Скопировать">
                    <Copy size={14} />
                  </button>
                  <button onClick={(e) => handleDelete(e, event.id, event.title)} disabled={isDeleting}
                          className="p-1.5 rounded-lg bg-black/30 text-white hover:bg-red-500 transition-all disabled:opacity-50"
                          title={t.common.delete}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
