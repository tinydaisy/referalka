'use client'

/**
 * «Где лицо на фото» — точка лица плюс приближение кадра для каждой формы.
 *
 * ⚠️ КЛИК, А НЕ ДВА СЛАЙДЕРА. Человек смотрит на фото и тычет в нос — это одно
 * движение. Слайдерами X/Y (как у фона лендинга) ту же точку ищут наугад.
 *
 * ⚠️⚠️ ПРИБЛИЖЕНИЕ НАСТРАИВАЕТСЯ РУКАМИ И ОТДЕЛЬНО ДЛЯ КАЖДОЙ ФОРМЫ (мигр. 451).
 * Раньше оно было зашито константой, одинаковой для всех: у портрета по плечи
 * приближать нечего, а человека в полный рост и втрое мало. Клиент видел
 * результат только на готовой афише и поправить не мог.
 *
 * ⚠️ Афиша берёт ИМЕННО ЭТИ настройки — и точку, и масштаб своей формы. То, что
 * видно здесь в кружке, ровно так и встанет в круглой маске на афише.
 */

import { useRef } from 'react'
import { formatFocal, parseFocal } from '@/lib/photoFocal'
import MaskedPhoto from '@/components/MaskedPhoto'
import { zoomOf, offsetOf, type CropSettings, type CropShape } from '@/lib/photoCrop'

export type { CropShape, CropSettings }
/** Старое имя — чтобы не править все места разом. */
export type CropZooms = CropSettings

export default function FocalPointPicker({
  url, value, onChange, hint, zooms, onZoomChange,
}: {
  url: string
  /** Точка лица («50% 35%») или пусто. */
  value?: string | null
  onChange: (v: string) => void
  hint?: string
  /** Текущие масштабы по формам. */
  zooms?: CropZooms | null
  /** Пусто — ползунки приближения не показываем (карточки, где их некуда сохранить). */
  onZoomChange?: (patch: CropZooms) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const { x, y } = parseFocal(value)
  const marked = !!(value || '').trim()

  function pick(e: React.MouseEvent) {
    const box = boxRef.current
    if (!box) return
    const r = box.getBoundingClientRect()
    if (!r.width || !r.height) return
    onChange(formatFocal(
      ((e.clientX - r.left) / r.width) * 100,
      ((e.clientY - r.top) / r.height) * 100,
    ))
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Само фото целиком: кликать надо по настоящему лицу, поэтому
            показываем без обрезки (contain), а не в рамке. */}
        <div
          ref={boxRef}
          onClick={pick}
          className="relative shrink-0 rounded-xl overflow-hidden border card-border bg-gray-50 cursor-crosshair select-none"
          style={{ width: 200, height: 260 }}
          title="Нажмите на лицо"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" className="w-full h-full" style={{ objectFit: 'contain' }} draggable={false} />

          {/* Метка. Не перехватывает клики — иначе по самой метке не попасть. */}
          <div
            className="absolute pointer-events-none"
            style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}
          >
            <div className="w-6 h-6 rounded-full border-2 border-white shadow-[0_0_0_2px_rgba(0,0,0,0.5)]"
                 style={{ background: 'rgba(255,207,164,0.55)' }} />
          </div>
        </div>

        {/* Живые примеры: ровно те рамки, в которых фото показывается людям. */}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-500 mb-2">
            {marked
              ? 'Так фото встанет на афише — подгоните каждую форму:'
              : 'Точка не отмечена — кадр держится за верхнюю треть. Нажмите на лицо, чтобы задать точно.'}
          </p>
          <div className="flex items-start gap-4 flex-wrap">
            {(['circle', 'square', 'portrait'] as CropShape[]).map(shape => (
              <ShapeTuner
                key={shape}
                shape={shape}
                url={url}
                focal={value}
                settings={zooms}
                onChange={onZoomChange}
              />
            ))}
          </div>
          {hint && <p className="text-xs text-gray-400 mt-3 leading-relaxed">{hint}</p>}
          {marked && (
            <button type="button"
                    onClick={() => onChange('')}
                    className="text-xs text-gray-400 hover:text-gray-600 underline mt-3">
              Убрать отметку
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const LABEL: Record<CropShape, string> = {
  circle: 'Кружок',
  square: 'Квадрат',
  portrait: 'Афиша',
}

/** Одна форма: превью, приближение и сдвиг. */
function ShapeTuner({ shape, url, focal, settings, onChange }: {
  shape: CropShape
  url: string
  focal?: string | null
  settings?: CropSettings | null
  onChange?: (patch: CropSettings) => void
}) {
  const w = 96
  const h = shape === 'portrait' ? 128 : 96
  const zoom = zoomOf(shape, settings)
  const { dx, dy } = offsetOf(shape, settings)

  return (
    <div className="text-center">
      {/* ⚠️ Тот же компонент, что рисует афишу: точка лица попадает ровно в
          центр маски — это видно здесь и ровно так будет на афише. */}
      <MaskedPhoto
        url={url}
        shape={shape}
        focal={focal}
        settings={settings}
        width={w}
        height={h}
        radius={shape === 'circle' ? '50%' : 10}
        className="border card-border bg-gray-100 mx-auto"
      />
      <p className="text-[10px] text-gray-400 mt-1">{LABEL[shape]}</p>

      {onChange && (
        <div className="mt-1 space-y-1" style={{ width: w }}>
          <Slider label="масштаб" min={0.3} max={3} step={0.05} value={zoom}
                  fmt={v => `×${v.toFixed(2)}`}
                  onChange={v => onChange({ [`crop_zoom_${shape}`]: v } as CropSettings)} />
          {/* Сдвиг — когда центр не то, что нужно: шляпа, высокая причёска. */}
          <Slider label="вбок" min={-50} max={50} step={1} value={dx}
                  fmt={v => `${v > 0 ? '+' : ''}${v}`}
                  onChange={v => onChange({ [`crop_dx_${shape}`]: v } as CropSettings)} />
          <Slider label="выше/ниже" min={-50} max={50} step={1} value={dy}
                  fmt={v => `${v > 0 ? '+' : ''}${v}`}
                  onChange={v => onChange({ [`crop_dy_${shape}`]: v } as CropSettings)} />
          {(zoom !== 1 || dx !== 0 || dy !== 0) && (
            <button type="button"
                    onClick={() => onChange({
                      [`crop_zoom_${shape}`]: 1,
                      [`crop_dx_${shape}`]: 0,
                      [`crop_dy_${shape}`]: 0,
                    } as CropSettings)}
                    className="text-[10px] text-gray-400 hover:text-gray-600 underline">
              сбросить
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Компактный ползунок с подписью и значением. */
function Slider({ label, min, max, step, value, fmt, onChange }: {
  label: string; min: number; max: number; step: number; value: number
  fmt: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-gray-400 leading-none">
        <span>{label}</span><span>{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
             onChange={e => onChange(Number(e.target.value))}
             className="w-full" style={{ height: 14 }} />
    </div>
  )
}
