/**
 * Круглое фото человека с настроенным кадром — как в кабинете.
 *
 * ⚠️⚠️ ТА ЖЕ МАТЕМАТИКА, ЧТО В `web/src/lib/photoCrop.ts`. Клиент настраивает
 * кадр один раз в карточке спикера, и он обязан выглядеть одинаково везде:
 * на афише, в списке спикеров, в программе, в Mini App и в веб-версии.
 * Разойдутся формулы — настройка перестанет что-либо значить.
 *
 * ⚠️ ПОЧЕМУ НЕ `background-position`. Он совмещает точку N % КАРТИНКИ с точкой
 * N % РАМКИ, а не с её центром: в центр попадает только «50 %». Отмеченный нос
 * из-за этого уезжал вбок и вверх.
 *
 * Считаем честно: вписываем фото (cover), умножаем на зум, сдвигаем так, чтобы
 * точка легла в центр, прибавляем ручной сдвиг и не даём картинке отойти от
 * краёв рамки (иначе в углу остаётся пустота).
 */

export type CropSettings = {
  photo_focal?: string | null
  crop_zoom_circle?: number | null
  crop_dx_circle?: number | null
  crop_dy_circle?: number | null
}

const DEFAULT_FOCAL = { x: 50, y: 33 }

function parseFocal(focal?: string | null): { x: number; y: number } {
  const m = (focal || '').match(/(-?[\d.]+)\s*%\s+(-?[\d.]+)\s*%/)
  if (!m) return DEFAULT_FOCAL
  const x = Number(m[1]); const y = Number(m[2])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return DEFAULT_FOCAL
  return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) }
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/**
 * Стили картинки внутри КРУГЛОЙ рамки размера `size` (в пикселях).
 *
 * ⚠️ `natW`/`natH` — настоящие пропорции снимка. Не переданы — берём 3:4
 * (самый частый портрет); погрешность видна только на необычных форматах.
 */
export function circleCropStyle(
  p: CropSettings | null | undefined,
  size: number,
  natW?: number,
  natH?: number,
): React.CSSProperties {
  const { x: fx, y: fy } = parseFocal(p?.photo_focal)
  const zoom = Math.max(1, Math.min(3, num(p?.crop_zoom_circle, 1)))
  const dx = Math.max(-50, Math.min(50, num(p?.crop_dx_circle, 0)))
  const dy = Math.max(-50, Math.min(50, num(p?.crop_dy_circle, 0)))

  const IW = natW && natH ? natW : 3
  const IH = natW && natH ? natH : 4
  const base = Math.max(size / IW, size / IH)
  const W = IW * base * zoom
  const H = IH * base * zoom

  let left = size / 2 - W * (fx / 100) + (dx / 100) * size
  let top = size / 2 - H * (fy / 100) + (dy / 100) * size
  // Не отходим от краёв: иначе в рамке остаётся пустота.
  left = Math.min(0, Math.max(size - W, left))
  top = Math.min(0, Math.max(size - H, top))

  return {
    position: 'absolute',
    width: W, height: H, left, top,
    objectFit: 'cover',
    maxWidth: 'none',
  }
}
