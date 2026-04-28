'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Link2, Mic, Users, UserCircle, Settings, LogOut, Menu, X, Trophy, Award, Send, Calendar, Gift, LifeBuoy, Radio, Smartphone, ChevronDown, BookOpen, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLang } from '@/contexts/LangContext'
import { api } from '@/lib/api'

export default function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [me, setMe] = useState<{ name?: string; email?: string } | null>(null)
  const { t, lang, setLang } = useLang()

  useEffect(() => {
    api.auth.me().then((data: any) => setMe({ name: data?.name, email: data?.email })).catch(() => {})
  }, [])

  function isActive(href: string, exact?: boolean) {
    if (href === '#') return false
    if (exact) return pathname === href
    return pathname === href || pathname.startsWith(href + '/')
  }

  const sections = [
    {
      items: [
        { href: '/dashboard', label: t.nav.dashboard, icon: LayoutDashboard, exact: true },
        { href: '/dashboard/broadcasts', label: t.nav.broadcasts, icon: Send },
      ],
    },
    {
      label: t.nav.base,
      items: [
        { href: '/dashboard/clients', label: t.nav.clients, icon: UserCircle },
        { href: '/dashboard/collaborations', label: t.nav.collaborations, icon: Users },
        { href: '/dashboard/lead-magnets', label: t.nav.leadMagnets, icon: Gift },
        { href: '/dashboard/channels', label: t.nav.channels, icon: Radio },
      ],
    },
    {
      label: t.nav.eventsSection,
      items: [
        { href: '/dashboard/events', label: t.nav.events, icon: Calendar },
        { href: '/dashboard/conferences', label: t.nav.conferences, icon: Mic },
      ],
    },
    {
      label: t.nav.miniAppSection,
      items: [
        { href: '/dashboard/mini-app', label: t.nav.miniApp, icon: Smartphone },
      ],
    },
    {
      label: t.nav.soon,
      items: [
        { href: '#', label: t.nav.awards, icon: Award },
        { href: '#', label: t.nav.tournaments, icon: Trophy },
      ],
    },
  ]

  const content = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <img
            src="/images/logo_no_ivision_wwhite.png"
            alt=""
            className="h-8 w-auto"
          />
          <span className="text-[#FFCFA4] font-bold text-xl tracking-wide">ПЛЮСОН</span>
        </div>
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
              {section.items.map(({ href, label, icon: Icon, exact }: { href: string; label: string; icon: any; exact?: boolean }) => {
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
                        {t.nav.comingSoon}
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
        {/* Current user */}
        {me && (me.name || me.email) && (
          <div className="flex items-center gap-3 px-3 py-2 mb-1 rounded-lg bg-white/5">
            <UserCircle size={28} className="text-white/60 shrink-0" />
            <div className="min-w-0 flex-1">
              {me.name && (
                <div className="text-sm font-medium text-white truncate">{me.name}</div>
              )}
              {me.email && (
                <div className="text-[11px] text-white/50 truncate">{me.email}</div>
              )}
            </div>
          </div>
        )}
        {/* Language toggle */}
        <button
          onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-white/50 hover:text-white hover:bg-white/10 w-full transition-colors"
        >
          <span className="text-base leading-none">🌐</span>
          <span>{t.nav.switchLang}</span>
        </button>

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
          {t.nav.settings}
        </Link>
        {/* Тех.поддержка с подменю */}
        <button
          onClick={() => setSupportOpen(o => !o)}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium w-full transition-colors ${
            supportOpen || pathname.startsWith('/dashboard/help')
              ? 'bg-white/10 text-white'
              : 'text-white/70 hover:bg-white/10 hover:text-white'
          }`}
        >
          <LifeBuoy size={17} />
          <span className="flex-1 text-left">Тех.поддержка</span>
          <ChevronDown size={14} className={`transition-transform ${supportOpen ? 'rotate-180' : ''}`} />
        </button>

        {supportOpen && (
          <div className="ml-4 pl-3 border-l border-white/10 mt-0.5 mb-1 space-y-0.5">
            <a
              href="https://t.me/margo_forbs?text=Вопрос_по_Плюсон"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-white/70 hover:bg-white/10 hover:text-white transition-colors"
            >
              <MessageCircle size={15} />
              Написать разработчику в Telegram
            </a>
            <Link
              href="/dashboard/help"
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                pathname.startsWith('/dashboard/help')
                  ? 'bg-white/15 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              <BookOpen size={15} />
              Инструкции
            </Link>
          </div>
        )}
        <button
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/10 w-full transition-colors"
          onClick={() => {
            localStorage.removeItem('plusson_token')
            document.cookie = 'plusson_token=; path=/; max-age=0'
            window.location.href = '/login'
          }}
        >
          <LogOut size={17} />
          {t.nav.logout}
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
