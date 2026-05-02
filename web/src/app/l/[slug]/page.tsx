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

type LandingEvent = {
  slug: string
  title: string
  description: string | null
  poster_url: string | null
  client_id: number | null
  client_bot_handle: string | null
}

const FALLBACK_TG_URL = 'https://t.me/pluson_bot/pluson'

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
      return { slug, title: slug, description: null, poster_url: null, client_id: null, client_bot_handle: null }
    }
    const data = await res.json()
    return {
      slug: data.slug ?? slug,
      title: data.title ?? slug,
      description: data.description ?? null,
      poster_url: data.poster_url ?? null,
      client_id: data.client_id ?? null,
      client_bot_handle: data.client_bot_handle ?? null,
    }
  } catch {
    return { slug, title: slug, description: null, poster_url: null, client_id: null, client_bot_handle: null }
  }
}

function buildTgRedirectUrl(botHandle: string | null): string {
  if (!botHandle) return FALLBACK_TG_URL
  // Бот клиента: Main Mini App открывается через t.me/<handle> + ?startapp=...
  // (скрипт redirect_web_app.js допишет ?startapp=ref_pgSLUG_pidX_srcY)
  return `https://t.me/${botHandle}`
}

export default async function EventLandingPage({ params }: { params: { slug: string } }) {
  const event = await getEvent(params.slug)
  const tgUrl = buildTgRedirectUrl(event.client_bot_handle)

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
        <Script src="/redirect_web_app/redirect_web_app.js?v=7" strategy="beforeInteractive" />
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

        <h1 style={{ fontSize: 24, fontWeight: 700, textAlign: 'center', marginBottom: 8 }}>
          {event.title}
        </h1>

        {event.description && (
          <p style={{ fontSize: 16, textAlign: 'center', color: '#FFCFA4', marginBottom: 32 }}>
            {event.description}
          </p>
        )}

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
