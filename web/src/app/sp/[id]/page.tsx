/**
 * Публичная страница спикера — /sp/{client_id}
 *
 * Зачем. У спикера постоянно просят фото, логотипы, регалии и темы выступлений.
 * Каждый раз искать по папкам и пересылать файлами — работа, которая повторяется
 * с каждым новым организатором. Здесь он даёт одну ссылку, а организатор берёт
 * нужное сам: скачивает картинки, копирует тексты, забирает ссылки на каналы.
 *
 * ⚠️ Страницу видит любой, у кого есть адрес. Почта, телефон и служебные поля
 * сюда не попадают — только то, что человек и так показывает публично.
 */
import { notFound } from 'next/navigation'
import SpeakerPageClient from './SpeakerPageClient'

export const dynamic = 'force-dynamic'

// Запрос идёт с сервера, поэтому во внутренний адрес, а не через внешний домен:
// иначе получился бы лишний круг через nginx обратно в этот же Next.js.
const API = process.env.INTERNAL_API_URL || 'http://127.0.0.1:8000'

export default async function SpeakerPage({ params }: { params: { id: string } }) {
  const res = await fetch(`${API}/api/v1/public/clients/${params.id}/speaker-page`, {
    cache: 'no-store',
  }).catch(() => null)

  if (!res || !res.ok) notFound()
  const data = await res.json()

  return <SpeakerPageClient data={data} />
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const res = await fetch(`${API}/api/v1/public/clients/${params.id}/speaker-page`, {
    cache: 'no-store',
  }).catch(() => null)
  if (!res || !res.ok) return { title: 'Страница не найдена' }
  const d = await res.json()
  const name = d.name || d.brand_name || 'Спикер'
  return {
    title: `${name} — материалы для организаторов`,
    description: d.owner_positioning || undefined,
  }
}
