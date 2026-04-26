'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Calendar, Plus, Copy, Trash2, ChevronRight, Users } from 'lucide-react'
import { api } from '@/lib/api'
import ViewToggle, { ViewMode } from '@/components/ViewToggle'

interface EventItem {
  id: number
  slug: string
  title: string
  module_slug: string
  status: string
  poster_url: string | null
  participants_count: number
  created_at: string
  start_at?: string | null
  end_at?: string | null
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  active: { label: 'активно',   cls: 'bg-green-100 text-green-700' },
  ended:  { label: 'завершено', cls: 'bg-red-50 text-red-600' },
  // 'draft' не показываем — пустой бейдж
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function EventsPage() {
  const router = useRouter()
  const [items, setItems] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('list')
  const [copyingId, setCopyingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem('plusson_events_view') as ViewMode | null
    if (saved === 'grid' || saved === 'list') setView(saved)
  }, [])
  function setViewPersist(v: ViewMode) {
    setView(v); localStorage.setItem('plusson_events_view', v)
  }

  async function load() {
    setLoading(true)
    try {
      const res = await api.events.list()
      const filtered = (res.events || []).filter((e: EventItem) => e.module_slug !== 'conference')
      // Догружаем start_at для каждого через GET (list не возвращает) — батчем по необходимости
      // Но для производительности — пока без догрузки, используем created_at если start_at нет
      setItems(filtered)
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Не получилось загрузить')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function handleCopy(id: number) {
    setCopyingId(id)
    try {
      const res = await api.events.copy(id)
      router.push(`/dashboard/events/${res.event.id}`)
    } catch (e: any) {
      alert(e.message || 'Ошибка копирования')
      setCopyingId(null)
    }
  }

  async function handleDelete(id: number, title: string) {
    if (!confirm(`Удалить «${title}»?`)) return
    setDeletingId(id)
    try {
      await api.events.delete(id)
      setItems(prev => prev.filter(e => e.id !== id))
    } catch (e: any) {
      alert(e.message)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" style={{ color: '#25455D' }}>
            <Calendar size={24} /> Мероприятия
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Вебинары, уроки в записи, нетворкинги, эфиры, мастер-классы. Конференции — в отдельном разделе.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} onChange={setViewPersist} />
          <Link href="/dashboard/events/new"
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Plus size={18} /> Создать
          </Link>
        </div>
      </div>

      {error && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>}

      {loading ? (
        <div className="text-gray-400 text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <Calendar className="mx-auto mb-3 text-gray-300" size={40} />
          <p className="text-gray-500 text-sm mb-4">У вас пока нет мероприятий</p>
          <Link href="/dashboard/events/new" className="text-sm underline" style={{ color: '#25455D' }}>
            Создать первое
          </Link>
        </div>
      ) : view === 'list' ? (
        <div className="bg-white rounded-xl border border-gray-200 divide-y">
          {items.map(e => {
            const st = STATUS_LABEL[e.status]
            const dateLabel = formatDate(e.start_at || e.created_at)
            return (
              <div key={e.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
                <Link href={`/dashboard/events/${e.id}`} className="flex-1 min-w-0 flex items-center gap-3">
                  {e.poster_url ? (
                    <img src={e.poster_url} alt="" className="w-10 h-10 rounded object-cover bg-gray-100" />
                  ) : (
                    <div className="w-10 h-10 rounded flex items-center justify-center"
                         style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                      <Calendar size={16} className="text-white/60" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-900 truncate">{e.title}</div>
                    <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                      <span>{dateLabel}</span>
                      <span>·</span>
                      <span>{e.participants_count} {e.participants_count === 1 ? 'участник' : 'участников'}</span>
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
                        title="Скопировать">
                  <Copy size={16} />
                </button>
                <button onClick={() => handleDelete(e.id, e.title)} disabled={deletingId === e.id}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                        title="Удалить">
                  <Trash2 size={16} />
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        // ─── Плитки в стиле конференций (градиентная шапка)
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {items.map(e => {
            const st = STATUS_LABEL[e.status]
            const dateLabel = formatDate(e.start_at || e.created_at)
            return (
              <div key={e.id} className="relative group">
                <Link href={`/dashboard/events/${e.id}`}
                      className="block bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all overflow-hidden">
                  <div className="h-24 flex items-end p-4 relative" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                    {e.poster_url && (
                      <img src={e.poster_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />
                    )}
                    {st && (
                      <span className={`text-xs px-2.5 py-1 rounded-full relative z-10 ${st.cls}`}>
                        {st.label}
                      </span>
                    )}
                  </div>
                  <div className="p-5">
                    <div className="flex items-start justify-between mb-3">
                      <h3 className="font-semibold text-gray-900 leading-snug flex-1 mr-2">{e.title}</h3>
                      <ChevronRight size={16} className="text-gray-400 shrink-0 mt-0.5" />
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-600">
                      <span className="flex items-center gap-1.5">
                        <Users size={14} className="text-gray-400" />
                        {e.participants_count || 0} участников
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Calendar size={14} className="text-gray-400" />
                        {dateLabel}
                      </span>
                    </div>
                  </div>
                </Link>
                <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition">
                  <button onClick={() => handleCopy(e.id)} disabled={copyingId === e.id}
                          className="p-1.5 rounded-lg bg-white/90 text-gray-600 hover:bg-white shadow-sm disabled:opacity-50" title="Скопировать">
                    <Copy size={14} />
                  </button>
                  <button onClick={() => handleDelete(e.id, e.title)} disabled={deletingId === e.id}
                          className="p-1.5 rounded-lg bg-black/30 text-white hover:bg-red-500 disabled:opacity-50" title="Удалить">
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
