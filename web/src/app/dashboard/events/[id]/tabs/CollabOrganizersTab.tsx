'use client'
import { useEffect, useState } from 'react'
import { Users, ExternalLink, Star } from 'lucide-react'
import { api } from '@/lib/api'
import RefLinkInline from '@/components/RefLinkInline'

const PEACH = '#FFCFA4'
const DARK = '#25455D'

/**
 * Организаторы КОЛЛАБ-события (совладельцы из event_owners) — раздел «Люди».
 *
 * ⚠️ Главное отличие от обычного события: в коллабе у КАЖДОГО организатора СВОЙ
 * VIP-бот и СВОЯ база. Поэтому реф-ссылка каждого строится через ЕГО бота и несёт
 * ЕГО реф-код — приведённые им люди засчитываются именно ему (вклад в рейтинг).
 * Ссылки считает бэк (/collab/events/{id}/organizers), фронт их только показывает.
 */
export default function CollabOrganizersTab({ eventId, eventStatus }: {
  eventId: number
  eventStatus?: 'draft' | 'published' | 'ended' | null
}) {
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
          Это совместное событие. У каждого организатора <b>своя ссылка через своего бота</b> —
          кого он приведёт, тот попадёт в его базу и засчитается ему во вклад.
          Отдавайте партнёрам и аудитории только свою ссылку.
        </p>
      </div>

      {rows.map(o => (
        <div key={o.client_id} className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-start gap-4">
            {o.photo_url
              ? <img src={o.photo_url} alt="" className="w-14 h-14 rounded-xl object-cover shrink-0" />
              : <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"><Users className="w-6 h-6" /></div>}
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
                <div className="text-xs text-gray-600 mt-0.5">Проект: <span className="font-medium">{o.brand_name}</span></div>
              )}
              <div className="mt-1 flex items-center gap-3 flex-wrap">
                <a href={`/dashboard/collab-hub/org/${o.client_id}`} target="_blank" rel="noreferrer"
                   className="text-xs inline-flex items-center gap-1 text-gray-500 hover:text-gray-700">
                  <ExternalLink className="w-3 h-3" />Профиль в Хабе
                </a>
                {o.ref_code && <span className="text-xs text-gray-400">Реф-код: <code className="font-mono">{o.ref_code}</code></span>}
              </div>
            </div>
          </div>

          <div className="mt-4">
            {Object.keys(o.links || {}).length > 0 ? (
              <RefLinkInline
                slug={null}
                refCode={o.ref_code}
                links={o.links}
                eventStatus={eventStatus}
                title={o.is_me ? 'Ваши ссылки (через вашего бота)' : `Ссылки ${o.name} (через его бота)`}
              />
            ) : (
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
                У этого организатора не подключён свой бот — ссылка не строится.
                Подключите бота в разделе «Каналы».
              </div>
            )}
          </div>
        </div>
      ))}

      {rows.length === 0 && (
        <div className="text-gray-400 py-10 text-center">Организаторы не найдены.</div>
      )}
    </div>
  )
}
