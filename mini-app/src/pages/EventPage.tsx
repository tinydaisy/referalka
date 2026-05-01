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
import { getEventLanding, getParticipantInEvent, registerParticipant } from '../api'

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
  const [prefill, setPrefill] = useState<{ name?: string; email?: string; phone?: string } | null>(null)
  const [autoRegToast, setAutoRegToast] = useState<{ email: string; phone: string } | null>(null)

  // Загружаем лендинг события (публично) + проверяем участие (если есть tg_id)
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    Promise.all([
      getEventLanding(slug).catch(() => null),
      tgUser?.id ? getParticipantInEvent(slug, tgUser.id).catch(() => null) : Promise.resolve(null),
    ]).then(async ([landing, part]) => {
      if (cancelled) return
      setEvent(landing)
      setParticipant(part?.participant ? {
        ...part.participant,
        referrals_count:      part.referrals_count,
        visited_count:        part.visited_count,
        registered_count:     part.registered_count,
        gifts_received_count: part.gifts_received_count,
        my_people:            part.my_people || [],
      } : null)
      setPrefill(part?.prefill || null)

      const alreadyRegistered = !!part?.participant?.is_registered
      const ended = isEnded(landing)

      // Фиксируем «интересовался» — без автоматической регистрации.
      // Незарегистрированные ВСЕГДА видят сначала лендинг.
      if (tgUser?.id && slug && !alreadyRegistered) {
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
      if (ended)                  setTab('results')
      else if (alreadyRegistered) setTab('program')
      else                        setTab('landing')
    }).finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [slug, tgUser?.id])

  // Определяем состояние и набор вкладок (вычисляется ДО early return —
  // иначе useEffect ниже сломает порядок хуков React).
  const ended      = isEnded(event)
  const registered = !!participant?.is_registered
  const state: State = ended ? 'ended' : registered ? 'registered' : 'not_registered'

  // Активность игры/розыгрыша определяется тогглами в дашборде клиента.
  // Если клиент не включил — соответствующая вкладка вообще не показывается.
  const refOn    = !!event?.referral_enabled
  const raffleOn = !!event?.raffle_enabled

  // Если событие завершено и участника нет — Игру тоже не показываем.
  const filterByEnabled = (items: NavItem[]) => items.filter(n =>
    (n.id !== 'game'   || refOn)    &&
    (n.id !== 'raffle' || raffleOn)
  )

  const navItemsEnded = participant
    ? filterByEnabled(NAV_ENDED)
    : filterByEnabled(NAV_ENDED).filter(n => n.id !== 'game')
  const navItems = state === 'not_registered' ? filterByEnabled(NAV_NOT_REG)
                 : state === 'registered'     ? filterByEnabled(NAV_REGISTERED)
                 :                              navItemsEnded

  // Если текущая вкладка пропала из navItems (например клиент выключил
  // рефералку/розыгрыш) — переключаем на первую доступную.
  useEffect(() => {
    if (!event) return
    if (!navItems.some(n => n.id === tab)) {
      setTab(navItems[0]?.id || 'landing')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOn, raffleOn, state, event])

  if (loading || !event) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Загружаем...
      </div>
    )
  }

  function handleRegistered(p: any) {
    setParticipant({ ...p, is_registered: true })
    setShowReg(false)
    setTab('program')
  }

  // Клик по «Хочу участвовать»: если контакты этого человека уже есть
  // в базе клиента (email+phone) — регистрируем без формы, иначе показываем форму.
  async function handleWantParticipate() {
    const canAutoRegister = !!(prefill?.email?.trim() && prefill?.phone?.trim())
    if (canAutoRegister && tgUser?.id) {
      try {
        const r: any = await registerParticipant({
          event_slug: slug,
          tg_id: tgUser.id,
          username: tgUser.username,
          first_name: tgUser.first_name || prefill!.name || '',
          last_name:  tgUser.last_name  || '',
          email: prefill!.email!,
          phone: prefill!.phone!,
          ref_code: partnerId,
          utm_source: utmSource,
        })
        const reg = r?.participant || r
        setParticipant({ ...reg, is_registered: true })
        setAutoRegToast({ email: prefill!.email!, phone: prefill!.phone! })
        setTab('program')
        setTimeout(() => setAutoRegToast(null), 6000)
        return
      } catch (_) {
        // Не получилось — fallback на форму.
      }
    }
    setShowReg(true)
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
            <h1 style={{ color: 'white', fontSize: 15, fontWeight: 700, lineHeight: 1.25,
                         whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
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
                   width: 36, height: 36, borderRadius: 8, objectFit: 'contain',
                   background: 'transparent',
                   cursor: 'pointer', flexShrink: 0,
                 }} />
          )}
        </div>
      </div>

      {autoRegToast && (
        <div style={{
          background: '#FFCFA4', color: '#25455D', padding: '10px 14px',
          fontSize: 12, lineHeight: 1.45, fontWeight: 700,
          borderBottom: '1px solid #f0b87a',
        }}>
          ✓ Вы зарегистрированы — данные взяты из вашей карточки:
          <div style={{ marginTop: 4, fontWeight: 600, wordBreak: 'break-all' }}>
            {autoRegToast.email} · {autoRegToast.phone}
          </div>
        </div>
      )}

      <div className="page">
        {tab === 'landing'   && <LandingTab  event={event} onRegister={handleWantParticipate} />}
        {tab === 'program'   && <ProgramTab  event={event} tgUser={tgUser} />}
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
