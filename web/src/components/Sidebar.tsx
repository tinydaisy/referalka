'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Calendar, Settings, CreditCard, LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'

const navItems = [
  { href: '/dashboard', label: 'Мои события', icon: Calendar },
  { href: '/dashboard/settings', label: 'Настройки', icon: Settings },
  { href: '/dashboard/billing', label: 'Тарифы', icon: CreditCard },
]

export default function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

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
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
          return (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-white/20 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon size={18} />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* Logout */}
      <div className="px-3 py-4 border-t border-white/10">
        <button
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/10 w-full transition-colors"
          onClick={() => {
            localStorage.removeItem('plusson_token')
            window.location.href = '/login'
          }}
        >
          <LogOut size={18} />
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
