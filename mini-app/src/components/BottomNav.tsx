import { useState } from 'react'

export interface NavItem {
  id: string
  label: string
  icon: 'calendar' | 'ecosystem' | 'landing' | 'program' | 'game' | 'raffle' | 'services' | 'results' | 'plus' | 'welcome'
  locked?: boolean
}

interface Props {
  items: NavItem[]
  active: string
  onTab: (id: string) => void
}

const Calendar = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
)
const Ecosystem = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
  </svg>
)
const Landing = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>
  </svg>
)
const Program = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
)
const Game = () => (
  // Иконка подарка (коробка с бантом) — id 'game' исторический, label «Подарки».
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 12 20 22 4 22 4 12"/>
    <rect x="2" y="7" width="20" height="5"/>
    <line x1="12" y1="22" x2="12" y2="7"/>
    <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/>
    <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/>
  </svg>
)
const Raffle = () => (
  // Билет с перфорацией — для вкладки «Розыгрыш». До этого тут была иконка
  // подарка, но она «уехала» во вкладку «Подарки».
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 9a2 2 0 012-2h16a2 2 0 012 2v1a2 2 0 000 4v1a2 2 0 01-2 2H4a2 2 0 01-2-2v-1a2 2 0 000-4z"/>
    <line x1="13" y1="5" x2="13" y2="7"/>
    <line x1="13" y1="11" x2="13" y2="13"/>
    <line x1="13" y1="17" x2="13" y2="19"/>
  </svg>
)
const Services = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/>
  </svg>
)
const Results = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
  </svg>
)
const Plus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
)
const Welcome = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="8 12 11 15 16 9"/>
  </svg>
)
const ICONS = {
  calendar: Calendar, ecosystem: Ecosystem, landing: Landing,
  program: Program, game: Game, raffle: Raffle, services: Services, results: Results, plus: Plus,
  welcome: Welcome,
}

export default function BottomNav({ items, active, onTab }: Props) {
  const [popup, setPopup] = useState<string | null>(null)

  function tap(item: NavItem) {
    if (item.locked) {
      setPopup(item.label)
      setTimeout(() => setPopup(null), 2200)
      return
    }
    onTab(item.id)
  }

  return (
    <>
      {popup && (
        <div className="lock-popup fade-in">
          🔒 «{popup}» откроется после регистрации
        </div>
      )}
      <nav className="bottom-nav">
        {items.map(it => {
          const Icon = ICONS[it.icon]
          const isActive = active === it.id
          return (
            <button
              key={it.id}
              className={`bnav-item ${isActive ? 'active' : ''} ${it.locked ? 'locked' : ''}`}
              onClick={() => tap(it)}
            >
              <span className="bnav-icon-wrap">
                <Icon />
                {it.locked && <span className="bnav-lock-overlay">🔒</span>}
              </span>
              <span>{it.label}</span>
            </button>
          )
        })}
      </nav>
    </>
  )
}
