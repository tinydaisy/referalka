'use client'
import { useState, useEffect } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { api } from '@/lib/api'
import FileUploader from '@/components/FileUploader'
import AnnouncementTextsBlock from '@/components/AnnouncementTextsBlock'

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

type SubTab = 'posters' | 'materials'

export default function PostersTab({ eventId }: { eventId: number }) {
  const [tab, setTab] = useUrlTab<SubTab>('sub', 'posters')

  return (
    <div>
      <SubTabs current={tab} onChange={setTab} />
      {tab === 'posters' ? <PostersBlock eventId={eventId} /> : <AnnouncementTextsBlock eventId={eventId} />}
    </div>
  )
}

function SubTabs({ current, onChange }: { current: SubTab; onChange: (t: SubTab) => void }) {
  const items: { key: SubTab; label: string }[] = [
    { key: 'posters',   label: 'Афиши' },
    { key: 'materials', label: 'Тексты анонсов' },
  ]
  return (
    <div className="border-b border-gray-200 mb-6 flex gap-1 -mt-2">
      {items.map(it => (
        <button key={it.key}
                onClick={() => onChange(it.key)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  current === it.key
                    ? 'border-[#FFCFA4] text-[#25455D]'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}>
          {it.label}
        </button>
      ))}
    </div>
  )
}

function PostersBlock({ eventId }: { eventId: number }) {
  const [items, setItems] = useState<Poster[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  // Афиша, пока регистрация не открыта (миграция 345). Колонка события, а не
  // строка event_posters: там CHECK на три ориентации, и четвёртый вид пришлось
  // бы отфильтровывать в трёх десятках запросов к афишам события.
  const [preRegPoster, setPreRegPoster] = useState<string | null>(null)
  const [regClosed, setRegClosed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [r, ev] = await Promise.all([
        api.referralProgram.posters.list(eventId, { onlyCommon: true }),
        api.events.get(eventId),
      ])
      setItems(r.items || [])
      const e = ev?.event ?? ev
      setVideoUrl(e?.video_url ?? null)
      setPreRegPoster(e?.pre_reg_poster_url ?? null)
      setRegClosed(!!e?.registration_closed)
      setErr(null)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [eventId])

  async function saveVideoUrl(url: string | null) {
    try {
      await api.events.update(eventId, { video_url: url })
      setVideoUrl(url)
    } catch (e: any) { setErr(e.message) }
  }

  async function savePreRegPoster(url: string | null) {
    try {
      await api.events.update(eventId, { pre_reg_poster_url: url })
      setPreRegPoster(url)
    } catch (e: any) { setErr(e.message) }
  }

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
          <div key={o.key} className="bg-white rounded-2xl border card-border shadow-sm p-6">
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

      {/* Афиша, пока регистрация не открыта (миграция 345) */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="mb-4">
          <h3 className="font-semibold text-gray-900">Афиша до старта регистрации</h3>
          <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
            Показывается, пока регистрация не открыта — вместо обычной афиши. Нужна, когда
            финальной афиши ещё нет. Не загрузите — возьмётся обычная афиша события.
          </p>
          {/* ⚠️ Подсказка, где включается сам режим: иначе клиент загрузит
              картинку и не поймёт, почему её нигде не видно. */}
          {!regClosed && (
            <p className="text-xs text-gray-400 mt-2">
              Сейчас регистрация открыта — эта афиша не показывается. Включается галочкой
              «Регистрация ещё не открыта» в настройках события.
            </p>
          )}
        </div>
        <FileUploader
          mode="single"
          kind="pre_reg_poster"
          eventId={eventId}
          value={preRegPoster}
          onChange={u => savePreRegPoster(u)}
          aspectClass="aspect-video"
          emptyText="Афиша не загружена"
          buttonLabel="Загрузить"
        />
      </div>

      {/* Общее видео события — отдаётся всем спикерам на их странице «Материалы». */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="mb-4">
          <h3 className="font-semibold text-gray-900">Общее видео</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            Один файл (mp4/webm/mov, до 100 МБ) — будет доступен на скачивание спикерам в их кабинете во вкладке «Материалы».
          </p>
        </div>
        <FileUploader
          mode="single"
          kind="event_video"
          eventId={eventId}
          accept="video/*"
          value={videoUrl}
          onChange={u => saveVideoUrl(u)}
          aspectClass="aspect-video"
          emptyText="Видео не загружено"
          buttonLabel="Загрузить видео"
        />
      </div>
    </div>
  )
}
