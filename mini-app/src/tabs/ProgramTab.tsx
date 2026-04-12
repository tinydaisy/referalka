import { useState, useEffect } from 'react'
import { getSessions } from '../api'

const MOCK_SESSIONS = [
  {
    id: 1, day: 1, start_datetime: '2026-04-15T10:00:00',
    title: 'Открытие конференции', speaker_name: 'Марго Форбс',
    speaker_title: 'Основатель ПЛЮСОН', company: null,
    track_label: 'Главная', track_color: '#FFCFA4',
    gift_description: null
  },
  {
    id: 2, day: 1, start_datetime: '2026-04-15T11:00:00',
    title: 'Реферальный маркетинг: как заставить аудиторию работать на вас',
    speaker_name: 'Иван Петров', speaker_title: 'Маркетолог', company: 'Marketing Lab',
    track_label: 'Продажи', track_color: '#C084FC',
    gift_description: 'Чек-лист по реферальным программам'
  },
  {
    id: 3, day: 2, start_datetime: '2026-04-16T10:00:00',
    title: 'Автоматизация воронок через Telegram', speaker_name: 'Алексей Сидоров',
    speaker_title: 'Telegram-маркетолог', company: null,
    track_label: 'Telegram', track_color: '#22d3ee',
    gift_description: null
  },
]

interface Props { event: any }

export default function ProgramTab({ event }: Props) {
  const [day, setDay] = useState(1)
  const [sessions, setSessions] = useState(MOCK_SESSIONS)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!event?.id) return
    setLoading(true)
    getSessions(event.id, day)
      .then(r => { if (r.sessions?.length) setSessions(r.sessions) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [event?.id, day])

  const daySessions = sessions.filter(s => s.day === day)

  function formatTime(dt: string) {
    if (!dt) return '—:—'
    try { return new Date(dt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) }
    catch { return '—:—' }
  }

  return (
    <div className="fade-in">
      {/* Day switcher */}
      <div className="pills">
        {[1, 2].map(d => (
          <button key={d} className={`pill ${day === d ? 'active' : ''}`} onClick={() => setDay(d)}>
            День {d}
          </button>
        ))}
      </div>

      <div style={{ padding: '4px 16px 16px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 40, color: 'var(--muted)', fontSize: 14 }}>
            Загружаем программу...
          </div>
        ) : daySessions.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Программа дня {day} пока не опубликована</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {daySessions.map(s => (
              <div key={s.id} className="card" style={{ padding: '14px 14px' }}>
                {/* Time + track */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ color: 'var(--muted)', fontSize: 13, fontWeight: 500, minWidth: 44 }}>
                    {formatTime(s.start_datetime)}
                  </span>
                  {s.track_label && (
                    <span style={{
                      background: `${s.track_color}20`,
                      color: s.track_color || 'var(--peach)',
                      fontSize: 11, padding: '2px 10px', borderRadius: 20, fontWeight: 500,
                      border: `1px solid ${s.track_color}40`
                    }}>
                      {s.track_label}
                    </span>
                  )}
                </div>

                {/* Speaker */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    background: 'linear-gradient(45deg, #25455D, #0a1520)',
                    border: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#FFCFA4', fontWeight: 700, fontSize: 14
                  }}>
                    {(s.speaker_name || '?')[0]}
                  </div>
                  <div>
                    <p style={{ color: 'white', fontSize: 13, fontWeight: 600 }}>{s.speaker_name}</p>
                    {(s.speaker_title || s.company) && (
                      <p style={{ color: 'var(--muted)', fontSize: 11 }}>
                        {[s.speaker_title, s.company].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>

                {/* Title */}
                <p style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, lineHeight: 1.4, fontWeight: 500 }}>
                  {s.title}
                </p>

                {/* Gift */}
                {s.gift_description && (
                  <div style={{
                    marginTop: 10, padding: '8px 12px', borderRadius: 10,
                    background: 'rgba(255,207,164,0.08)', border: '1px solid rgba(255,207,164,0.2)'
                  }}>
                    <p style={{ color: 'var(--peach)', fontSize: 12 }}>
                      🎁 {s.gift_description}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
