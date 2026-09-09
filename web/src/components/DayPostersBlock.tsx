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
  day: number | null
}

interface Day {
  day_number: number
  day_date?: string | null
  title?: string | null
}

const POSTER_TYPES: { key: Orientation; labelRu: string; labelEn: string; ratio: string; aspect: string }[] = [
  { key: 'square',     labelRu: 'Квадратная',    labelEn: 'Square',     ratio: '1:1',  aspect: 'aspect-square' },
  { key: 'horizontal', labelRu: 'Горизонтальная', labelEn: 'Horizontal', ratio: '16:9', aspect: 'aspect-video' },
  { key: 'vertical',   labelRu: 'Вертикальная',   labelEn: 'Vertical',   ratio: '9:16', aspect: 'aspect-[9/16]' },
]

const RU_M: Record<string, string> = {
  '01': 'янв', '02': 'фев', '03': 'мар', '04': 'апр', '05': 'май', '06': 'июн',
  '07': 'июл', '08': 'авг', '09': 'сен', '10': 'окт', '11': 'ноя', '12': 'дек',
}

function dayLabel(d: Day): string {
  let date = ''
  if (d.day_date) {
    const p = d.day_date.toString().slice(0, 10).split('-')
    if (p.length === 3) date = ` · ${parseInt(p[2])} ${RU_M[p[1]] || p[1]}`
  }
  const title = (d.title || '').trim()
  return `День ${d.day_number}${date}${title ? ` — ${title}` : ''}`
}

/**
 * Афиши ДНЯ события (подвкладка «Дни события» в разделе «Афиши»).
 *
 * У каждого дня программы своя афиша — квадратная / горизонтальная / вертикальная.
 * Хранятся в той же таблице event_posters, но с привязкой к дню (миграция 215):
 * day = номер дня, тогда как у общих афиш day = NULL.
 *
 * Дневные рассылки («старт дня», «за 2 часа», «за 30 минут», «за сутки», «итоги дня»)
 * берут фото по приоритету: фото шаблона → афиша дня → общая афиша события.
 * Внутри группы: квадрат → горизонтальная → вертикальная.
 */
export default function DayPostersBlock({ eventId }: { eventId: number }) {
  const { lang } = useLang()
  const [days, setDays] = useState<Day[]>([])
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [items, setItems] = useState<Poster[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Дни программы + все дневные афиши разом (чтобы показать, у каких дней афиша уже есть).
  async function load() {
    setLoading(true)
    try {
      const [d, p] = await Promise.all([
        api.conference.days.list(eventId),
        api.referralProgram.posters.list(eventId),
      ])
      const dayList: Day[] = d.days || []
      setDays(dayList)
      setItems((p.items || []).filter((x: Poster) => x.day != null))
      setSelectedDay(prev => prev ?? (dayList[0]?.day_number ?? null))
      setErr(null)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [eventId])

  async function handleChange(orientation: Orientation, newUrls: string[]) {
    if (selectedDay == null) return
    const oldItems = items.filter(p => p.day === selectedDay && p.orientation === orientation)
    const oldUrls = oldItems.map(p => p.url)

    for (const url of newUrls.filter(u => !oldUrls.includes(u))) {
      try {
        await api.referralProgram.posters.create(eventId, { url, orientation, sort: 0, day: selectedDay })
      } catch (e: any) { setErr(e.message) }
    }
    for (const url of oldUrls.filter(u => !newUrls.includes(u))) {
      const item = oldItems.find(p => p.url === url)
      if (item) {
        try { await api.referralProgram.posters.delete(eventId, item.id) }
        catch (e: any) { setErr(e.message) }
      }
    }
    await load()
  }

  if (loading) return <div className="text-gray-400 text-sm">{lang === 'ru' ? 'Загрузка…' : 'Loading…'}</div>

  if (days.length === 0) {
    return (
      <div className="max-w-2xl">
        <div className="bg-amber-50 border border-amber-100 text-amber-800 rounded-2xl px-5 py-4 text-sm">
          {lang === 'ru'
            ? 'У события пока нет дней программы. Добавьте дни во вкладке «Программа» — тогда сможете загрузить афишу для каждого дня.'
            : 'This event has no program days yet. Add days in the Program tab first.'}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-gray-500">
        {lang === 'ru'
          ? 'Своя афиша для каждого дня программы. Рассылки, привязанные ко дню («Начинаем День события», «За 2 часа», «За 30 минут», «За сутки», «Итоги дня»), возьмут афишу этого дня — если в самом шаблоне рассылки фото не загружено. Если у дня афиши нет, подставится общая афиша события.'
          : 'A poster per program day. Day-based broadcasts use the day poster unless the template has its own photo; otherwise the common event poster is used.'}
      </p>

      {err && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{err}</div>}

      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {lang === 'ru' ? 'День события' : 'Event day'}
        </label>
        <select
          value={selectedDay ?? ''}
          onChange={e => setSelectedDay(Number(e.target.value))}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none bg-white">
          {days.map(d => {
            const has = items.some(p => p.day === d.day_number)
            return (
              <option key={d.day_number} value={d.day_number}>
                {dayLabel(d)}{has ? ' ✓' : ''}
              </option>
            )
          })}
        </select>
        <p className="text-xs text-gray-400 mt-1.5">
          {lang === 'ru'
            ? 'Галочкой отмечены дни, у которых афиша уже загружена.'
            : 'Days with an uploaded poster are marked.'}
        </p>
      </div>

      {selectedDay != null && POSTER_TYPES.map(o => {
        const urls = items
          .filter(p => p.day === selectedDay && p.orientation === o.key)
          .map(p => p.url)
        return (
          <div key={`${selectedDay}-${o.key}`} className="bg-white rounded-2xl border card-border shadow-sm p-6">
            <div className="mb-4">
              <h3 className="font-semibold text-gray-900">{lang === 'ru' ? o.labelRu : o.labelEn}</h3>
              <p className="text-xs text-gray-400 mt-0.5">
                {lang === 'ru' ? `Соотношение сторон ${o.ratio}` : `Aspect ratio ${o.ratio}`}
                {o.key === 'square' && (lang === 'ru' ? ' · в рассылку пойдёт первой' : ' · used first in broadcasts')}
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
              emptyText={lang === 'ru' ? 'Афиши пока нет' : 'No poster yet'}
              buttonLabel={lang === 'ru' ? 'Загрузить' : 'Upload'}
            />
          </div>
        )
      })}
    </div>
  )
}
