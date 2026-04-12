type Tab = 'game' | 'program' | 'services' | 'raffle'

interface Props {
  active: Tab
  onTab: (t: Tab) => void
  moduleTabs?: string[]
}

const GameIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="12" y1="18" x2="12" y2="12"/>
    <line x1="9" y1="15" x2="15" y2="15"/>
  </svg>
)

const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
)

const BagIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/>
    <line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/>
  </svg>
)

const GiftIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 12 20 22 4 22 4 12"/>
    <rect x="2" y="7" width="20" height="5"/>
    <line x1="12" y1="22" x2="12" y2="7"/>
    <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/>
    <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/>
  </svg>
)

export default function BottomNav({ active, onTab, moduleTabs = [] }: Props) {
  const isConf = moduleTabs.includes('conference')
  return (
    <nav className="bottom-nav">
      <button className={`bnav-item ${active === 'game' ? 'active' : ''}`} onClick={() => onTab('game')}>
        <GameIcon /><span>Игра</span>
      </button>
      {isConf && <>
        <button className={`bnav-item ${active === 'program' ? 'active' : ''}`} onClick={() => onTab('program')}>
          <CalendarIcon /><span>Программа</span>
        </button>
        <button className={`bnav-item ${active === 'services' ? 'active' : ''}`} onClick={() => onTab('services')}>
          <BagIcon /><span>Услуги</span>
        </button>
        <button className={`bnav-item ${active === 'raffle' ? 'active' : ''}`} onClick={() => onTab('raffle')}>
          <GiftIcon /><span>Розыгрыш</span>
        </button>
      </>}
    </nav>
  )
}
