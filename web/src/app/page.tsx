import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import LandingClient from './LandingClient'

export const dynamic = 'force-dynamic'

/**
 * Корень сайта.
 *
 * На pluson.ru — наш продающий лендинг. На домене КЛИЕНТА — его главная
 * страница (миграция 278): витрина событий, витрина на вкладке «О проекте»
 * или лендинг выбранного события.
 *
 * ⚠️ Раньше этой ветки не было, и на клиентском домене открывался лендинг
 * ПЛЮСОНа: клиент платил за свой домен и показывал на нём нашу рекламу.
 * nginx отдаёт всё неизвестное в Next.js, а `/` здесь занят платформой —
 * поэтому развилка нужна именно тут.
 */
export default async function Home() {
  const host = (headers().get('host') || '').split(':')[0].toLowerCase()
  // ⚠️ Ходим в API по локальному адресу, а не через NEXT_PUBLIC_API_URL:
  // запрос идёт с сервера, и внешний https-адрес клиентского домена вёл бы
  // обратно в этот же Next.js через nginx — лишний круг и таймаут при сбое.
  const api = process.env.INTERNAL_API_URL || 'http://127.0.0.1:8000'

  let target: string | null = null
  try {
    // no-store: настройку меняют в кабинете и сразу идут проверять на домене.
    const r = await fetch(`${api}/api/v1/public/domain/home?host=${encodeURIComponent(host)}`,
                          { cache: 'no-store' })
    if (r.ok) target = (await r.json())?.path || null
  } catch {
    // Бэкенд недоступен — показываем лендинг, а не пустую страницу.
  }

  if (target) redirect(target)
  return <LandingClient />
}
