import { useEffect, useState } from 'react'
import { getClientEvents } from '../api'

interface Props {
  clientId: number
  onOpenEvent: (slug: string) => void
}

interface Ev { id: number; slug: string; title: string; poster_url?: string; start_at?: string; end_at?: string; bucket: 'now' | 'upcoming' | 'past' }

function formatDate(dt?: string) {
  if (!dt) return ''
  try {
    return new Date(dt).toLocaleDateString('ru', { day: 'numeric', month: 'long' })
  } catch { return '' }
}

function Section({ title, items, onOpen }: { title: string; items: Ev[]; onOpen: (s: string) => void }) {
  if (!items.length) return null
  return (
    <>
      <div className="sec-h">{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 4px' }}>
        {items.map(e => (
          <div key={e.id} className="hub-card fade-in" onClick={() => onOpen(e.slug)}>
            {e.poster_url
              ? <img className="poster" src={e.poster_url} alt={e.title} />
              : <div className="poster" />
            }
            <div className="body">
              <span className={`badge badge-${e.bucket === 'now' ? 'green' : e.bucket === 'past' ? 'gray' : 'gold'}`}>
                {e.bucket === 'now' ? '● Идёт сейчас' : e.bucket === 'past' ? 'Завершено' : 'Скоро'}
              </span>
              <div className="title">{e.title}</div>
              {(e.start_at || e.end_at) && (
                <div className="meta">{formatDate(e.start_at)}{e.end_at && e.start_at !== e.end_at ? ` — ${formatDate(e.end_at)}` : ''}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export default function CalendarTab({ clientId, onOpenEvent }: Props) {
  const [data, setData] = useState<{ now: Ev[]; upcoming: Ev[]; past: Ev[] }>({ now: [], upcoming: [], past: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getClientEvents(clientId)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [clientId])

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем события…</div>

  const empty = !data.now.length && !data.upcoming.length && !data.past.length
  if (empty) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 60, padding: 16 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>📅</div>
        <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 16 }}>Пока нет событий</p>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
          Организатор скоро объявит<br />ближайшие мероприятия
        </p>
      </div>
    )
  }

  return (
    <div className="fade-in" style={{ paddingBottom: 16 }}>
      <Section title="🔴 Сейчас идёт"  items={data.now}      onOpen={onOpenEvent} />
      <Section title="📅 Скоро"        items={data.upcoming} onOpen={onOpenEvent} />
      <Section title="✓ Прошли"        items={data.past}     onOpen={onOpenEvent} />
    </div>
  )
}
