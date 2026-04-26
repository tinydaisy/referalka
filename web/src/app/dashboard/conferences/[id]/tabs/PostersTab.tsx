'use client'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'
import FileUploader from '@/components/FileUploader'

type PosterType = 'horizontal' | 'vertical' | 'square'

const POSTER_TYPES: { key: PosterType; labelRu: string; labelEn: string; ratio: string; aspect: string }[] = [
  { key: 'horizontal', labelRu: 'Горизонтальные', labelEn: 'Horizontal', ratio: '16:9', aspect: 'aspect-video' },
  { key: 'vertical',   labelRu: 'Вертикальные',   labelEn: 'Vertical',   ratio: '9:16', aspect: 'aspect-[9/16]' },
  { key: 'square',     labelRu: 'Квадратные',      labelEn: 'Square',     ratio: '1:1',  aspect: 'aspect-square' },
]

export default function PostersTab({ eventId }: { eventId: number }) {
  const { lang } = useLang()
  const [posters, setPosters] = useState<Record<PosterType, string[]>>({
    horizontal: [], vertical: [], square: []
  })

  useEffect(() => {
    api.conference.get(eventId).then(r => {
      const c = r.conference
      if (c) {
        setPosters({
          horizontal: c.poster_horizontal || [],
          vertical:   c.poster_vertical   || [],
          square:     c.poster_square     || [],
        })
      }
    }).catch(() => {})
  }, [eventId])

  async function updatePosters(type: PosterType, urls: string[]) {
    setPosters(p => ({ ...p, [type]: urls }))
    await api.conference.update(eventId, { [`poster_${type}`]: urls })
  }

  return (
    <div className="max-w-2xl space-y-6">
      {POSTER_TYPES.map(pt => (
        <div key={pt.key} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="mb-4">
            <h3 className="font-semibold text-gray-900">{lang === 'ru' ? pt.labelRu : pt.labelEn}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{lang === 'ru' ? `Соотношение сторон ${pt.ratio}` : `Aspect ratio ${pt.ratio}`}</p>
          </div>
          <FileUploader
            mode="multiple"
            kind="event_poster"
            eventId={eventId}
            posterType={pt.key}
            value={posters[pt.key]}
            onChange={urls => updatePosters(pt.key, urls)}
            aspectClass={pt.aspect}
            emptyText={lang === 'ru' ? 'Афиши не загружены' : 'No posters uploaded'}
            buttonLabel={lang === 'ru' ? 'Загрузить' : 'Upload'}
          />
        </div>
      ))}
    </div>
  )
}
