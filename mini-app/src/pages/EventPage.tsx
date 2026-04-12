import { useState, useEffect } from 'react'
import BottomNav from '../components/BottomNav'
import GameTab from '../tabs/GameTab'
import ProgramTab from '../tabs/ProgramTab'
import ServicesTab from '../tabs/ServicesTab'
import RaffleTab from '../tabs/RaffleTab'
import { getParticipantInEvent, registerParticipant } from '../api'

type Tab = 'game' | 'program' | 'services' | 'raffle'

interface Props { slug: string; tgUser: any; partnerId?: string; utmSource?: string }

const MOCK_PARTICIPANT = { id: 1, ref_code: 'abc12345', points_total: 3, event_id: 1, referrals_count: 3 }
const MOCK_EVENT = { id: 1, slug: 'ivision-7', title: 'iVision Conference 7', module_slug: 'conference', status: 'active' }

export default function EventPage({ slug, tgUser, partnerId, utmSource }: Props) {
  const [tab, setTab] = useState<Tab>('game')
  const [event, setEvent] = useState<any>(MOCK_EVENT)
  const [participant, setParticipant] = useState<any>(MOCK_PARTICIPANT)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!tgUser?.id || !slug || slug === 'current') { setLoading(false); return }
    getParticipantInEvent(slug, tgUser.id)
      .then(r => {
        setEvent({ ...MOCK_EVENT, ...r.participant, title: r.participant?.event_title, id: r.participant?.event_id })
        setParticipant({ ...r.participant, referrals_count: r.referrals_count })
      })
      .catch(() => {
        // Auto-register при переходе по партнёрской ссылке
        if (partnerId || utmSource) {
          registerParticipant({
            event_slug: slug, tg_id: tgUser.id,
            username: tgUser.username, first_name: tgUser.first_name,
            ref_code: partnerId,
            utm_source: utmSource,
          }).then(r => setParticipant(r.participant)).catch(() => {})
        }
      })
      .finally(() => setLoading(false))
  }, [slug, tgUser])

  function goBack() {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const moduleTabs = event?.module_slug === 'conference' ? ['conference'] : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Header */}
      <div className="grad-header" style={{ paddingTop: 16, paddingBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={goBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', width: 32, height: 32, borderRadius: 8, cursor: 'pointer', fontSize: 18 }}>
            ‹
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ color: 'white', fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {event?.title || slug}
            </h1>
            {event?.module_slug && (
              <span className="badge badge-gold" style={{ fontSize: 10, marginTop: 2 }}>
                {event.module_slug === 'conference' ? 'Конференция' : 'Базовый'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="page">
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--muted)', fontSize: 14 }}>
            Загружаем...
          </div>
        ) : (
          <>
            {tab === 'game'     && <GameTab event={event} participant={participant} tgUser={tgUser} />}
            {tab === 'program'  && <ProgramTab event={event} />}
            {tab === 'services' && <ServicesTab event={event} />}
            {tab === 'raffle'   && <RaffleTab event={event} participant={participant} />}
          </>
        )}
      </div>

      <BottomNav active={tab} onTab={setTab} moduleTabs={moduleTabs} />
    </div>
  )
}
