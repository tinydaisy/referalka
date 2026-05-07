'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import RefLinkInline from '@/components/RefLinkInline'

/**
 * Страница организатора в контексте конкретного мероприятия.
 *
 * Аналогично странице спикера в конференции (/dashboard/conferences/{id}/speakers/{ec_id}):
 * показывает данные коллаборатора + per-event поля (партнёрская ссылка с pid).
 * Сама карточка коллаборатора (глобальная) — отдельная страница в /dashboard/collaborations.
 */
export default function EventOrganizerPage() {
  const router = useRouter()
  const { id, ecId } = useParams()
  const eventId = Number(id)
  const ecIdNum = Number(ecId)

  const [event, setEvent] = useState<any>(null)
  const [item, setItem] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.events.get(eventId),
      api.events.listCollaborators(eventId, 'organizer'),
    ])
      .then(([evRes, colRes]: any) => {
        setEvent(evRes?.event || null)
        const arr = Array.isArray(colRes) ? colRes : (colRes?.items ?? colRes?.collaborators ?? [])
        const found = arr.find((c: any) => c.id === ecIdNum)
        if (!found) { router.push(`/dashboard/events/${eventId}?tab=co_organizers`); return }
        setItem(found)
      })
      .catch(() => router.push(`/dashboard/events/${eventId}?tab=co_organizers`))
      .finally(() => setLoading(false))
  }, [eventId, ecIdNum])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }
  if (!item || !event) return null

  return (
    <div className="max-w-2xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link href="/dashboard/events" className="hover:text-gray-700">Мероприятия</Link>
        <span>/</span>
        <Link href={`/dashboard/events/${eventId}?tab=co_organizers`} className="hover:text-gray-700">{event.title}</Link>
        <span>/</span>
        <span className="text-gray-700">{item.name}</span>
      </div>

      {/* Шапка */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/dashboard/events/${eventId}?tab=co_organizers`}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex items-center gap-3 flex-1">
          {item.photo_url ? (
            <img src={item.photo_url} alt={item.name} className="w-14 h-14 rounded-full object-cover" />
          ) : (
            <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
              {item.name.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 truncate">{item.name}</h1>
            {item.title && <p className="text-gray-500 text-sm truncate">{item.title}</p>}
            {item.personal_tg_username && (
              <p className="text-xs text-gray-400 truncate">@{String(item.personal_tg_username).replace(/^@/, '')}</p>
            )}
          </div>
        </div>
        <Link href={`/dashboard/collaborations/${item.collaborator_id}`}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-[#25455D] px-2.5 py-1.5 rounded-lg border border-gray-200 hover:border-gray-300">
          <ExternalLink size={13} /> Профиль
        </Link>
      </div>

      {/* Партнёрская ссылка для ЭТОГО мероприятия */}
      <div className="mb-6">
        <RefLinkInline slug={event.slug} refCode={item.ref_code} />
      </div>

      {/* Регалии (read-only превью; правится в карточке коллаборатора) */}
      {Array.isArray(item.achievements) && item.achievements.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">Регалии</h2>
          <ul className="space-y-1.5">
            {item.achievements.map((a: string, i: number) => (
              <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#25455D] shrink-0 mt-2" />
                {a}
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400 mt-3">
            Чтобы изменить — откройте <Link href={`/dashboard/collaborations/${item.collaborator_id}`} className="underline">профиль коллаборатора</Link>.
          </p>
        </div>
      )}
    </div>
  )
}
