/**
 * Страница заказа тарифа — pluson.ru/e/{slug}/order/{tariffId} (миграция 257).
 *
 * Заменяет схему со скрытыми полями GetCourse: раньше контакт передавался
 * GET-параметрами на чужой лендинг, теперь человека опознаёт сама форма —
 * по email или телефону находит контакт в базе клиента либо заводит новый.
 *
 * Оформление берём у лендинга события, чтобы страница не выпадала из стиля.
 */
import type { Metadata } from 'next'
import OrderForm from './OrderForm'

export const dynamic = 'force-dynamic'

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getLanding(slug: string) {
  try {
    const res = await fetch(
      `${apiBase}/api/v1/public/event-landing/${encodeURIComponent(slug)}?kind=main`,
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
  const d = await getLanding(params.slug)
  return { title: d?.event?.title ? `Заказ — ${d.event.title}` : 'Оформление заказа' }
}

export default async function OrderPage({
  params, searchParams,
}: {
  params: { slug: string; tariffId: string }
  searchParams: { c?: string }
}) {
  const data = await getLanding(params.slug)

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Страница не найдена</h1>
          <p className="mt-2 text-gray-600">Проверьте ссылку.</p>
        </div>
      </div>
    )
  }

  const tariff = (data.data?.tariffs?.items || [])
    .find((t: any) => String(t.id) === params.tariffId)

  if (!tariff) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Тариф не найден</h1>
          <p className="mt-2 text-gray-600">Возможно, он больше не продаётся.</p>
          <a href={`/e/${params.slug}`} className="mt-4 inline-block text-blue-600 hover:underline">
            Вернуться к тарифам
          </a>
        </div>
      </div>
    )
  }

  return (
    <>
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      <OrderForm
        page={data.page}
        event={data.event}
        tariff={tariff}
        offerUrl={data.data?.tariffs?.offer_url || null}
        slug={params.slug}
        contactId={searchParams.c || null}
      />
    </>
  )
}
