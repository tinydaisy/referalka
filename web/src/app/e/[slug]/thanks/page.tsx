/**
 * Страница после оплаты — /e/{slug}/thanks (миграция 240).
 *
 * Клиент ставит этот адрес как страницу возврата в платёжной системе
 * (Продамус / ЮKassa / GetCourse). Человек после оплаты видит подтверждение и
 * кнопки на ботов клиента — чтобы не потеряться и получить материалы события.
 *
 * Оформление то же, что у основной страницы: своя запись `event_landing_pages`
 * с kind='post_pay'.
 */
import type { Metadata } from 'next'
import LandingRenderer from '../LandingRenderer'

export const dynamic = 'force-dynamic'

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getLanding(slug: string) {
  try {
    const res = await fetch(
      `${apiBase}/api/v1/public/event-landing/${encodeURIComponent(slug)}?kind=post_pay`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export const metadata: Metadata = {
  title: 'Спасибо за оплату',
  robots: { index: false },   // страницу возврата в поиск не пускаем
}

export default async function ThanksPage({ params }: { params: { slug: string } }) {
  const data = await getLanding(params.slug)

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Спасибо за оплату!</h1>
          <p className="mt-2 text-gray-600">
            Мы свяжемся с вами и пришлём все материалы.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      <LandingRenderer data={data} slug={params.slug} />
    </>
  )
}
