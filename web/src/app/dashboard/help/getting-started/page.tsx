'use client'
import Link from 'next/link'
import { BookOpen, Bot, User, Bell, LayoutGrid, Gift } from 'lucide-react'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

type Step = {
  n: number
  icon: React.ReactNode
  title: string
  intro?: string
  items: { label: string; path: string }[]
  note?: string
  link?: { href: string; label: string }
}

const STEPS: Step[] = [
  {
    n: 1,
    icon: <Bot size={20} />,
    title: 'Подключите своего бота',
    intro: 'Через него участники будут открывать ваше приложение и получать сообщения.',
    items: [
      { label: 'Добавить своего бота', path: 'Дашборд → Каналы → Добавить своего бота → следуйте инструкции' },
    ],
    link: { href: '/dashboard/help/connect-bot', label: 'Подробная инструкция: как подключить Mini App к боту' },
  },
  {
    n: 2,
    icon: <User size={20} />,
    title: 'Расскажите о себе',
    intro: 'Эти данные участники видят в приложении и используют для связи с вами.',
    items: [
      { label: 'Поправьте имя', path: 'Дашборд → Настройки → Профиль → Имя' },
      { label: 'Укажите службу поддержки', path: 'Дашборд → Настройки → Профиль → Служба поддержки → Никнейм' },
      { label: 'Настройте канал для уведомлений', path: 'Дашборд → Настройки → Техническое → Канал уведомлений' },
    ],
  },
  {
    n: 3,
    icon: <LayoutGrid size={20} />,
    title: 'Оформите Mini App',
    intro: 'Так клиент увидит ваш бренд и события в приложении.',
    items: [
      { label: 'Бренд, Основатель, Продукты', path: 'Дашборд → Настройки → Mini App' },
    ],
    note: 'Обязательно вставьте канал и его ID — без этого не будут приходить уведомления о новых интересантах.',
  },
  {
    n: 4,
    icon: <Gift size={20} />,
    title: 'Добавьте свой лид-магнит',
    intro: 'Бесплатный материал, за который человек оставляет контакт и заходит в воронку.',
    items: [
      { label: 'Создать лид-магнит', path: 'Дашборд → Лид-магниты' },
    ],
  },
]

export default function GettingStartedPage() {
  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">С чего начать</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>С чего начать</h1>
          <p className="text-sm text-gray-500 mt-1">
            Минимальная настройка платформы за 4 шага. Всё, что нужно — в меню слева на Дашборде.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {STEPS.map(step => (
          <div key={step.n} className="bg-white rounded-2xl border card-border shadow-sm p-5">
            <div className="flex items-start gap-3.5">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 relative"
                   style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH})`, color: BRAND }}>
                {step.icon}
                <span className="absolute -top-2 -left-2 w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center"
                      style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
                  {step.n}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-bold" style={{ color: BRAND }}>{step.title}</h2>
                {step.intro && <p className="text-sm text-gray-500 mt-0.5">{step.intro}</p>}

                <div className="mt-3 space-y-2.5">
                  {step.items.map((it, i) => (
                    <div key={i}>
                      <div className="text-sm font-semibold text-gray-800">{it.label}</div>
                      <div className="mt-1 inline-block text-xs font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5">
                        {it.path}
                      </div>
                    </div>
                  ))}
                </div>

                {step.note && (
                  <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg border border-amber-200 bg-amber-50">
                    <Bell size={14} className="text-amber-700 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-900 leading-snug">{step.note}</p>
                  </div>
                )}

                {step.link && (
                  <Link href={step.link.href}
                        className="inline-block mt-3 text-xs font-semibold underline"
                        style={{ color: BRAND }}>
                    {step.link.label} →
                  </Link>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
        <div className="text-sm font-semibold text-gray-800 mb-1">Готово!</div>
        <p className="text-sm text-gray-600">
          После этих шагов платформа готова к работе. Дальше можно создавать события, рассылки и подключать
          дополнительные возможности — все инструкции собраны в{' '}
          <Link href="/dashboard/help" className="text-blue-600 hover:underline">разделе Инструкций</Link>.
        </p>
      </div>
    </div>
  )
}
