'use client'
/**
 * Шапка публичных страниц ПЛЮСОНа — одна на всё, что НЕ кабинет.
 *
 * ⚠️ В кабинет не попадает: он живёт под /dashboard со своим макетом
 * (DashboardLayout), а эта шапка подключается только в публичных.
 *
 * ⚠️ Фон — фирменный градиент #25455D → #0a1520 под 45°, как во всех шапках
 * платформы. Значит логотип БЕЛЫЙ: синий на тёмном не виден.
 */
import Link from 'next/link'
import { useState } from 'react'
import { ChevronDown, Menu, X } from 'lucide-react'

const DARK = 'linear-gradient(45deg, #25455D, #0a1520)'
const TARIFFS_HREF = '/#tariffs'
const PEACH = '#FFCFA4'

/**
 * «Наши решения». Страниц под модули пока нет — ведут на блок тарифов.
 *
 * ⚠️ Отдельной страницы /pricing НЕТ — только якорь на главной. Появится —
 * правим TARIFFS_HREF здесь и в футере.
 *
 * ⚠️ Приставка «Модуль» у Конференций и Премий/Турниров: это части платформы.
 * Коллабораторная без приставки — отдельный продукт со своим каталогом,
 * лендингом и механикой.
 */
const SOLUTIONS = [
  { label: 'Модуль «Конференции»', href: TARIFFS_HREF },
  { label: 'Модуль «Премии/Турниры»', href: TARIFFS_HREF },
  { label: 'Коллабораторная', href: TARIFFS_HREF },
  { label: 'ПЛЮСОН', href: '/' },
]

/**
 * ⚠️ Короткое «Конференция iViSiON», а не «Конференция «ВИДЕНИЕ / iViSiON»»:
 * длинное название занимало полстроки и ломало ряд переносом на две строки.
 * Полное имя стоит в футере, там место есть.
 */
const NAV = [
  { label: 'Тарифы', href: TARIFFS_HREF },
  { label: 'Коллабораторная', href: TARIFFS_HREF },
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
    <header className="sticky top-0 z-30 text-white" style={{ background: DARK }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center gap-6">

        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/logo_no_ivision_wwhite.png" alt="" className="h-7 w-auto" />
          <span className="font-bold text-[15px] tracking-tight whitespace-nowrap">
            iViSiON: ПЛЮСОН
          </span>
        </Link>

        {/* Меню на компьютере */}
        <nav className="hidden lg:flex items-center gap-6 text-sm flex-1">
          {NAV.map(n => (
            <Link key={n.label} href={n.href}
                  className="text-white/70 hover:text-white transition-colors whitespace-nowrap">
              {n.label}
            </Link>
          ))}

          <div className="relative"
               onMouseEnter={() => setOpen(true)}
               onMouseLeave={() => setOpen(false)}>
            <button type="button"
                    className="flex items-center gap-1 text-white/70 hover:text-white transition-colors whitespace-nowrap">
              Наши решения
              <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
              <div className="absolute left-0 top-full pt-3">
                <div className="bg-white rounded-xl shadow-xl py-1.5 min-w-[230px] overflow-hidden">
                  {SOLUTIONS.map(s => (
                    <Link key={s.label} href={s.href}
                          className="block px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                      {s.label}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Link href="/pr/ivision-for-speakers"
                className="text-white/70 hover:text-white transition-colors whitespace-nowrap">
            Конференция iViSiON
          </Link>
          <Link href="/help"
                className="text-white/70 hover:text-white transition-colors whitespace-nowrap">
            База знаний
          </Link>
        </nav>

        <div className="flex items-center gap-3 shrink-0 ml-auto lg:ml-0">
          <Link href="/login"
                className="text-sm text-white/70 hover:text-white transition-colors whitespace-nowrap">
            Войти
          </Link>
          <Link href={registerHref}
                className="px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-opacity hover:opacity-90"
                style={{ background: PEACH, color: '#25455D' }}>
            Зарегистрироваться
          </Link>
          <button type="button" onClick={() => setMobile(v => !v)}
                  aria-label="Меню"
                  className="lg:hidden p-2 -mr-2 text-white/70">
            {mobile ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Меню на телефоне */}
      {mobile && (
        <div className="lg:hidden border-t border-white/10">
          <div className="max-w-6xl mx-auto px-5 py-3 space-y-0.5">
            {NAV.map(n => (
              <Link key={n.label} href={n.href} onClick={() => setMobile(false)}
                    className="block py-2.5 text-sm text-white/80">
                {n.label}
              </Link>
            ))}

            <div className="pt-2">
              <div className="text-xs font-bold uppercase tracking-wide py-1.5"
                   style={{ color: PEACH }}>
                Наши решения
              </div>
              {SOLUTIONS.map(s => (
                <Link key={s.label} href={s.href} onClick={() => setMobile(false)}
                      className="block py-2.5 pl-3 text-sm text-white/80">
                  {s.label}
                </Link>
              ))}
            </div>

            <Link href="/pr/ivision-for-speakers" onClick={() => setMobile(false)}
                  className="block py-2.5 text-sm text-white/80">
              Конференция «ВИДЕНИЕ / iViSiON»
            </Link>
            <Link href="/help" onClick={() => setMobile(false)}
                  className="block py-2.5 text-sm text-white/80">
              База знаний
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}
