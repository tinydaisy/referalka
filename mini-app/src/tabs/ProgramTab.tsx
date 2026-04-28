import { useState, useEffect, useMemo } from 'react'
import { getSessions, getSpeakers, getDays } from '../api'

interface Session {
  id: number
  day: number
  start_time?: string
  end_time?: string
  title: string
  speaker_name?: string
  speaker_title?: string
  photo_url?: string
  track_label?: string
  track_color?: string
  gift_description?: string
}

interface Day {
  day_number: number
  day_date?: string
  open_time?: string
  close_time?: string
}

interface Speaker {
  id: number
  name: string
  title?: string
  photo_url?: string
  role?: string
}

interface Props { event: any }

const PEACH = '#FFCFA4'
const DARK = '#25455D'

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
function fmtDate(d?: string) {
  if (!d) return ''
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return d
  const day = parseInt(m[3], 10)
  const month = parseInt(m[2], 10) - 1
  return `${day} ${MONTHS[month]}`
}
function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayState(day: Day): 'past' | 'today' | 'future' {
  if (!day.day_date) return 'future'
  const t = todayIso()
  if (day.day_date < t) return 'past'
  if (day.day_date > t) return 'future'
  return 'today'
}

function initials(name?: string) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  return (parts[0]?.[0] || '').toUpperCase() + (parts[1]?.[0] || '').toUpperCase()
}

export default function ProgramTab({ event }: Props) {
  const isConference = event?.module_slug === 'conference'
  const hasVip = !!event?.has_vip_tariff
  const hasChat = !!event?.chat_url
  const hasStream = !!event?.stream_url

  const [days, setDays] = useState<Day[]>([])
  const [sessionsByDay, setSessionsByDay] = useState<Record<number, Session[]>>({})
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [openDay, setOpenDay] = useState<number | null>(null)
  const [loadingDay, setLoadingDay] = useState<number | null>(null)

  // Загружаем дни и спикеров (только для конференции)
  useEffect(() => {
    if (!event?.id || !isConference) return
    Promise.all([
      getDays(event.id).then((r: any) => r.days as Day[]).catch(() => []),
      getSpeakers(event.id).then((r: any) => r.speakers as Speaker[]).catch(() => []),
    ]).then(([d, sp]) => {
      setDays(d)
      setSpeakers(sp)
      // По умолчанию раскрываем сегодняшний день, иначе ближайший будущий, иначе первый
      const today = d.find(x => dayState(x) === 'today')
      const future = d.find(x => dayState(x) === 'future')
      setOpenDay(today?.day_number || future?.day_number || d[0]?.day_number || null)
    })
  }, [event?.id, isConference])

  // Лениво грузим сессии раскрываемого дня
  useEffect(() => {
    if (!event?.id || openDay == null) return
    if (sessionsByDay[openDay]) return
    setLoadingDay(openDay)
    getSessions(event.id, openDay)
      .then((r: any) => setSessionsByDay(prev => ({ ...prev, [openDay]: r.sessions || [] })))
      .catch(() => setSessionsByDay(prev => ({ ...prev, [openDay]: [] })))
      .finally(() => setLoadingDay(null))
  }, [event?.id, openDay])

  const formatTimeMsk = (start?: string, end?: string) => {
    if (!start && !end) return '—:—'
    if (start && end) return `${start.slice(0, 5)}–${end.slice(0, 5)} МСК`
    return `${(start || end || '').slice(0, 5)} МСК`
  }

  const sortedSpeakers = useMemo(() => speakers, [speakers])

  return (
    <div className="fade-in">
      {/* Скролл спикеров наверху (макет: горизонтальная лента кружков) */}
      {isConference && sortedSpeakers.length > 0 && (
        <div style={{
          display: 'flex', gap: 12, overflowX: 'auto', padding: '4px 2px 12px',
          marginLeft: -16, marginRight: -16, paddingLeft: 16, paddingRight: 16,
          scrollbarWidth: 'none',
        }}>
          {sortedSpeakers.map(sp => (
            <div key={sp.id} style={{ flexShrink: 0, width: 60, textAlign: 'center' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%', margin: '0 auto 4px',
                background: sp.photo_url
                  ? `center/cover url(${sp.photo_url})`
                  : 'linear-gradient(45deg, #25455D, #0a1520)',
                border: `1.5px solid ${PEACH}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: PEACH, fontWeight: 700, fontSize: 16,
              }}>
                {!sp.photo_url && initials(sp.name)}
              </div>
              <div style={{
                fontSize: 10, lineHeight: 1.2, color: 'var(--muted)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {sp.name?.split(' ')[0]}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* VIP-кнопка */}
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

      {/* Стрим + Чат */}
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
                            textAlign: 'center', fontWeight: 700, fontSize: 11 }}>Смотреть →</div>
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
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
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
                            textAlign: 'center', fontWeight: 700, fontSize: 11 }}>Вступить →</div>
            </a>
          )}
        </div>
      )}

      {/* Программа по дням — аккордеон */}
      {isConference && days.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', margin: '6px 2px 8px' }}>
            Программа по дням
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {days.map(d => {
              const state = dayState(d)
              const isOpen = openDay === d.day_number
              const dayLabel = `День ${d.day_number}`
              const dateLabel = d.day_date
                ? `${fmtDate(d.day_date)} · ${state === 'past' ? 'завершён' : state === 'today' ? 'идёт сейчас' : 'впереди'}`
                : ''
              const accent = state === 'today'
              return (
                <div key={d.day_number} style={{
                  background: accent
                    ? 'linear-gradient(135deg, #fff8f0, white)'
                    : 'white',
                  borderRadius: 12,
                  border: accent ? `1px solid ${PEACH}` : '1px solid transparent',
                  boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
                  overflow: 'hidden',
                  opacity: state === 'past' && !isOpen ? 0.7 : 1,
                }}>
                  <button
                    onClick={() => setOpenDay(isOpen ? null : d.day_number)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between', padding: '12px 14px',
                      background: 'transparent', border: 0, cursor: 'pointer',
                      fontFamily: 'inherit', textAlign: 'left',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1a2a3a',
                                    display: 'flex', alignItems: 'center', gap: 6 }}>
                        {state === 'today' && (
                          <span style={{
                            width: 8, height: 8, borderRadius: '50%', background: '#d32f2f',
                            display: 'inline-block',
                          }}/>
                        )}
                        {dayLabel}
                      </div>
                      {dateLabel && (
                        <div style={{ fontSize: 11, color: '#6b7c8e', marginTop: 2 }}>{dateLabel}</div>
                      )}
                    </div>
                    <div style={{
                      fontSize: 18, color: '#c5cdd6',
                      transform: isOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform 0.2s',
                    }}>▸</div>
                  </button>

                  {isOpen && (
                    <div style={{ padding: '0 14px 12px' }}>
                      {loadingDay === d.day_number ? (
                        <div style={{ padding: '16px 0', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                          Загружаем…
                        </div>
                      ) : (sessionsByDay[d.day_number] || []).length === 0 ? (
                        <div style={{ padding: '16px 0', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                          Сессий пока нет
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {(sessionsByDay[d.day_number] || []).map(s => (
                            <div key={s.id} style={{
                              borderTop: '1px solid #eef1f4', paddingTop: 10,
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                <span style={{ color: 'var(--muted)', fontSize: 13, fontWeight: 500 }}>
                                  {formatTimeMsk(s.start_time, s.end_time)}
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
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                  <div style={{
                                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                                    background: s.photo_url
                                      ? `center/cover url(${s.photo_url})`
                                      : 'linear-gradient(45deg, #25455D, #0a1520)',
                                    border: `1px solid ${PEACH}`,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: PEACH, fontWeight: 700, fontSize: 11,
                                  }}>
                                    {!s.photo_url && initials(s.speaker_name)}
                                  </div>
                                  <p style={{ color: 'var(--text)', fontSize: 12, fontWeight: 600 }}>{s.speaker_name}</p>
                                </div>
                              )}
                              <p style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.4, fontWeight: 600 }}>
                                {s.title}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Если не конференция — простой плоский список сессий (как было) */}
      {!isConference && (
        <div style={{ textAlign: 'center', paddingTop: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Программа пока не опубликована</p>
        </div>
      )}

      {/* Карточки спикеров под программой */}
      {isConference && sortedSpeakers.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)', margin: '6px 2px 8px' }}>
            Спикеры конференции
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 16 }}>
            {sortedSpeakers.map(sp => (
              <div key={sp.id} style={{
                background: 'white', borderRadius: 12, padding: 10,
                display: 'flex', gap: 10, alignItems: 'center',
                boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
                  background: sp.photo_url
                    ? `center/cover url(${sp.photo_url})`
                    : 'linear-gradient(45deg, #25455D, #0a1520)',
                  border: `1.5px solid ${PEACH}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: PEACH, fontWeight: 700, fontSize: 14,
                }}>
                  {!sp.photo_url && initials(sp.name)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {sp.role && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase',
                                  letterSpacing: 0.5, fontWeight: 600, marginBottom: 1 }}>
                      {sp.role}
                    </div>
                  )}
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {sp.name}
                  </div>
                  {sp.title && (
                    <div style={{ fontSize: 11, color: '#6b7c8e',
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {sp.title}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
