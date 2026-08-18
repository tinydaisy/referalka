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
 * Исключение — `?preview=<токен>`: подписанная ссылка владельца из кабинета.
 * ⚠️ Токен идёт ПАРАМЕТРОМ АДРЕСА: страница рендерится на сервере, заголовка
 * `Authorization` из браузера у неё нет.
 */
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import LandingRenderer from './LandingRenderer'
import PreviewBar from '@/components/PreviewBar'

export const dynamic = 'force-dynamic'   // цены и «осталось мест» должны быть свежими

const apiBase =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || 'http://localhost:8000'

async function getLanding(slug: string, kind: 'main' | 'post_pay', preview?: string) {
  try {
    const qs = preview ? `&preview=${encodeURIComponent(preview)}` : ''
    const res = await fetch(
      `${apiBase}/api/v1/public/event-landing/${encodeURIComponent(slug)}?kind=${kind}${qs}`,
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
  // ⚠️ Картинка превью и значок вкладки — ВСЕГДА логотип бренда клиента
  // (clients.brand_logo_url). Не афиша: страница открыта под его брендом, и в
  // переписке должен узнаваться он. Без этого Telegram брал первую попавшуюся
  // картинку со страницы — и у клиента показывался логотип ПЛЮСОНа
  // (прод, 2026-08-18).
  const brandLogo = data.data?.brand?.logo_url || data.data?.organizer?.brand_logo_url
  const ogImage = brandLogo || event.poster_url
  return {
    title: event.title,
    description: event.description?.slice(0, 200) || undefined,
    // Фавикон вкладки — тоже логотип клиента: страница открыта на ЕГО домене
    // и под его брендом, наш значок там выглядит чужим.
    icons: brandLogo ? { icon: brandLogo } : undefined,
    openGraph: {
      title: event.title,
      description: event.description?.slice(0, 200) || undefined,
      images: ogImage ? [ogImage] : undefined,
    },
  }
}

export default async function EventLandingPage(
  { params, searchParams }: {
    params: { slug: string }
    searchParams: {
      pid?: string; c?: string; utm_source?: string; preview?: string
      /** `1` — страницу открыл наш рендерер PDF (см. backend/app/services/landing_pdf.py). */
      pdf?: string
    }
  },
) {
  const preview = searchParams?.preview
  // ⚠️ Режим печати. Нужен там, где на бумаге интерактив не работает: у
  // галереи-карусели прокрутки в PDF нет, и человек видел только первую
  // карточку без всякого намёка, что рядом есть ещё.
  const forPdf = searchParams?.pdf === '1'
  // Абсолютный адрес страницы — для ссылок внутри PDF (относительные там мертвы).
  // Домен берём из заголовка запроса: у клиента он может быть свой.
  const host = headers().get('host') || ''
  const pageUrl = host ? `https://${host}/e/${params.slug}` : ''
  const data = await getLanding(params.slug, 'main', preview)

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
      {preview && <PreviewBar />}
      <LandingRenderer data={data} slug={params.slug}
                       pid={searchParams.pid || null}
                       contactId={searchParams.c || null}
                       utmSource={searchParams.utm_source || null}
                       forPdf={forPdf}
                       pageUrl={pageUrl} />
    </>
  )
}
