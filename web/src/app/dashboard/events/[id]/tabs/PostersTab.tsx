'use client'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'

type Orientation = 'horizontal' | 'vertical' | 'square'

interface Poster {
  id: number
  url: string
  orientation: Orientation
  sort: number
}

const ORIENTATIONS: { key: Orientation; label: string; ratio: string; aspect: string }[] = [
  { key: 'horizontal', label: 'Горизонтальные', ratio: '16:9', aspect: 'aspect-video' },
  { key: 'vertical',   label: 'Вертикальные',   ratio: '9:16', aspect: 'aspect-[9/16]' },
  { key: 'square',     label: 'Квадратные',     ratio: '1:1',  aspect: 'aspect-square' },
]

export default function PostersTab({ eventId }: { eventId: number }) {
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

    // 1. Новые URL (есть в new, нет в old) — создаём через api.create
    const added = newUrls.filter(u => !oldUrls.includes(u))
    for (const url of added) {
      try {
        await api.referralProgram.posters.create(eventId, { url, orientation, sort: 0 })
      } catch (e: any) { setErr(e.message) }
    }

    // 2. Удалённые URL — удаляем через api.delete (R2 уже почищен FileUploader-ом)
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

  if (loading) return <div className="text-gray-400 text-sm">Загрузка…</div>

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-gray-500">
        Афиши используются на лендинге события и в материалах для шеринга.
      </p>

      {err && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{err}</div>}

      {ORIENTATIONS.map(o => {
        const urls = items.filter(p => p.orientation === o.key).map(p => p.url)
        return (
          <div key={o.key} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <div className="mb-4">
              <h3 className="font-semibold text-gray-900">{o.label}</h3>
              <p className="text-xs text-gray-400 mt-0.5">Соотношение сторон {o.ratio}</p>
            </div>
            <FileUploader
              mode="multiple"
              kind="event_poster"
              eventId={eventId}
              posterType={o.key}
              value={urls}
              onChange={u => handleChange(o.key, u)}
              aspectClass={o.aspect}
              emptyText="Афиш пока нет"
              buttonLabel="Загрузить"
            />
          </div>
        )
      })}
    </div>
  )
}
