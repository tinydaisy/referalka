'use client'
import { useState, useEffect, useRef } from 'react'
import { Upload, Trash2, ImageIcon, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'

type PosterType = 'horizontal' | 'vertical' | 'square'

const POSTER_TYPES: { key: PosterType; labelRu: string; labelEn: string; ratio: string }[] = [
  { key: 'horizontal', labelRu: 'Горизонтальные', labelEn: 'Horizontal', ratio: '16:9' },
  { key: 'vertical',   labelRu: 'Вертикальные',   labelEn: 'Vertical',   ratio: '9:16' },
  { key: 'square',     labelRu: 'Квадратные',      labelEn: 'Square',     ratio: '1:1' },
]

export default function PostersTab({ eventId }: { eventId: number }) {
  const { lang } = useLang()
  const [posters, setPosters] = useState<Record<PosterType, string[]>>({
    horizontal: [], vertical: [], square: []
  })
  const [uploading, setUploading] = useState<PosterType | null>(null)
  const fileRefs = {
    horizontal: useRef<HTMLInputElement>(null),
    vertical:   useRef<HTMLInputElement>(null),
    square:     useRef<HTMLInputElement>(null),
  }

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

  async function handleUpload(type: PosterType, files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(type)
    try {
      const newUrls: string[] = []
      for (const file of Array.from(files)) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('type', type)
        const r = await fetch(`/api/upload-poster?event_id=${eventId}`, {
          method: 'POST',
          body: formData,
          headers: {
            Authorization: `Bearer ${localStorage.getItem('plusson_token') || ''}`,
          },
        })
        if (!r.ok) throw new Error(lang === 'ru' ? 'Ошибка загрузки' : 'Upload error')
        const data = await r.json()
        newUrls.push(data.url)
      }
      const updated = { ...posters, [type]: [...posters[type], ...newUrls] }
      setPosters(updated)
      await api.conference.update(eventId, {
        [`poster_${type}`]: updated[type],
      })
    } catch (err: any) {
      alert(err.message)
    } finally {
      setUploading(null)
      if (fileRefs[type].current) fileRefs[type].current.value = ''
    }
  }

  async function removeposter(type: PosterType, url: string) {
    const updated = { ...posters, [type]: posters[type].filter(u => u !== url) }
    setPosters(updated)
    await api.conference.update(eventId, {
      [`poster_${type}`]: updated[type],
    })
  }

  return (
    <div className="max-w-2xl space-y-6">
      {POSTER_TYPES.map(pt => (
        <div key={pt.key} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-gray-900">{lang === 'ru' ? pt.labelRu : pt.labelEn}</h3>
              <p className="text-xs text-gray-400 mt-0.5">{lang === 'ru' ? `Соотношение сторон ${pt.ratio}` : `Aspect ratio ${pt.ratio}`}</p>
            </div>
            <button
              onClick={() => fileRefs[pt.key].current?.click()}
              disabled={uploading === pt.key}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {uploading === pt.key
                ? <Loader2 size={15} className="animate-spin" />
                : <Upload size={15} />}
              {lang === 'ru' ? 'Загрузить' : 'Upload'}
            </button>
            <input
              ref={fileRefs[pt.key]}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={e => handleUpload(pt.key, e.target.files)}
            />
          </div>

          {posters[pt.key].length === 0 ? (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center text-gray-400">
              <ImageIcon size={24} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm">{lang === 'ru' ? 'Афиши не загружены' : 'No posters uploaded'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {posters[pt.key].map((url, i) => (
                <div key={i} className="relative group aspect-video rounded-xl overflow-hidden bg-gray-100">
                  <img src={url} alt="" className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeposter(pt.key, url)}
                    className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                  >
                    <Trash2 size={18} className="text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
