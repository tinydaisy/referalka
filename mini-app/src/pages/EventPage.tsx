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
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="grad-header" style={{ paddingTop: 14, paddingBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack}
                  style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white',
                           width: 32, height: 32, borderRadius: 8, cursor: 'pointer', fontSize: 18 }}>
            ‹
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ color: 'white', fontSize: 15, fontWeight: 600,
                         whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {event.title}
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11, marginTop: 2 }}>
              {eventDateLabel(event)}
            </p>
          </div>
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
