'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { Plus, Users, Calendar, ChevronRight, Mic, Trash2, Copy, Trophy } from 'lucide-react'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'
import ViewToggle, { ViewMode } from '@/components/ViewToggle'

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Moscow' })
}

function formatDayTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const day  = d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', timeZone: 'Europe/Moscow' })
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  return `${day} ${time}`
}

// Вилка дат «23 апр 10:00 – 29 апр 23:59 МСК». Время всегда в МСК.
function formatDateRange(start: string | null | undefined, end: string | null | undefined): string {
  if (start && end) return `${formatDayTime(start)} – ${formatDayTime(end)} МСК`
  if (start) return `${formatDayTime(start)} МСК`
  if (end)   return `${formatDayTime(end)} МСК`
  return ''
}

// Зелёный — событие в будущем или идёт сейчас. Красный — закончилось.
function dateColorClass(end: string | null | undefined): string {
  if (!end) return 'text-gray-400'
  return new Date(end) < new Date() ? 'text-red-600' : 'text-emerald-600'
}

export default function ConferencesPage() {
  const { t } = useLang()
  const router = useRouter()
  const pathname = usePathname()
  // Та же страница обслуживает /dashboard/conferences и /dashboard/tournaments —
  // обе работают с теми же таблицами conf_*, отличаются только module_slug и UI-лейблами.
  const isTournament = !!pathname?.startsWith('/dashboard/tournaments')
  const basePath = isTournament ? '/dashboard/tournaments' : '/dashboard/conferences'
  const moduleSlug = isTournament ? 'turnir' : 'conference'
  const pageTitle = isTournament ? 'Премии/Турниры' : t.conferences.title
  const pageSubtitle = isTournament
    ? 'Чемпионаты, премии и многоэтапные программы — те же возможности что у конференций.'
    : t.conferences.subtitle
  const addNewLabel = isTournament ? 'Создать турнир' : t.conferences.addNew
  const emptyTitle = isTournament ? 'Здесь будут ваши турниры' : t.conferences.empty.title
  const emptySubtitle = isTournament ? 'Создайте первый турнир или премию' : t.conferences.empty.subtitle
  const emptyBtn = isTournament ? 'Создать первый турнир' : t.conferences.empty.btn
  const HeaderIcon = isTournament ? Trophy : Mic

  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [copyingId, setCopyingId] = useState<number | null>(null)
  const [view, setView] = useState<ViewMode>('list')

  const STATUS_LABELS: Record<string, { label: string; cls: string; dot: string }> = {
    draft:     { label: t.status.draft,     cls: 'bg-gray-100 text-gray-600 border-gray-200',          dot: 'bg-gray-400' },
    published: { label: t.status.published, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',  dot: 'bg-emerald-500' },
    active:    { label: t.status.active,    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',  dot: 'bg-emerald-500' },
    ended:     { label: t.status.ended,     cls: 'bg-red-50 text-red-600 border-red-200',              dot: 'bg-red-400' },
  }

  const storageKey = isTournament ? 'plusson_tournaments_view' : 'plusson_conferences_view'
  useEffect(() => {
    const saved = localStorage.getItem(storageKey) as ViewMode | null
    if (saved === 'grid' || saved === 'list') setView(saved)
  }, [storageKey])

  function setViewPersist(v: ViewMode) {
    setView(v)
    localStorage.setItem(storageKey, v)
  }

  async function load() {
    setLoading(true)
    try {
      const r = await api.events.list(moduleSlug)
      setEvents(r.events || [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [moduleSlug])

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
            <HeaderIcon size={24} /> {pageTitle}
          </h1>
          <p className="text-gray-500 mt-1 text-sm">{pageSubtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} onChange={setViewPersist} />
          <Link href={`${basePath}/new`}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Plus size={16} /> {addNewLabel}
          </Link>
        </div>
      </div>

      {events.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-16 text-center">
          <div className="w-20 h-20 rounded-full mx-auto mb-6 flex items-center justify-center"
               style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <HeaderIcon size={36} className="text-white" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">{emptyTitle}</h2>
          <p className="text-gray-500 mb-8 max-w-sm mx-auto">{emptySubtitle}</p>
          <Link href={`${basePath}/new`}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Plus size={16} /> {emptyBtn}
          </Link>
        </div>
      ) : view === 'list' ? (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {events.map(e => {
            const st = STATUS_LABELS[e.status]
            const startIso = e.effective_start_at || e.start_at
            const endIso   = e.effective_end_at   || e.end_at
            const dateLabel = formatDateRange(startIso, endIso) || formatDate(e.created_at)
            const dateCls   = startIso || endIso ? dateColorClass(endIso) : 'text-gray-400'
            return (
              <div key={e.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
                <Link href={`${basePath}/${e.id}`} className="flex-1 min-w-0 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 truncate">{e.title}</span>
                      {st && (
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border ${st.cls}`}>
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${st.dot}`} />
                          {st.label}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs mt-0.5">
                      <span className={`font-medium ${dateCls}`}>{dateLabel}</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-400">{e.participants_count || 0} {t.conferences.participants}</span>
                    </div>
                  </div>
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
            const startIso = event.effective_start_at || event.start_at
            const endIso   = event.effective_end_at   || event.end_at
            const dateLabel = formatDateRange(startIso, endIso) || formatDate(event.created_at)
            const dateCls   = startIso || endIso ? dateColorClass(endIso) : 'text-gray-600'
            return (
              <div key={event.id} className="relative group">
                <Link
                  href={`${basePath}/${event.id}`}
                  className={`block bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
                >
                  <div className="h-3" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }} />
                  <div className="p-5">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-gray-900 leading-snug flex-1 mr-2">
                        {event.title}
                      </h3>
                      <ChevronRight size={16} className="text-gray-400 shrink-0 mt-0.5" />
                    </div>
                    {status && (
                      <div className="mb-3">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium border ${status.cls}`}>
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${status.dot}`} />
                          {status.label}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-4 text-sm">
                      <span className="flex items-center gap-1.5 text-gray-600">
                        <Users size={14} className="text-gray-400" />
                        {event.participants_count || 0} {t.conferences.participants}
                      </span>
                      <span className={`flex items-center gap-1.5 font-medium ${dateCls}`}>
                        <Calendar size={14} className="opacity-70" />
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
