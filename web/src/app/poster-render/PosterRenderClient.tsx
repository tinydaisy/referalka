'use client'

/**
 * Одна афиша во весь экран — то, что снимает Chromium.
 *
 * ⚠️ Полотно рисует ОБЩИЙ `PosterCanvas`, тот же, что в предпросмотре редактора.
 * Своей вёрстки здесь нет: она разошлась бы с предпросмотром, и клиент правил бы
 * одно, а скачивал другое.
 *
 * ⚠️ Данные — по подписанному токену в адресе (`?t=`): Chromium открывает
 * страницу как посторонний, токена кабинета у него нет.
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import PosterCanvas, { POSTER_SIZE, type PosterOrientation } from '@/components/posters/PosterCanvas'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

export default function PosterRenderClient() {
  const sp = useSearchParams()
  const [data, setData] = useState<any>(null)

  const event = sp.get('event') || ''
  const o = (sp.get('o') || 'vertical') as PosterOrientation
  const token = sp.get('t') || ''
  // ⚠️⚠️ ВИД АФИШИ И ЧТО ИМЕННО СНИМАЕМ (миграция 459). Без этих трёх
  // параметров Chromium снимал бы общую афишу под видом дневной и
  // индивидуальной: и день, и спикер просто терялись бы по дороге, а файлы
  // получились бы одинаковыми.
  const kind = (sp.get('kind') || 'common') as 'common' | 'day' | 'individual'
  const day = sp.get('day')
  const speaker = sp.get('speaker')
  const size = POSTER_SIZE[o] || POSTER_SIZE.vertical

  useEffect(() => {
    fetch(`${apiBase}/api/v1/public/poster/data?event=${encodeURIComponent(event)}`
          + `&o=${encodeURIComponent(o)}&t=${encodeURIComponent(token)}`
          + `&kind=${encodeURIComponent(kind)}`
          + (day ? `&day=${encodeURIComponent(day)}` : '')
          + (speaker ? `&speaker=${encodeURIComponent(speaker)}` : ''))
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {})
  }, [event, o, token, kind, day, speaker])

  // Пока данные не пришли — пустой экран нужного размера, чтобы снимок не
  // поймал схлопнутую страницу, если что-то пойдёт не так.
  if (!data) return <div style={{ width: size.w, height: size.h, background: '#0a1520' }} />

  return (
    <div style={{ width: size.w, height: size.h, overflow: 'hidden' }}>
      <PosterCanvas
        layout={{ ...data.layout, orientation: o, kind }}
        theme={data.theme || {}}
        people={data.people || []}
        days={Array.isArray(data.days) ? data.days : []}
        sessions={data.sessions && typeof data.sessions === 'object' ? data.sessions : {}}
        day={day != null ? Number(day) : null}
        speakerId={speaker != null ? Number(speaker) : null}
      />
    </div>
  )
}
