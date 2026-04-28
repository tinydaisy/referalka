'use client'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'
import FileUploader from '@/components/FileUploader'

type Orientation = 'horizontal' | 'vertical' | 'square'

interface Poster {
  id: number
  url: string
  orientation: Orientation
  sort: number
}

const POSTER_TYPES: { key: Orientation; labelRu: string; labelEn: string; ratio: string; aspect: string }[] = [
  { key: 'horizontal', labelRu: 'Горизонтальные', labelEn: 'Horizontal', ratio: '16:9', aspect: 'aspect-video' },
  { key: 'vertical',   labelRu: 'Вертикальные',   labelEn: 'Vertical',   ratio: '9:16', aspect: 'aspect-[9/16]' },
  { key: 'square',     labelRu: 'Квадратные',      labelEn: 'Square',     ratio: '1:1',  aspect: 'aspect-square' },
]

// Афиши конференции лежат в `event_posters` — единый источник истины,
// общий с обычными мероприятиями. API: /events/{id}/referral/posters.
// Старые поля conf_conferences.poster_* больше не используются для записи —
// существующие данные мигрированы в event_posters миграцией 046.
export default function PostersTab({ eventId }: { eventId: number }) {
  const { lang } = useLang()
  const [items, setItems] = useState<Poster[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await api.referralProgram.posters.list(eventId)
      setItems(r.items || [])
      setErr(null)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [eventId])

  async function handleChange(orientation: Orientation, newUrls: string[]) {
    const oldItems = items.filter(p => p.orientation === orientation)
    const oldUrls = oldItems.map(p => p.url)

    const added = newUrls.filter(u => !oldUrls.includes(u))
    for (const url of added) {
      try {
        await api.referralProgram.posters.create(eventId, { url, orientation, sort: 0 })
      } catch (e: any) { setErr(e.message) }
    }

    const removed = oldUrls.filter(u => !newUrls.includes(u))
    for (const url of removed) {
      const item = oldItems.find(p => p.url === url)
      if (item) {
        try {
          await api.referralProgram.posters.delete(eventId, item.id)
        } catch (e: any) { setErr(e.message) }
      }
    }

    await load()
  }

  if (loading) return <div className="text-gray-400 text-sm">{lang === 'ru' ? 'Загрузка…' : 'Loading…'}</div>

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-gray-500">
        {lang === 'ru'
          ? 'Афиши используются на лендинге, в Mini App и в материалах для шеринга.'
          : 'Posters are used on the landing page, in Mini App and in sharing materials.'}
      </p>

      {err && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{err}</div>}

      {POSTER_TYPES.map(o => {
        const urls = items.filter(p => p.orientation === o.key).map(p => p.url)
        return (
          <div key={o.key} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <div className="mb-4">
              <h3 className="font-semibold text-gray-900">{lang === 'ru' ? o.labelRu : o.labelEn}</h3>
              <p className="text-xs text-gray-400 mt-0.5">
                {lang === 'ru' ? `Соотношение сторон ${o.ratio}` : `Aspect ratio ${o.ratio}`}
              </p>
            </div>
            <FileUploader
              mode="multiple"
              kind="event_poster"
              eventId={eventId}
              posterType={o.key}
              value={urls}
              onChange={u => handleChange(o.key, u)}
              aspectClass={o.aspect}
              emptyText={lang === 'ru' ? 'Афиш пока нет' : 'No posters yet'}
              buttonLabel={lang === 'ru' ? 'Загрузить' : 'Upload'}
            />
          </div>
        )
      })}
    </div>
  )
}
