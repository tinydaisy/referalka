import { useState } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import SelectorEventsTab from '../tabs/SelectorEventsTab'
import LeadersTab from '../tabs/LeadersTab'
import PlussonPromoTab from '../tabs/PlussonPromoTab'

interface Props {
  tgUser: any
  onOpenEvent: (slug: string) => void
  initialTab?: string
}

const NAV: NavItem[] = [
  { id: 'events',  label: 'События',          icon: 'calendar' },
  { id: 'leaders', label: 'Лидеры',           icon: 'leaders'  },
  { id: 'plusson', label: 'iViSiON: ПЛЮСОН',  icon: 'plus'     },
]

const VALID_TABS = new Set(NAV.map(n => n.id))

// Mini App base. У TG это '/tg', у VK '/vk' — берём из vite BASE_URL.
const APP_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

export default function HubSelector({ tgUser, onOpenEvent, initialTab }: Props) {
  const [tab, setTab] = useState(initialTab && VALID_TABS.has(initialTab) ? initialTab : 'events')

  const greeting = tgUser?.first_name ? `Привет, ${tgUser.first_name}!` : 'Привет!'

  // Клик по лидеру → переход в Hub этого клиента. Реализуем через
  // window.location — App.tsx по `/c/{N}/...` сам отдаст Hub-компонент.
  // Сохраняем query-string и hash: VK Bridge launch params (?vk_user_id&sign…)
  // и TG-startparam (#…) живут именно там — без них следующий рендер не
  // опознает юзера и Hub окажется пустым.
  function openLeader(clientId: number) {
    const qs = window.location.search || ''
    const hash = window.location.hash || ''
    window.location.assign(`/c/${clientId}${APP_BASE}/${qs}${hash}`)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {tab === 'events' && (
        <div className="grad-header" style={{ paddingTop: 18, paddingBottom: 18 }}>
          <p style={{ color: 'var(--peach)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, opacity: 0.7 }}>
            iViSiON: ПЛЮСОН
          </p>
          <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700, marginTop: 6 }}>
            {greeting}
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 4 }}>
            Ваши события — выберите, какое открыть
          </p>
        </div>
      )}

      {tab === 'leaders' && (
        <div className="grad-header" style={{ paddingTop: 18, paddingBottom: 18 }}>
          <p style={{ color: 'var(--peach)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, opacity: 0.7 }}>
            iViSiON: ПЛЮСОН
          </p>
          <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700, marginTop: 6 }}>
            Лидеры
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 4 }}>
            Организаторы и эксперты, с которыми вы связаны
          </p>
        </div>
      )}

      <div className="page">
        {tab === 'events'  && (
          <SelectorEventsTab
            tgUser={tgUser}
            onOpenEvent={onOpenEvent}
            onSwitchToPromo={() => setTab('plusson')}
          />
        )}
        {tab === 'leaders' && (
          <LeadersTab
            tgUser={tgUser}
            onOpenLeader={openLeader}
            onSwitchToPromo={() => setTab('plusson')}
          />
        )}
        {tab === 'plusson' && <PlussonPromoTab />}
      </div>

      <BottomNav items={NAV} active={tab} onTab={setTab} />
    </div>
  )
}
