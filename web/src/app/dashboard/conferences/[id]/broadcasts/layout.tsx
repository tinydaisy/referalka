'use client'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ArrowLeft, Edit2, Send } from 'lucide-react'
import { api } from '@/lib/api'

export default function BroadcastsLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams()
  const pathname = usePathname()

  // Этот layout переиспользуется (ре-экспортом) в conferences / tournaments /
  // events / contests. Базовый раздел берём из текущего URL, а не хардкодим
  // 'conferences' — иначе из турнира «назад» и подвкладки уводили в раздел
  // конференций (и сайдбар подсвечивал «Конференции»).
  const section = pathname.match(/^\/dashboard\/(conferences|tournaments|events|contests)\//)?.[1] || 'conferences'
  const base = `/dashboard/${section}/${id}`

  // ⚠️ У КОЛЛАБЫ раздел называется «Моя очередь рассылок»: организаторы
  // равноправны, каждый ведёт СВОЮ очередь по своей базе и чужие не видит.
  // Общее слово «Рассылки» читалось как одна очередь на всех.
  const [isCollab, setIsCollab] = useState(false)
  useEffect(() => {
    if (!id) return
    api.events.get(Number(id))
      .then((e: any) => setIsCollab(!!(e?.event?.is_collab ?? e?.is_collab)))
      .catch(() => { /* не смогли — оставляем общий заголовок */ })
  }, [id])

  const navItems = [
    { href: `${base}/broadcasts/templates`, label: 'Шаблоны', icon: Edit2 },
    { href: `${base}/broadcasts/queue`, label: 'Очередь рассылок', icon: Send },
  ]

  return (
    <div>
      {/* Заголовок раздела */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={base}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h2 className="text-xl font-bold text-gray-900">
            {isCollab ? 'Моя очередь рассылок' : 'Рассылки'}
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {isCollab
              ? 'Каждый организатор настраивает свою очередь — шаблоны при этом общие для всех'
              : 'Шаблоны сообщений и очередь автоматических рассылок'}
          </p>
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
