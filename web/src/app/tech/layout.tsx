'use client'

/**
 * Кабинет тех-специалиста (внедренца) — третий тип входа (миграция 391).
 *
 * ⚠️ Отдельный раздел, а не вкладка в кабинете клиента: специалист видит СРЕЗ
 * данных платформы по закреплённым за ним клиентам. Ни кабинет клиента, ни
 * админка для этого не годятся — в первом нет данных о подписках вовсе, во
 * второй все клиенты и тарифы.
 *
 * ⚠️ Права проверяет БЭКЕНД на каждом запросе (`get_current_tech` + фильтр по
 * `tech_specialist_id` в SQL). Здесь только навигация и вход: спрятанный пункт
 * меню защитой не является.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Users, Wallet, BookOpen, MessageCircle, LogOut, TrendingUp, ClipboardList, HelpCircle, Bell, Coins, Contact, Send, Landmark } from 'lucide-react'
import { api } from '@/lib/api'

const NAV = [
  { href: '/tech', label: 'Мои клиенты', icon: Users, exact: true },
  // ⚠️ «Мои клиенты» и «CRM» — РАЗНЫЕ разделы: первый отвечает «что у клиента
  // есть» (события, боты, подписчики), второй — «где он в воронке».
  { href: '/tech/crm', label: 'CRM', icon: Contact },
  { href: '/tech/kpi', label: 'Показатели', icon: TrendingUp },
  { href: '/tech/dialogs', label: 'Диалоги', icon: MessageCircle },
  // ⚠️ «Мои деньги» — разбор заработка по видам; «Начисления» — список
  // операций. Это разные экраны: первый объясняет, второй перечисляет.
  { href: '/tech/money', label: 'Мои деньги', icon: Coins },
  { href: '/tech/accruals', label: 'Начисления', icon: Wallet },
  // Персональные заказы (миграция 439): внедренец собирает услугу под
  // клиента и отдаёт ссылку на оплату. Видит ТОЛЬКО свои — фильтр в SQL.
  { href: '/tech/custom-orders', label: 'Персональные заказы', icon: ClipboardList },
  // Частые вопросы (миграция 460): ОБЩАЯ база готовых ответов — завёл один,
  // видят все. Ответ копируется кнопкой и сразу отправляется клиенту.
  { href: '/tech/faq', label: 'Частые вопросы', icon: HelpCircle },
  // Куда слать события по своим клиентам: личка в боте + рабочая группа.
  { href: '/tech/notify', label: 'Уведомления', icon: Bell },
  // Доступ в mailer.pluson.ru (миграция 517): выдаёт владелец из админки.
  { href: '/tech/mailer', label: 'Авторассыльщик', icon: Send },
]

export default function TechLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [me, setMe] = useState<any>(null)
  const [checked, setChecked] = useState(false)
  // Новые сообщения — цифрой у пункта «Диалоги», как в кабинете клиента:
  // без неё человек не знает, что ему написали, пока сам не откроет раздел.
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (pathname === '/tech/login') { setChecked(true); return }
    api.tech.me()
      .then(setMe)
      .catch(() => router.replace('/tech/login'))
      .finally(() => setChecked(true))
  }, [pathname, router])

  // ⚠️ Отдельным лёгким запросом и ПЕРИОДИЧЕСКИ: сообщение может прийти, пока
  // человек сидит на другой странице, и цифра должна появиться сама.
  // Перечитываем и при смене страницы — вышел из диалогов, цифра упала.
  useEffect(() => {
    if (pathname === '/tech/login') return
    let alive = true
    const load = () => api.tech.dialogsUnread()
      .then((r: any) => { if (alive) setUnread(r?.unread || 0) })
      .catch(() => {})
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [pathname])

  if (pathname === '/tech/login') return <>{children}</>
  if (!checked) return null

  // Материалы Коллабораторной — только тем, кому это право дали поимённо: их
  // видят все купившие модуль, и ошибка одного видна всей платформе.
  const nav = me?.can_edit_materials
    ? [...NAV, { href: '/tech/materials', label: 'Материалы', icon: BookOpen }]
    : NAV

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="hidden w-64 shrink-0 flex-col md:flex"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        <div className="border-b border-white/10 px-5 py-6">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/logo_no_ivision_wwhite.png" alt="" className="h-8 w-auto" />
            <span className="whitespace-nowrap text-sm font-bold text-[#FFCFA4]">
              iViSiON: ПЛЮСОН
            </span>
          </div>
          <div className="mt-2 text-xs text-white/50">Кабинет внедренца</div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {nav.map(({ href, label, icon: Icon, exact }: any) => {
            const active = exact ? pathname === href : pathname.startsWith(href)
            return (
              <Link key={href} href={href}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                      active ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}>
                <Icon size={17} />
                <span className="flex-1">{label}</span>
                {/* Цифра новых сообщений — только у «Диалогов» и только когда
                    есть что показать: ноль в кружке ничего не сообщает. */}
                {href === '/tech/dialogs' && unread > 0 && (
                  <span className="rounded-full px-1.5 py-0.5 text-[11px] font-bold"
                        style={{ background: '#FFCFA4', color: '#25455D' }}
                        title={`Новых сообщений: ${unread}`}>
                    {unread}
                  </span>
                )}
              </Link>
            )
          })}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="px-3 py-2 text-sm text-white/80">{me?.name || me?.email}</div>
          {/* Реквизиты — рядом с именем (просьба владельца 26.09.2026): это
              данные о самом человеке, а не рабочий раздел. */}
          <Link href="/tech/requisites"
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  pathname.startsWith('/tech/requisites')
                    ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}>
            <Landmark size={17} /> Реквизиты для выплат
          </Link>
          <button
            onClick={() => { localStorage.removeItem('plusson_token'); router.replace('/tech/login') }}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/70 transition-colors hover:bg-white/10 hover:text-white">
            <LogOut size={17} /> Выйти
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden">{children}</main>
    </div>
  )
}
