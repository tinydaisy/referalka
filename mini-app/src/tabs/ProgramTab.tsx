import { useState, useEffect, useRef, useMemo } from 'react'
import { getSessions, getSpeakers, getDays, checkConferenceSubscription, getEventCollaborators } from '../api'

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

interface Props { event: any; tgUser?: any; refreshKey?: number }

// Сейчас в Москве — "YYYY-MM-DD" и "HH:MM" (24ч), без зависимости от
// часового пояса устройства. Используется для выделения активной сессии.
function nowMsk(): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = fmt.formatToParts(new Date())
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  }
}

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

// Форматирует дату-вилку события для шапки Программы (мероприятия).
// Один день:    "03.05.2026 10:00–11:30 МСК"
// Разные дни:   "03.05.2026 10:00 — 04.05.2026 11:30 МСК"
// Только старт: "03.05.2026 10:00 МСК"
function formatEventDateRange(startAt?: string | null, endAt?: string | null): string {
  if (!startAt) return ''
  const tz = 'Europe/Moscow'
  const partsOf = (iso: string) => {
    const dt = new Date(iso)
    if (isNaN(dt.getTime())) return null
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const o: Record<string, string> = {}
    for (const p of fmt.formatToParts(dt)) o[p.type] = p.value
    return {
      date: `${o.day}.${o.month}.${o.year}`,
      time: `${o.hour}:${o.minute}`,
    }
  }
  const s = partsOf(startAt)
  if (!s) return ''
  if (!endAt) return `${s.date} ${s.time} МСК`
  const e = partsOf(endAt)
  if (!e) return `${s.date} ${s.time} МСК`
  if (s.date === e.date) return `${s.date} ${s.time}–${e.time} МСК`
  return `${s.date} ${s.time} — ${e.date} ${e.time} МСК`
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

// Блок стрима показывается ТОЛЬКО в дни события.
// Для конференций — если сегодня = одна из дат `conf_days.day_date`
// (поддерживает любые конфигурации, в т.ч. дни с пропусками).
// Для одиночных событий — если сегодня попадает в [start_at..end_at].
function isStreamDay(event: any, days: Day[]): boolean {
  const today = todayIso()
  if (event?.module_slug === 'conference' && days.length > 0) {
    return days.some(d => d.day_date === today)
  }
  if (!event?.start_at) return false
  const start = new Date(event.start_at)
  if (isNaN(start.getTime())) return false
  const end = event.end_at ? new Date(event.end_at) : start
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0)
  const endDay   = new Date(end.getFullYear(),   end.getMonth(),   end.getDate(),   23, 59, 59)
  const now = new Date()
  return now >= startDay && now <= endDay
}

export default function ProgramTab({ event, tgUser, refreshKey }: Props) {
  const isConference = event?.module_slug === 'conference'
  // Кнопка VIP появляется если у события вписан vip_url
  // (единый источник истины в events.vip_url).
  const vipUrl  = event?.vip_url || ''
  const hasVip  = !!vipUrl
  const hasChat = !!event?.chat_url

  const [days, setDays] = useState<Day[]>([])
  const [sessionsByDay, setSessionsByDay] = useState<Record<number, Session[]>>({})
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  // Соорганизаторы — только для не-конф мероприятий (role='organizer' в event_collaborators)
  const [coOrganizers, setCoOrganizers] = useState<Speaker[]>([])
  const [openDay, setOpenDay] = useState<number | null>(null)
  const [loadingDay, setLoadingDay] = useState<number | null>(null)
  const [highlightSpeakerId, setHighlightSpeakerId] = useState<number | null>(null)
  // Текущее время МСК: для подсветки сессии, которая идёт прямо сейчас.
  // Обновляется при возврате на вкладку (refreshKey) и каждые 30 секунд.
  const [nowTs, setNowTs] = useState(() => nowMsk())

  useEffect(() => {
    setNowTs(nowMsk())
    const t = setInterval(() => setNowTs(nowMsk()), 30000)
    return () => clearInterval(t)
  }, [refreshKey])

  // Блок стрима показываем всегда если URL задан. В день вебинара /
  // один из дней конференции — активная ссылка с LIVE-значком.
  // В остальные дни — неактивная плашка-«заглушка» с пояснением.
  const hasStream = !!event?.stream_url
  const streamLive = hasStream && isStreamDay(event, days)

  const speakersScrollRef = useRef<HTMLDivElement | null>(null)
  const speakerCardRefs   = useRef<Record<number, HTMLDivElement | null>>({})

  // Гейт чата: при тапе на плитку проверяем подписку на каналы организатора /
  // спикеров (зависит от subscription_mode конференции). Если подписан — открываем
  // чат сразу, если нет — показываем модалку со списком каналов и кнопкой
  // «Я подписался — проверить ещё раз».
  type SubChannel = { speaker_id: number; name: string; tg_channel_id: string; tg_channel_url: string | null }
  const [chatGate, setChatGate] = useState<{
    loading: boolean
    notSubscribed: SubChannel[] | null
    subscribed: SubChannel[]
    error?: string | null
  }>({ loading: false, notSubscribed: null, subscribed: [] })

  // Открываем ссылку через Telegram WebApp SDK — window.open в Mini App
  // не работает (silently fails). Для t.me-ссылок — openTelegramLink, для
  // остальных — openLink. Браузер-фолбэк только если SDK недоступен.
  function openExternal(url: string) {
    const tg = (window as any).Telegram?.WebApp
    if (tg?.openTelegramLink && /^https?:\/\/t\.me\//i.test(url)) {
      tg.openTelegramLink(url)
      return
    }
    if (tg?.openLink) {
      tg.openLink(url)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  // [DEBUG TEMP] последний результат запроса для отладки
  const [debugInfo, setDebugInfo] = useState<string>('')

  async function openChatWithCheck() {
    if (!event?.chat_url) return
    const needsCheck = isConference || !!event?.require_subscription
    if (!needsCheck || !event?.id || !tgUser?.id) {
      setDebugInfo(`ПРОПУЩЕНО: needsCheck=${needsCheck} eventId=${event?.id} tgId=${tgUser?.id || '(пусто)'} module=${event?.module_slug} require_sub=${event?.require_subscription} isConf=${isConference}`)
      openExternal(event.chat_url)
      return
    }
    setDebugInfo(`ИДЁТ: tgId=${tgUser.id} eventId=${event.id}`)
    setChatGate({ loading: true, notSubscribed: null, subscribed: [], error: null })
    try {
      const r: any = await checkConferenceSubscription(event.id, tgUser.id)
      setDebugInfo(`ОТВЕТ: status=${r?.status} not_sub=${(r?.not_subscribed || []).length} sub=${(r?.subscribed || []).length}`)
      if (r?.status === 1) {
        setChatGate({ loading: false, notSubscribed: null, subscribed: [] })
        openExternal(event.chat_url)
      } else {
        setChatGate({
          loading: false,
          notSubscribed: r?.not_subscribed || [],
          subscribed: r?.subscribed || [],
        })
      }
    } catch (e: any) {
      setDebugInfo(`ОШИБКА: ${e?.message || 'неизвестная'}`)
      setChatGate({ loading: false, notSubscribed: null, subscribed: [], error: e?.message || 'Не удалось проверить подписку' })
    }
  }

  async function recheckChat() {
    if (!event?.id || !tgUser?.id) return
    setChatGate(g => ({ ...g, loading: true, error: null }))
    try {
      const r: any = await checkConferenceSubscription(event.id, tgUser.id)
      if (r?.status === 1) {
        setChatGate({ loading: false, notSubscribed: null, subscribed: [] })
        openExternal(event.chat_url)
      } else {
        setChatGate({
          loading: false,
          notSubscribed: r?.not_subscribed || [],
          subscribed: r?.subscribed || [],
        })
      }
    } catch (e: any) {
      setChatGate(g => ({ ...g, loading: false, error: e?.message || 'Не удалось проверить' }))
    }
  }

  // Соорганизаторы для не-конф мероприятий
  useEffect(() => {
    if (!event?.id || isConference) { setCoOrganizers([]); return }
    getEventCollaborators(event.id, 'organizer')
      .then((r: any) => {
        const items = (r.items || []).map((c: any) => ({
          id: c.id,
          speaker_id: c.collaborator_id,
          name: c.name,
          title: c.title,
          photo_url: c.photo_url,
          achievements: c.achievements,
          tg_channel_url: c.tg_channel_url,
          instagram_url: c.instagram_url,
          personal_tg_username: c.personal_tg_username,
        }))
        setCoOrganizers(items)
      })
      .catch(() => setCoOrganizers([]))
  }, [event?.id, isConference, refreshKey])

  // Загрузка дней + спикеров. refreshKey в зависимостях — чтобы при возврате
  // на вкладку программы данные подтягивались заново (клиент мог поправить
  // расписание / убрать спикера / сменить статус регистрации).
  useEffect(() => {
    if (!event?.id || !isConference) return
    Promise.all([
      getDays(event.id).then((r: any) => r.days as Day[]).catch(() => []),
      getSpeakers(event.id).then((r: any) => r.speakers as Speaker[]).catch(() => []),
    ]).then(([d, sp]) => {
      setDays(d)
      setSpeakers(sp)
      // На refresh сбрасываем кэш сессий, чтобы перезагрузить активный день
      setSessionsByDay({})
      setOpenDay(prev => {
        if (prev != null && d.some(x => x.day_number === prev)) return prev
        const today = d.find(x => dayState(x) === 'today')
        const future = d.find(x => dayState(x) === 'future')
        return today?.day_number || future?.day_number || d[0]?.day_number || null
      })
    })
  }, [event?.id, isConference, refreshKey])

  // Лениво грузим сессии раскрываемого дня
  useEffect(() => {
    if (!event?.id || openDay == null) return
    if (sessionsByDay[openDay]) return
    setLoadingDay(openDay)
    getSessions(event.id, openDay)
      .then((r: any) => setSessionsByDay(prev => ({ ...prev, [openDay]: r.sessions || [] })))
      .catch(() => setSessionsByDay(prev => ({ ...prev, [openDay]: [] })))
      .finally(() => setLoadingDay(null))
  }, [event?.id, openDay, sessionsByDay])

  // Активная прямо сейчас сессия (по дню и времени МСК).
  const activeSession: Session | null = useMemo(() => {
    for (const d of days) {
      if (!d.day_date || d.day_date !== nowTs.date) continue
      const list = sessionsByDay[d.day_number] || []
      for (const s of list) {
        const start = (s.start_time || '').slice(0, 5)
        const end   = (s.end_time   || '').slice(0, 5)
        if (!start) continue
        const startsBefore = start <= nowTs.time
        const endsAfter    = end ? end >= nowTs.time : true
        if (startsBefore && endsAfter) return s
      }
    }
    return null
  }, [days, sessionsByDay, nowTs])
  const activeSpeakerEventId = activeSession?.speaker_event_id || null

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

      {/* VIP — персиковая кнопка с синим текстом, видна над стримом и чатом.
          У конференции — сразу под каруселью спикеров; у мероприятия — в самом верху. */}
      {hasVip && (
        <a href={vipUrl} target="_blank" rel="noreferrer" style={{
          display: 'block', textDecoration: 'none',
          background: PEACH, color: DARK,
          borderRadius: 14, padding: '16px 16px', marginBottom: 12,
          textAlign: 'center', fontWeight: 900, fontSize: 15,
          letterSpacing: 1.2, textTransform: 'uppercase',
          boxShadow: '0 4px 14px rgba(255,207,164,0.55)',
          border: `1px solid rgba(37,69,93,0.08)`,
        }}>
          Расшириться до VIP-тарифа
        </a>
      )}

      {/* Стрим — плашка во всю ширину.
          В день вебинара/конференции — активная ссылка с LIVE-значком.
          В остальные дни — неактивная заглушка «появится в день эфира». */}
      {hasStream && (
        streamLive ? (
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
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: '#7a8a9a', color: 'white',
            borderRadius: 14, padding: 14, marginBottom: 10,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 10, flexShrink: 0,
              background: 'rgba(255,255,255,0.18)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7"/>
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>Стрим</div>
              <div style={{ fontSize: 11, marginTop: 2, lineHeight: 1.35, opacity: 0.9 }}>
                В день эфира здесь появится ссылка для подключения
              </div>
            </div>
          </div>
        )
      )}

      {/* Чат события — отдельная плашка во всю ширину */}
      {hasChat && (
        <>
          <button onClick={openChatWithCheck} disabled={chatGate.loading} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'linear-gradient(135deg, #25455D, #0a1520)', color: 'white',
            borderRadius: 14, padding: 14, marginBottom: 12,
            border: 0, cursor: 'pointer', width: '100%', textAlign: 'left',
            fontFamily: 'inherit',
            opacity: chatGate.loading ? 0.7 : 1,
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(255,207,164,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={PEACH} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 12 20 22 4 22 4 12"/>
                <rect x="2" y="7" width="20" height="5"/>
                <line x1="12" y1="22" x2="12" y2="7"/>
                <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>
                <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800 }}>Чат события</div>
              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                {chatGate.loading ? 'Проверяем подписку…' : (event.chat_member_count_label || 'Нетворкинг и подарки за регистрацию')}
              </div>
            </div>
            <div style={{ fontSize: 24, color: PEACH, fontWeight: 600, marginRight: 4 }}>›</div>
          </button>
          {/* [DEBUG TEMP] баннер с результатом последней проверки */}
          {debugInfo && (
            <div style={{
              fontSize: 11, padding: '8px 10px', marginBottom: 12, borderRadius: 8,
              background: '#fff8e1', border: '1px solid #ffe0a3', color: '#5a4a00',
              wordBreak: 'break-all', fontFamily: 'monospace',
            }}>
              {debugInfo}
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
              const dayLabel = d.day_date
                ? `День ${d.day_number} · ${fmtDate(d.day_date)}`
                : `День ${d.day_number}`
              const stateLabel = state === 'past' ? 'завершён' : state === 'today' ? 'идёт сейчас' : 'впереди'
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                      {state === 'today' && (
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d32f2f',
                                       display: 'inline-block', flexShrink: 0 }}/>
                      )}
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#1a2a3a', lineHeight: 1.2 }}>
                        {dayLabel}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7c8e', fontWeight: 500 }}>· {stateLabel}</div>
                    </div>
                    <div style={{ fontSize: 18, color: '#c5cdd6',
                                  transform: isOpen ? 'rotate(90deg)' : 'none',
                                  transition: 'transform 0.2s', flexShrink: 0 }}>▸</div>
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
                            const isLive = activeSession?.id === s.id
                            return (
                              <div key={s.id} style={{
                                background: isLive ? 'linear-gradient(135deg, #fff8f0, white)' : altBg,
                                border: isLive ? `2px solid ${PEACH}` : '1px solid rgba(37,69,93,0.20)',
                                borderRadius: 12,
                                padding: '10px 10px',
                                // Тонкая полоса-разделитель сверху между слотами
                                marginTop: idx === 0 ? 0 : 4,
                                boxShadow: isLive ? '0 4px 14px rgba(255,207,164,0.45)' : 'none',
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                  {/* Время — ЖИРНОЕ */}
                                  <span style={{ color: DARK, fontSize: 13, fontWeight: 800 }}>
                                    {formatTimeMsk(s.start_time, s.end_time)}
                                  </span>
                                  {isLive && (
                                    <span style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      background: '#d32f2f', color: 'white',
                                      fontSize: 10, padding: '2px 8px', borderRadius: 10,
                                      fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase',
                                    }}>
                                      <span style={{ width: 5, height: 5, borderRadius: '50%',
                                                     background: 'white', display: 'inline-block' }}/>
                                      Идёт сейчас
                                    </span>
                                  )}
                                  {s.track_label && (
                                    <span style={{
                                      background: `${s.track_color || PEACH}20`,
                                      color: s.track_color || PEACH,
                                      fontSize: 11, padding: '2px 10px', borderRadius: 20, fontWeight: 500,
                                      border: `1px solid ${s.track_color || PEACH}40`,
                                    }}>{s.track_label}</span>
                                  )}
                                </div>

                                <p style={{ color: '#1a2a3a',
                                            fontSize: isLive ? 15 : 14, lineHeight: 1.4,
                                            fontWeight: isLive ? 900 : 700, marginBottom: 8 }}>
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

      {!isConference && (event?.start_at || event?.description) && (
        <div className="card" style={{ padding: 16 }}>
          {event?.start_at && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: PEACH, color: DARK,
              borderRadius: 10, padding: '8px 14px',
              marginBottom: event?.description ? 14 : 0,
              fontSize: 14, fontWeight: 800,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={DARK} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              {formatEventDateRange(event.start_at, event.end_at)}
            </div>
          )}
          {event?.description && (
            <p style={{
              color: 'var(--text)', fontSize: 14, lineHeight: 1.55,
              whiteSpace: 'pre-wrap', margin: 0,
            }}>
              {event.description}
            </p>
          )}
        </div>
      )}

      {/* Соорганизаторы — для не-конф мероприятий, внизу программы */}
      {!isConference && coOrganizers.length > 0 && (
        <>
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
            Ведут мероприятие
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
            {coOrganizers.map(c => (
              <div key={c.id} className="card" style={{
                padding: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}>
                {c.photo_url ? (
                  <img src={c.photo_url} alt=""
                    style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                ) : (
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%',
                    background: 'rgba(37,69,93,0.08)', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: DARK, fontWeight: 700, fontSize: 14,
                  }}>{c.name.slice(0, 2).toUpperCase()}</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: DARK, lineHeight: 1.2 }}>
                    {c.name}
                  </div>
                  {c.title && (
                    <div style={{ fontSize: 12, color: '#6b7c8e', marginTop: 3, lineHeight: 1.3 }}>
                      {c.title}
                    </div>
                  )}
                  {c.achievements && c.achievements.length > 0 && (
                    <div style={{ fontSize: 11, color: '#8a99a8', marginTop: 4, lineHeight: 1.3 }}>
                      {c.achievements.slice(0, 2).join(' · ')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
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
              const isLive = activeSpeakerEventId === sp.id
              return (
                <div
                  key={sp.id}
                  ref={el => { speakerCardRefs.current[sp.id] = el }}
                  style={{
                    background: PASTELS[idx % PASTELS.length],
                    borderRadius: 14, padding: 14,
                    boxShadow: isLive
                      ? '0 4px 14px rgba(255,207,164,0.45)'
                      : '0 2px 8px rgba(37,69,93,0.05)',
                    border: (isHighlighted || isLive) ? `2px solid ${PEACH}` : '2px solid transparent',
                    transition: 'border-color 0.3s',
                  }}
                >
                  {isLive && (
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      background: '#d32f2f', color: 'white',
                      fontSize: 10, padding: '3px 9px', borderRadius: 10,
                      fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase',
                      marginBottom: 8,
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%',
                                     background: 'white', display: 'inline-block' }}/>
                      Сейчас в эфире
                    </div>
                  )}
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
                      <div style={{
                        fontSize: isLive ? 16 : 15,
                        fontWeight: isLive ? 900 : 700,
                        color: '#1a2a3a', lineHeight: 1.2,
                      }}>
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

      {/* Модалка с проверкой подписки для входа в чат.
          Сверху — каналы, на которые НЕ подписан (с кнопкой «Подписаться»).
          Снизу — каналы, на которые УЖЕ подписан (с галочкой). */}
      {chatGate.notSubscribed && chatGate.notSubscribed.length > 0 && (
        <div onClick={() => setChatGate({ loading: false, notSubscribed: null, subscribed: [] })} style={{
          position: 'fixed', inset: 0, background: 'rgba(10,21,32,0.7)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          zIndex: 1000, animation: 'fadeIn 0.2s',
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: 'white', borderRadius: '16px 16px 0 0',
            width: '100%', maxWidth: 520,
            padding: '20px 18px 24px', maxHeight: '85vh', overflowY: 'auto',
          }}>
            <div style={{ width: 40, height: 4, background: '#ddd', borderRadius: 2, margin: '0 auto 16px' }} />

            <h3 style={{ color: DARK, fontSize: 17, fontWeight: 800, margin: '0 0 6px' }}>
              Чтобы войти в чат
            </h3>
            <p style={{ color: '#666', fontSize: 13, lineHeight: 1.5, margin: '0 0 16px' }}>
              Подпишитесь на {chatGate.notSubscribed.length === 1 ? 'канал' : 'каналы'} ниже —
              после этого нажмите «Я подписался».
            </p>

            <ol style={{ listStyle: 'none', counterReset: 'sub-list', padding: 0, margin: '0 0 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {chatGate.notSubscribed.map((ch, idx) => (
                <li key={`ns-${ch.speaker_id}`} style={{ counterIncrement: 'sub-list' }}>
                  <a href={ch.tg_channel_url || '#'} target="_blank" rel="noreferrer" style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: '#f6f8fb', borderRadius: 12, padding: '10px 12px',
                    textDecoration: 'none', color: DARK, border: '1px solid #e5e9f0',
                  }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: '50%', background: PEACH,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, color: DARK, fontSize: 14, fontWeight: 800,
                    }}>
                      {idx + 1}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ch.name}
                    </div>
                    <span style={{ fontSize: 12, color: DARK, fontWeight: 700 }}>Подписаться →</span>
                  </a>
                </li>
              ))}
            </ol>

            {chatGate.subscribed && chatGate.subscribed.length > 0 && (
              <>
                <div style={{
                  fontSize: 11, color: '#888', textTransform: 'uppercase',
                  letterSpacing: 0.5, fontWeight: 700, margin: '6px 2px 6px',
                }}>
                  Уже подписаны
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {chatGate.subscribed.map(ch => (
                    <li key={`s-${ch.speaker_id}`}>
                      <a href={ch.tg_channel_url || '#'} target="_blank" rel="noreferrer" style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        background: '#f3faf4', borderRadius: 12, padding: '8px 12px',
                        textDecoration: 'none', color: DARK, border: '1px solid #d8ecdb',
                      }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: '50%', background: '#3aa758',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, color: 'white', fontSize: 14, fontWeight: 800,
                        }}>
                          ✓
                        </div>
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: '#3a4a3a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ch.name}
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {chatGate.error && (
              <div style={{ color: '#c0392b', fontSize: 12, marginBottom: 10 }}>{chatGate.error}</div>
            )}

            <button onClick={recheckChat} disabled={chatGate.loading} style={{
              width: '100%', padding: '13px 16px', border: 0, borderRadius: 12,
              background: PEACH, color: DARK, fontSize: 14, fontWeight: 800,
              cursor: 'pointer', fontFamily: 'inherit',
              opacity: chatGate.loading ? 0.7 : 1,
            }}>
              {chatGate.loading ? 'Проверяем…' : 'Я подписался — проверить'}
            </button>

            <button onClick={() => setChatGate({ loading: false, notSubscribed: null, subscribed: [] })} style={{
              width: '100%', padding: '11px', marginTop: 8, border: 0,
              background: 'transparent', color: '#888', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}>
              Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
