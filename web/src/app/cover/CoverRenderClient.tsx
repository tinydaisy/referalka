'use client'

/**
 * Одна обложка во весь экран — то, что снимает Chromium.
 *
 * ⚠️ Полотно рисует ОБЩИЙ `CoverCanvas`, тот же, что в предпросмотре настроек.
 * Своей вёрстки здесь нет: она разошлась бы с предпросмотром, и клиент правил бы
 * одно, а скачивал другое.
 *
 * ⚠️ Данные — по подписанному токену в адресе (`?t=`): Chromium открывает
 * страницу как посторонний, токена кабинета у него нет.
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import CoverCanvas, { COVER_W, COVER_H } from '@/components/covers/CoverCanvas'

const apiBase = process.env.NEXT_PUBLIC_API_URL || ''

export default function CoverRenderClient() {
  const sp = useSearchParams()
  const [data, setData] = useState<any>(null)

  const kind = sp.get('kind') || 'material'
  const token = sp.get('t') || ''
  const title = sp.get('title') || ''
  const subtitle = sp.get('subtitle') || ''
  const overline = sp.get('overline') || ''
  const photo = sp.get('photo') || ''

  useEffect(() => {
    fetch(`${apiBase}/api/v1/public/cover/data?kind=${encodeURIComponent(kind)}&t=${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {})
  }, [kind, token])

  // Пока данные не пришли — пустой экран нужного размера, чтобы снимок не
  // поймал схлопнутую страницу, если что-то пойдёт не так.
  if (!data) return <div style={{ width: COVER_W, height: COVER_H, background: '#0a1520' }} />

  return (
    <div style={{ width: COVER_W, height: COVER_H, overflow: 'hidden' }}>
      <CoverCanvas
        template={data.template}
        theme={data.theme}
        title={title}
        subtitle={subtitle || null}
        overline={overline || null}
        photoUrl={photo || data.theme?.sample_photo_url || null}
      />
    </div>
  )
}
