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

const PEACH = '#FFCFA4'

export default function Hub({ clientId, tgUser, onOpenEvent }: Props) {
  const [tab, setTab] = useState('calendar')
  const [profile, setProfile] = useState<any>(null)
  const tgId = tgUser?.id ? Number(tgUser.id) : undefined

  useEffect(() => {
    getClientProfile(clientId).then(setProfile).catch(() => {})
  }, [clientId])

  const brand = profile?.brand_name || profile?.name || 'Организатор'
  const tagline = profile?.positioning || ''
  const brandLogo = profile?.brand_logo_url

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Шапка только на Календаре. На Экосистеме — её собственная шапка-визитка. */}
      {tab === 'calendar' && (
        <div className="grad-header" style={{ paddingTop: 18, paddingBottom: 18, position: 'relative' }}>
          {brandLogo && (
            <img src={brandLogo} alt=""
                 onClick={() => setTab('ecosystem')}
                 style={{
                   position: 'absolute', top: 14, right: 14,
                   width: 36, height: 36, borderRadius: 8, objectFit: 'contain',
                   background: 'transparent',
                   cursor: 'pointer',
                 }} />
          )}
          <p style={{ color: PEACH, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.5, fontWeight: 700, opacity: 0.7 }}>
            iViSiON: ПЛЮСОН
          </p>
          <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700, marginTop: 6, paddingRight: brandLogo ? 50 : 0 }}>
            {brand}
          </h1>
          {tagline && (
            <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 4 }}>
              {tagline}
            </p>
          )}
        </div>
      )}

      <div className="page">
        {tab === 'calendar'  && <CalendarTab  clientId={clientId} tgId={tgId} onOpenEvent={onOpenEvent} />}
        {tab === 'ecosystem' && <EcosystemTab clientId={clientId} />}
      </div>

      <BottomNav items={NAV} active={tab} onTab={setTab} />
    </div>
  )
}
