/**
 * Динамический лендинг события
 * URL: /l/{event_slug}  — например /l/ivision-7
 *
 * Два режима:
 *   /l/ivision-7           → показывает веб-лендинг события
 *   /l/ivision-7?app=tg    → redirect_web_app.js редиректит в Telegram Mini App
 *
 * Куда именно редиректит (бот клиента vs общий @pluson_bot) — определяется
 * прямо на странице через `APP_CONFIG.tg`, который собирается из данных события:
 *   - есть подключённый главный TG-бот клиента (channels) → t.me/<bot_handle>
 *   - нет → t.me/pluson_bot/pluson (общий fallback)
 */

import Script from 'next/script'
import { redirect } from 'next/navigation'

type LandingEvent = {
  slug: string
  title: string
  description: string | null
  poster_url: string | null
  client_id: number | null
  client_bot_handle: string | null
  landing_url: string | null
  /** form | landing | external — на сторонний сайт уводим только при 'external'. */
  registration_mode: string | null
}

// У клиента без своего бота вход идёт на веб-страницу события ПЛЮСОНа
// (работает без бота). Системный @pluson_bot больше не используется (2026-07-08).

async function getEvent(slug: string): Promise<LandingEvent> {
  const apiBase =
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.API_URL ||
    'http://localhost:8000'
  try {
    const res = await fetch(`${apiBase}/api/v1/public/events/${slug}/landing`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      return { slug, title: slug, description: null, poster_url: null, client_id: null, client_bot_handle: null, landing_url: null, registration_mode: null }
    }
    const data = await res.json()
    return {
      slug: data.slug ?? slug,
      title: data.title ?? slug,
      description: data.description ?? null,
      poster_url: data.poster_url ?? null,
      client_id: data.client_id ?? null,
      client_bot_handle: data.client_bot_handle ?? null,
      landing_url: data.landing_url ?? null,
      registration_mode: data.registration_mode ?? null,
    }
  } catch {
    return { slug, title: slug, description: null, poster_url: null, client_id: null, client_bot_handle: null, landing_url: null, registration_mode: null }
  }
}

function buildTgRedirectUrl(botHandle: string | null, slug: string): string {
  // Бот клиента: Main Mini App открывается через t.me/<handle> + ?startapp=...
  // (скрипт redirect_web_app.js допишет ?startapp=ref_pgSLUG_pidX_srcY).
  if (botHandle) return `https://telegram.me/${botHandle}`
  // Нет своего бота → веб-страница события (без Telegram). Системный @pluson_bot
  // не используем (2026-07-08).
  return `https://pluson.ru/event/${slug}`
}

// Служебные query-ключи, которые мы НЕ передаём как «флаги тарифа» — они
// обрабатываются явно (app/pid/utm_source/event_slug/new_partner_id/live).
const RESERVED_QS_KEYS = new Set([
  'app', 'pid', 'new_partner_id', 'utm_source', 'event_slug', 'live',
])

// Из произвольного searchParams отбираем валидные «флаги» вида `?shpw` / `?shpw=1`:
// латиница+цифры+дефис, длина 1..16, не более 5 штук.
function extractFlags(sp: Record<string, string | string[] | undefined>): string[] {
  const out: string[] = []
  const re = /^[a-z0-9-]{1,16}$/
  for (const key of Object.keys(sp || {})) {
    if (RESERVED_QS_KEYS.has(key)) continue
    const k = key.toLowerCase()
    if (!re.test(k) || out.includes(k)) continue
    out.push(k)
    if (out.length >= 5) break
  }
  return out
}

export default async function EventLandingPage({
  params,
  searchParams,
}: {
  params: { slug: string }
  searchParams: Record<string, string | string[] | undefined>
}) {
  const event = await getEvent(params.slug)

  // sp.* для удобства: searchParams приходит как массив или строка — берём первое.
  const spStr = (k: string): string | undefined => {
    const v = searchParams?.[k]
    return Array.isArray(v) ? v[0] : v
  }
  const flags = extractFlags(searchParams)
  const appParam = spStr('app')

  // Веб-вход без ?app=tg: 301-редирект на сторонний лендинг клиента.
  // ⚠️ Только когда сторонний сайт ВЫБРАН способом регистрации
  // (registration_mode='external'). Раньше хватало заполненного поля
  // landing_url, но у многих там лежит ссылка на бота или на чужое событие —
  // и человека уводило не туда. С ?app=tg — обычный flow через Telegram.
  if (event.landing_url && event.registration_mode === 'external' && !appParam) {
    const url = new URL(event.landing_url)
    const pid = spStr('pid') || spStr('new_partner_id')
    const utmSource = spStr('utm_source')
    if (pid)        url.searchParams.set('pid', pid)
    if (utmSource)  url.searchParams.set('utm_source', utmSource)
    url.searchParams.set('event_slug', event.slug)
    for (const f of flags) url.searchParams.set(f, '1')
    // Партнёрский параметр внешней платформы клиента (например, gcpc=fdd97).
    // Берётся из карточки коллаборатора, привязанного к pid.
    const apiBase =
      process.env.NEXT_PUBLIC_API_URL ||
      process.env.API_URL ||
      'http://localhost:8000'
    let externalRef: string | null = null
    if (pid) {
      try {
        const res = await fetch(
          `${apiBase}/api/v1/public/events/${encodeURIComponent(event.slug)}/external-ref?pid=${encodeURIComponent(pid)}`,
          { cache: 'no-store' },
        )
        if (res.ok) {
          const data = await res.json()
          externalRef = (data?.external_ref_param as string) || null
        }
      } catch { /* тихо игнорим, основной редирект не ломаем */ }
    }
    let redirectUrl = url.toString()
    if (externalRef) {
      redirectUrl += '&' + externalRef.replace(/^[?&]+/, '')
    }
    redirect(redirectUrl)
  }

  const tgUrl = buildTgRedirectUrl(event.client_bot_handle, event.slug)

  return (
    <html lang="ru">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{event.title}</title>

        {/* PAGE_CODE / CLIENT_ID / APP_CONFIG задаются динамически — без app_config.js.
            CLIENT_ID попадает в startapp как `_cid{N}` — это страховка на случай, если
            у бота клиента в BotFather прописан общий URL Mini App вместо /c/{N}/tg/. */}
        <Script id="page-code" strategy="beforeInteractive">
          {`var PAGE_CODE = ${JSON.stringify(event.slug)};
            var CLIENT_ID = ${JSON.stringify(event.client_id)};
            var APP_CONFIG = { tg: ${JSON.stringify(tgUrl)} };`}
        </Script>
        <Script src="/redirect_web_app/redirect_web_app.js?v=8" strategy="beforeInteractive" />
      </head>
      <body
        style={{
          margin: 0,
          background: 'linear-gradient(45deg, #25455D, #0a1520)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Roboto, sans-serif',
          color: '#fff',
          padding: '24px',
          boxSizing: 'border-box',
        }}
      >
        {event.poster_url && (
          <img
            src={event.poster_url}
            alt={event.title}
            style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 12, marginBottom: 24 }}
          />
        )}

        <h1 style={{ fontSize: 24, fontWeight: 700, textAlign: 'center', marginBottom: 32 }}>
          {event.title}
        </h1>

        <a
          href={`?app=tg`}
          style={{
            display: 'inline-block',
            background: '#FFCFA4',
            color: '#0a1520',
            fontWeight: 700,
            fontSize: 16,
            padding: '14px 32px',
            borderRadius: 12,
            textDecoration: 'none',
          }}
        >
          Открыть в Telegram
        </a>
      </body>
    </html>
  )
}
