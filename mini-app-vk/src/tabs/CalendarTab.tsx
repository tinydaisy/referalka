import { useEffect, useState } from 'react'
import { getClientEvents } from '../api'

interface Props {
  clientId: number
  tgId?: number
  onOpenEvent: (slug: string) => void
}

type ParticipationStatus = 'new' | 'interested' | 'registered' | null

interface Ev {
  id: number
  slug: string
  title: string
  poster_url?: string
  start_at?: string
  end_at?: string
  bucket: 'now' | 'upcoming' | 'past'
  participation_status?: ParticipationStatus
}

function formatDate(dt?: string) {
  if (!dt) return ''
  try {
    return new Date(dt).toLocaleDateString('ru', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })
  } catch { return '' }
}

// Афиша карточки события: ничего не рендерим, если URL пустой или картинка не загрузилась
function EventPoster({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null
  return <img className="poster" src={src} alt={alt} onError={() => setFailed(true)} />
}

function StatusPill({ status }: { status: ParticipationStatus }) {
  if (!status) return null
  if (status === 'registered') return <span className="status-pill status-pill-registered">✓ Вы записаны</span>
  if (status === 'interested') return <span className="status-pill status-pill-interested">Вы интересовались</span>
  return <span className="status-pill status-pill-new">Новое</span>
}

function Section({ title, items, onOpen }: { title: string; items: Ev[]; onOpen: (s: string) => void }) {
  if (!items.length) return null
  return (
    <>
      {title && <div className="sec-h">{title}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 4px' }}>
        {items.map(e => (
          <div key={e.id} className="hub-card fade-in" onClick={() => onOpen(e.slug)}>
            <EventPoster src={e.poster_url} alt={e.title} />
            <div className="body">
              <div className="badge-row">
                <span className={`badge badge-${e.bucket === 'now' ? 'green' : e.bucket === 'past' ? 'gray' : 'gold'}`}>
                  {e.bucket === 'now' ? '● Идёт сейчас' : e.bucket === 'past' ? 'Завершено' : 'Скоро'}
                </span>
                <StatusPill status={e.participation_status ?? null} />
              </div>
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

export default function CalendarTab({ clientId, tgId, onOpenEvent }: Props) {
  const [data, setData] = useState<{ now: Ev[]; upcoming: Ev[]; past: Ev[] }>({ now: [], upcoming: [], past: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getClientEvents(clientId, undefined, tgId)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [clientId, tgId])

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
      <ArchiveSection items={data.past} onOpen={onOpenEvent} />
    </div>
  )
}

function ArchiveSection({ items, onOpen }: { items: Ev[]; onOpen: (s: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  return (
    <>
      <div style={{ padding: '0 16px', marginTop: 8 }}>
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            background: 'transparent',
            border: '1px dashed var(--muted)',
            borderRadius: 12,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            color: 'var(--muted)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          <span>Архив прошедших · {items.length}</span>
          <span style={{ fontSize: 12, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
        </button>
      </div>
      {open && <Section title="" items={items} onOpen={onOpen} />}
    </>
  )
}
