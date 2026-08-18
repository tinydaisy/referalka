/**
 * Публичная страница продукта (миграции 290, 293) — `/pr/{slug}`.
 *
 * Собирается ТЕМ ЖЕ конструктором блоков, что лендинг события: рендерер общий
 * (`/e/[slug]/LandingRenderer`), отличается только владелец и куда ведут кнопки.
 *
 * ⚠️ Клиента определяем по домену (заголовок Host): slug уникален в пределах
 * КАБИНЕТА, а не глобально — у разных клиентов может быть свой /pr/mentoring.
 * Поэтому Host пробрасываем в API явно, иначе серверный запрос его потеряет.
 *
 * Лендинг не опубликован → показываем простую витрину (описание, состав,
 * тарифы). Так продукт продаётся сразу после создания, не дожидаясь, пока
 * клиент соберёт страницу.
 */
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import LandingRenderer from '../../e/[slug]/LandingRenderer'
import ProductPage from './ProductPage'
import PreviewBar from '@/components/PreviewBar'

export const dynamic = 'force-dynamic'   // цены должны быть свежими

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function fetchJson(path: string) {
  try {
    const host = headers().get('host') || ''
    const res = await fetch(`${apiBase}${path}`, {
      cache: 'no-store',
      headers: host ? { host } : undefined,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/* ⚠️ `preview` — подписанный токен владельца, открывающий ЧЕРНОВИК. Идёт
   параметром адреса, потому что эта страница рендерится на сервере: заголовка
   `Authorization` из браузера у неё нет, и проверка по заголовку не работала
   вовсе. Пробрасываем в API как есть. */
const qs = (preview?: string) => (preview ? `?preview=${encodeURIComponent(preview)}` : '')

const getLanding = (slug: string, preview?: string) =>
  fetchJson(`/api/v1/public/product-landing/${encodeURIComponent(slug)}${qs(preview)}`)

const getProduct = (slug: string, preview?: string) =>
  fetchJson(`/api/v1/public/products/${encodeURIComponent(slug)}${qs(preview)}`)

export async function generateMetadata(
  { params }: { params: { slug: string } },
): Promise<Metadata> {
  const data = (await getLanding(params.slug)) || (await getProduct(params.slug))
  if (!data) return { title: 'Страница не найдена' }
  const p = data.product
  // ⚠️ Значок вкладки и картинка превью — ЛОГОТИП БРЕНДА клиента: страница
  // открыта на его площадке и под его брендом, узнаваться должен он. Без этого
  // Telegram подставлял первую попавшуюся картинку со страницы, и в переписке
  // у клиента показывался логотип ПЛЮСОНа (прод, 2026-08-18).
  const brandLogo = (data as any).data?.organizer?.brand_logo_url
  return {
    title: p.title,
    description: p.subtitle || p.description?.slice(0, 200) || undefined,
    icons: brandLogo ? { icon: brandLogo } : undefined,
    openGraph: {
      title: p.title,
      description: p.subtitle || p.description?.slice(0, 200) || undefined,
      images: brandLogo ? [brandLogo] : (p.cover_url ? [p.cover_url] : undefined),
    },
  }
}

export default async function Page({
  params, searchParams,
}: {
  params: { slug: string }
  searchParams: {
    pid?: string; c?: string; utm_source?: string; preview?: string
    /** `1` — страницу открыл наш рендерер PDF. */
    pdf?: string
  }
}) {
  const preview = searchParams?.preview
  // Абсолютный адрес страницы — для ссылок внутри PDF (домен может быть свой).
  const prHost = headers().get('host') || ''
  const prPageUrl = prHost ? `https://${prHost}/pr/${params.slug}` : ''
  // Собранный лендинг главнее: если клиент его опубликовал — показываем блоки.
  const landing = await getLanding(params.slug, preview)
  if (landing) {
    return (
      <>
        {preview && <PreviewBar />}
        <LandingRenderer
          data={landing}
          slug={params.slug}
          ownerType="product"
          pid={searchParams?.pid ?? null}
          contactId={searchParams?.c ?? null}
          utmSource={searchParams?.utm_source ?? null}
          forPdf={searchParams?.pdf === '1'}
          pageUrl={prPageUrl}
        />
      </>
    )
  }

  // Лендинг ещё не собран — простая витрина, чтобы продукт продавался сразу.
  const data = await getProduct(params.slug, preview)
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

  return (
    <>
      {preview && <PreviewBar />}
      <ProductPage data={data} slug={params.slug} />
    </>
  )
}
