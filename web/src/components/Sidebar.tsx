'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Link2, Mic, Users, Settings, CreditCard, LogOut, Menu, X, Trophy, Award } from 'lucide-react'
import { useState } from 'react'

type NavSection = {
  label?: string
  items: { href: string; label: string; icon: any; exact?: boolean }[]
}

const sections: NavSection[] = [
  {
    items: [
      { href: '/dashboard', label: 'Дашборд', icon: LayoutDashboard, exact: true },
    ],
  },
  {
    label: 'РЕФЕРАЛКИ',
    items: [
      { href: '/dashboard/referrals', label: 'Мои кампании', icon: Link2 },
    ],
  },
  {
    label: 'КОНФЕРЕНЦИИ',
    items: [
      { href: '/dashboard/conferences', label: 'Мои конференции', icon: Mic },
    ],
  },
  {
    label: 'БАЗА',
    items: [
      { href: '/dashboard/collaborations', label: 'Коллаборации', icon: Users },
    ],
  },
  {
    label: 'СКОРО',
    items: [
      { href: '#', label: 'Премии', icon: Award },
      { href: '#', label: 'Турниры', icon: Trophy },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  function isActive(href: string, exact?: boolean) {
    if (href === '#') return false
    if (exact) return pathname === href
    return pathname === href || pathname.startsWith(href + '/')
  }

  const content = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-white/10">
        <img
          src="/images/logo_no_ivision_wwhite.png"
          alt="ПЛЮСОН"
          className="h-8 w-auto"
          onError={(e) => {
            const t = e.target as HTMLImageElement
            t.style.display = 'none'
            t.nextElementSibling?.classList.remove('hidden')
          }}
        />
        <span className="hidden text-white font-bold text-xl tracking-wide">ПЛЮСОН</span>
        <p className="text-white/50 text-xs mt-1">реферальный сервис</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {sections.map((section, si) => (
          <div key={si} className={si > 0 ? 'mt-4' : ''}>
            {section.label && (
              <p className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest text-white/35 uppercase">
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map(({ href, label, icon: Icon, exact }) => {
                const active = isActive(href, exact)
                const isComingSoon = href === '#'
                return (
                  <Link
                    key={href + label}
                    href={href}
                    onClick={() => !isComingSoon && setMobileOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      isComingSoon
                        ? 'text-white/30 cursor-default pointer-events-none'
                        : active
                        ? 'bg-white/20 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Icon size={17} />
                    <span>{label}</span>
                    {isComingSoon && (
                      <span className="ml-auto text-[9px] font-semibold bg-white/10 text-white/40 px-1.5 py-0.5 rounded">
                        скоро
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 pt-3 border-t border-white/10 space-y-0.5">
        <Link
          href="/dashboard/settings"
          onClick={() => setMobileOpen(false)}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            pathname.startsWith('/dashboard/settings')
              ? 'bg-white/20 text-white'
              : 'text-white/70 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Settings size={17} />
          Настройки
        </Link>
        <button
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/10 w-full transition-colors"
          onClick={() => {
            localStorage.removeItem('plusson_token')
            window.location.href = '/login'
          }}
        >
          <LogOut size={17} />
          Выйти
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sidebar hidden lg:flex flex-col fixed left-0 top-0 bottom-0 z-40">
        {content}
      </aside>

      {/* Mobile hamburger */}
      <button
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg text-white gradient-bg"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="sidebar absolute left-0 top-0 bottom-0 w-64 flex flex-col z-50">
            {content}
          </aside>
        </div>
      )}
    </>
  )
}
