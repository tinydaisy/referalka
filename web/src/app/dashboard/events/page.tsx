'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Calendar, Plus, Copy, LayoutGrid, List as ListIcon, ExternalLink } from 'lucide-react'
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

type ViewMode = 'list' | 'grid'

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft:  { label: 'черновик',  cls: 'bg-gray-100 text-gray-500' },
  active: { label: 'активно',   cls: 'bg-green-100 text-green-700' },
  ended:  { label: 'завершено', cls: 'bg-red-50 text-red-600' },
}

export default function EventsPage() {
  const router = useRouter()
  const [items, setItems] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('list')
  const [copyingId, setCopyingId] = useState<number | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem('plusson_events_view') as ViewMode | null
    if (saved === 'grid' || saved === 'list') setView(saved)
  }, [])

  function setViewPersist(v: ViewMode) {
    setView(v)
    localStorage.setItem('plusson_events_view', v)
  }

  async function load() {
    setLoading(true)
    try {
      const res = await api.events.list()
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
          <Link href="/dashboard/events/new"
                className="text-sm underline" style={{ color: '#25455D' }}>
            Создать первое
          </Link>
        </div>
      ) : view === 'list' ? (
        <ListView items={items} onCopy={handleCopy} copyingId={copyingId} />
      ) : (
        <GridView items={items} onCopy={handleCopy} copyingId={copyingId} />
      )}
    </div>
  )
}


export function ViewToggle({ view, onChange }: {
  view: ViewMode; onChange: (v: ViewMode) => void
}) {
  return (
    <div className="inline-flex p-1 bg-gray-100 rounded-lg">
      <button onClick={() => onChange('list')}
              className={`p-1.5 rounded ${view === 'list' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400 hover:text-gray-700'}`}
              title="Списком">
        <ListIcon size={16} />
      </button>
      <button onClick={() => onChange('grid')}
              className={`p-1.5 rounded ${view === 'grid' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400 hover:text-gray-700'}`}
              title="Плитками">
        <LayoutGrid size={16} />
      </button>
    </div>
  )
}


function ListView({ items, onCopy, copyingId }: {
  items: EventItem[]; onCopy: (id: number) => void; copyingId: number | null
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 divide-y">
      {items.map(e => {
        const st = STATUS_LABEL[e.status] || STATUS_LABEL.draft
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
                  <span>/{e.slug}</span>
                  <span>·</span>
                  <span>{e.participants_count} {e.participants_count === 1 ? 'участник' : 'участников'}</span>
                </div>
              </div>
              <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded shrink-0 ${st.cls}`}>
                {st.label}
              </span>
            </Link>
            <button onClick={() => onCopy(e.id)} disabled={copyingId === e.id}
                    className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"
                    title="Скопировать событие">
              <Copy size={16} />
            </button>
          </div>
        )
      })}
    </div>
  )
}


function GridView({ items, onCopy, copyingId }: {
  items: EventItem[]; onCopy: (id: number) => void; copyingId: number | null
}) {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {items.map(e => {
        const st = STATUS_LABEL[e.status] || STATUS_LABEL.draft
        return (
          <div key={e.id} className="bg-white rounded-xl border border-gray-200 hover:border-gray-400 transition overflow-hidden relative group">
            <button onClick={() => onCopy(e.id)} disabled={copyingId === e.id}
                    className="absolute top-2 right-2 p-1.5 rounded bg-white/90 text-gray-500 hover:text-gray-900 hover:bg-white shadow-sm z-10 opacity-0 group-hover:opacity-100 transition disabled:opacity-50"
                    title="Скопировать">
              <Copy size={14} />
            </button>
            <Link href={`/dashboard/events/${e.id}`}>
              {e.poster_url ? (
                <div className="aspect-video bg-gray-100">
                  <img src={e.poster_url} alt={e.title} className="w-full h-full object-cover" />
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
                  <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded shrink-0 ${st.cls}`}>
                    {st.label}
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-2 flex items-center gap-2">
                  <span>{e.participants_count} {e.participants_count === 1 ? 'участник' : 'участников'}</span>
                  <span className="text-gray-300">·</span>
                  <span className="font-mono text-[10px] text-gray-400">/{e.slug}</span>
                </div>
              </div>
            </Link>
          </div>
        )
      })}
    </div>
  )
}
