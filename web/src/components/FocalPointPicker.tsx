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
import { formatFocal, parseFocal, focalCss } from '@/lib/photoFocal'

/** Формы, для которых настраивается кадр. */
export type CropShape = 'circle' | 'square' | 'portrait'

export type CropZooms = {
  crop_zoom_circle?: number | null
  crop_zoom_square?: number | null
  crop_zoom_portrait?: number | null
}

// ⚠️ Умолчание 1.0 — кадр БЕЗ приближения: голова помещается целиком, макушка
// и волосы не срезаются. Прежние 1.6 обрезали часть головы у портретов,
// снятых крупно. Приблизить клиент может сам ползунком — это его выбор, а
// «по умолчанию ничего не отрезано» безопаснее.
export const ZOOM_DEFAULT: Record<CropShape, number> = {
  circle: 1,
  square: 1,
  portrait: 1,
}

const FIELD: Record<CropShape, keyof CropZooms> = {
  circle: 'crop_zoom_circle',
  square: 'crop_zoom_square',
  portrait: 'crop_zoom_portrait',
}

/** Приближение для формы: заданное клиентом либо умолчание. */
export function zoomOf(shape: CropShape, z?: CropZooms | null): number {
  const v = z?.[FIELD[shape]]
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) && (n as number) >= 1 ? (n as number) : ZOOM_DEFAULT[shape]
}

/**
 * Куда смотрит кадр внутри маски.
 *
 * ⚠️ У круга и квадрата точка лица стоит РОВНО ПО ЦЕНТРУ: иначе человек
 * выглядывает из-за края. У прямоугольника лицо поднимают вверх — под ним ещё
 * плечи и подпись.
 */
export function cropPosition(shape: CropShape, focal?: string | null): string {
  const { x, y } = parseFocal(focal)
  if (shape === 'portrait') return focalCss(focal)
  return `${Math.round(x)}% 50%`
}

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
                zoom={zoomOf(shape, zooms)}
                onZoom={onZoomChange
                  ? v => onZoomChange({ [FIELD[shape]]: v } as CropZooms)
                  : undefined}
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

/** Одна форма: превью + ползунок приближения под ним. */
function ShapeTuner({ shape, url, focal, zoom, onZoom }: {
  shape: CropShape
  url: string
  focal?: string | null
  zoom: number
  onZoom?: (v: number) => void
}) {
  const w = 86
  const h = shape === 'portrait' ? 114 : 86
  const pos = cropPosition(shape, focal)

  return (
    <div className="text-center">
      <div className="overflow-hidden border card-border bg-gray-100 mx-auto"
           style={{ width: w, height: h, borderRadius: shape === 'circle' ? 9999 : 10 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="w-full h-full"
             style={{
               objectFit: 'cover', objectPosition: pos,
               // ⚠️⚠️ ЗУМ ОТ ЦЕНТРА, а не от точки лица. `object-position` УЖЕ
               // поставил отмеченную точку в центр видимого кадра; если ещё и
               // `transform-origin` задать той же точкой, сдвиг применится
               // дважды и лицо уедет вбок (так и было у Вангуловой).
               ...(zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: 'center' } : {}),
             }} />
      </div>
      <p className="text-[10px] text-gray-400 mt-1">{LABEL[shape]}</p>
      {onZoom && (
        <div className="mt-1" style={{ width: w }}>
          {/* Ползунок приближения. ⚠️ Шаг 0.05 — иначе кадр прыгает и
              подогнать лицо точно не получается. */}
          <input type="range" min={1} max={3} step={0.05} value={zoom}
                 onChange={e => onZoom(Number(e.target.value))}
                 className="w-full" />
          <div className="text-[10px] text-gray-400">×{zoom.toFixed(2)}</div>
        </div>
      )}
    </div>
  )
}
