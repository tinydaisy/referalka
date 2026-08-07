'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Link2, Mic, Users, UserCircle, Settings, LogOut, Menu, X, Trophy, Award, Send, Calendar, Gift, LifeBuoy, Radio, ChevronDown, BookOpen, MessageCircle, Vote, Wallet, CreditCard, Handshake, Search, Inbox, Sparkles, Star, Smartphone, BarChart3, MessageSquareQuote, FileText, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLang } from '@/contexts/LangContext'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_NAV_LABEL } from '@/lib/support'

export default function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})  // свёрнутые секции по label
  const [me, setMe] = useState<{ name?: string; email?: string; features?: string[]; role?: string; assistant_access_level?: string | null; tariff_slug?: string; is_system_service?: boolean } | null>(null)
  const { t } = useLang()

  useEffect(() => {
    api.auth.me().then((data: any) => setMe({
      name: data?.name,
      email: data?.email,
      features: data?.features || [],
      role: data?.role || 'owner',
      assistant_access_level: data?.assistant_access_level ?? null,
      tariff_slug: data?.subscription?.tariff_slug,
      is_system_service: !!data?.is_system_service,
    })).catch(() => {})
  }, [])

  const features = me?.features || []
  const hasConference = features.includes('conference')
  // Премии/Турниры — ОТДЕЛЬНЫЙ платный модуль (features.tournaments, 5000 ₽/мес).
  // Раньше открывался по фиче 'conference' — клиент, купивший только Конференции,
  // получал турниры бесплатно.
  const hasTournaments = features.includes('tournaments')
  const hasContests = features.includes('contests')
  const hasCollabHub = features.includes('collab_hub')
  const isAnyAssistant = me?.role === 'assistant'
  const isFullAssistant = isAnyAssistant && me?.assistant_access_level === 'full'
  // Режем UI только ограниченному ассистенту — полный работает как владелец (миграция 208).
  const isAssistant = isAnyAssistant && !isFullAssistant
  // МедиаЛифт — служебный раздел сервисного аккаунта («ПЛЮСОН Сервис»).
  // Одно-единственное событие, не список: пункт ведёт сразу внутрь него.
  const isSystemService = !!me?.is_system_service
  // «Партнёры» (collaborations) — по фиче event_organizers (vip + admin).
  const hasTestimonials = features.includes('testimonials')
  const hasOffers = features.includes('offers')
  const hasEventOrganizers = features.includes('event_organizers')

  // Коллаб-событие открывается по тому же пути /dashboard/events/{id}, что и обычное
  // мероприятие. Чтобы в меню подсвечивались «Коллабы», а не «Мероприятия», узнаём
  // is_collab по id из пути (лёгкий запрос, кешируется по id).
  const eventIdInPath = (() => {
    const m = /^\/dashboard\/events\/(\d+)/.exec(pathname || '')
    return m ? Number(m[1]) : null
  })()
  const [collabEventIds, setCollabEventIds] = useState<Record<number, boolean>>({})
  useEffect(() => {
    if (!eventIdInPath || collabEventIds[eventIdInPath] !== undefined) return
    api.events.get(eventIdInPath)
      .then((r: any) => setCollabEventIds(prev => ({ ...prev, [eventIdInPath]: !!r?.event?.is_collab })))
      .catch(() => setCollabEventIds(prev => ({ ...prev, [eventIdInPath]: false })))
  }, [eventIdInPath])
  const inCollabEvent = eventIdInPath ? collabEventIds[eventIdInPath] === true : false

  // Есть ли закрытый чат Коллабораторной хоть на одной площадке (TG/MAX,
  // миграции 264 и 266). Сам пункт ведёт на внутреннюю страницу с кнопками —
  // площадок две, прямой ссылкой в меню их не уместить.
  // Грузим только тем, у кого раздел есть; ошибку глотаем — без ссылок просто
  // не будет пункта меню, ломать сайдбар из-за этого нельзя.
  const [hasCollabChat, setHasCollabChat] = useState(false)
  useEffect(() => {
    if (!hasCollabHub) return
    api.collabHub.settings()
      .then((r: any) => setHasCollabChat(!!(r?.chat_url || r?.chat_url_max)))
      .catch(() => {})
  }, [hasCollabHub])

  function isActive(href: string, exact?: boolean) {
    if (href === '#') return false
    // Открыта коллаба → «Мероприятия» не активны, активны «Коллабы».
    if (inCollabEvent) {
      if (href === '/dashboard/events') return false
      if (href === '/dashboard/collab-hub/events') return true
    }
    if (exact) return pathname === href
    return pathname === href || pathname.startsWith(href + '/')
  }

  const sections = [
    {
      items: [
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
        // ⚠️ Доступ — по СВОЕЙ фиче 'tournaments' (модуль-аддон), не по 'conference'.
        ...(hasTournaments ? [{ href: '/dashboard/tournaments', label: 'Премии/Турниры', icon: Trophy }] : []),
        // Конкурсы — для тарифов с фичей 'contests' (старт и выше)
        ...(hasContests ? [{ href: '/dashboard/contests', label: 'Участие в конкурсах', icon: Vote }] : []),
        // МедиаЛифт — только сервисный аккаунт. Одно служебное событие (не список),
        // поэтому ведём сразу внутрь его карточки.
        ...(isSystemService ? [{ href: '/dashboard/medialift', label: 'МедиаЛифт', icon: Radio }] : []),
      ],
    },
    {
      label: t.nav.base,
      items: [
        { href: '/dashboard/clients', label: t.nav.clients, icon: UserCircle },
        // «Партнёры» (коллабораторы/спикеры) — по фиче event_organizers.
        ...(hasEventOrganizers ? [{ href: '/dashboard/collaborations', label: t.nav.collaborations, icon: Users }] : []),
        { href: '/dashboard/lead-magnets', label: t.nav.leadMagnets, icon: Gift },
        // Отзывы/кейсы и оферты — по своим фичам (миграция 249).
        ...(hasTestimonials ? [{ href: '/dashboard/testimonials', label: 'Отзывы и кейсы', icon: MessageSquareQuote }] : []),
        // ⚠️ Пункт виден ВСЕГДА: скрытый раздел читается как «такого нет».
        // Без фичи страница покажет замок с объяснением и ссылкой на тариф.
        { href: '/dashboard/offers', label: 'Оферты', icon: FileText },
        { href: '/dashboard/analytics', label: t.nav.analytics, icon: BarChart3 },
        // Каналы — у ассистента нет доступа даже на чтение (миграция 106)
        ...(isAssistant ? [] : [{ href: '/dashboard/channels', label: t.nav.channels, icon: Radio }]),
        // Mini App: Продукты — отдельная ссылка ТОЛЬКО для ассистента. Владелец
        // попадает в Mini App через Настройки → вкладка «Mini App» (ему Настройки
        // доступны). У ассистента Настройки скрыты, но продукты (client_offerings)
        // ему разрешены полностью — даём прямой вход на вкладку «Продукты».
        ...(isAssistant ? [{ href: '/dashboard/mini-app?tab=products', label: 'Mini App: Продукты', icon: Smartphone }] : []),
        // «Подписка» и «Партнёрская» перенесены в меню пользователя (внизу сайдбара).
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
        // Закрытый чат участников — страница с кнопками на площадки (TG/MAX),
        // адреса задаёт администратор платформы. Ни одной ссылки → пункта нет.
        ...(hasCollabChat
          ? [{ href: '/dashboard/collab-hub/chat', label: 'Закрытый чат', icon: MessageCircle }]
          : []),
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
              {section.items.map(({ href, label, icon: Icon, exact, external: itemExternal }: { href: string; label: string; icon: any; exact?: boolean; external?: boolean }) => {
                const active = isActive(href, exact)
                const isComingSoon = href === '#'
                // Внешняя ссылка (например закрытый чат в Telegram) — обычный
                // <a> в новую вкладку: Link увёл бы на несуществующий роут.
                if (itemExternal) {
                  return (
                    <a
                      key={href + label}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setMobileOpen(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <Icon size={17} />
                      <span>{label}</span>
                      <ExternalLink size={13} className="ml-auto text-white/40" />
                    </a>
                  )
                }
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

      {/* Bottom — на мобильном крупный нижний отступ, чтобы панель браузера на
          iPhone не перекрывала имя пользователя и раскрывающееся меню под ним.
          На десктопе (lg) отступ обычный. */}
      <div className="px-3 pt-3 pb-24 lg:pb-4 sidebar-bottom-safe border-t border-white/10 space-y-0.5">
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
            <Link
              href={SUPPORT_URL}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                pathname === SUPPORT_URL
                  ? 'bg-white/15 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              <MessageCircle size={15} />
              {SUPPORT_NAV_LABEL}
            </Link>
            <Link
              href="/dashboard/help"
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                pathname.startsWith('/dashboard/help') && pathname !== SUPPORT_URL
                  ? 'bg-white/15 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              <BookOpen size={15} />
              Инструкции
            </Link>
          </div>
        )}
        {/* Current user — кликабельный, раскрывает меню Настройки / Партнёрская / Подписка.
            Показываем ВСЕГДА (имя/email опциональны) — иначе при не загруженном /auth/me
            пропадает доступ к Настройкам. */}
        <>
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className={`flex items-center gap-3 px-3 py-2 mt-2 w-full rounded-lg transition-colors ${
                userMenuOpen ? 'bg-white/10' : 'bg-white/5 hover:bg-white/10'
              }`}
            >
              <UserCircle size={28} className="text-white/60 shrink-0" />
              <div className="min-w-0 flex-1 text-left">
                <div className="text-sm font-medium text-white truncate">
                  {me?.name || me?.email || 'Мой кабинет'}
                  {isAnyAssistant && (
                    <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wider text-[#FFCFA4]">
                      {isFullAssistant ? '· ассистент (полный доступ)' : '· ассистент'}
                    </span>
                  )}
                </div>
                {me?.name && me?.email && (
                  <div className="text-[11px] text-white/50 truncate">{me.email}</div>
                )}
              </div>
              <ChevronDown size={14} className={`text-white/50 shrink-0 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {userMenuOpen && (
              <div className="ml-4 pl-3 border-l border-white/10 mt-0.5 mb-1 space-y-0.5">
                {/* Настройки — у ассистента нет доступа (миграция 106) */}
                {!isAssistant && (
                  <Link
                    href="/dashboard/settings"
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      pathname.startsWith('/dashboard/settings')
                        ? 'bg-white/15 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Settings size={15} />
                    {t.nav.settings}
                  </Link>
                )}
                {/* Партнёрская программа — у ассистента нет доступа (бонусы и вывод — личное) */}
                {!isAssistant && (
                  <Link
                    href="/dashboard/partner-program"
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      pathname.startsWith('/dashboard/partner-program')
                        ? 'bg-white/15 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <Wallet size={15} />
                    Партнёрская
                  </Link>
                )}
                {/* Подписка (тарифы и оплата) — у ассистента нет доступа */}
                {!isAssistant && (
                  <Link
                    href="/dashboard/subscription"
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      pathname.startsWith('/dashboard/subscription')
                        ? 'bg-white/15 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <CreditCard size={15} />
                    Подписка
                  </Link>
                )}
              </div>
            )}
        </>
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
