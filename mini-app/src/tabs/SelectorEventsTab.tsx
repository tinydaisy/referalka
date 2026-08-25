import { useEffect, useState, useMemo } from 'react'
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
  client_name?: string
  client_brand_name?: string
  client_photo_url?: string
  client_positioning?: string
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

function StatusPill({ status }: { status?: ParticipationStatus }) {
  if (!status) return null
  if (status === 'registered') return <span className="status-pill status-pill-registered">✓ Вы записаны</span>
  if (status === 'interested') return <span className="status-pill status-pill-interested">Вы интересовались</span>
  return <span className="status-pill status-pill-new">Новое</span>
}

function BrandHeader({ e }: { e: Ev }) {
  const brand = e.client_brand_name || e.client_name || 'Организатор'
  const [failed, setFailed] = useState(false)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 0' }}>
      {e.client_photo_url && !failed ? (
        <img
          src={e.client_photo_url}
          alt={brand}
          onError={() => setFailed(true)}
          style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        />
      ) : (
        <div style={{
          width: 22, height: 22, borderRadius: '50%',
          background: 'var(--gradient)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--peach)', fontWeight: 700, fontSize: 10, flexShrink: 0,
        }}>
          {brand[0]?.toUpperCase()}
        </div>
      )}
      <div style={{
        fontSize: 12, fontWeight: 600, color: 'var(--muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {brand}
      </div>
    </div>
  )
}

function EventCard({ e, onOpen }: { e: Ev; onOpen: (s: string) => void }) {
  const badgeClass =
    e.bucket === 'now' ? 'badge-green' : e.bucket === 'past' ? 'badge-gray' : 'badge-gold'
  const badgeText =
    e.bucket === 'now' ? '● Идёт сейчас' : e.bucket === 'past' ? 'Завершено' : 'Скоро'

  return (
    <div className="hub-card fade-in" onClick={() => onOpen(e.slug)}>
      <BrandHeader e={e} />
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
  const [showArchive, setShowArchive] = useState(false)

  useEffect(() => {
    if (!tgUser?.id) { setLoading(false); return }
    getMiniAppMyEvents(Number(tgUser.id))
      .then((data: { groups: Group[] }) => setGroups(data.groups || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [tgUser?.id])

  // Плоский список: распаковываем events из групп, прокидываем в каждый event
  // данные об организаторе (нужны для брендинговой шапки карточки).
  const allEvents: Ev[] = useMemo(() => {
    const out: Ev[] = []
    for (const g of groups) {
      for (const e of g.events) {
        out.push({
          ...e,
          client_id:          g.client_id,
          client_name:        e.client_name        ?? g.client_name,
          client_brand_name:  e.client_brand_name  ?? g.client_brand_name,
          client_photo_url:   e.client_photo_url   ?? g.client_photo_url,
          client_positioning: e.client_positioning ?? g.client_positioning,
        })
      }
    }
    return out
  }, [groups])

  const active = useMemo(() => {
    const arr = allEvents.filter(e => e.bucket !== 'past')
    return arr.sort((a, b) => bucketRank(a) - bucketRank(b) || dateAsc(a, b))
  }, [allEvents])

  const past = useMemo(() => {
    const arr = allEvents.filter(e => e.bucket === 'past')
    return arr.sort((a, b) => dateDesc(a, b))
  }, [allEvents])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем события…</div>
  }

  if (error || (!active.length && !past.length)) {
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
            background: 'var(--peach)',
            color: 'var(--dark)',
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 16px 4px' }}>
        {active.map(e => (
          <EventCard key={`a-${e.id}`} e={e} onOpen={onOpenEvent} />
        ))}
        {past.length > 0 && (
          <button
            onClick={() => setShowArchive(v => !v)}
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
            <span>Архив прошедших · {past.length}</span>
            <span style={{ fontSize: 12, transition: 'transform 0.2s', transform: showArchive ? 'rotate(180deg)' : 'none' }}>▾</span>
          </button>
        )}
        {showArchive && past.map(e => (
          <EventCard key={`p-${e.id}`} e={e} onOpen={onOpenEvent} />
        ))}
      </div>
    </div>
  )
}

// Сортировка активных: 'now' раньше 'soon'. Внутри — по start_at ASC.
function bucketRank(e: Ev): number {
  if (e.bucket === 'now') return 0
  if (e.bucket === 'soon') return 1
  return 2
}
function dateAsc(a: Ev, b: Ev): number {
  return (a.start_at || '').localeCompare(b.start_at || '')
}
function dateDesc(a: Ev, b: Ev): number {
  return (b.end_at || b.start_at || '').localeCompare(a.end_at || a.start_at || '')
}
