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

/** Число из адреса. Пусто или мусор → null: у кадра свои умолчания. */
function numOrNull(v: string | null): number | null {
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export default function CoverRenderClient() {
  const sp = useSearchParams()
  const [data, setData] = useState<any>(null)

  const kind = sp.get('kind') || 'material'
  const token = sp.get('t') || ''
  const title = sp.get('title') || ''
  const subtitle = sp.get('subtitle') || ''
  const overline = sp.get('overline') || ''
  const photo = sp.get('photo') || ''

  // ⚠️⚠️ КАДР ПРИЕЗЖАЕТ В АДРЕСЕ (26.09.2026). Раньше обложка не применяла
  // его вовсе: фото вставлялось как есть, и отмеченная точка лица не работала —
  // на готовых обложках лица оказывались обрезанными, а сами фото вставали
  // вразнобой. Точка и зум настроены в карточке человека и нужны здесь же.
  const crop = {
    photo_focal: sp.get('photo_focal'),
    cutout_photo_focal: sp.get('cutout_photo_focal'),
    crop_zoom_circle: numOrNull(sp.get('crop_zoom_circle')),
    crop_zoom_square: numOrNull(sp.get('crop_zoom_square')),
    crop_zoom_portrait: numOrNull(sp.get('crop_zoom_portrait')),
    crop_dx_circle: numOrNull(sp.get('crop_dx_circle')),
    crop_dy_circle: numOrNull(sp.get('crop_dy_circle')),
    crop_dx_square: numOrNull(sp.get('crop_dx_square')),
    crop_dy_square: numOrNull(sp.get('crop_dy_square')),
    crop_dx_portrait: numOrNull(sp.get('crop_dx_portrait')),
    crop_dy_portrait: numOrNull(sp.get('crop_dy_portrait')),
  }

  useEffect(() => {
    fetch(`${apiBase}/api/v1/public/cover/data?kind=${encodeURIComponent(kind)}&t=${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => {})
  }, [kind, token])

  // Пока данные не пришли — пустой экран нужного размера, чтобы снимок не
  // поймал схлопнутую страницу, если что-то пойдёт не так.
  if (!data) return <div style={{ width: COVER_W, height: COVER_H, background: '#0a1520' }} />

  // ⚠️⚠️ БЕЗ ВЫРЕЗКИ — ФИГУРА, А НЕ «ВО ВСЮ ВЫСОТУ» (26.09.2026). Шаблон один
  // на всех спикеров, а фото у людей разные: у части в поле вырезки лежит
  // обычный JPEG (прозрачности в нём нет). «Во всю высоту» такое фото
  // разворачивает во весь рост вместе с фоном — на обложке получался интерьер
  // ресторана вместо силуэта. Портрет-фигура кадрирует его по лицу, и рядом с
  // настоящими вырезками он смотрится ровно.
  //
  // ⚠️ Подменяем ТОЛЬКО когда шаблон стоит на `cutout`: выбрал клиент фигуру
  // осознанно — его выбор и остаётся.
  const noCutout = sp.get('has_cutout') === '0'
  const template = noCutout && (data.template?.photo_shape ?? 'cutout') === 'cutout'
    ? { ...data.template, photo_shape: 'portrait' as const }
    : data.template

  return (
    <div style={{ width: COVER_W, height: COVER_H, overflow: 'hidden' }}>
      <CoverCanvas
        template={template}
        theme={data.theme}
        title={title}
        subtitle={subtitle || null}
        overline={overline || null}
        photoUrl={photo || data.theme?.sample_photo_url || null}
        photoCrop={crop}
      />
    </div>
  )
}
