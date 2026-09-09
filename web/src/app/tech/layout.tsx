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
import { Users, Wallet, BookOpen, MessageCircle, LogOut } from 'lucide-react'
import { api } from '@/lib/api'

const NAV = [
  { href: '/tech', label: 'Мои клиенты', icon: Users, exact: true },
  { href: '/tech/dialogs', label: 'Диалоги', icon: MessageCircle },
  { href: '/tech/accruals', label: 'Начисления', icon: Wallet },
]

export default function TechLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [me, setMe] = useState<any>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (pathname === '/tech/login') { setChecked(true); return }
    api.tech.me()
      .then(setMe)
      .catch(() => router.replace('/tech/login'))
      .finally(() => setChecked(true))
  }, [pathname, router])

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
                <Icon size={17} /> {label}
              </Link>
            )
          })}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="px-3 py-2 text-sm text-white/80">{me?.name || me?.email}</div>
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
