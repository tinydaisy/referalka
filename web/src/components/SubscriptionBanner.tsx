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
 * устаревшая плашка врёт заметнее, чем её отсутствие. Оплачен модуль —
 * плашка янтарная (не приговор), нет — красная.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { api } from '@/lib/api'

type Subscription = {
  tariff_slug: string
  tariff_name: string
  expires_at: string
  status: string
  days_left: number
  is_active: boolean
}

/** Модули, которые покупаются отдельно и продолжают работать без тарифа. */
const PAID_MODULES = ['collab_hub', 'conference', 'tournaments', 'awards']

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function SubscriptionBanner() {
  const [sub, setSub] = useState<Subscription | null>(null)
  const [features, setFeatures] = useState<string[]>([])

  useEffect(() => {
    api.auth.me()
      .then((data: any) => {
        setSub(data?.subscription || null)
        setFeatures(Array.isArray(data?.features) ? data.features : [])
      })
      .catch(() => {})
  }, [])

  if (!sub) return null
  const isExpired = !sub.is_active || sub.days_left < 0
  if (!isExpired) return null

  const hasModule = PAID_MODULES.some(s => features.includes(s))

  // ⚠️ ТЕКСТ КОРОТКИЙ И ТОЛЬКО ПО ФАКТУ (решение владельца 2026-08-27).
  // Прежние пояснения «редактирование недоступно», «просмотр всех данных
  // сохранён» были неправдой: у клиента с оплаченным модулем редактирование
  // работает, а «просмотр всех данных» ничего не объясняет. Никаких списков
  // закрытого здесь — только название истёкшего тарифа и одна строка сути.
  const tone = hasModule
    ? { box: 'bg-amber-50 border-amber-200', head: 'text-amber-800', sub: 'text-amber-700',
        icon: 'text-amber-600', btn: 'bg-amber-600 hover:bg-amber-700', Ico: Info }
    : { box: 'bg-red-50 border-red-200', head: 'text-red-700', sub: 'text-red-600',
        icon: 'text-red-600', btn: 'bg-red-600 hover:bg-red-700', Ico: AlertTriangle }
  const Ico = tone.Ico

  return (
    <div className={`mb-4 px-4 py-3 rounded-lg border flex items-start gap-3 ${tone.box}`}>
      <Ico size={20} className={`${tone.icon} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <div className={`font-semibold text-sm ${tone.head}`}>
          Подписка ПЛЮСОН, тариф «{sub.tariff_name}», истекла {formatDate(sub.expires_at)}
        </div>
        <div className={`text-xs mt-0.5 ${tone.sub}`}>
          Часть функционала вам недоступна. Продлите подписку.
        </div>
      </div>
      <Link
        href="/dashboard/settings?tab=subscription"
        className={`shrink-0 px-3 py-1.5 rounded-md text-white text-xs font-medium transition-colors ${tone.btn}`}
      >
        Продлить
      </Link>
    </div>
  )
}
