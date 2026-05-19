import { useEffect, useState } from 'react'
import { getMiniAppMyEvents } from '../api'

interface Props {
  tgUser: any
  onOpenEvent: (slug: string) => void
  onSwitchToPromo: () => void
}

type ParticipationStatus = 'new' | 'interested' | 'registered'

interface Ev {
  id: number
  slug: string
  title: string
  poster_url?: string
  start_at?: string
  end_at?: string
  module_slug?: string
  status?: string
  bucket: 'now' | 'soon' | 'past'
  client_id: number
  participation_status?: ParticipationStatus
}

interface Group {
  client_id: number
  client_name?: string
  client_brand_name?: string
  client_photo_url?: string
  client_positioning?: string
  events: Ev[]
}

function formatDate(dt?: string) {
  if (!dt) return ''
  try {
    return new Date(dt).toLocaleDateString('ru', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' })
  } catch { return '' }
}

function EventPoster({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null
  return <img className="poster" src={src} alt={alt} onError={() => setFailed(true)} />
}

function GroupHeader({ g }: { g: Group }) {
  const brand = g.client_brand_name || g.client_name || 'Организатор'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '20px 16px 8px',
      }}
    >
      {g.client_photo_url ? (
        <img
          src={g.client_photo_url}
          alt={brand}
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            objectFit: 'cover',
            flexShrink: 0,
          }}
        />
      ) : (
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: 'linear-gradient(45deg, #25455D, #0a1520)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FFCFA4',
            fontWeight: 700,
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          {brand[0]?.toUpperCase()}
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {brand}
        </div>
        {g.client_positioning && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {g.client_positioning}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status?: ParticipationStatus }) {
  if (!status) return null
  if (status === 'registered') return <span className="status-pill status-pill-registered">✓ Вы записаны</span>
  if (status === 'interested') return <span className="status-pill status-pill-interested">Вы интересовались</span>
  return <span className="status-pill status-pill-new">Новое</span>
}

function EventCard({ e, onOpen }: { e: Ev; onOpen: (s: string) => void }) {
  const badgeClass =
    e.bucket === 'now' ? 'badge-green' : e.bucket === 'past' ? 'badge-gray' : 'badge-gold'
  const badgeText =
    e.bucket === 'now' ? '● Идёт сейчас' : e.bucket === 'past' ? 'Завершено' : 'Скоро'

  return (
    <div className="hub-card fade-in" onClick={() => onOpen(e.slug)}>
      <EventPoster src={e.poster_url} alt={e.title} />
      <div className="body">
        <div className="badge-row">
          <span className={`badge ${badgeClass}`}>{badgeText}</span>
          <StatusPill status={e.participation_status} />
        </div>
        <div className="title">{e.title}</div>
        {(e.start_at || e.end_at) && (
          <div className="meta">
            {formatDate(e.start_at)}
            {e.end_at && e.start_at !== e.end_at ? ` — ${formatDate(e.end_at)}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}

export default function SelectorEventsTab({ tgUser, onOpenEvent, onSwitchToPromo }: Props) {
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!tgUser?.id) { setLoading(false); return }
    getMiniAppMyEvents(Number(tgUser.id))
      .then((data: { groups: Group[] }) => setGroups(data.groups || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [tgUser?.id])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем события…</div>
  }

  if (error || !groups.length) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px' }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>📭</div>
        <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 16 }}>
          У вас пока нет событий
        </p>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
          Перейдите по ссылке от организатора —<br />и событие появится здесь
        </p>
        <button
          onClick={onSwitchToPromo}
          style={{
            marginTop: 24,
            background: '#FFCFA4',
            color: '#25455D',
            border: 'none',
            padding: '12px 20px',
            borderRadius: 12,
            fontWeight: 700,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          А что такое iViSiON: ПЛЮСОН? →
        </button>
      </div>
    )
  }

  return (
    <div className="fade-in" style={{ paddingBottom: 16 }}>
      {groups.map(g => (
        <div key={g.client_id}>
          <GroupHeader g={g} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 4px' }}>
            {g.events.map(e => (
              <EventCard key={e.id} e={e} onOpen={onOpenEvent} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
