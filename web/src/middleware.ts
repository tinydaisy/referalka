import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Основной адрес платформы. Кабинет живёт только здесь.
const PLATFORM_HOST = (process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru')
  .replace(/^https?:\/\//, '')
  .replace(/\/.*$/, '')
  .toLowerCase()

export function middleware(request: NextRequest) {
  const token = request.cookies.get('plusson_token')?.value
  const { pathname } = request.nextUrl

  // ⚠️ Кабинет и админка — только на основном домене (миграция 270).
  // На своём домене клиента у них ломается вход: JWT и cookies выданы для
  // pluson.ru и на другой origin не приезжают, а вебхуки платёжек и
  // интеграций настроены на pluson.ru. Поэтому вместо «пустого кабинета,
  // который не логинится» уводим на основной адрес.
  const host = (request.headers.get('host') || '').split(':')[0].toLowerCase()
  const isForeignHost =
    !!host &&
    !!PLATFORM_HOST &&
    host !== PLATFORM_HOST &&
    host !== `www.${PLATFORM_HOST}` &&
    !host.endsWith('.localhost') &&
    host !== 'localhost'

  if (isForeignHost && (pathname.startsWith('/dashboard') || pathname.startsWith('/admin'))) {
    const url = new URL(request.nextUrl.pathname + request.nextUrl.search,
                        `https://${PLATFORM_HOST}`)
    return NextResponse.redirect(url)
  }

  // Страница входа админа не требует токена — иначе неавторизованного
  // перебрасывало бы на /login (клиентский вход).
  const isAdminLogin = pathname === '/admin/login' || pathname.startsWith('/admin/login/')

  if ((pathname.startsWith('/dashboard') || pathname.startsWith('/admin')) && !isAdminLogin) {
    if (!token) {
      const target = pathname.startsWith('/admin') ? '/admin/login' : '/login'
      return NextResponse.redirect(new URL(target, request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*'],
}
