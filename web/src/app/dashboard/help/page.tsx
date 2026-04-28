'use client'
import Link from 'next/link'
import { BookOpen, ChevronRight } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface Article {
  href: string
  title: string
  description: string
  emoji: string
}

const ARTICLES: Article[] = [
  {
    href: '/dashboard/help/connect-bot',
    title: 'Как подключить Mini App к своему боту',
    description: 'Пошаговая настройка через @BotFather: токен в Каналах, регистрация Mini App, Menu Button и готовые ссылки',
    emoji: '🤖',
  },
]

export default function HelpIndexPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Тех.поддержка / Инструкции</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Инструкции</h1>
          <p className="text-sm text-gray-500 mt-1">
            Содержание всех инструкций по работе с ПЛЮСОН. Кликните по теме, чтобы открыть полный гайд.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {ARTICLES.map(a => (
          <Link
            key={a.href}
            href={a.href}
            className="block bg-white rounded-2xl border border-gray-100 hover:border-gray-300 hover:shadow-md transition-all p-4"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl flex-shrink-0"
                   style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH})` }}>
                {a.emoji}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h2 className="text-base font-bold" style={{ color: BRAND }}>{a.title}</h2>
                  <ChevronRight size={20} className="text-gray-300 flex-shrink-0" />
                </div>
                <p className="text-sm text-gray-500 leading-snug">{a.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Не нашли ответ?</div>
        <p className="text-sm text-gray-600">
          Напишите разработчику —{' '}
          <a href="https://t.me/margo_forbs?text=Вопрос_по_Плюсон"
             target="_blank" rel="noopener noreferrer"
             className="text-blue-600 hover:underline">
            открыть чат в Telegram
          </a>
        </p>
      </div>
    </div>
  )
}
