import { useState, useEffect } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import CalendarTab from '../tabs/CalendarTab'
import EcosystemTab from '../tabs/EcosystemTab'
import { getClientProfile } from '../api'

interface Props {
  clientId: number
  tgUser: any
  onOpenEvent: (slug: string) => void
}

const NAV: NavItem[] = [
  { id: 'calendar',  label: 'Календарь',   icon: 'calendar'  },
  { id: 'ecosystem', label: 'Экосистема',  icon: 'ecosystem' },
]

export default function Hub({ clientId, onOpenEvent }: Props) {
  const [tab, setTab] = useState('calendar')
  const [name, setName] = useState<string>('')

  useEffect(() => {
    getClientProfile(clientId).then(p => setName(p.name || '')).catch(() => {})
  }, [clientId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="grad-header" style={{ paddingTop: 18, paddingBottom: 18 }}>
        <p style={{ color: 'rgba(255,207,164,0.7)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.2 }}>
          ПЛЮСОН
        </p>
        <h1 style={{ color: 'white', fontSize: 20, fontWeight: 700, marginTop: 4 }}>
          {name || 'Организатор'}
        </h1>
      </div>

      <div className="page">
        {tab === 'calendar'  && <CalendarTab  clientId={clientId} onOpenEvent={onOpenEvent} />}
        {tab === 'ecosystem' && <EcosystemTab clientId={clientId} />}
      </div>

      <BottomNav items={NAV} active={tab} onTab={setTab} />
    </div>
  )
}
