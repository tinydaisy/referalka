'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Users, Star, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'

const PEACH = '#FFCFA4'
const DARK = '#25455D'

/**
 * Организаторы КОЛЛАБ-события — просто СПИСОК людей (клиенты-совладельцы из event_owners).
 * Клик по строке → карточка организатора (тема / подарки из ПЛЮСОНа / афиша / ссылки),
 * как карточка спикера в конференции.
 *
 * ⚠️ Ссылки здесь НЕ показываем — они внутри карточки, во вкладке «Ссылки».
 * В коллабе у каждого организатора СВОЙ бот → у каждого своя ссылка.
 */
export default function CollabOrganizersTab({ eventId }: { eventId: number }) {
  const router = useRouter()
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.collabHub.eventOrganizers(eventId)
      .then((r: any) => setRows(r.organizers || []))
      .catch((e: any) => setErr(e?.message || 'Не удалось загрузить'))
      .finally(() => setLoading(false))
  }, [eventId])

  if (loading) return <div className="text-gray-400 py-10 text-center">Загрузка…</div>
  if (err) return <div className="text-gray-400 py-10 text-center">{err}</div>

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border p-4" style={{ borderColor: PEACH, background: '#FFF8F1' }}>
        <p className="text-sm" style={{ color: '#C77B3B' }}>
          Это совместное событие. Откройте свою карточку — там тема, подарки и ваша ссылка
          <b> через вашего бота</b>: кого приведёте по ней, тот попадёт в вашу базу и засчитается вам во вклад.
        </p>
      </div>

      <div className="bg-white rounded-2xl border card-border divide-y divide-gray-100">
        {rows.map(o => (
          <button
            key={o.client_id}
            onClick={() => router.push(`/dashboard/events/${eventId}/collab-organizers/${o.client_id}`)}
            className="w-full flex items-center gap-4 p-4 text-left hover:bg-gray-50 transition"
          >
            {o.photo_url
              ? <img src={o.photo_url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0" />
              : <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"><Users className="w-5 h-5" /></div>}

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold" style={{ color: DARK }}>{o.name}</span>
                {o.is_me && (
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                        style={{ background: PEACH, color: DARK }}>
                    <Star className="w-3 h-3" />Это вы
                  </span>
                )}
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                  {o.role === 'owner' ? 'Организатор' : 'Соорганизатор'}
                </span>
              </div>
              {o.brand_name && o.brand_name !== o.name && (
                <div className="text-xs text-gray-500 mt-0.5 truncate">Проект: {o.brand_name}</div>
              )}
            </div>

            <ChevronRight className="w-5 h-5 text-gray-300 shrink-0" />
          </button>
        ))}

        {rows.length === 0 && (
          <div className="text-gray-400 py-10 text-center">Организаторы не найдены.</div>
        )}
      </div>
    </div>
  )
}
