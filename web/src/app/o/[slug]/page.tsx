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

  // Оформление — как у лендингов клиента (те же настройки, что у анкеты):
  // человек пришёл из его воронки и не должен упереться в чужую страницу.
  const t = offer.theme || {}
  const bg = t.lp_bg_color
    ? `linear-gradient(${t.lp_bg_angle ?? 45}deg, ${t.lp_bg_color}, ${t.lp_bg_color_2 || t.lp_bg_color})`
    : 'linear-gradient(45deg, #25455D, #0a1520)'
  const brand = offer.brand || {}
  const hasBrand = brand.logo_url || brand.brand_name || brand.owner_name

  return (
    <div className="min-h-screen px-4 py-8" style={{ background: bg }}>
      {/* Шрифты лежат у нас, не на Google CDN (в РФ он у части людей режется). */}
      <link rel="stylesheet" href="/fonts/landing-fonts.css" />
      <div
        className="mx-auto w-full max-w-3xl rounded-2xl p-6 shadow-sm sm:p-8"
        style={{
          background: t.lp_card_bg || '#fff',
          color: t.lp_card_text_color || t.lp_color_body || undefined,
          fontFamily: t.lp_font_body || undefined,
        }}
      >
        {/* ⚠️ Та же шапка, что на анкете: человек читает условия сделки и
            должен видеть, с кем её заключает, ещё до текста. */}
        {hasBrand && (
          <div className="mb-5 flex items-center gap-3 border-b border-black/10 pb-4">
            {brand.logo_url && (
              <img src={brand.logo_url} alt=""
                   className="h-12 w-12 shrink-0 rounded-xl object-cover" />
            )}
            <div className="min-w-0">
              {brand.brand_name && (
                <div className="truncate font-semibold">{brand.brand_name}</div>
              )}
              {brand.owner_name && (
                <div className="truncate text-sm opacity-70">{brand.owner_name}</div>
              )}
            </div>
          </div>
        )}

        <h1 className="text-2xl font-bold sm:text-3xl"
            style={{
              color: t.lp_color_heading || undefined,
              fontFamily: t.lp_font_heading || undefined,
            }}>
          {offer.title}
        </h1>
        <div
          className="mt-6 whitespace-pre-wrap text-[15px] leading-relaxed"
          // Текст оферты пишет сам клиент в своём кабинете — это его документ,
          // не пользовательский ввод с улицы.
          dangerouslySetInnerHTML={{ __html: offer.body || '' }}
        />
      </div>
    </div>
  )
}
