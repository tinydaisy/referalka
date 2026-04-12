// API Proxy: проксирует все запросы на бэкенд
// Браузер → Next.js (/api/*) → Backend (BACKEND_URL/api/*)
// BACKEND_URL переменная окружения, поэтому работает на любом хостинге

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000'

async function proxyRequest(
  request: Request,
  { params }: { params: { slug: string[] } },
  method: string
) {
  const path = params.slug.join('/')
  const url = new URL(request.url)
  const queryString = url.search

  let body: ArrayBuffer | undefined = undefined
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
    try {
      // Читаем тело как буфер чтобы сохранить оригинальный формат
      body = await request.arrayBuffer()
    } catch (e) {
      console.error(`[Proxy] Failed to read body:`, e)
    }
  }

  try {
    const fetchUrl = `${BACKEND_URL}/api/${path}${queryString}`

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    }

    // Копируем авторизацию если есть
    const authHeader = request.headers.get('authorization')
    if (authHeader) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        authorization: authHeader,
      }
    }

    // Добавляем тело как буфер для POST/PUT/PATCH
    if (body && body.byteLength > 0) {
      fetchOptions.body = body
    }

    const response = await fetch(fetchUrl, fetchOptions)

    let data: any
    const contentType = response.headers.get('content-type')

    if (contentType?.includes('application/json')) {
      try {
        data = await response.json()
      } catch {
        data = { detail: `HTTP ${response.status}` }
      }
    } else {
      data = await response.text()
    }

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)

    return new Response(
      JSON.stringify({
        detail: 'Backend unavailable',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}

export async function GET(request: Request, params: any) {
  return proxyRequest(request, params, 'GET')
}

export async function POST(request: Request, params: any) {
  return proxyRequest(request, params, 'POST')
}

export async function PUT(request: Request, params: any) {
  return proxyRequest(request, params, 'PUT')
}

export async function PATCH(request: Request, params: any) {
  return proxyRequest(request, params, 'PATCH')
}

export async function DELETE(request: Request, params: any) {
  return proxyRequest(request, params, 'DELETE')
}
