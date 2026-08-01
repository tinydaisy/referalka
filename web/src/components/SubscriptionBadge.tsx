'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

type Subscription = {
  tariff_slug: string
  tariff_name: string
  expires_at: string
  status: string
  days_left: number
  is_active: boolean
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  // ⚠️ Год обязателен: без него «до 20 августа» читается как «в этом году»,
  // хотя доступ может быть оплачен на год вперёд — клиент шёл в поддержку
  // выяснять, не заканчивается ли у него всё через пару недель.
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function SubscriptionBadge() {
  const [sub, setSub] = useState<Subscription | null>(null)

  useEffect(() => {
    api.auth.me()
      .then((data: any) => setSub(data?.subscription || null))
      .catch(() => {})
  }, [])

  if (!sub) return null

  const daysLeft = sub.days_left
  const isExpired = !sub.is_active || daysLeft < 0

  let bg = 'bg-emerald-50'
  let text = 'text-emerald-700'
  let dotColor = 'bg-emerald-500'
  let label: string

  if (isExpired) {
    bg = 'bg-red-50'
    text = 'text-red-700'
    dotColor = 'bg-red-500'
    label = 'Подписка истекла'
  } else if (daysLeft <= 7) {
    bg = 'bg-amber-50'
    text = 'text-amber-700'
    dotColor = 'bg-amber-500'
    label = daysLeft === 0
      ? 'Истекает сегодня'
      : daysLeft === 1
      ? 'Остался 1 день'
      : `Осталось ${daysLeft} дн.`
  } else {
    label = `${sub.tariff_name} · до ${formatDate(sub.expires_at)}`
  }

  return (
    <Link
      href="/dashboard/settings?tab=subscription"
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${bg} ${text} hover:opacity-80 transition-opacity`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span>{label}</span>
    </Link>
  )
}
