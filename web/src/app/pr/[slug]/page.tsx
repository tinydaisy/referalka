/**
 * Публичная страница продукта (миграция 290) — `/pr/{slug}`.
 *
 * Пока это простая продающая страница: описание, состав и тарифы с оплатой.
 * Когда конструктор блоков будет развязан с события, сюда встанет он — и
 * страница станет собираться из блоков, как лендинг события.
 *
 * ⚠️ Клиента определяем по домену (заголовок Host): slug уникален в пределах
 * КАБИНЕТА, а не глобально — у разных клиентов может быть свой /pr/mentoring.
 * Поэтому Host пробрасываем в API явно, иначе запрос с сервера потеряет его.
 *
 * ⚠️ Ссылок на материалы здесь нет ни в каком виде — только названия и
 * описания. Ссылка появляется в кабинете, у того, кто купил.
 */
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import ProductPage from './ProductPage'

export const dynamic = 'force-dynamic'   // цены должны быть свежими

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getProduct(slug: string) {
  try {
    const host = headers().get('host') || ''
    const res = await fetch(
      `${apiBase}/api/v1/public/products/${encodeURIComponent(slug)}`,
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
  const data = await getProduct(params.slug)
  if (!data) return { title: 'Страница не найдена' }
  const p = data.product
  return {
    title: p.title,
    description: p.subtitle || p.description?.slice(0, 200) || undefined,
    openGraph: {
      title: p.title,
      description: p.subtitle || p.description?.slice(0, 200) || undefined,
      images: p.cover_url ? [p.cover_url] : undefined,
    },
  }
}

export default async function Page({ params }: { params: { slug: string } }) {
  const data = await getProduct(params.slug)

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white px-4">
        <div className="text-center">
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Страница не найдена</h1>
          <p className="text-gray-500">
            Возможно, ссылка устарела или страница ещё не опубликована.
          </p>
        </div>
      </div>
    )
  }

  return <ProductPage data={data} slug={params.slug} />
}
