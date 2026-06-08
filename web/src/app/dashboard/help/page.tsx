'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ChevronRight, Copy, Check, ExternalLink } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface Article {
  href: string
  title: string
  description: string
  emoji: string
  isPublic?: boolean
  publicNote?: string
}

const ARTICLES: Article[] = [
  {
    href: '/dashboard/help/connect-bot',
    title: 'Как подключить Mini App к своему боту',
    description: 'Пошаговая настройка через @BotFather: токен в Каналах, регистрация Mini App, Menu Button и готовые ссылки',
    emoji: '🤖',
  },
  {
    href: '/dashboard/help/vk-setup',
    title: 'Как подключить Mini App к своему сообществу ВКонтакте',
    description: 'Создание сообщества, Mini App в dev.vk.com, токены сообщества и Secure key, настройка Long Poll и Menu в группе — пошагово со скриншотами',
    emoji: '🟦',
  },
  {
    href: '/dashboard/help/miniapp-deeplinks',
    title: 'Ссылки на нужную вкладку Mini App (Подарки / Программа)',
    description: 'Откройте Mini App участника сразу на «Подарках» или «Программе». Если человек ещё не зарегистрирован — ссылка сама приведёт его на страницу регистрации. Внутри — генератор готовых ссылок под ваши события',
    emoji: '🔗',
  },
  {
    href: '/dashboard/help/alt-launch-links',
    title: 'Альтернативные ссылки запуска в Telegram (бот / лендинг / без лендинга)',
    description: 'Три готовых варианта: чтобы сначала открылся бот с кнопкой на приложение, чтобы бот вёл на ваш сторонний лендинг, или чтобы Mini App открылся сразу без стороннего лендинга (флаг nolend). Внутри — генератор готовых ссылок под ваши события',
    emoji: '🚀',
  },
  {
    href: '/dashboard/help/getcourse-register',
    title: 'Как регистрировать участников со стороннего лендинга (GetCourse)',
    description: 'Настройка формы GetCourse + Процесса с webhook в ПЛЮСОН: при отправке формы участник автоматически помечается зарегистрированным на событие, email и телефон обновляются в его карточке',
    emoji: '📝',
  },
  {
    href: '/dashboard/help/getcourse-partner',
    title: 'Как передавать партнёрский код из GetCourse в ПЛЮСОН',
    description: 'Замыкаем круг «гость → партнёр»: на лендинге GetCourse человек получает свой партнёрский код, через webhook он сохраняется в ПЛЮСОН, и теперь его ссылки автоматически дописывают этот код к лендингу. Внутри — отдельный раздел про настройку виджетов оплаты с JS-скриптом',
    emoji: '🤝',
  },
  {
    href: '/dashboard/help/landing-widgets-people',
    title: 'Виджет «Люди события» для своего лендинга',
    description: 'Спикеры, жюри, организаторы, партнёры со всеми данными (фото, регалии, должность, медийные активы) — на ваш лендинг через один JSON-запрос. Есть готовый промпт для нейросети — копируйте и отдавайте Claude/ChatGPT, она сама подключит',
    emoji: '👥',
  },
  {
    href: '/dashboard/help/landing-widgets-program',
    title: 'Виджет «Программа события» для своего лендинга',
    description: 'Этапы, дни, сессии со спикерами — на ваш лендинг через один JSON-запрос. Время в формате HH:MM МСК. Есть готовый промпт для нейросети — копируйте и отдавайте Claude/ChatGPT, она сама подключит',
    emoji: '📅',
  },
  {
    href: '/docs/api',
    title: 'API iViSiON: ПЛЮСОНа для интеграции с конструкторами чат-ботов',
    description: 'Salebot, BotHelp, SendPulse, n8n, Make, любой webhook. Регистрация участника, программа конференции, спикеры и регалии, каналы, проверка подписки, билет розыгрыша. Есть отдельная секция как настроить блок HTTP-запрос в Salebot и как читать ответ.',
    emoji: '🔌',
    isPublic: true,
    publicNote: 'Публичная страница — ссылку можно дать стороннему разработчику или сценаристу бота, авторизация не нужна',
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
            Содержание всех инструкций по работе с iViSiON: ПЛЮСОН. Кликните по теме, чтобы открыть полный гайд.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {ARTICLES.map(a => <ArticleCard key={a.href} article={a} />)}
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

function ArticleCard({ article }: { article: Article }) {
  const [origin, setOrigin] = useState('https://pluson.ru')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])
  const publicUrl = `${origin}${article.href}`
  function copyPublic(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <Link
      href={article.href}
      className="block bg-white rounded-2xl border border-gray-100 hover:border-gray-300 hover:shadow-md transition-all p-4"
    >
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl flex-shrink-0"
             style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH})` }}>
          {article.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="text-base font-bold" style={{ color: BRAND }}>{article.title}</h2>
            <ChevronRight size={20} className="text-gray-300 flex-shrink-0" />
          </div>
          <p className="text-sm text-gray-500 leading-snug">{article.description}</p>
          {article.isPublic && (
            <div className="mt-3 p-2.5 rounded-lg border border-amber-200 bg-amber-50">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 mb-1.5">
                <ExternalLink size={12} /> Публичная ссылка для шеринга
              </div>
              {article.publicNote && (
                <p className="text-xs text-amber-800 mb-2 leading-snug">{article.publicNote}</p>
              )}
              <div className="flex gap-2">
                <code className="flex-1 bg-white border border-amber-200 rounded px-2 py-1.5 text-xs font-mono overflow-x-auto whitespace-nowrap text-gray-700">
                  {publicUrl}
                </code>
                <button
                  onClick={copyPublic}
                  className="px-2.5 py-1.5 rounded text-white text-xs font-medium flex items-center gap-1 flex-shrink-0"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  {copied ? <><Check size={12}/> Скопировано</> : <><Copy size={12}/> Копировать</>}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Link>
  )
}
