import { useState, useEffect } from 'react'
import { getParticipantEvents } from '../api'

const MOCK_EVENTS = [
  { id: 1, slug: 'ivision-7', title: 'iVision Conference 7', module_slug: 'conference', status: 'active', points_total: 3, participant_id: 1, ref_code: 'abc12345' },
]

const MODULE_LABELS: Record<string, string> = {
  base: 'Базовый', conference: 'Конференция', webinar: 'Вебинар',
}

interface Props {
  tgUser: any
  startParams: { partnerId?: string; utmSource?: string }
  onOpenEvent: (slug: string) => void
}

export default function Dashboard({ tgUser, startParams, onOpenEvent }: Props) {
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!tgUser?.id) { setLoading(false); return }
    getParticipantEvents(tgUser.id)
      .then(r => {
        const list = r.events?.length ? r.events : MOCK_EVENTS
        setEvents(list)
        // Если участник записан ровно в одно событие — открываем его сразу
        if (list.length === 1) openEvent(list[0].slug)
      })
      .catch(() => setEvents(MOCK_EVENTS))
      .finally(() => setLoading(false))
  }, [tgUser])

  function openEvent(slug: string) {
    window.history.pushState({}, '', `/event/${slug}`)
    onOpenEvent(slug)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Header */}
      <div className="grad-header" style={{ paddingTop: 20, paddingBottom: 20, paddingLeft: 16, paddingRight: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ color: 'rgba(255,207,164,0.7)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              ПЛЮСОН
            </p>
            <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700, marginTop: 4 }}>
              Привет, {tgUser?.first_name || 'участник'}!
            </h1>
          </div>
          <div style={{
            width: 42, height: 42, borderRadius: '50%',
            background: 'rgba(255,207,164,0.15)', border: '2px solid rgba(255,207,164,0.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#FFCFA4', fontWeight: 700, fontSize: 18
          }}>
            {(tgUser?.first_name || 'U')[0]}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="page" style={{ padding: '16px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60, color: 'var(--muted)' }}>Загружаем события...</div>
        ) : events.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 60 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🚀</div>
            <p style={{ color: 'white', fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Пока нет событий</p>
            <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
              Перейдите по ссылке организатора,<br />чтобы участвовать в реферальной игре
            </p>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>Ваши события</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {events.map(ev => (
                <div
                  key={ev.id}
                  className="card fade-in"
                  onClick={() => openEvent(ev.slug)}
                  style={{ cursor: 'pointer', overflow: 'hidden', padding: 0 }}
                >
                  {/* Event banner */}
                  <div style={{
                    background: 'linear-gradient(45deg, #25455D, #0a1520)',
                    padding: '16px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                  }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span className={`badge badge-${ev.status === 'active' ? 'green' : 'gray'}`}>
                          {ev.status === 'active' ? '● Активно' : 'Завершено'}
                        </span>
                        <span className="badge badge-gold">{MODULE_LABELS[ev.module_slug] || ev.module_slug}</span>
                      </div>
                      <h3 style={{ color: 'white', fontSize: 16, fontWeight: 600 }}>{ev.title}</h3>
                    </div>
                    <span style={{ color: 'rgba(255,207,164,0.6)', fontSize: 20 }}>›</span>
                  </div>

                  {/* Progress */}
                  <div style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ color: 'var(--muted)', fontSize: 13 }}>Приглашено</span>
                      <span style={{ color: 'var(--peach)', fontWeight: 700 }}>{ev.points_total || 0} чел.</span>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${Math.min((ev.points_total || 0) * 20, 100)}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
