'use client'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { ArrowLeft, Edit2, Send } from 'lucide-react'

export default function BroadcastsLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams()
  const pathname = usePathname()

  const navItems = [
    { href: `/dashboard/conferences/${id}/broadcasts/templates`, label: 'Шаблоны', icon: Edit2 },
    { href: `/dashboard/conferences/${id}/broadcasts/queue`, label: 'Очередь рассылок', icon: Send },
  ]

  return (
    <div>
      {/* Заголовок раздела */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/dashboard/conferences/${id}`}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h2 className="text-xl font-bold text-gray-900">Рассылки</h2>
          <p className="text-xs text-gray-400 mt-0.5">Шаблоны сообщений и очередь автоматических рассылок</p>
        </div>
      </div>

      {/* Подвкладки */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit mb-6">
        {navItems.map(item => {
          const active = pathname === item.href
          return (
            <Link key={item.href} href={item.href}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              <item.icon size={14} />
              {item.label}
            </Link>
          )
        })}
      </div>

      {children}
    </div>
  )
}
