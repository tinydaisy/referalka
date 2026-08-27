'use client'
/**
 * Плашка «тариф истёк» в шапке кабинета.
 *
 * ⚠️ ТЕКСТ ЗАВИСИТ ОТ ТОГО, ЕСТЬ ЛИ ОПЛАЧЕННЫЙ МОДУЛЬ (2026-08-27).
 * Раньше плашка была одна и красная: «Редактирование, рассылки и подключение
 * каналов недоступны». Человек с оплаченной Коллабораторной читал её как
 * приговор всему кабинету, переставал пробовать и писал в поддержку, что
 * модуль не работает вовсе — хотя работало всё, кроме нескольких разделов.
 *
 * Поэтому: модуль оплачен → янтарная плашка и перечисление ЗАКРЫТОГО, а не
 * «ничего не работает». Модуля нет → красная, как была.
 *
 * ⚠️ Названия модулей берём из справочника фич (`/public/features`), а не из
 * литералов в коде: состав и имена меняются данными в админке.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { api } from '@/lib/api'
import { useFeatureCatalog } from '@/components/FeatureLock'

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
  const catalog = useFeatureCatalog()

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

  const mine = PAID_MODULES.filter(s => features.includes(s))
  const names = mine
    .map(s => catalog.find(f => f.slug === s)?.name || null)
    .filter(Boolean) as string[]

  // Модуль оплачен — плашка объясняет, что именно закрыто, и не пугает.
  if (mine.length) {
    const what = names.length
      ? (names.length === 1 ? `Модуль «${names[0]}» работает` : `Ваши модули (${names.join(', ')}) работают`)
      : 'Оплаченный модуль работает'
    return (
      <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-3">
        <Info size={20} className="text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-amber-800 text-sm">
            Тариф закончился {formatDate(sub.expires_at)}. {what} — им можно пользоваться как обычно.
          </div>
          <div className="text-amber-700 text-xs mt-0.5">
            Закрыты только разделы из тарифа: рассылки, реферальная программа, воронки догрева,
            вебинарная комната и приём оплат. Ссылку на сторонний эфир (Zoom и подобное) можно
            указать в настройках события. Продлите тариф, чтобы вернуть остальное.
          </div>
        </div>
        <Link
          href="/dashboard/settings?tab=subscription"
          className="shrink-0 px-3 py-1.5 rounded-md bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 transition-colors"
        >
          Продлить
        </Link>
      </div>
    )
  }

  return (
    <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-3">
      <AlertTriangle size={20} className="text-red-600 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-red-700 text-sm">
          Тариф закончился {formatDate(sub.expires_at)}
        </div>
        <div className="text-red-600 text-xs mt-0.5">
          Все данные на месте и открыты для просмотра. Пока тариф не продлён, нельзя менять
          настройки, вести события и отправлять рассылки.
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
