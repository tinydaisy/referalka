import { useState, useEffect } from 'react'
import { getSessions } from '../api'

interface Session {
  id: number
  day: number
  start_datetime: string
  title: string
  speaker_name?: string
  speaker_title?: string
  company?: string
  track_label?: string
  track_color?: string
  gift_description?: string
}

interface Props { event: any }

const PEACH = '#FFCFA4'
const DARK = '#25455D'

export default function ProgramTab({ event }: Props) {
  const isConference = event?.module_slug === 'conference'
  const hasVip = !!event?.has_vip_tariff
  const hasChat = !!event?.chat_url
  const hasStream = !!event?.stream_url || (isConference && !!event?.has_stream)

  const [day, setDay] = useState(1)
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!event?.id) return
    setLoading(true)
    getSessions(event.id, day)
      .then((r: any) => setSessions(r.sessions || []))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [event?.id, day])

  function formatTime(dt: string) {
    if (!dt) return '—:—'
    try { return new Date(dt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) }
    catch { return '—:—' }
  }

  return (
    <div className="fade-in">
      {/* VIP-кнопка наверху (только для конференции) */}
      {isConference && hasVip && (
        <a href={event?.vip_url || '#'} target="_blank" rel="noreferrer" style={{
          display: 'block', textDecoration: 'none',
          background: 'linear-gradient(135deg, #FFCFA4, #d4a574)', color: DARK,
          borderRadius: 14, padding: '14px 16px', marginBottom: 12,
          textAlign: 'center', fontWeight: 900, fontSize: 14,
          letterSpacing: 1, textTransform: 'uppercase',
          boxShadow: '0 4px 12px rgba(255,207,164,0.4)',
        }}>
          {event?.vip_title || 'Оплатить VIP-тариф'}
        </a>
      )}

      {/* Стрим + Чат: 2 колонки */}
      {(hasStream || hasChat) && (
        <div style={{ display: 'grid', gridTemplateColumns: hasStream && hasChat ? '1fr 1fr' : '1fr', gap: 8, marginBottom: 12 }}>
          {hasStream && event?.stream_url && (
            <a href={event.stream_url} target="_blank" rel="noreferrer" style={{
              background: 'linear-gradient(135deg, #25455D, #0a1520)', color: 'white',
              borderRadius: 14, padding: 12, textDecoration: 'none',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <div style={{
                  background: '#d32f2f', color: 'white', fontSize: 11, fontWeight: 900,
                  padding: '8px 12px', borderRadius: 8, letterSpacing: 1.2,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                  <span style={{ width: 6, height: 6, background: 'white', borderRadius: '50%', display: 'inline-block' }}></span>
                  LIVE
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>Стрим</div>
                  <div style={{ fontSize: 10, opacity: 0.7 }}>Эфир идёт</div>
                </div>
              </div>
              <div style={{ background: PEACH, color: DARK, padding: 7, borderRadius: 8,
                            textAlign: 'center', fontWeight: 700, fontSize: 11 }}>
                Смотреть →
              </div>
            </a>
          )}
          {hasChat && (
            <a href={event.chat_url} target="_blank" rel="noreferrer" style={{
              background: 'linear-gradient(135deg, #25455D, #0a1520)', color: 'white',
              borderRadius: 14, padding: 12, textDecoration: 'none',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: 'rgba(255,207,164,0.15)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PEACH} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>Чат</div>
                  <div style={{ fontSize: 10, opacity: 0.7 }}>{event.chat_member_count_label || 'Общение участников'}</div>
                </div>
              </div>
              <div style={{ background: PEACH, color: DARK, padding: 7, borderRadius: 8,
                            textAlign: 'center', fontWeight: 700, fontSize: 11 }}>
                Вступить →
              </div>
            </a>
          )}
        </div>
      )}

      {/* Day switcher (только для конференции с днями) */}
      {isConference && (
        <div className="pills">
          {[1, 2].map(d => (
            <button key={d} className={`pill ${day === d ? 'active' : ''}`} onClick={() => setDay(d)}>
              День {d}
            </button>
          ))}
        </div>
      )}

      <div style={{ padding: '4px 0 16px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 40, color: 'var(--muted)', fontSize: 14 }}>
            Загружаем программу…
          </div>
        ) : sessions.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
            <p style={{ color: 'var(--muted)', fontSize: 14 }}>Программа пока не опубликована</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sessions.map(s => (
              <div key={s.id} className="card" style={{ padding: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span style={{ color: 'var(--muted)', fontSize: 13, fontWeight: 500, minWidth: 44 }}>
                    {formatTime(s.start_datetime)}
                  </span>
                  {s.track_label && (
                    <span style={{
                      background: `${s.track_color || PEACH}20`,
                      color: s.track_color || PEACH,
                      fontSize: 11, padding: '2px 10px', borderRadius: 20, fontWeight: 500,
                      border: `1px solid ${s.track_color || PEACH}40`,
                    }}>{s.track_label}</span>
                  )}
                </div>
                {s.speaker_name && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                      background: 'linear-gradient(45deg, #25455D, #0a1520)',
                      border: `1px solid ${PEACH}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: PEACH, fontWeight: 700, fontSize: 14,
                    }}>{s.speaker_name[0].toUpperCase()}</div>
                    <div>
                      <p style={{ color: 'var(--text)', fontSize: 13, fontWeight: 600 }}>{s.speaker_name}</p>
                      {(s.speaker_title || s.company) && (
                        <p style={{ color: 'var(--muted)', fontSize: 11 }}>
                          {[s.speaker_title, s.company].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>
                )}
                <p style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.4, fontWeight: 600 }}>
                  {s.title}
                </p>
                {s.gift_description && (
                  <div style={{
                    marginTop: 10, padding: '8px 12px', borderRadius: 10,
                    background: 'rgba(255,207,164,0.08)', border: '1px solid rgba(255,207,164,0.2)',
                  }}>
                    <p style={{ color: PEACH, fontSize: 12 }}>🎁 {s.gift_description}</p>
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
