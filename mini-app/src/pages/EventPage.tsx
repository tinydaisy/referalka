import { useState, useEffect } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import LandingTab from '../tabs/LandingTab'
import ProgramTab from '../tabs/ProgramTab'
import GameTab from '../tabs/GameTab'
import RaffleTab from '../tabs/RaffleTab'
import ResultsTab from '../tabs/ResultsTab'
import CalendarTab from '../tabs/CalendarTab'
import EcosystemTab from '../tabs/EcosystemTab'
import RegistrationFlow from '../components/RegistrationFlow'
import { getEventLanding, getParticipantInEvent } from '../api'

type State = 'not_registered' | 'registered' | 'ended'

interface Props {
  slug: string
  tgUser: any
  partnerId?: string
  utmSource?: string
  onBack: () => void
}

const NAV_NOT_REG: NavItem[] = [
  { id: 'landing',   label: 'Лендинг',    icon: 'landing'   },
  { id: 'program',   label: 'Программа',  icon: 'program',   locked: true },
  { id: 'game',      label: 'Игра',       icon: 'game',      locked: true },
  { id: 'raffle',    label: 'Розыгрыш',   icon: 'raffle',    locked: true },
  { id: 'ecosystem', label: 'Экосистема', icon: 'ecosystem', locked: true },
]
const NAV_REGISTERED: NavItem[] = [
  { id: 'program',   label: 'Программа',  icon: 'program'   },
  { id: 'game',      label: 'Игра',       icon: 'game'      },
  { id: 'raffle',    label: 'Розыгрыш',   icon: 'raffle'    },
  { id: 'ecosystem', label: 'Экосистема', icon: 'ecosystem' },
]
const NAV_ENDED: NavItem[] = [
  { id: 'results',   label: 'Итоги',      icon: 'results'   },
  { id: 'game',      label: 'Игра',       icon: 'game'      },
  { id: 'calendar',  label: 'Календарь',  icon: 'calendar'  },
  { id: 'ecosystem', label: 'Экосистема', icon: 'ecosystem' },
]

function isEnded(event: any): boolean {
  if (event?.status === 'ended') return true
  if (event?.end_at && new Date(event.end_at) < new Date()) return true
  return false
}

function eventDateLabel(event: any): string {
  const start = event?.start_at ? new Date(event.start_at) : null
  const end   = event?.end_at   ? new Date(event.end_at)   : null
  const now   = new Date()
  if (!start) return ''
  if (start <= now && (!end || end >= now)) return '· идёт сейчас'
  if (start > now) {
    const days = Math.ceil((start.getTime() - now.getTime()) / 86400000)
    return `· через ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`
  }
  if (end && end < now) return '· завершено'
  return ''
}

export default function EventPage({ slug, tgUser, partnerId, utmSource, onBack }: Props) {
  const [event, setEvent] = useState<any>(null)
  const [participant, setParticipant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<string>('landing')
  const [showReg, setShowReg] = useState(false)

  // Загружаем лендинг события (публично) + проверяем участие (если есть tg_id)
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    Promise.all([
      getEventLanding(slug).catch(() => null),
      tgUser?.id ? getParticipantInEvent(slug, tgUser.id).catch(() => null) : Promise.resolve(null),
    ]).then(([landing, part]) => {
      if (cancelled) return
      setEvent(landing)
      setParticipant(part?.participant ? { ...part.participant, referrals_count: part.referrals_count } : null)

      // Фиксируем «интересовался» при открытии события — даже если пользователь
      // попал сюда из селектора (т.е. inline-скрипт в index.html не пускался
      // с этим event_slug). Бэк делает upsert + ON CONFLICT DO NOTHING,
      // так что повторно ничего не создаст.
      if (tgUser?.id && slug && !part?.participant?.is_registered) {
        fetch(`${import.meta.env.VITE_API_URL}/api/v1/event`, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id:    String(tgUser.id),
            event:      'event_start',
            first_name: tgUser.first_name || '',
            last_name:  tgUser.last_name  || '',
            username:   tgUser.username   || '',
            partner_id: partnerId || '',
            event_slug: slug,
            client_id:  0,
            platform:   'telegram',
          }),
        }).catch(() => {})
      }

      // Initial tab по состоянию
      const ended = isEnded(landing)
      const registered = !!part?.participant?.is_registered
      if (ended)             setTab('results')
      else if (registered)   setTab('program')
      else                   setTab('landing')
    }).finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [slug, tgUser?.id])

  if (loading || !event) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Загружаем...
      </div>
    )
  }

  // Определяем состояние и набор вкладок
  const ended      = isEnded(event)
  const registered = !!participant?.is_registered
  const state: State = ended ? 'ended' : registered ? 'registered' : 'not_registered'
  // Если событие завершено и участника нет — Игру не показываем
  const navItemsEnded = participant ? NAV_ENDED : NAV_ENDED.filter(n => n.id !== 'game')
  const navItems = state === 'not_registered' ? NAV_NOT_REG
                 : state === 'registered'     ? NAV_REGISTERED
                 :                              navItemsEnded

  function handleRegistered(p: any) {
    setParticipant({ ...p, is_registered: true })
    setShowReg(false)
    setTab('program')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="grad-header" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
          <button onClick={onBack}
                  style={{ background: 'rgba(255, 207, 164, 0.15)', border: 'none', color: 'white',
                           width: 36, height: 36, borderRadius: 10, cursor: 'pointer', fontSize: 20,
                           display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            ‹
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ color: 'white', fontSize: 16, fontWeight: 700,
                         whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {event.title}
            </h1>
            <p style={{ color: 'rgba(255, 207, 164, 0.85)', fontSize: 12, marginTop: 2, fontWeight: 500 }}>
              {eventDateLabel(event)}
            </p>
          </div>
          {event.client_brand_logo && (
            <img src={event.client_brand_logo} alt=""
                 onClick={() => setTab('ecosystem')}
                 style={{
                   width: 36, height: 36, borderRadius: 8, objectFit: 'cover',
                   background: 'rgba(255,255,255,0.95)', padding: 3,
                   cursor: 'pointer', flexShrink: 0,
                 }} />
          )}
        </div>
      </div>

      <div className="page">
        {tab === 'landing'   && <LandingTab  event={event} onRegister={() => setShowReg(true)} />}
        {tab === 'program'   && <ProgramTab  event={event} />}
        {tab === 'game'      && <GameTab     event={event} participant={participant} tgUser={tgUser} />}
        {tab === 'raffle'    && <RaffleTab   event={event} participant={participant} />}
        {tab === 'results'   && <ResultsTab  event={event} participant={participant} />}
        {tab === 'calendar'  && event.client_id && <CalendarTab clientId={event.client_id} onOpenEvent={(s) => {
          const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
          window.location.assign(`${base}/event/${s}`)
        }} />}
        {tab === 'ecosystem' && event.client_id && <EcosystemTab clientId={event.client_id} />}
      </div>

      <BottomNav items={navItems} active={tab} onTab={setTab} />

      {showReg && (
        <RegistrationFlow
          event={event}
          tgUser={tgUser}
          partnerId={partnerId}
          utmSource={utmSource}
          onClose={() => setShowReg(false)}
          onDone={handleRegistered}
        />
      )}
    </div>
  )
}
