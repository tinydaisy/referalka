'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ChevronRight, ChevronDown, Copy, Check, ExternalLink } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

interface Article {
  href: string
  title: string
  description: string
  emoji: string
  isPublic?: boolean
  publicNote?: string
  group?: string
}

interface Section {
  id: string
  title: string
  emoji: string
  hint?: string
  articles: Article[]
}

const SECTIONS: Section[] = [
  {
    id: 'setup',
    title: 'Первичная настройка',
    emoji: '⚙️',
    hint: 'С чего начать — подключение Mini App к вашему боту и сообществу',
    articles: [
      {
        href: '/dashboard/help/connect-bot',
        title: 'Как подключить Mini App к своему боту (Telegram)',
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
        href: '/dashboard/help/max-setup',
        title: 'Как создать открытый канал в MAX',
        description: 'Пошаговый гайд через платформу «Партнёры МАХ» (business.max.ru): регистрация, верификация организации по ИНН (Госуслуги или банки) и создание открытого канала — около 15–20 минут',
        emoji: '🟣',
      },
    ],
  },
  {
    id: 'links',
    title: 'Дополнительные ссылки',
    emoji: '🔗',
    hint: 'Готовые ссылки на нужные вкладки и альтернативные способы запуска',
    articles: [
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
    ],
  },
  {
    id: 'api',
    title: 'API-функции для интеграции со сторонними сервисами',
    emoji: '🔌',
    hint: 'Получение и передача данных события во внешние системы, GetCourse',
    articles: [
      {
        group: 'Выгрузка и API',
        href: '/dashboard/help/participants-export',
        title: 'Выгрузка участников события (зарегистрированные / незарегистрированные)',
        description: 'Два готовых запроса: список зарегистрированных и список незарегистрированных участников события — без организаторов, жюри, спикеров и партнёров. JSON с именем, email, телефоном, реф-кодом, UTM и аккаунтами в Telegram/VK/MAX. Для своих рассылок, аналитики, импорта в CRM',
        emoji: '📤',
      },
      {
        group: 'Выгрузка и API',
        href: '/docs/api',
        title: 'API iViSiON: ПЛЮСОНа для интеграции с конструкторами чат-ботов',
        description: 'Salebot, BotHelp, SendPulse, n8n, Make, любой webhook. Регистрация участника, программа конференции, спикеры и регалии, каналы, проверка подписки, билет розыгрыша. Есть отдельная секция как настроить блок HTTP-запрос в Salebot и как читать ответ.',
        emoji: '🔌',
        isPublic: true,
        publicNote: 'Публичная страница — ссылку можно дать стороннему разработчику или сценаристу бота, авторизация не нужна',
      },
      {
        group: '🎓 Интеграция с GetCourse',
        href: '/dashboard/help/getcourse-register',
        title: 'Как регистрировать участников со стороннего лендинга (GetCourse)',
        description: 'Настройка формы GetCourse + Процесса с webhook в ПЛЮСОН: при отправке формы участник автоматически помечается зарегистрированным на событие, email и телефон обновляются в его карточке',
        emoji: '📝',
      },
      {
        group: '🎓 Интеграция с GetCourse',
        href: '/dashboard/help/getcourse-partner',
        title: 'Как передавать партнёрский код из GetCourse в ПЛЮСОН',
        description: 'Замыкаем круг «гость → партнёр»: на лендинге GetCourse человек получает свой партнёрский код, через webhook он сохраняется в ПЛЮСОН, и теперь его ссылки автоматически дописывают этот код к лендингу. Внутри — отдельный раздел про настройку виджетов оплаты с JS-скриптом',
        emoji: '🤝',
      },
      {
        group: '🌐 Передача данных события для внешних сайтов',
        href: '/dashboard/help/landing-widgets-program',
        title: 'Передача данных: «Программа события» для своего лендинга',
        description: 'Этапы, дни, сессии со спикерами — на ваш лендинг через один JSON-запрос. Время в формате HH:MM МСК. Есть готовый промпт для нейросети — копируйте и отдавайте Claude/ChatGPT, она сама подключит',
        emoji: '📅',
      },
      {
        group: '🌐 Передача данных события для внешних сайтов',
        href: '/dashboard/help/landing-widgets-people',
        title: 'Передача данных: «Люди события» для своего лендинга',
        description: 'Спикеры, жюри, организаторы, партнёры со всеми данными (фото, регалии, должность, медийные активы) — на ваш лендинг через один JSON-запрос. Есть готовый промпт для нейросети — копируйте и отдавайте Claude/ChatGPT, она сама подключит',
        emoji: '👥',
      },
    ],
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
            Все инструкции по работе с iViSiON: ПЛЮСОН, собранные по разделам. Откройте раздел и выберите тему.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {SECTIONS.map((s, i) => <SectionBlock key={s.id} section={s} defaultOpen={i === 0} />)}
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

function SectionBlock({ section, defaultOpen }: { section: Section; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
             style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH})` }}>
          {section.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-bold" style={{ color: BRAND }}>{section.title}</div>
          {section.hint && <div className="text-xs text-gray-400 mt-0.5">{section.hint}</div>}
        </div>
        <span className="text-xs text-gray-400 flex-shrink-0">{section.articles.length}</span>
        {open
          ? <ChevronDown size={20} className="text-gray-400 flex-shrink-0" />
          : <ChevronRight size={20} className="text-gray-300 flex-shrink-0" />}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-gray-50">
          {section.articles.map((a, idx) => {
            const showGroup = a.group && a.group !== section.articles[idx - 1]?.group
            return (
              <div key={a.href}>
                {showGroup && (
                  <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mt-3 mb-1.5 px-1">
                    {a.group}
                  </div>
                )}
                <ArticleCard article={a} />
              </div>
            )
          })}
        </div>
      )}
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
      className="block bg-white rounded-xl border border-gray-100 hover:border-gray-300 hover:shadow-sm transition-all p-3.5"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl flex-shrink-0"
             style={{ background: '#f8fafc' }}>
          {article.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="text-sm font-bold" style={{ color: BRAND }}>{article.title}</h2>
            <ChevronRight size={18} className="text-gray-300 flex-shrink-0" />
          </div>
          <p className="text-xs text-gray-500 leading-snug">{article.description}</p>
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
