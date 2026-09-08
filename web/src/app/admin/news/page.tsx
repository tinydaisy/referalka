'use client'

/**
 * Новости платформы в админке.
 *
 * ⚠️ Страница только оборачивает общий <NewsManager /> — он же стоит в кабинете
 * сервисного клиента (`/dashboard/platform-news`). Своей копии тут быть не
 * должно: две реализации одного экрана неминуемо разъедутся.
 */
import NewsManager from '@/components/news/NewsManager'

export default function AdminNewsPage() {
  return <NewsManager />
}
