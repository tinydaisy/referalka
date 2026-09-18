/**
 * Круглый аватар человека с настроенным кадром.
 *
 * ⚠️ Кадр берётся из карточки спикера (точка лица, приближение, сдвиг) — тот
 * же расчёт, что на афише и в кабинете. Клиент настраивает один раз, а видно
 * везде: список спикеров, программа, Mini App, веб-версия.
 *
 * ⚠️ Нет фото — показываем инициалы, как и раньше: пустой серый круг выглядит
 * как ошибка загрузки.
 */

import { useState } from 'react'
import { circleCropStyle, type CropSettings } from '../utils/photoCrop'

export default function Avatar({
  person, url, size, name, border, style,
}: {
  /** Карточка человека: из неё берутся настройки кадра. */
  person?: CropSettings | null
  url?: string | null
  size: number
  /** Для инициалов, когда фото нет. */
  name?: string | null
  /** Рамка, напр. `2px solid #FFCFA4`. */
  border?: string
  style?: React.CSSProperties
}) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)

  const initials = (name || '')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]?.toUpperCase() || '').join('')

  const box: React.CSSProperties = {
    position: 'relative', overflow: 'hidden',
    width: size, height: size, borderRadius: '50%',
    flexShrink: 0, border,
    ...style,
  }

  if (!url) {
    return (
      <div style={{
        ...box,
        background: 'var(--gradient)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#FFCFA4', fontWeight: 700, fontSize: Math.round(size * 0.32),
      }}>{initials}</div>
    )
  }

  return (
    <div style={box}>
      <img
        src={url}
        alt=""
        onLoad={e => {
          const el = e.currentTarget
          if (el.naturalWidth && el.naturalHeight) {
            setNat({ w: el.naturalWidth, h: el.naturalHeight })
          }
        }}
        style={circleCropStyle(person, size, nat?.w, nat?.h)}
        draggable={false}
      />
    </div>
  )
}
