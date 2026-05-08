import { useState } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import SelectorEventsTab from '../tabs/SelectorEventsTab'
import PlussonPromoTab from '../tabs/PlussonPromoTab'

interface Props {
  tgUser: any
  onOpenEvent: (slug: string) => void
}

const NAV: NavItem[] = [
  { id: 'events', label: 'События',  icon: 'calendar' },
  { id: 'plusson', label: 'iViSiON: ПЛЮСОН',  icon: 'plus'     },
]

export default function HubSelector({ tgUser, onOpenEvent }: Props) {
  const [tab, setTab] = useState('events')

  const greeting = tgUser?.first_name ? `Привет, ${tgUser.first_name}!` : 'Привет!'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {tab === 'events' && (
        <div className="grad-header" style={{ paddingTop: 18, paddingBottom: 18 }}>
          <p style={{ color: '#FFCFA4', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, opacity: 0.7 }}>
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

      <div className="page">
        {tab === 'events'  && (
          <SelectorEventsTab
            tgUser={tgUser}
            onOpenEvent={onOpenEvent}
            onSwitchToPromo={() => setTab('plusson')}
          />
        )}
        {tab === 'plusson' && <PlussonPromoTab />}
      </div>

      <BottomNav items={NAV} active={tab} onTab={setTab} />
    </div>
  )
}
