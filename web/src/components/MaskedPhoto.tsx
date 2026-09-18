'use client'

/**
 * Фото в маске: отмеченная точка лица встаёт ровно в центр.
 *
 * ⚠️ Узнаёт НАСТОЯЩИЕ пропорции снимка (`naturalWidth`/`naturalHeight`) и
 * пересчитывает кадр по ним. Без этого пришлось бы гадать, и на горизонтальных
 * или квадратных фото точка уезжала бы.
 *
 * ⚠️ Один компонент и в кабинете, и на афише — расчёт общий (`photoCrop.ts`).
 * Разойдись они, клиент настроил бы кадр в карточке, а на афише получил другое.
 */

import { useState } from 'react'
import { cropStyle, type CropSettings, type CropShape } from '@/lib/photoCrop'

export default function MaskedPhoto({
  url, shape, focal, settings, width, height, radius, className, style,
}: {
  url: string
  shape: CropShape
  focal?: string | null
  settings?: CropSettings | null
  /** Размер маски в пикселях — расчёт идёт в реальных величинах. */
  width: number
  height: number
  /** Скругление: число — пиксели, строка — как есть («50%» для круга). */
  radius?: number | string
  className?: string
  style?: React.CSSProperties
}) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)

  return (
    <div
      className={className}
      style={{
        position: 'relative', overflow: 'hidden',
        width, height, borderRadius: radius,
        ...style,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        // ⚠️ Пропорции узнаём при загрузке. До этого момента кадр считается по
        // допущению 3:4 — картинка не прыгает, просто уточняется.
        onLoad={e => {
          const el = e.currentTarget
          if (el.naturalWidth && el.naturalHeight) {
            setNat({ w: el.naturalWidth, h: el.naturalHeight })
          }
        }}
        style={cropStyle(shape, focal, settings, width, height, nat?.w, nat?.h)}
        draggable={false}
      />
    </div>
  )
}
