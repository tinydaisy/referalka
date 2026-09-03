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

type Addon = {
  slug: string
  name: string
  expires_at: string | null
  days_left: number
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  // ⚠️ Год обязателен: без него «до 20 августа» читается как «в этом году»,
  // хотя доступ может быть оплачен на год вперёд — клиент шёл в поддержку
  // выяснять, не заканчивается ли у него всё через пару недель.
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** «осталось 3 дня» / «истекает сегодня» / «истекло». */
function daysPhrase(days: number): string {
  if (days < 0) return 'истекло'
  if (days === 0) return 'истекает сегодня'
  const n = days % 100
  const one = days % 10
  const word = (n >= 11 && n <= 14) ? 'дней' : one === 1 ? 'день' : (one >= 2 && one <= 4) ? 'дня' : 'дней'
  return `осталось ${days} ${word}`
}

/**
 * Значок подписки в шапке кабинета.
 *
 * ⚠️ Показывает ТО, ЧТО КОНЧАЕТСЯ РАНЬШЕ ВСЕГО — тариф или любой из купленных
 * модулей. Раньше учитывался только тариф: клиент с оплаченными «Конференциями»
 * видел бодрое «Профи · до 12 марта» и не знал, что модуль сгорает послезавтра.
 *
 * ⚠️ Наведение раскрывает ВЕСЬ состав — тариф и каждый модуль со своим сроком.
 * Одной строкой это не показать (у человека бывает три модуля), а разворачивать
 * список в шапке некуда.
 */
export default function SubscriptionBadge() {
  const [sub, setSub] = useState<Subscription | null>(null)
  const [addons, setAddons] = useState<Addon[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    api.auth.me()
      .then((data: any) => {
        setSub(data?.subscription || null)
        setAddons(Array.isArray(data?.addons) ? data.addons : [])
      })
      .catch(() => {})
  }, [])

  if (!sub) return null

  // Что кончается раньше: тариф или модуль. Модули без срока (бессрочные)
  // в расчёт не берём — им нечего истекать.
  const dated = addons.filter(a => a.expires_at)
  const soonest = dated.reduce<Addon | null>(
    (acc, a) => (acc === null || a.days_left < acc.days_left ? a : acc), null)

  const tariffExpired = !sub.is_active || sub.days_left < 0
  // ⚠️ Истёкший тариф главнее любого модуля: без него кабинет заморожен целиком,
  // и говорить про модуль в этот момент бессмысленно.
  const useAddon = !tariffExpired && soonest !== null && soonest.days_left < sub.days_left

  const days = useAddon ? soonest!.days_left : sub.days_left
  const isExpired = useAddon ? days < 0 : tariffExpired
  const whatName = useAddon ? soonest!.name : sub.tariff_name

  let bg = 'bg-emerald-50'
  let text = 'text-emerald-700'
  let dotColor = 'bg-emerald-500'
  let label: string

  if (isExpired) {
    bg = 'bg-red-50'
    text = 'text-red-700'
    dotColor = 'bg-red-500'
    // ⚠️ Называем, ЧТО именно истекло: «Подписка истекла» при живом тарифе и
    // сгоревшем модуле — прямая неправда, человек шёл разбираться в поддержку.
    label = useAddon ? `${whatName} · истекло` : 'Подписка истекла'
  } else if (days <= 7) {
    bg = 'bg-amber-50'
    text = 'text-amber-700'
    dotColor = 'bg-amber-500'
    label = `${whatName} · ${daysPhrase(days)}`
  } else {
    const iso = useAddon ? soonest!.expires_at! : sub.expires_at
    label = `${whatName} · до ${formatDate(iso)}`
  }

  // Расшифровка нужна, только когда есть о чём рассказывать сверх строки.
  const hasDetails = dated.length > 0

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <Link
        href="/dashboard/subscription"
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${bg} ${text} hover:opacity-80 transition-opacity`}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span>{label}</span>
      </Link>

      {hasDetails && open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-gray-100 bg-white p-3 shadow-lg">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Что подключено
          </p>
          <Row
            name={sub.tariff_name}
            days={sub.days_left}
            expiresAt={sub.expires_at}
            expired={tariffExpired}
          />
          {dated.map(a => (
            <Row
              key={a.slug}
              name={a.name}
              days={a.days_left}
              expiresAt={a.expires_at!}
              expired={a.days_left < 0}
            />
          ))}
          <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-400">
            Нажмите, чтобы продлить
          </p>
        </div>
      )}
    </div>
  )
}

function Row({ name, days, expiresAt, expired }: {
  name: string; days: number; expiresAt: string; expired: boolean
}) {
  const tone = expired ? 'text-red-600' : days <= 7 ? 'text-amber-700' : 'text-gray-500'
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs font-medium text-gray-800">{name}</span>
      <span className={`whitespace-nowrap text-[11px] ${tone}`}>
        {expired ? 'истекло' : `до ${formatDate(expiresAt)}`}
        {!expired && days <= 7 && ` · ${daysPhrase(days)}`}
      </span>
    </div>
  )
}
