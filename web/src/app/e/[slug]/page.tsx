/**
 * Публичная страница собранного лендинга события (миграция 240).
 *
 *   /e/{slug}         — основная страница
 *   /e/{slug}/thanks  — страница после оплаты (return-url платёжки)
 *
 * Данные приходят одним запросом с бэка уже собранными: оформление, блоки в
 * нужном порядке и содержимое живых блоков (спикеры, программа, тарифы). Здесь
 * — только загрузка и передача в рендер.
 *
 * Черновик (`is_published = FALSE`) бэк отдаёт 404 → показываем «не найдено».
 */
import type { Metadata } from 'next'
import LandingRenderer from './LandingRenderer'

export const dynamic = 'force-dynamic'   // цены и «осталось мест» должны быть свежими

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getLanding(slug: string, kind: 'main' | 'post_pay') {
  try {
    const res = await fetch(
      `${apiBase}/api/v1/public/event-landing/${encodeURIComponent(slug)}?kind=${kind}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function generateMetadata(
  { params }: { params: { slug: string } },
): Promise<Metadata> {
  const data = await getLanding(params.slug, 'main')
  if (!data) return { title: 'Событие' }
  const { event } = data
  return {
    title: event.title,
    description: event.description?.slice(0, 200) || undefined,
    openGraph: {
      title: event.title,
      description: event.description?.slice(0, 200) || undefined,
      images: event.poster_url ? [event.poster_url] : undefined,
    },
  }
}

export default async function EventLandingPage(
  { params }: { params: { slug: string } },
) {
  const data = await getLanding(params.slug, 'main')

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Страница не найдена</h1>
          <p className="mt-2 text-gray-600">
            Лендинг ещё не опубликован или ссылка неверна.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Шрифты лежат у нас (см. web/scripts/fetch_landing_fonts.sh) — не
          подтягиваются с Google, чтобы не мигали и не резались у части
          пользователей в РФ. */}
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      <LandingRenderer data={data} slug={params.slug} />
    </>
  )
}
