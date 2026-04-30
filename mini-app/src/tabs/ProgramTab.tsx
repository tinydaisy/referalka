import { useState, useEffect, useRef, useMemo } from 'react'
import { getSessions, getSpeakers, getDays } from '../api'

interface Session {
  id: number
  day: number
  start_time?: string
  end_time?: string
  title: string
  speaker_event_id?: number
  speaker_name?: string
  speaker_title?: string
  speaker_role?: string
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
  speaker_id?: number
  name: string
  title?: string
  photo_url?: string
  role?: string
  achievements?: string[] | null
  tg_channel_url?: string | null
  instagram_url?: string | null
  personal_tg_username?: string | null
  speaker_topic?: string | null
  gift_after_speech_title?: string | null
  gift_after_speech_url?: string | null
  gift_raffle_title?: string | null
  gift_raffle_url?: string | null
  topics?: { topic: string }[]
}

interface Props { event: any }

const PEACH = '#FFCFA4'
const DARK = '#25455D'

// Пастельные фоны для чередования карточек спикеров (наши бренд-цвета,
// слегка приглушённые — чтобы карточки не сливались).
const PASTELS = ['#fff8f0', '#f0f5fb', '#fbf2f0', '#f3f5f0', '#fdf6e8', '#f5f0fb']

const ROLE_LABELS: Record<string, string> = {
  speaker:    'Спикер',
  headliner:  'Хедлайнер',
  partner:    'Партнёр',
  organizer:  'Организатор',
}

const ROLE_COLORS: Record<string, { bg: string; fg: string }> = {
  speaker:    { bg: 'rgba(37,69,93,0.08)',     fg: DARK },
  headliner:  { bg: 'rgba(255,207,164,0.25)',  fg: '#a86b2c' },
  partner:    { bg: 'rgba(76,175,80,0.12)',    fg: '#2e7d32' },
  organizer:  { bg: 'rgba(156,39,176,0.10)',   fg: '#6a1b9a' },
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

function fmtDate(d?: string) {
  if (!d) return ''
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return d
  return `${parseInt(m[3], 10)} ${MONTHS[parseInt(m[2], 10) - 1]}`
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
function tgLink(url?: string | null, username?: string | null): string | null {
  if (url && /^https?:\/\//i.test(url)) return url
  if (url && url.startsWith('@')) return `https://t.me/${url.slice(1)}`
  if (url) return `https://t.me/${url}`
  if (username) return `https://t.me/${username.replace(/^@/, '')}`
  return null
}

// Блок стрима показывается ТОЛЬКО в дни события — не раньше и не позже.
// Окно: от 00:00 первого дня (start_at) до 23:59 последнего дня (end_at).
// Для конференций start_at/end_at в API уже считаются как MIN/MAX из conf_days.
function isStreamDay(event: any): boolean {
  if (!event?.start_at) return false
  const start = new Date(event.start_at)
  if (isNaN(start.getTime())) return false
  const end = event.end_at ? new Date(event.end_at) : start
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0)
  const endDay   = new Date(end.getFullYear(),   end.getMonth(),   end.getDate(),   23, 59, 59)
  const now = new Date()
  return now >= startDay && now <= endDay
}

export default function ProgramTab({ event }: Props) {
  const isConference = event?.module_slug === 'conference'
  // Кнопка VIP появляется если у события вписан vip_url
  // (единый источник истины в events.vip_url).
  const vipUrl  = event?.vip_url || ''
  const hasVip  = !!vipUrl
  const hasChat = !!event?.chat_url
  const hasStream = !!event?.stream_url && isStreamDay(event)

  const [days, setDays] = useState<Day[]>([])
  const [sessionsByDay, setSessionsByDay] = useState<Record<number, Session[]>>({})
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [openDay, setOpenDay] = useState<number | null>(null)
  const [loadingDay, setLoadingDay] = useState<number | null>(null)
  const [highlightSpeakerId, setHighlightSpeakerId] = useState<number | null>(null)

  const speakersScrollRef = useRef<HTMLDivElement | null>(null)
  const speakerCardRefs   = useRef<Record<number, HTMLDivElement | null>>({})

  // Загрузка дней + спикеров
  useEffect(() => {
    if (!event?.id || !isConference) return
    Promise.all([
      getDays(event.id).then((r: any) => r.days as Day[]).catch(() => []),
      getSpeakers(event.id).then((r: any) => r.speakers as Speaker[]).catch(() => []),
    ]).then(([d, sp]) => {
      setDays(d)
      setSpeakers(sp)
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

  // Авто-скролл ленты спикеров (через requestAnimationFrame — стабильнее
  // setInterval на iOS Telegram WebApp; шаг считаем от dt в мс)
  useEffect(() => {
    const el = speakersScrollRef.current
    if (!el || speakers.length === 0) return
    let raf = 0
    let last = 0
    let paused = false
    const onTouch = () => { paused = true; setTimeout(() => { paused = false }, 4000) }
    el.addEventListener('touchstart', onTouch, { passive: true })
    el.addEventListener('mousedown',  onTouch)

    const SPEED = 35  // px в секунду

    const tick = (t: number) => {
      if (last && !paused) {
        const dt = t - last
        const half = el.scrollWidth / 2
        if (half > 0) {
          el.scrollLeft += (dt / 1000) * SPEED
          if (el.scrollLeft >= half) el.scrollLeft -= half
        }
      }
      last = t
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('touchstart', onTouch)
      el.removeEventListener('mousedown',  onTouch)
    }
  }, [speakers.length])

  const formatTimeMsk = (start?: string, end?: string) => {
    if (!start && !end) return '—:—'
    if (start && end) return `${start.slice(0, 5)}–${end.slice(0, 5)} МСК`
    return `${(start || end || '').slice(0, 5)} МСК`
  }

  // Дублируем массив для бесшовного auto-scroll
  const speakersLoop = useMemo(() => [...speakers, ...speakers], [speakers])

  const goToSpeaker = (speakerEventId?: number) => {
    if (!speakerEventId) return
    const card = speakerCardRefs.current[speakerEventId]
    if (!card) return
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightSpeakerId(speakerEventId)
    setTimeout(() => setHighlightSpeakerId(null), 1800)
  }

  return (
    <div className="fade-in">
      {/* Авто-скролл лента спикеров */}
      {isConference && speakers.length > 0 && (
        <div
          ref={speakersScrollRef}
          style={{
            display: 'flex', gap: 12, overflowX: 'auto', padding: '4px 0 12px',
            marginLeft: -16, marginRight: -16, paddingLeft: 16, paddingRight: 16,
            scrollbarWidth: 'none',
          }}
        >
          {speakersLoop.map((sp, i) => {
            const parts = (sp.name || '').trim().split(/\s+/)
            const firstName = parts[0] || ''
            const lastName  = parts.slice(1).join(' ')
            return (
              <button
                key={`${sp.id}-${i}`}
                onClick={() => goToSpeaker(sp.id)}
                style={{
                  flexShrink: 0, width: 64, textAlign: 'center',
                  background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
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
                <div style={{ fontSize: 10, lineHeight: 1.15, color: '#1a2a3a', fontWeight: 700,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {firstName}
                </div>
                {lastName && (
                  <div style={{ fontSize: 10, lineHeight: 1.15, color: '#1a2a3a', fontWeight: 700,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lastName}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* VIP */}
      {isConference && hasVip && (
        <a href={vipUrl} target="_blank" rel="noreferrer" style={{
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

      {/* Стрим — отдельная плашка во всю ширину */}
      {hasStream && event?.stream_url && (
        <a href={event.stream_url} target="_blank" rel="noreferrer" style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'linear-gradient(135deg, #25455D, #0a1520)', color: 'white',
          borderRadius: 14, padding: 14, textDecoration: 'none', marginBottom: 10,
        }}>
          <div style={{
            background: '#d32f2f', color: 'white', fontSize: 11, fontWeight: 900,
            padding: '8px 12px', borderRadius: 8, letterSpacing: 1.2,
            display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0,
          }}>
            <span style={{ width: 6, height: 6, background: 'white', borderRadius: '50%', display: 'inline-block' }}/>
            LIVE
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800 }}>Смотреть стрим</div>
            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>Эфир уже идёт — подключайтесь</div>
          </div>
          <div style={{ fontSize: 24, color: PEACH, fontWeight: 600, marginRight: 4 }}>›</div>
        </a>
      )}

      {/* Чат события — отдельная плашка во всю ширину */}
      {hasChat && (
        <>
          <a href={event.chat_url} target="_blank" rel="noreferrer" style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'linear-gradient(135deg, #25455D, #0a1520)', color: 'white',
            borderRadius: 14, padding: 14, textDecoration: 'none',
            marginBottom: event?.require_subscription ? 0 : 12,
            borderBottomLeftRadius:  event?.require_subscription ? 0 : 14,
            borderBottomRightRadius: event?.require_subscription ? 0 : 14,
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(255,207,164,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PEACH} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>Чат события</div>
              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                {event.chat_member_count_label || 'Общение участников и спикеров'}
              </div>
            </div>
            <div style={{ fontSize: 24, color: PEACH, fontWeight: 600, marginRight: 4 }}>›</div>
          </a>

          {/* Условие входа в чат — переиспользуем общее «Требование подписки»
              события (events.require_subscription). Для конференций — подписки
              на организатора и спикеров; для мероприятий — только на организатора. */}
          {event?.require_subscription && (
            <div style={{
              background: PEACH, color: DARK,
              borderTop: '1px solid rgba(37,69,93,0.15)',
              borderRadius: '0 0 14px 14px', padding: '10px 14px',
              fontSize: 12, fontWeight: 700, lineHeight: 1.4, marginBottom: 12,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={DARK} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8"  x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>
                {isConference
                  ? 'Чтобы войти в чат, подпишитесь на каналы организатора и спикеров'
                  : 'Чтобы войти в чат, подпишитесь на канал организатора'}
              </span>
            </div>
          )}
        </>
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
                  background: accent ? 'linear-gradient(135deg, #fff8f0, white)' : 'white',
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
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d32f2f',
                                         display: 'inline-block' }}/>
                        )}
                        {dayLabel}
                      </div>
                      {dateLabel && (
                        <div style={{ fontSize: 11, color: '#6b7c8e', marginTop: 2 }}>{dateLabel}</div>
                      )}
                    </div>
                    <div style={{ fontSize: 18, color: '#c5cdd6',
                                  transform: isOpen ? 'rotate(90deg)' : 'none',
                                  transition: 'transform 0.2s' }}>▸</div>
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
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {(sessionsByDay[d.day_number] || []).map((s, idx) => {
                            const speakerRoleLabel = s.speaker_role && ROLE_LABELS[s.speaker_role]
                            const roleColors = (s.speaker_role && ROLE_COLORS[s.speaker_role]) || ROLE_COLORS.speaker
                            // Чередуем фон: чётные — белые, нечётные — полупрозрачный бирюзовый
                            const altBg = idx % 2 === 0 ? 'white' : 'rgba(37,69,93,0.13)'
                            return (
                              <div key={s.id} style={{
                                background: altBg,
                                border: '1px solid rgba(37,69,93,0.20)',
                                borderRadius: 12,
                                padding: '10px 10px',
                                // Тонкая полоса-разделитель сверху между слотами
                                marginTop: idx === 0 ? 0 : 4,
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                  {/* Время — ЖИРНОЕ */}
                                  <span style={{ color: DARK, fontSize: 13, fontWeight: 800 }}>
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

                                <p style={{ color: '#1a2a3a', fontSize: 14, lineHeight: 1.4,
                                            fontWeight: 700, marginBottom: 8 }}>
                                  {s.title}
                                </p>

                                {s.speaker_name && (
                                  <button
                                    onClick={() => goToSpeaker(s.speaker_event_id)}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                                      background: 'white', border: `1px solid rgba(37,69,93,0.12)`,
                                      borderRadius: 10, padding: '8px 10px', cursor: 'pointer',
                                      fontFamily: 'inherit', textAlign: 'left',
                                    }}
                                  >
                                    <div style={{
                                      width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                                      background: s.photo_url
                                        ? `center/cover url(${s.photo_url})`
                                        : 'linear-gradient(45deg, #25455D, #0a1520)',
                                      border: `1.5px solid ${PEACH}`,
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      color: PEACH, fontWeight: 700, fontSize: 12,
                                    }}>
                                      {!s.photo_url && initials(s.speaker_name)}
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0,
                                                  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      <span style={{ color: '#1a2a3a', fontSize: 12, fontWeight: 700 }}>
                                        {s.speaker_name}
                                      </span>
                                      {speakerRoleLabel && (
                                        <span style={{
                                          background: roleColors.bg, color: roleColors.fg,
                                          fontSize: 9, padding: '2px 7px', borderRadius: 10, fontWeight: 700,
                                          textTransform: 'uppercase', letterSpacing: 0.4,
                                        }}>{speakerRoleLabel}</span>
                                      )}
                                    </div>
                                    {/* Карточка → по правому краю */}
                                    <span style={{
                                      flexShrink: 0, color: DARK, fontSize: 11, fontWeight: 700,
                                      whiteSpace: 'nowrap',
                                    }}>
                                      Карточка →
                                    </span>
                                  </button>
                                )}
                              </div>
                            )
                          })}
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

      {!isConference && (
        <div style={{ textAlign: 'center', paddingTop: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Программа пока не опубликована</p>
        </div>
      )}

      {/* Карточки спикеров — расширенная информация (как в шаблоне рассылки speaker_intro) */}
      {isConference && speakers.length > 0 && (
        <>
          {/* Жирная разделительная плашка между программой и спикерами */}
          <div style={{
            background: 'linear-gradient(45deg, #25455D, #0a1520)',
            color: PEACH,
            padding: '14px 16px',
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 900,
            textTransform: 'uppercase',
            letterSpacing: 2,
            textAlign: 'center',
            margin: '24px 0 12px',
            borderTop: `2px solid ${PEACH}`,
            borderBottom: `2px solid ${PEACH}`,
            boxShadow: '0 4px 12px rgba(37,69,93,0.15)',
          }}>
            Спикеры конференции
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 16 }}>
            {speakers.map((sp, idx) => {
              const roleLabel = sp.role && ROLE_LABELS[sp.role]
              const roleColors = (sp.role && ROLE_COLORS[sp.role]) || ROLE_COLORS.speaker
              // Берём ВСЕ темы (у Марго их две, например по дням)
              const topicsList: string[] = Array.isArray(sp.topics) && sp.topics.length > 0
                ? sp.topics.map(t => t.topic).filter(Boolean)
                : (sp.speaker_topic ? [sp.speaker_topic] : [])
              const tg = tgLink(sp.tg_channel_url, sp.personal_tg_username)
              const insta = sp.instagram_url
                ? (sp.instagram_url.startsWith('http') ? sp.instagram_url : `https://instagram.com/${sp.instagram_url.replace(/^@/, '')}`)
                : null
              const ach = (sp.achievements || []).filter(a => a && a.trim())
              const isHighlighted = highlightSpeakerId === sp.id
              return (
                <div
                  key={sp.id}
                  ref={el => { speakerCardRefs.current[sp.id] = el }}
                  style={{
                    background: PASTELS[idx % PASTELS.length],
                    borderRadius: 14, padding: 14,
                    boxShadow: '0 2px 8px rgba(37,69,93,0.05)',
                    border: isHighlighted ? `2px solid ${PEACH}` : '2px solid transparent',
                    transition: 'border-color 0.3s',
                  }}
                >
                  {/* Шапка карточки */}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
                    <div style={{
                      width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
                      background: sp.photo_url
                        ? `center/cover url(${sp.photo_url})`
                        : 'linear-gradient(45deg, #25455D, #0a1520)',
                      border: `2px solid ${PEACH}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: PEACH, fontWeight: 700, fontSize: 18,
                    }}>
                      {!sp.photo_url && initials(sp.name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {roleLabel && (
                        <span style={{
                          display: 'inline-block', background: roleColors.bg, color: roleColors.fg,
                          fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 700,
                          textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4,
                        }}>{roleLabel}</span>
                      )}
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2a3a', lineHeight: 1.2 }}>
                        {sp.name}
                      </div>
                      {sp.title && (
                        <div style={{ fontSize: 12, color: '#6b7c8e', marginTop: 2, lineHeight: 1.3 }}>
                          {sp.title}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Темы выступлений (может быть несколько по дням) */}
                  {topicsList.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase',
                                    letterSpacing: 0.4, fontWeight: 700, marginBottom: 4 }}>
                        {topicsList.length > 1 ? 'Темы' : 'Тема'}
                      </div>
                      {topicsList.map((t, ti) => (
                        <div key={ti} style={{ fontSize: 13, color: '#1a2a3a', fontWeight: 600,
                                                lineHeight: 1.35, marginBottom: ti < topicsList.length - 1 ? 6 : 0 }}>
                          {t}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Регалии — без заголовка, маркер тёмно-бирюзовый */}
                  {ach.length > 0 && (
                    <ul style={{ margin: '0 0 8px', padding: 0, listStyle: 'none' }}>
                      {ach.map((a, i) => (
                        <li key={i} style={{ fontSize: 12, color: '#3a4a5a', lineHeight: 1.4,
                                              paddingLeft: 14, position: 'relative', marginBottom: 3 }}>
                          <span style={{ position: 'absolute', left: 0, top: -1, color: DARK,
                                          fontWeight: 700, fontSize: 14 }}>•</span>
                          {a}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Подарок на эфире */}
                  {sp.gift_after_speech_title && (
                    <div style={{
                      marginTop: 8, padding: '8px 10px', borderRadius: 10,
                      background: 'rgba(255,207,164,0.18)', border: '1px solid rgba(255,207,164,0.35)',
                    }}>
                      <div style={{ fontSize: 10, color: '#a86b2c', textTransform: 'uppercase',
                                    letterSpacing: 0.4, fontWeight: 700, marginBottom: 2 }}>
                        🎁 Подарок на эфире
                      </div>
                      <div style={{ fontSize: 12, color: '#1a2a3a', fontWeight: 600 }}>
                        {sp.gift_after_speech_title}
                      </div>
                    </div>
                  )}

                  {/* Подарок в розыгрыше */}
                  {sp.gift_raffle_title && (
                    <div style={{
                      marginTop: 8, padding: '8px 10px', borderRadius: 10,
                      background: 'rgba(156,39,176,0.06)', border: '1px solid rgba(156,39,176,0.18)',
                    }}>
                      <div style={{ fontSize: 10, color: '#6a1b9a', textTransform: 'uppercase',
                                    letterSpacing: 0.4, fontWeight: 700, marginBottom: 2 }}>
                        🎟 Подарок в розыгрыше
                      </div>
                      <div style={{ fontSize: 12, color: '#1a2a3a', fontWeight: 600 }}>
                        {sp.gift_raffle_title}
                      </div>
                    </div>
                  )}

                  {/* Соцсети */}
                  {(tg || insta) && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      {tg && (
                        <a href={tg} target="_blank" rel="noreferrer" style={{
                          flex: 1, textDecoration: 'none',
                          background: DARK, color: 'white',
                          padding: '7px 10px', borderRadius: 10,
                          fontSize: 11, fontWeight: 600, textAlign: 'center',
                        }}>Тг-канал →</a>
                      )}
                      {insta && (
                        <a href={insta} target="_blank" rel="noreferrer" style={{
                          flex: 1, textDecoration: 'none',
                          background: 'white', color: DARK, border: `1px solid ${DARK}`,
                          padding: '6px 10px', borderRadius: 10,
                          fontSize: 11, fontWeight: 600, textAlign: 'center',
                        }}>Нельзяграм →</a>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
