/**
 * Публичная база знаний — /help
 *
 * Те же статьи, что в кабинете, только без входа. Человек до регистрации видит,
 * что продукт понятный и описан по шагам — это само по себе снимает страх
 * «а разберусь ли я». Плюс страницы находит поиск и приводит людей.
 *
 * ⚠️ Технические разделы (интеграции, API) сюда не попадают — см. флаг
 * `internalOnly` в sections.ts.
 */
import Link from 'next/link'
import { BookOpen } from 'lucide-react'

export const metadata = {
  title: 'База знаний — iViSiON: ПЛЮСОН',
  description: 'Инструкции по работе с платформой: события, спикеры, рассылки, воронки, коллаборации.',
}

export default function PublicHelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-3 flex items-center justify-between gap-4">
          <Link href="/help" className="flex items-center gap-2 min-w-0">
            <span className="p-1.5 rounded-lg text-white shrink-0"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
              <BookOpen size={16} />
            </span>
            <span className="font-bold truncate" style={{ color: '#25455D' }}>
              База знаний
            </span>
          </Link>

          <nav className="flex items-center gap-2 sm:gap-4 shrink-0">
            <Link href="/" className="text-sm text-gray-500 hover:text-gray-800 hidden sm:inline">
              О платформе
            </Link>
            <Link href="/login" className="text-sm text-gray-500 hover:text-gray-800">
              Войти
            </Link>
            <Link href="/register" className="btn-gold px-3.5 py-2 rounded-xl text-sm font-semibold">
              Попробовать
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-5 sm:px-8 py-8">
        {children}
      </main>

      <footer className="border-t border-gray-100 bg-white">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-gray-400">
            © iViSiON: ПЛЮСОН — платформа для экспертов, спикеров и организаторов
          </p>
          <Link href="/register" className="text-xs font-medium" style={{ color: '#25455D' }}>
            Попробовать бесплатно →
          </Link>
        </div>
      </footer>
    </div>
  )
}
