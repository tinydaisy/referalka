'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
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
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function SubscriptionBanner() {
  const [sub, setSub] = useState<Subscription | null>(null)

  useEffect(() => {
    api.auth.me()
      .then((data: any) => setSub(data?.subscription || null))
      .catch(() => {})
  }, [])

  if (!sub) return null
  const isExpired = !sub.is_active || sub.days_left < 0
  if (!isExpired) return null

  return (
    <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-3">
      <AlertTriangle size={20} className="text-red-600 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-red-700 text-sm">
          Подписка истекла {formatDate(sub.expires_at)}
        </div>
        <div className="text-red-600 text-xs mt-0.5">
          Редактирование, рассылки и подключение каналов недоступны. Просмотр всех данных сохранён. Продлите тариф для возобновления работы.
        </div>
      </div>
      <Link
        href="/dashboard/settings?tab=subscription"
        className="shrink-0 px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-medium hover:bg-red-700 transition-colors"
      >
        Продлить
      </Link>
    </div>
  )
}
