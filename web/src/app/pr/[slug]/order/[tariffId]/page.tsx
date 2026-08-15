/**
 * Страница заказа тарифа ПРОДУКТА — pluson.ru/pr/{slug}/order/{tariffId}.
 *
 * ⚠️ Форма ОДНА на событие и продукт — переиспользуется `OrderForm` из
 * `/e/[slug]/order/[tariffId]`. Второй копии быть не должно: у продукта была
 * своя модалка на витрине, и она уже разошлась с событийной — не спрашивала
 * Telegram-ник и согласие на рассылку, не брала оформление лендинга.
 * Различается только адрес приёмника заказа (проп `ownerType`).
 *
 * ⚠️ Клиента определяем по заголовку Host: slug продукта уникален в пределах
 * КАБИНЕТА, а не глобально. Host пробрасываем в API явно, иначе серверный
 * запрос его потеряет и у клиентов со своим доменом страница сломается.
 */
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import OrderForm from '../../../../e/[slug]/order/[tariffId]/OrderForm'

export const dynamic = 'force-dynamic'

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getLanding(slug: string) {
  try {
    const host = headers().get('host') || ''
    const res = await fetch(
      `${apiBase}/api/v1/public/product-landing/${encodeURIComponent(slug)}?kind=main`,
      { cache: 'no-store', headers: host ? { host } : undefined },
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
  return { title: d?.product?.title ? `Заказ — ${d.product.title}` : 'Оформление заказа' }
}

export default async function ProductOrderPage({
  params, searchParams,
}: {
  params: { slug: string; tariffId: string }
  searchParams: { c?: string; pid?: string; utm_source?: string }
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
          <a href={`/pr/${params.slug}`} className="mt-4 inline-block text-blue-600 hover:underline">
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
        // ⚠️ У продукта поля `event` нет — подставляем сам продукт под теми же
        // ключами, которых ждёт форма (title/description). Так же поступает
        // общий LandingRenderer.
        event={{ ...(data.product || {}), skip_contact_form: false }}
        tariff={tariff}
        offerUrl={data.data?.tariffs?.offer_url || null}
        privacyUrl={data.data?.tariffs?.privacy_url || null}
        brandName={data.data?.tariffs?.brand_name || null}
        ownerName={data.data?.tariffs?.owner_name || null}
        slug={params.slug}
        contactId={searchParams.c || null}
        pid={searchParams.pid || null}
        utmSource={searchParams.utm_source || null}
        ownerType="product"
      />
    </>
  )
}
