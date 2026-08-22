'use client'
/**
 * Шапка публичных страниц ПЛЮСОНа — одна на всё, что НЕ кабинет.
 *
 * ⚠️ В кабинет не попадает: он живёт под /dashboard со своим макетом
 * (DashboardLayout), а эта шапка подключается только в публичных.
 *
 * ⚠️ Логотип на тёмном фоне — светлый вариант. Тёмный на тёмном не виден.
 */
import Link from 'next/link'
import { useState } from 'react'
import { ChevronDown, Menu, X } from 'lucide-react'

const BRAND = '#25455D'

/**
 * «Наши решения». Страниц под модули пока нет — временно ведут на тарифы.
 * ⚠️ Названия с приставкой «Модуль» у Конференций и Премий/Турниров: это
 * части платформы. Коллабораторная без приставки — она ощущается отдельным
 * продуктом (свой каталог, свой лендинг, своя механика).
 */
const SOLUTIONS = [
  { label: 'Модуль «Конференции»', href: '/pricing' },
  { label: 'Модуль «Премии/Турниры»', href: '/pricing' },
  { label: 'Коллабораторная', href: '/pricing' },
  { label: 'ПЛЮСОН', href: '/' },
]

export default function PublicHeader({ registerHref = '/register' }: {
  /**
   * Адрес регистрации. Лендинг передаёт его с реферальным кодом (`?pid=…`) —
   * без этого партнёрская привязка теряется прямо в шапке.
   */
  registerHref?: string
} = {}) {
  const [open, setOpen] = useState(false)      // выпадающий список решений
  const [mobile, setMobile] = useState(false)  // меню на телефоне

  return (
    <header className="bg-white border-b border-gray-100 sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-3 flex items-center justify-between gap-4">
        <Link href="/" className="font-bold text-lg shrink-0" style={{ color: BRAND }}>
          iViSiON: ПЛЮСОН
        </Link>

        {/* Меню на компьютере */}
        <nav className="hidden lg:flex items-center gap-5 text-sm">
          <Link href="/pricing" className="text-gray-600 hover:text-gray-900">Тарифы</Link>
          <Link href="/pricing" className="text-gray-600 hover:text-gray-900">Коллабораторная</Link>

          <div className="relative"
               onMouseEnter={() => setOpen(true)}
               onMouseLeave={() => setOpen(false)}>
            <button type="button" className="flex items-center gap-1 text-gray-600 hover:text-gray-900">
              Наши решения <ChevronDown size={14} />
            </button>
            {open && (
              <div className="absolute left-0 top-full pt-2">
                <div className="bg-white rounded-xl border border-gray-100 shadow-lg py-1.5 min-w-[220px]">
                  {SOLUTIONS.map(s => (
                    <Link key={s.label} href={s.href}
                          className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                      {s.label}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Link href="/pr/ivision-for-speakers" className="text-gray-600 hover:text-gray-900">
            Конференция «ВИДЕНИЕ / iViSiON»
          </Link>
          <Link href="/help" className="text-gray-600 hover:text-gray-900">База знаний</Link>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900 px-2 py-2">
            Войти
          </Link>
          <Link href={registerHref} className="btn-gold px-3.5 sm:px-4 py-2 rounded-xl text-sm font-semibold">
            Зарегистрироваться
          </Link>
          <button type="button" onClick={() => setMobile(v => !v)}
                  aria-label="Меню"
                  className="lg:hidden p-2 -mr-2 text-gray-500">
            {mobile ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Меню на телефоне */}
      {mobile && (
        <div className="lg:hidden border-t border-gray-100 bg-white">
          <div className="max-w-6xl mx-auto px-5 py-3 space-y-1">
            <Link href="/pricing" onClick={() => setMobile(false)}
                  className="block py-2 text-sm text-gray-700">Тарифы</Link>
            <Link href="/pricing" onClick={() => setMobile(false)}
                  className="block py-2 text-sm text-gray-700">Коллабораторная</Link>

            <div className="pt-1">
              <div className="text-xs font-bold uppercase tracking-wide text-gray-400 py-1">
                Наши решения
              </div>
              {SOLUTIONS.map(s => (
                <Link key={s.label} href={s.href} onClick={() => setMobile(false)}
                      className="block py-2 pl-3 text-sm text-gray-700">
                  {s.label}
                </Link>
              ))}
            </div>

            <Link href="/pr/ivision-for-speakers" onClick={() => setMobile(false)}
                  className="block py-2 text-sm text-gray-700">
              Конференция «ВИДЕНИЕ / iViSiON»
            </Link>
            <Link href="/help" onClick={() => setMobile(false)}
                  className="block py-2 text-sm text-gray-700">База знаний</Link>
          </div>
        </div>
      )}
    </header>
  )
}
