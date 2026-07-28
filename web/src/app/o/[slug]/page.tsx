/**
 * Публичная страница оферты — pluson.ru/o/{slug} (миграция 249).
 *
 * Текст лежит у нас, а не на стороннем сайте: ссылка не протухнет, если
 * клиент переедет с другой площадки. Если у оферты указан внешний адрес —
 * ведём туда редиректом.
 */
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getOffer(slug: string) {
  try {
    const res = await fetch(
      `${apiBase}/api/v1/public/offers/${encodeURIComponent(slug)}`,
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
  const o = await getOffer(params.slug)
  return { title: o?.title || 'Оферта', robots: { index: false } }
}

export default async function OfferPage({ params }: { params: { slug: string } }) {
  const offer = await getOffer(params.slug)

  if (!offer) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Документ не найден</h1>
          <p className="mt-2 text-gray-600">Проверьте ссылку.</p>
        </div>
      </div>
    )
  }

  if (offer.external_url) redirect(offer.external_url)

  return (
    <div className="min-h-screen bg-white py-10">
      <div className="mx-auto max-w-3xl px-5">
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{offer.title}</h1>
        <div
          className="prose prose-sm mt-6 max-w-none whitespace-pre-wrap text-[15px] leading-relaxed text-gray-800"
          // Текст оферты пишет сам клиент в своём кабинете — это его документ,
          // не пользовательский ввод с улицы.
          dangerouslySetInnerHTML={{ __html: offer.body || '' }}
        />
      </div>
    </div>
  )
}
