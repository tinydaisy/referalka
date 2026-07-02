import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const token = request.cookies.get('plusson_token')?.value
  const { pathname } = request.nextUrl

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
