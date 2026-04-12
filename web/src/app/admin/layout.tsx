'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart2, Users, Handshake, CreditCard, Settings, LogOut } from 'lucide-react'

const adminNav = [
  { href: '/admin', label: 'Обзор', icon: BarChart2 },
  { href: '/admin/clients', label: 'Клиенты', icon: Users },
  { href: '/admin/partners', label: 'Партнёры', icon: Handshake },
  { href: '/admin/tariffs', label: 'Тарифы', icon: CreditCard },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="sidebar hidden lg:flex flex-col fixed left-0 top-0 bottom-0 z-40 w-60">
        <div className="px-5 py-6 border-b border-white/10">
          <p className="text-white font-bold text-lg tracking-wide">ПЛЮСОН</p>
          <p className="text-white/50 text-xs mt-1">Панель администратора</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {adminNav.map(({ href, label, icon: Icon }) => {
            const active = pathname === href
            return (
              <Link key={href} href={href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon size={18} /> {label}
              </Link>
            )
          })}
        </nav>
        <div className="px-3 py-4 border-t border-white/10">
          <button
            className="flex items-center gap-3 px-3 py-2 text-white/60 hover:text-white text-sm w-full"
            onClick={() => { localStorage.removeItem('plusson_token'); window.location.href = '/login' }}
          >
            <LogOut size={16} /> Выйти
          </button>
        </div>
      </aside>
      <main className="flex-1 lg:ml-60 px-4 sm:px-6 py-8 pt-16 lg:pt-8 max-w-6xl">
        {children}
      </main>
    </div>
  )
}
