import { useEffect, useState } from 'react'
import { getMiniAppMyEvents } from '../api'

interface Props {
  tgUser: any
  onOpenEvent: (slug: string) => void
  onSwitchToPromo: () => void
}

interface Ev {
  id: number
  slug: string
  title: string
  poster_url?: string
  start_at?: string
  end_at?: string
  module_slug?: string
  status?: string
  client_id: number
  client_name?: string
  client_brand_name?: string
  client_photo_url?: string
}

function formatDate(dt?: string) {
  if (!dt) return ''
  try {
    return new Date(dt).toLocaleDateString('ru', { day: 'numeric', month: 'long' })
  } catch { return '' }
}

function ClientLine({ ev }: { ev: Ev }) {
  const brand = ev.client_brand_name || ev.client_name || 'Организатор'
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
      от {brand}
    </div>
  )
}

function Section({ title, items, onOpen, kind }: {
  title: string
  items: Ev[]
  onOpen: (s: string) => void
  kind: 'now' | 'soon' | 'past'
}) {
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
              <span className={`badge badge-${kind === 'now' ? 'green' : kind === 'past' ? 'gray' : 'gold'}`}>
                {kind === 'now' ? '● Идёт сейчас' : kind === 'past' ? 'Завершено' : 'Скоро'}
              </span>
              <div className="title">{e.title}</div>
              <ClientLine ev={e} />
              {(e.start_at || e.end_at) && (
                <div className="meta">
                  {formatDate(e.start_at)}
                  {e.end_at && e.start_at !== e.end_at ? ` — ${formatDate(e.end_at)}` : ''}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export default function SelectorEventsTab({ tgUser, onOpenEvent, onSwitchToPromo }: Props) {
  const [data, setData] = useState<{ now: Ev[]; soon: Ev[]; past: Ev[] }>({ now: [], soon: [], past: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!tgUser?.id) { setLoading(false); return }
    getMiniAppMyEvents(Number(tgUser.id))
      .then(setData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [tgUser?.id])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 60, color: 'var(--muted)' }}>Загружаем события…</div>
  }

  const empty = !data.now.length && !data.soon.length && !data.past.length
  if (empty || error) {
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
          А что такое ПЛЮСОН? →
        </button>
      </div>
    )
  }

  return (
    <div className="fade-in" style={{ paddingBottom: 16 }}>
      <Section title="🔴 Сейчас идёт" items={data.now}  kind="now"  onOpen={onOpenEvent} />
      <Section title="📅 Скоро"       items={data.soon} kind="soon" onOpen={onOpenEvent} />
      <Section title="✓ Прошли"       items={data.past} kind="past" onOpen={onOpenEvent} />
    </div>
  )
}
