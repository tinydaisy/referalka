'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { BarChart2, Users, Handshake, CreditCard, Settings, LogOut, Radio, Tag, Percent, FileText, HardDrive, Sparkles, Megaphone, Wrench, ClipboardList, Gift, Contact } from 'lucide-react'
import { api } from '@/lib/api'

const adminNav = [
  { href: '/admin', label: 'Обзор', icon: BarChart2 },
  { href: '/admin/news', label: 'Новости', icon: Megaphone },
  { href: '/admin/clients', label: 'Клиенты', icon: Users },
  { href: '/admin/system-channels', label: 'Системные каналы', icon: Radio },
  { href: '/admin/tg-setup', label: 'Автонастройка', icon: Sparkles },
  { href: '/admin/tech', label: 'Тех-специалисты', icon: Wrench },
  // ⚠️⚠️ ДВА РАЗНЫХ ПУНКТА, И ЭТО НАМЕРЕННО (23.09.2026). Логика у них разная:
  //   • «Клиенты внедренцев» — КАРТОЧКА: события, боты, подписчики, вебинары,
  //     коллаборации, тариф, когда зарегался. Отвечает «что у клиента есть».
  //   • «CRM внедренцев» — ВОРОНКА по статусам: триал → активирован → удержан
  //     → оживлён → отвалился. Отвечает «где он в пути и что делать дальше».
  // Слить их в один экран — значит смешать «что есть» и «где он», а это разные
  // вопросы и разные решения.
  { href: '/admin/tech/clients', label: 'Клиенты внедренцев', icon: Contact },
  { href: '/admin/tech/crm', label: 'CRM внедренцев', icon: Contact },
  { href: '/admin/partners', label: 'Партнёры', icon: Handshake },
  { href: '/admin/tariffs', label: 'Тарифы', icon: CreditCard },
  { href: '/admin/promotions', label: 'Акции', icon: Tag },
  { href: '/admin/orders', label: 'Оплаты', icon: CreditCard },
  // Персональные заказы (миграция 439): произвольная услуга, цена «как
  // договорились». Рядом с «Оплатами» — это тоже про деньги.
  { href: '/admin/custom-orders', label: 'Персональные заказы', icon: ClipboardList },
  { href: '/admin/withdrawals', label: 'Заявки на вывод', icon: CreditCard },
  { href: '/admin/referral-settings', label: 'Реф-программа', icon: Percent },
  // Рядом с реф-программой: это её инструмент — подарок, которым клиенты
  // приводят нам новых клиентов (миграция 472).
  { href: '/admin/plusson-lead-magnet', label: 'Плюсоновский лид-магнит', icon: Gift },
  { href: '/admin/storage', label: 'Файловое хранилище', icon: HardDrive },
  { href: '/admin/legal-docs', label: 'Правовые документы', icon: FileText },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [checking, setChecking] = useState(true)
  const [authorized, setAuthorized] = useState(false)
  const [adminInfo, setAdminInfo] = useState<{ email?: string; name?: string } | null>(null)

  useEffect(() => {
    // Страница /admin/login не должна гонять auth-check (там идёт сам логин).
    if (pathname === '/admin/login') {
      setChecking(false)
      setAuthorized(true)
      return
    }
    const token = typeof window !== 'undefined' && localStorage.getItem('plusson_token')
    if (!token) {
      router.replace('/admin/login')
      return
    }
    // /admin/me доступен ТОЛЬКО для JWT с role='admin'. Используем его
    // (а не /auth/me, который читает clients по sub и для админа возвращает
    // данные клиента-Маргариты — это запутывает guard).
    fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/v1/admin/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(me => {
        if (me && me.role === 'admin') {
          setAdminInfo({ email: me.email, name: me.name })
          setAuthorized(true)
          setChecking(false)
        } else {
          // Не админ или токен невалиден — на /admin/login
          router.replace('/admin/login')
        }
      })
      .catch(() => router.replace('/admin/login'))
  }, [pathname, router])

  if (pathname === '/admin/login') {
    // /admin/login сам по себе не требует обёртки админ-сайдбара
    return <>{children}</>
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Проверяем доступ к админке…</div>
      </div>
    )
  }

  if (!authorized) {
    return null
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="sidebar hidden lg:flex flex-col fixed left-0 top-0 bottom-0 z-40 w-60">
        <div className="px-5 py-6 border-b border-white/10">
          <p className="text-white font-bold text-lg tracking-wide">iViSiON: ПЛЮСОН</p>
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
          {adminInfo && (
            <div className="px-3 py-2 mb-2">
              <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1">Залогинены как</div>
              <div className="text-sm text-white font-medium truncate" title={adminInfo.email}>
                {adminInfo.name || 'Администратор'}
              </div>
              <div className="text-xs text-white/60 truncate" title={adminInfo.email}>
                {adminInfo.email}
              </div>
            </div>
          )}
          <button
            className="flex items-center gap-3 px-3 py-2 text-white/60 hover:text-white text-sm w-full"
            onClick={() => { localStorage.removeItem('plusson_token'); window.location.href = '/admin/login' }}
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
