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

// Mini App base ('/tg' для TG, '/vk' для VK). Возврат «к списку лидеров» ведёт
// на корень Mini App без cid-префикса — там App.tsx покажет HubSelector.
const APP_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

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
          <button
            onClick={() => {
              // Сохраняем launch params VK / TG initData при возврате
              const qs = window.location.search || ''
              const hash = window.location.hash || ''
              window.location.assign(`${APP_BASE}/${qs}${hash}`)
            }}
            style={{
              position: 'absolute', top: 14, left: 12,
              background: 'rgba(255,255,255,0.10)',
              border: '1px solid rgba(255,207,164,0.4)',
              color: '#FFCFA4',
              fontSize: 12, fontWeight: 600,
              padding: '4px 10px', borderRadius: 999,
              cursor: 'pointer',
            }}
            title="К списку лидеров"
          >← К списку лидеров</button>
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
          <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700, paddingRight: brandLogo ? 50 : 0, paddingTop: 28 }}>
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
