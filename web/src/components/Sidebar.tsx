'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Link2, Mic, Users, UserCircle, Settings, LogOut, Menu, X, Trophy, Award, Send, Calendar, Gift, LifeBuoy, Radio, ChevronDown, BookOpen, MessageCircle, Vote, Wallet, CreditCard, Handshake, Search, Inbox, Sparkles, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLang } from '@/contexts/LangContext'
import { api } from '@/lib/api'

export default function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})  // свёрнутые секции по label
  const [me, setMe] = useState<{ name?: string; email?: string; features?: string[]; role?: string } | null>(null)
  const { t } = useLang()

  useEffect(() => {
    api.auth.me().then((data: any) => setMe({
      name: data?.name,
      email: data?.email,
      features: data?.features || [],
      role: data?.role || 'owner',
    })).catch(() => {})
  }, [])

  const features = me?.features || []
  const hasConference = features.includes('conference')
  const hasContests = features.includes('contests')
  const hasCollabHub = features.includes('collab_hub')
  const isAssistant = me?.role === 'assistant'

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
      label: t.nav.eventsSection,
      items: [
        { href: '/dashboard/events', label: t.nav.events, icon: Calendar },
        // Конференции — только для тарифов с фичей 'conference' (ПРОФИ, VIP, Пробный)
        ...(hasConference ? [{ href: '/dashboard/conferences', label: t.nav.conferences, icon: Mic }] : []),
        // Премии/Турниры — multi-day программы (этапы / недели / дни) поверх тех же таблиц
        // conf_* что и конференции, но семантика и UI заточены под чемпионаты/премии.
        // Доступ — той же фичей 'conference' пока не выделим в отдельную.
        ...(hasConference ? [{ href: '/dashboard/tournaments', label: 'Премии/Турниры', icon: Trophy }] : []),
        // Конкурсы — для тарифов с фичей 'contests' (старт и выше)
        ...(hasContests ? [{ href: '/dashboard/contests', label: 'Участие в конкурсах', icon: Vote }] : []),
      ],
    },
    {
      label: t.nav.base,
      items: [
        { href: '/dashboard/clients', label: t.nav.clients, icon: UserCircle },
        { href: '/dashboard/collaborations', label: t.nav.collaborations, icon: Users },
        { href: '/dashboard/lead-magnets', label: t.nav.leadMagnets, icon: Gift },
        // Каналы — у ассистента нет доступа даже на чтение (миграция 106)
        ...(isAssistant ? [] : [{ href: '/dashboard/channels', label: t.nav.channels, icon: Radio }]),
        // Подписка (тарифы и оплата) — у ассистента нет доступа
        ...(isAssistant ? [] : [{ href: '/dashboard/subscription', label: 'Подписка', icon: CreditCard }]),
        // Партнёрская программа — у ассистента нет доступа (бонусы и вывод — личное)
        ...(isAssistant ? [] : [{ href: '/dashboard/partner-program', label: 'Партнёрская', icon: Wallet }]),
      ],
    },
    // Коллабораторная (Хаб) — ВНЕШНИЙ раздел (другие клиенты ПЛЮСОНа). Под Базой, выделен оттенком + рамкой.
    // Только со 2-го тарифа (pro/vip/trial), не start.
    ...(hasCollabHub ? [{
      label: 'КОЛЛАБОРАТОРНАЯ (ХАБ)',
      external: true,
      items: [
        { href: '/dashboard/collab-hub', label: 'Каталог', icon: Search, exact: true },
        { href: '/dashboard/collab-hub/events', label: 'Коллабы', icon: Calendar },
        { href: '/dashboard/collab-hub/requests', label: 'Запросы', icon: Inbox },
        { href: '/dashboard/collab-hub/matchmaker', label: 'Умный сват', icon: Sparkles },
        { href: '/dashboard/collab-hub/card', label: 'Моя карточка', icon: Star },
      ],
    }] : []),
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
          <span className="text-[#FFCFA4] font-bold text-sm whitespace-nowrap">iViSiON: ПЛЮСОН</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {sections.map((section: any, si: number) => {
          const isCollapsed = section.label ? !!collapsed[section.label] : false
          const isExternal = !!section.external
          return (
          <div key={si} className={`${si > 0 ? 'mt-4' : ''} ${isExternal ? 'rounded-xl border border-[#FFCFA4]/30 bg-[#3a5f7d]/40 p-2' : ''}`}>
            {section.label && (
              <button
                onClick={() => setCollapsed(c => ({ ...c, [section.label]: !c[section.label] }))}
                className="w-full flex items-center gap-1.5 px-2 pb-1.5 text-[10px] font-semibold tracking-widest uppercase hover:text-white/60"
                style={{ color: isExternal ? '#FFCFA4' : 'rgba(255,255,255,0.35)' }}
              >
                <ChevronDown size={12} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                {section.label}
              </button>
            )}
            {!isCollapsed && <div className="space-y-0.5">
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
            </div>}
          </div>
          )
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 pt-3 border-t border-white/10 space-y-0.5">
        {/* Настройки — у ассистента нет доступа (миграция 106) */}
        {!isAssistant && (
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
        )}
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
        {/* Current user — над «Выйти» */}
        {me && (me.name || me.email) && (
          <div className="flex items-center gap-3 px-3 py-2 mt-2 rounded-lg bg-white/5">
            <UserCircle size={28} className="text-white/60 shrink-0" />
            <div className="min-w-0 flex-1">
              {me.name && (
                <div className="text-sm font-medium text-white truncate">
                  {me.name}
                  {isAssistant && (
                    <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wider text-[#FFCFA4]">
                      · ассистент
                    </span>
                  )}
                </div>
              )}
              {me.email && (
                <div className="text-[11px] text-white/50 truncate">{me.email}</div>
              )}
            </div>
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
