'use client'
import { useState, useEffect } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
import { api } from '@/lib/api'
import { useLang } from '@/contexts/LangContext'
import FileUploader from '@/components/FileUploader'
import AnnouncementTextsBlock from '@/components/AnnouncementTextsBlock'
import MaterialsExportButton from '@/components/MaterialsExportButton'
import DayPostersBlock from '@/components/DayPostersBlock'

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

type SubTab = 'posters' | 'days' | 'materials'

// Афиши конференции лежат в `event_posters` — единый источник истины,
// общий с обычными мероприятиями. API: /events/{id}/referral/posters.
// Старые поля conf_conferences.poster_* больше не используются для записи —
// существующие данные мигрированы в event_posters миграцией 046.
export default function PostersTab({ eventId, moduleSlug }: { eventId: number; moduleSlug?: string | null }) {
  const { lang } = useLang()
  const [tab, setTab] = useUrlTab<SubTab>('sub', 'posters')

  const labels: Record<SubTab, string> = {
    posters:   lang === 'ru' ? 'Общие афиши' : 'Common posters',
    days:      lang === 'ru' ? 'Дни события' : 'Event days',
    materials: lang === 'ru' ? 'Тексты анонсов' : 'Announcement texts',
  }

  return (
    <div>
      <div className="border-b border-gray-200 mb-6 flex items-center gap-1 -mt-2">
        {(['posters','days','materials'] as SubTab[]).map(t => (
          <button key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    tab === t
                      ? 'border-[#FFCFA4] text-[#25455D]'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}>
            {labels[t]}
          </button>
        ))}
        <div className="ml-auto pb-1">
          <MaterialsExportButton eventId={eventId} moduleSlug={moduleSlug} />
        </div>
      </div>

      {tab === 'posters' && <PostersBlock eventId={eventId} />}
      {tab === 'days' && <DayPostersBlock eventId={eventId} />}
      {tab === 'materials' && <AnnouncementTextsBlock eventId={eventId} />}
    </div>
  )
}

function PostersBlock({ eventId }: { eventId: number }) {
  const { lang } = useLang()
  const [items, setItems] = useState<Poster[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  // Афиша, пока регистрация не открыта (миграция 345). Живёт колонкой события,
  // а не строкой event_posters: там CHECK на три ориентации, и четвёртый вид
  // пришлось бы отфильтровывать в трёх десятках запросов к афишам события.
  const [preRegPoster, setPreRegPoster] = useState<string | null>(null)
  const [regClosed, setRegClosed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [r, ev] = await Promise.all([
        // Только ОБЩИЕ афиши события (day IS NULL). Афиши дней — в подвкладке «Дни события».
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
          <div key={o.key} className="bg-white rounded-2xl border card-border shadow-sm p-6">
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

      {/* Афиша, пока регистрация не открыта (миграция 345) */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="mb-4">
          <h3 className="font-semibold text-gray-900">
            {lang === 'ru' ? 'Афиша до старта регистрации' : 'Pre-registration poster'}
          </h3>
          <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">
            {lang === 'ru'
              ? 'Показывается, пока регистрация не открыта — вместо обычной афиши. '
                + 'Нужна, когда финальной афиши ещё нет. Не загрузите — возьмётся обычная афиша события.'
              : 'Shown while registration is closed, instead of the regular poster.'}
          </p>
          {/* ⚠️ Подсказка, где включается сам режим: иначе клиент загрузит
              картинку и не поймёт, почему её нигде не видно. */}
          {!regClosed && lang === 'ru' && (
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
          emptyText={lang === 'ru' ? 'Афиша не загружена' : 'No poster'}
          buttonLabel={lang === 'ru' ? 'Загрузить' : 'Upload'}
        />
      </div>

      {/* Общее видео события — для скачивания спикерами */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="mb-4">
          <h3 className="font-semibold text-gray-900">{lang === 'ru' ? 'Общее видео' : 'Common video'}</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            {lang === 'ru'
              ? 'Один файл (mp4/webm/mov, до 100 МБ) — будет доступен на скачивание спикерам в их кабинете во вкладке «Материалы».'
              : 'One file (mp4/webm/mov, up to 100 MB) — available to speakers in their Materials tab.'}
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
          emptyText={lang === 'ru' ? 'Видео не загружено' : 'No video'}
          buttonLabel={lang === 'ru' ? 'Загрузить видео' : 'Upload video'}
        />
      </div>
    </div>
  )
}
