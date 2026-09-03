'use client'
/**
 * Плашка «подписка истекла» в шапке кабинета.
 *
 * ⚠️ ТЕКСТ — ТОЛЬКО ФАКТ, БЕЗ ПОЯСНЕНИЙ (решение владельца 2026-08-27).
 * Прежняя плашка утверждала: «Редактирование, рассылки и подключение каналов
 * недоступны. Просмотр всех данных сохранён». Оба утверждения неверны у
 * клиента с оплаченным модулем — редактирование у него работает. Человек читал
 * это как приговор всему кабинету и переставал пробовать: отсюда жалобы, что
 * купленный модуль «не работает вовсе».
 *
 * Теперь: какой тариф и когда истёк + одна строка «часть функционала
 * недоступна». Перечислять закрытое здесь нельзя — список меняется, а
 * устаревшая плашка врёт заметнее, чем её отсутствие.
 *
 * ⚠️ ЦВЕТ ВСЕГДА КРАСНЫЙ (решение владельца 2026-08-28). Была развилка «оплачен
 * модуль → янтарная», её убрали: истёкшая подписка — это истёкшая подписка,
 * и выглядеть она должна одинаково у всех. Менялись только формулировки.
 */
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

  // ⚠️ ТЕКСТ КОРОТКИЙ И ТОЛЬКО ПО ФАКТУ (решение владельца 2026-08-27).
  // Прежние пояснения «редактирование недоступно», «просмотр всех данных
  // сохранён» были неправдой: у клиента с оплаченным модулем редактирование
  // работает, а «просмотр всех данных» ничего не объясняет. Никаких списков
  // закрытого здесь — только название истёкшего тарифа и одна строка сути.
  return (
    <div className="mb-4 px-4 py-3 rounded-lg border bg-red-50 border-red-200 flex items-start gap-3">
      <AlertTriangle size={20} className="text-red-600 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-red-700">
          Подписка ПЛЮСОН, тариф «{sub.tariff_name}», истекла {formatDate(sub.expires_at)}
        </div>
        <div className="text-xs mt-0.5 text-red-600">
          Часть функционала вам недоступна. Продлите подписку.
        </div>
      </div>
      <Link
        href="/dashboard/subscription"
        className="shrink-0 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-xs font-medium transition-colors"
      >
        Продлить
      </Link>
    </div>
  )
}
