/**
 * Динамический лендинг события
 * URL: /l/{event_slug}  — например /l/ivision-7
 *
 * Два режима:
 *   /l/ivision-7           → показывает веб-лендинг события
 *   /l/ivision-7?app=tg    → redirect_web_app.js редиректит в Telegram Mini App
 *
 * Данные события берутся из API (из БД). Пока API не подключен — заглушка.
 */

import Script from 'next/script'

// TODO: заменить заглушку на реальный запрос к API
async function getEvent(slug: string) {
  // В будущем: fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/events/by_slug/${slug}`)
  return {
    slug,
    title: slug,           // пока slug как название
    description: '',
    poster_url: null as string | null,
    landing_url: null as string | null,
  }
}

export default async function EventLandingPage({ params }: { params: { slug: string } }) {
  const event = await getEvent(params.slug)

  return (
    <html lang="ru">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{event.title}</title>

        {/* PAGE_CODE = event slug — передаётся в redirect_web_app.js */}
        <Script id="page-code" strategy="beforeInteractive">
          {`var PAGE_CODE = '${event.slug}';`}
        </Script>
        <Script src="/redirect_web_app/app_config.js" strategy="beforeInteractive" />
        <Script src="/redirect_web_app/redirect_web_app.js" strategy="beforeInteractive" />
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
        {/* Афиша события */}
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

        {/* Кнопка открытия в Telegram — скрипт обработает редирект через ?app=tg */}
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
