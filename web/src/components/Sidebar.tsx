'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Link2, Mic, Users, UserCircle, Settings, LogOut, Menu, X, Trophy, Award, Send, Calendar, Gift, LifeBuoy, Radio, ChevronDown, BookOpen, MessageCircle, Vote, Wallet, CreditCard, Handshake, Search, Inbox, Sparkles, Star, Smartphone, BarChart3, MessageSquareQuote, FileText, ExternalLink, Lock, ClipboardList, Package, PhoneCall, Megaphone, Wand2, KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLang } from '@/contexts/LangContext'
import { api } from '@/lib/api'
import { SUPPORT_URL, SUPPORT_NAV_LABEL } from '@/lib/support'
import { displayName } from '@/lib/personName'

export default function Sidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})  // свёрнутые секции по label
  const [me, setMe] = useState<{ name?: string; email?: string; features?: string[]; role?: string; assistant_access_level?: string | null; tariff_slug?: string; is_system_service?: boolean } | null>(null)
  const { t } = useLang()

  // Непрочитанные сообщения от людей — цифра у пункта «Контакты».
  // ⚠️ Две цифры, а не одна: `visible` — у подписанных (видно в списке сразу),
  // `hidden` — у полностью отписавшихся (список по умолчанию их прячет).
  const [unread, setUnread] = useState({ visible: 0, hidden: 0 })

  // Необработанные заявки анкет — цифра у пункта «Анкеты», по тому же
  // принципу, что непрочитанные у «Контактов»: видно, что есть работа, не
  // заходя в раздел. «Необработанная» = не стоит галочка «Обработано».
  const [unprocessed, setUnprocessed] = useState(0)

  useEffect(() => {
    api.auth.me().then((data: any) => setMe({
      // ⚠️ Имя владельца кабинета — С ФАМИЛИЕЙ (миграция 381): в шапке меню
      // человек видит себя, и по одному имени кабинет не опознать.
      name: displayName(data?.name, data?.last_name),
      email: data?.email,
      features: data?.features || [],
      role: data?.role || 'owner',
      assistant_access_level: data?.assistant_access_level ?? null,
      tariff_slug: data?.subscription?.tariff_slug,
      is_system_service: !!data?.is_system_service,
    })).catch(() => {})
  }, [])

  // ⚠️ Обновляем по таймеру и при возврате на вкладку: человек читает
  // переписку в соседнем разделе, и без этого цифра в меню оставалась бы
  // прежней до перезагрузки страницы. Раз в минуту — запрос лёгкий (один
  // COUNT по частичному индексу), но чаще дёргать незачем.
  useEffect(() => {
    let alive = true
    const load = () => {
      // Ошибку глушим: цифра в меню не повод показывать человеку сбой.
      api.dialogs.unreadCount()
        .then(r => {
          if (!alive) return
          // Старый бэкенд отдаёт только `unread` — тогда считаем всё видимым.
          const hidden = r?.unread_hidden ?? 0
          const visible = r?.unread_visible ?? ((r?.unread || 0) - hidden)
          setUnread({ visible: Math.max(0, visible), hidden: Math.max(0, hidden) })
        })
        .catch(() => {})
      // Тем же тиком — необработанные заявки анкет: человек отмечает
      // «Обработано» в соседнем разделе, и без обновления цифра в меню
      // висела бы прежней до перезагрузки страницы.
      api.surveys.unprocessedCount()
        .then(r => { if (alive) setUnprocessed(Math.max(0, r?.unprocessed || 0)) })
        .catch(() => {})
    }
    load()
    const timer = setInterval(load, 60_000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
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
  // Менеджер заказов — только «Контакты» и «Анкеты».
  const isOrdersAssistant = isAnyAssistant && me?.assistant_access_level === 'orders'
  // Менеджер лидов — «Контакты» и отслеживание в событиях, но только по
  // закреплённым за ним людям (миграция 484).
  const isLeadsAssistant = isAnyAssistant && me?.assistant_access_level === 'leads'
  // МедиаЛифт — служебный раздел сервисного аккаунта («ПЛЮСОН Сервис»).
  // Одно-единственное событие, не список: пункт ведёт сразу внутрь него.
  const isSystemService = !!me?.is_system_service
  // «Партнёры» (collaborations) — по фиче event_organizers (vip + admin).
  const hasTestimonials = features.includes('testimonials')
  // Продукты/услуги вне событий (миграция 290). ⚠️ Пока фича только у тарифа
  // admin — пункт СКРЫТ, а не показан с замком: раздел ещё не продаётся, и
  // дразнить им клиентов незачем. Станет продаваемым — вернуть как у Анкет.
  const hasProducts = features.includes('products')
  const hasOffers = features.includes('offers')
  // Анкеты (миграция 280) — фича `surveys`, Экстра и выше. Триал зеркалит
  // Профи, поэтому на триале анкет НЕТ: пункт показываем с замком.
  const hasSurveys = features.includes('surveys')
  const hasEventOrganizers = features.includes('event_organizers')
  // Своя партнёрская программа клиента (миграции 346–348). Пока только admin.
  const hasPartnerProgram = features.includes('partner_program')
  // Автообзвоны через Звонопёс (миграция 359). Пока только admin — пункт СКРЫТ
  // без фичи, как «Продукты»: раздел клиентам не продаётся.
  const hasCalls = features.includes('calls')

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

  // ⚠️ Здесь грузились настройки Коллабораторной ради пункта «Закрытый чат»
  // (есть ли адрес чата в TG/MAX, миграции 264 и 266). Пункт убран из меню
  // 16.09.2026 — запрос убран вместе с ним, чтобы сайдбар не ходил в API за
  // тем, что больше не показывает. Вернуть пункт = вернуть и эти строки.

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

  // ⚠️ Менеджеру заказов собираем СВОЁ короткое меню, а не вырезаем пункты
  // из общего: при добавлении нового раздела он иначе появился бы у него
  // сам собой. Разрешаем список, а не запрещаем.
  const ordersSections = [
    {
      label: 'Работа с заявками',
      items: [
        { href: '/dashboard/clients', label: t.nav.clients, icon: UserCircle },
        { href: '/dashboard/surveys', label: 'Анкеты', icon: ClipboardList },
      ],
    },
  ]

  // ⚠️ Менеджеру лидов — тоже СВОЙ список, по той же причине. Он ведёт своих
  // закреплённых людей: смотрит их в базе, находит в отслеживании событий и
  // пишет им. Каких именно людей он увидит, решает не меню, а фильтр на
  // сервере (`contact_assignments`).
  const leadsSections = [
    {
      label: 'Мои люди',
      items: [
        { href: '/dashboard/clients', label: t.nav.clients, icon: UserCircle },
        { href: '/dashboard/events', label: t.nav.events, icon: Calendar },
      ],
    },
  ]

  const sections = isOrdersAssistant ? ordersSections : isLeadsAssistant ? leadsSections : [
    {
      items: [
        { href: '/dashboard/broadcasts', label: t.nav.broadcasts, icon: Send },
        // Автообзвоны — звонки роботом через Звонопёс (миграция 359). Стоят
        // рядом с рассылками: это тот же выбор аудитории, только вместо
        // сообщения — звонок.
        // ⚠️ Пункт СКРЫТ без фичи, а не показан с замком (решение владельца):
        // фича только у admin, раздел клиентам не продаётся — дразнить незачем.
        // Тот же приём, что у «Продуктов».
        ...(hasCalls && !isAssistant ? [{
          href: '/dashboard/calls', label: 'Автообзвоны', icon: PhoneCall,
        }] : []),
        // Аналитика — про источники и воронки рассылок, поэтому стоит рядом
        // с ними, а не в разделе базы (решение владельца 2026-08-12).
        { href: '/dashboard/analytics', label: t.nav.analytics, icon: BarChart3 },
        // «Моя партнёрка» — СВОИ партнёры клиента: они рекомендуют его события
        // и продукты, он платит им сам (решение № 37, сразу под «Аналитикой»).
        // ⚠️ Не путать с «Партнёрка ПЛЮСОНа» внизу сайдбара — там клиент сам
        // партнёр платформы и получает кэшбэк.
        // ⚠️ Пункт виден ВСЕГДА, с замком без фичи: скрытый раздел читается
        // как «такого нет» — тот же приём, что у Анкет и Оферт.
        ...(isAssistant ? [] : [{
          // «(Beta)» — раздел в обкатке, входит только в тариф «Бизнес Beta».
          href: '/dashboard/my-partners', label: 'Моя партнёрка (Beta)',
          icon: Handshake, locked: !hasPartnerProgram,
        }]),
      ],
    },
    {
      label: t.nav.eventsSection,
      items: [
        { href: '/dashboard/events', label: t.nav.events, icon: Calendar },
        // ⚠️ Конференции и Турниры показываем ВСЕГДА — с замочком, если модуль
        // не подключён (2026-08-10). Раньше пункт просто исчезал, и вместе с
        // фильтром в общем списке событие становилось ненаходимым: у клиента
        // «пропадал раздел» без единого объяснения, хотя данные были целы.
        // Замочек честнее: видно, что раздел есть, и понятно, что сделать.
        { href: '/dashboard/conferences', label: t.nav.conferences, icon: Mic, locked: !hasConference },
        // Премии/Турниры — multi-day программы (этапы / недели / дни) поверх тех же таблиц
        // conf_* что и конференции, но семантика и UI заточены под чемпионаты/премии.
        // ⚠️ Доступ — по СВОЕЙ фиче 'tournaments' (модуль-аддон), не по 'conference'.
        { href: '/dashboard/tournaments', label: 'Премии/Турниры', icon: Trophy, locked: !hasTournaments },
        // Конкурсы — для тарифов с фичей 'contests' (старт и выше)
        { href: '/dashboard/contests', label: 'Участие в конкурсах', icon: Vote, locked: !hasContests },
        // МедиаЛифт — только сервисный аккаунт. Одно служебное событие (не список),
        // поэтому ведём сразу внутрь его карточки.
        ...(isSystemService ? [{ href: '/dashboard/medialift', label: 'МедиаЛифт', icon: Radio }] : []),
        // Новости платформы — тоже только сервисный аккаунт (миграция 374).
        // ⚠️ Это ВЕДЕНИЕ новостей (написать, опубликовать, разослать), а не их
        // чтение: чтение у всех клиентов — колокольчик в шапке и /dashboard/news.
        ...(isSystemService && !isAnyAssistant
          ? [{ href: '/dashboard/platform-news', label: 'Новости ПЛЮСОНа', icon: Megaphone }]
          : []),
      ],
    },
    {
      label: 'Учёт ресурсов',
      items: [
        { href: '/dashboard/clients', label: t.nav.clients, icon: UserCircle },
        // ⚠️ Пункты НЕ ВЫРЕЗАЕМ, а показываем с замком (решение владельца):
        // исчезнувший раздел читается как «такого в продукте нет», человек не
        // знает, что возможность существует и её можно подключить. Так уже
        // было с «Лендингом» — клиент решил, что раздел пропал.
        { href: '/dashboard/collaborations', label: t.nav.collaborations, icon: Users, locked: !hasEventOrganizers },
        // Продукты/услуги вне событий: наставничество, мастер-класс, консультация.
        { href: '/dashboard/products', label: 'Продукты и услуги', icon: Package, locked: !hasProducts },
        { href: '/dashboard/lead-magnets', label: t.nav.leadMagnets, icon: Gift },
        // Анкеты + доп. поля контакта (миграция 280) — фича `surveys` (Экстра).
        // ⚠️ Пункт виден ВСЕГДА: скрытый раздел читается как «такого нет».
        // ⚠️ И ВСЕГДА С ЗАМКОМ без фичи — как у соседних «Продуктов» и
        // «Отзывов». Раньше замка в меню не было, и человек на триале узнавал
        // о недоступности только открыв раздел: в меню пункт выглядел обычным.
        { href: '/dashboard/surveys', label: 'Анкеты', icon: ClipboardList, locked: !hasSurveys },
        // Отзывы/кейсы и оферты — по своим фичам (миграция 249).
        { href: '/dashboard/testimonials', label: 'Отзывы и кейсы', icon: MessageSquareQuote, locked: !hasTestimonials },
        // ⚠️ Пункт виден ВСЕГДА: скрытый раздел читается как «такого нет».
        // Без фичи страница покажет замок с объяснением и ссылкой на тариф.
        { href: '/dashboard/offers', label: 'Оферты', icon: FileText },
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
        // База материалов Коллабораторной — страница ВНУТРИ кабинета.
        // ⚠️ Не кабинет покупателя `/my`: смотрит клиент платформы, он уже
        // авторизован, и право смотреть даёт сам модуль. Второй вход по коду
        // на почту тут был бы лишним шагом к данным, доступ к которым есть.
        { href: '/dashboard/collab-hub/materials', label: 'База материалов', icon: BookOpen },
        // ⚠️ ПУНКТ «ЗАКРЫТЫЙ ЧАТ» УБРАН ИЗ МЕНЮ (решение владельца 16.09.2026).
        // Сама страница `/dashboard/collab-hub/chat` и её настройки остаются:
        // по прямой ссылке она работает, и вернуть пункт — это одна строка.
        // Раньше здесь был `...(hasCollabChat ? [{…}] : [])`.
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
              {section.items.map(({ href, label, icon: Icon, exact, external: itemExternal, locked }: { href: string; label: string; icon: any; exact?: boolean; external?: boolean; locked?: boolean }) => {
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
                    <span className={locked ? 'text-white/45' : undefined}>{label}</span>
                    {/* Непрочитанные сообщения от людей — цифра у пункта
                        «Контакты», как счётчик на иконке мессенджера: видно, что
                        кто-то написал, не заходя в раздел.
                        ⚠️ Когда есть непрочитанные у отписавшихся, показываем
                        ДВЕ цифры «0/4»: список контактов по умолчанию прячет
                        отписавшихся, и одна общая цифра выглядела расхождением —
                        в меню «4», а в списке ни одного непрочитанного. */}
                    {href === '/dashboard/clients' && (unread.visible + unread.hidden) > 0 && (
                      <span
                        title={unread.hidden > 0
                          ? `Новых сообщений: ${unread.visible} у подписанных, ${unread.hidden} у отписавшихся.`
                            + ' Отписавшихся список прячет — включите тумблер «показать отписавшихся».'
                          : `Новых сообщений: ${unread.visible}`}
                        className="ml-auto shrink-0 min-w-[20px] text-center text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: '#FFCFA4', color: '#25455D' }}
                      >
                        {unread.hidden > 0 ? `${unread.visible}/${unread.hidden}` : unread.visible}
                      </span>
                    )}
                    {/* Заявки анкет, которые ещё не обработали. Та же логика,
                        что у непрочитанных сообщений: цифра видна из любого
                        раздела, обновляется раз в минуту и при возврате на
                        вкладку. Ноль — бейджа нет вовсе. */}
                    {href === '/dashboard/surveys' && unprocessed > 0 && (
                      <span
                        title={`Заявок ждут обработки: ${unprocessed}`}
                        className="ml-auto shrink-0 min-w-[20px] text-center text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: '#FFCFA4', color: '#25455D' }}
                      >
                        {unprocessed}
                      </span>
                    )}
                    {/* Замочек = модуль не подключён. Пункт НЕ отключаем: клик
                        ведёт на страницу раздела, где объяснено, что делать. */}
                    {locked && <Lock size={12} className="ml-auto text-white/35" />}
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
            {/* ⚠️ Стоит НАД «Инструкциями» намеренно: это «сделайте за меня»,
                то есть более короткий путь, чем читать инструкцию самому. */}
            <Link
              href="/dashboard/autosetup"
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                pathname.startsWith('/dashboard/autosetup')
                  ? 'bg-white/15 text-white'
                  : 'text-white/70 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Wand2 size={15} />
              Автонастройка и готовые решения
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
                      {isFullAssistant ? '· ассистент (полный доступ)'
                        : isOrdersAssistant ? '· менеджер заказов'
                        : isLeadsAssistant ? '· менеджер лидов'
                        : '· ассистент'}
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
                    {/* ⚠️ «Партнёрка ПЛЮСОНа», а не просто «Партнёрская» (решение № 38):
                        рядом появился раздел «Моя партнёрка», где у клиента СВОИ
                        партнёры. Два почти одинаковых названия путали бы: здесь
                        клиент — партнёр платформы и получает кэшбэк, там платит он. */}
                    Партнёрка ПЛЮСОНа
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
                {/* ⚠️ «Сменить пароль» — ТОЛЬКО помощнику. Владелец меняет
                    свой в «Настройках», а помощнику настройки закрыты
                    целиком: до этого пункта он не мог сменить пароль никак,
                    только просить владельца выслать новый. */}
                {isAnyAssistant && (
                  <Link
                    href="/dashboard/my-password"
                    onClick={() => setMobileOpen(false)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      pathname.startsWith('/dashboard/my-password')
                        ? 'bg-white/15 text-white'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <KeyRound size={15} />
                    Сменить пароль
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
