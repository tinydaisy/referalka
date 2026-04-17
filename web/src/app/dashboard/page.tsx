'use client'
import Link from 'next/link'
import { Link2, Mic, Award, Trophy, ChevronRight } from 'lucide-react'

const modules = [
  {
    href: '/dashboard/referrals',
    icon: Link2,
    title: 'Рефералки',
    description: 'Реферальные кампании для ваших событий. Участники приглашают друзей и получают подарки.',
    color: 'from-[#25455D] to-[#0a1520]',
    available: true,
    badge: null,
  },
  {
    href: '/dashboard/conferences',
    icon: Mic,
    title: 'Конференции',
    description: 'Управляйте спикерами, программой, рассылками и промо-материалами вашей конференции.',
    color: 'from-[#25455D] to-[#0a1520]',
    available: true,
    badge: null,
  },
  {
    href: '#',
    icon: Award,
    title: 'Премии',
    description: 'Организуйте профессиональные премии с голосованием, номинациями и церемонией.',
    color: 'from-gray-400 to-gray-500',
    available: false,
    badge: 'Скоро',
  },
  {
    href: '#',
    icon: Trophy,
    title: 'Турниры',
    description: 'Соревновательные механики: рейтинги, баллы, лидерборды для вашей аудитории.',
    color: 'from-gray-400 to-gray-500',
    available: false,
    badge: 'Скоро',
  },
]

export default function DashboardPage() {
  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Добро пожаловать в ПЛЮСОН</h1>
        <p className="text-gray-500 mt-1">Выберите модуль, с которым хотите работать</p>
      </div>

      {/* Module cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {modules.map((mod) => {
          const Icon = mod.icon
          const card = (
            <div
              className={`relative rounded-2xl overflow-hidden border transition-all h-full ${
                mod.available
                  ? 'border-gray-100 shadow-sm hover:shadow-md hover:-translate-y-0.5 cursor-pointer'
                  : 'border-gray-100 opacity-60 cursor-default'
              }`}
            >
              {/* Top gradient banner */}
              <div className={`bg-gradient-to-br ${mod.color} h-24 flex items-center px-6`}>
                <div className="w-11 h-11 rounded-xl bg-white/20 flex items-center justify-center">
                  <Icon size={22} className="text-white" />
                </div>
                {mod.badge && (
                  <span className="ml-auto text-xs font-semibold bg-white/20 text-white px-2.5 py-1 rounded-full">
                    {mod.badge}
                  </span>
                )}
              </div>

              {/* Content */}
              <div className="bg-white p-5">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-lg font-bold text-gray-900">{mod.title}</h2>
                  {mod.available && <ChevronRight size={18} className="text-gray-400" />}
                </div>
                <p className="text-sm text-gray-500 leading-relaxed">{mod.description}</p>
              </div>
            </div>
          )

          return mod.available ? (
            <Link key={mod.title} href={mod.href} className="block h-full">
              {card}
            </Link>
          ) : (
            <div key={mod.title}>{card}</div>
          )
        })}
      </div>
    </div>
  )
}
