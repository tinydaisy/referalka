'use client'

/**
 * «Отметить лицо» — клик по фото ставит точку, за которую держится кадр.
 *
 * ⚠️ КЛИК, А НЕ ДВА СЛАЙДЕРА. Человек смотрит на фото и тычет в нос — это одно
 * движение. Слайдерами X/Y (как у фона лендинга) ту же точку ищут наугад,
 * дёргая ползунок и проверяя результат.
 *
 * ⚠️ Рядом с фото — живые примеры кадрирования (круг, квадрат, портрет). Без
 * них клиент не видит, ЗАЧЕМ он это делает: на большом фото голова не срезана
 * никогда, а срезается она именно в маленькой круглой миниатюре.
 */

import { useRef } from 'react'
import { formatFocal, parseFocal, focalCss } from '@/lib/photoFocal'

export default function FocalPointPicker({
  url, value, onChange, hint,
}: {
  url: string
  /** Текущее значение («50% 35%») или пусто. */
  value?: string | null
  onChange: (v: string) => void
  hint?: string
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
              ? 'Так фото встанет в разных местах:'
              : 'Точка не отмечена — кадр держится за верхнюю треть. Нажмите на лицо, чтобы задать точно.'}
          </p>
          <div className="flex items-end gap-3 flex-wrap">
            <Sample url={url} focal={value} w={64} h={64} round label="Кружок" />
            <Sample url={url} focal={value} w={72} h={72} label="Квадрат" />
            <Sample url={url} focal={value} w={72} h={96} label="Афиша" />
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

function Sample({ url, focal, w, h, round, label }: {
  url: string; focal?: string | null; w: number; h: number; round?: boolean; label: string
}) {
  return (
    <div className="text-center">
      <div className="overflow-hidden border card-border bg-gray-100 mx-auto"
           style={{ width: w, height: h, borderRadius: round ? 9999 : 10 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="w-full h-full"
             style={{ objectFit: 'cover', objectPosition: focalCss(focal) }} />
      </div>
      <p className="text-[10px] text-gray-400 mt-1">{label}</p>
    </div>
  )
}
