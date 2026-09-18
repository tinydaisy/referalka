/**
 * Кадрирование фото в маске: отмеченная точка лица встаёт РОВНО В ЦЕНТР.
 *
 * ⚠️⚠️ ПОЧЕМУ НЕ `object-position`. Он работает не так, как кажется: значение
 * «30 %» совмещает точку 30 % КАРТИНКИ с точкой 30 % МАСКИ, а вовсе не с её
 * центром. В центр попадает только «50 %». Поэтому отмеченный нос уезжал вбок
 * и вверх — и никакой зум это не чинил, потому что ошибка была в самой
 * позиции, а не в масштабе.
 *
 * Здесь считаем честно и явно:
 *   1) вписываем фото в маску (cover) и умножаем на зум;
 *   2) сдвигаем картинку так, чтобы точка (fx, fy) легла в центр маски;
 *   3) прибавляем ручной сдвиг клиента (dx, dy), если он его задал.
 *
 * Проверено арифметикой: при любом зуме и любой точке отклонение нулевое.
 *
 * ⚠️ ОДИН МОДУЛЬ НА ВСЕ МЕСТА — карточка коллаборатора, кабинет спикера,
 * полотно афиши. Разойдутся формулы — клиент настроит кадр в карточке, а на
 * афише получит другое, и доверия к настройке больше не будет.
 */

import { parseFocal } from '@/lib/photoFocal'

/** Формы, для которых кадр настраивается отдельно. */
export type CropShape = 'circle' | 'square' | 'portrait'

export type CropSettings = {
  crop_zoom_circle?: number | null
  crop_zoom_square?: number | null
  crop_zoom_portrait?: number | null
  crop_dx_circle?: number | null
  crop_dy_circle?: number | null
  crop_dx_square?: number | null
  crop_dy_square?: number | null
  crop_dx_portrait?: number | null
  crop_dy_portrait?: number | null
}

/** Пропорции масок: во сколько раз высота больше ширины. */
export const SHAPE_RATIO: Record<CropShape, number> = {
  circle: 1,
  square: 1,
  portrait: 1.35,
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/** Приближение для формы. 1 — кадр как есть, голова целиком. */
export function zoomOf(shape: CropShape, s?: CropSettings | null): number {
  const v = num(s?.[`crop_zoom_${shape}` as keyof CropSettings], 1)
  return Math.max(1, Math.min(3, v))
}

/** Ручной сдвиг кадра в процентах размера маски. */
export function offsetOf(shape: CropShape, s?: CropSettings | null): { dx: number; dy: number } {
  return {
    dx: Math.max(-50, Math.min(50, num(s?.[`crop_dx_${shape}` as keyof CropSettings], 0))),
    dy: Math.max(-50, Math.min(50, num(s?.[`crop_dy_${shape}` as keyof CropSettings], 0))),
  }
}

/**
 * Стили для картинки внутри маски заданного размера.
 *
 * `maskW` и `maskH` — размер маски В ПИКСЕЛЯХ. Именно в пикселях: проценты
 * тут не годятся, потому что сдвиг зависит от того, насколько картинка больше
 * маски, а это считается только в реальных величинах.
 *
 * ⚠️ `natW`/`natH` — НАСТОЯЩИЕ пропорции фото (браузер знает их после
 * загрузки: `naturalWidth`/`naturalHeight`). Без них пришлось бы гадать, и
 * точка уезжала бы на снимках непривычного формата — горизонтальных или
 * квадратных. Не переданы — берём 3:4, самый частый портрет.
 */
export function cropStyle(
  shape: CropShape,
  focal: string | null | undefined,
  settings: CropSettings | null | undefined,
  maskW: number,
  maskH: number,
  natW?: number,
  natH?: number,
): React.CSSProperties {
  const { x: fx, y: fy } = parseFocal(focal)
  const zoom = zoomOf(shape, settings)
  const { dx, dy } = offsetOf(shape, settings)

  // Настоящие пропорции фото, если известны.
  const IW = natW && natH ? natW : 3
  const IH = natW && natH ? natH : 4
  // cover: картинка должна покрыть маску целиком.
  const base = Math.max(maskW / IW, maskH / IH)
  const W = IW * base * zoom
  const H = IH * base * zoom

  // Сдвигаем так, чтобы точка (fx, fy) оказалась в центре маски,
  // и добавляем ручной сдвиг клиента.
  const left = maskW / 2 - W * (fx / 100) + (dx / 100) * maskW
  const top = maskH / 2 - H * (fy / 100) + (dy / 100) * maskH

  return {
    position: 'absolute',
    width: W,
    height: H,
    left,
    top,
    // ⚠️ `cover` внутри самой картинки: её пропорции могут отличаться от
    // допущения 3:4, и без этого она растянулась бы.
    objectFit: 'cover',
    maxWidth: 'none',
  }
}
