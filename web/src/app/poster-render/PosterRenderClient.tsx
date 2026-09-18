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
  const size = POSTER_SIZE[o] || POSTER_SIZE.vertical

  useEffect(() => {
    fetch(`${apiBase}/api/v1/public/poster/data?event=${encodeURIComponent(event)}`
          + `&o=${encodeURIComponent(o)}&t=${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {})
  }, [event, o, token])

  // Пока данные не пришли — пустой экран нужного размера, чтобы снимок не
  // поймал схлопнутую страницу, если что-то пойдёт не так.
  if (!data) return <div style={{ width: size.w, height: size.h, background: '#0a1520' }} />

  return (
    <div style={{ width: size.w, height: size.h, overflow: 'hidden' }}>
      <PosterCanvas
        layout={{ ...data.layout, orientation: o }}
        theme={data.theme || {}}
        people={data.people || []}
      />
    </div>
  )
}
