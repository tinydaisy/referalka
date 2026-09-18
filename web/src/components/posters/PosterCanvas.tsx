'use client'

/**
 * Полотно афиши события.
 *
 * ⚠️⚠️ ОДИН КОМПОНЕНТ НА ПРЕДПРОСМОТР И НА ФАЙЛ — ровно как у обложек
 * (`covers/CoverCanvas.tsx`). Картинку снимает headless-браузер с ЭТОЙ ЖЕ
 * вёрстки, поэтому «в предпросмотре одно, в скачанном другое» не бывает по
 * построению. Отдельного рисовальщика (canvas, Pillow) заводить нельзя: он
 * разойдётся с предпросмотром на переносах длинных фамилий и на кегле — а
 * фамилий на афише два десятка.
 *
 * ⚠️ ВСЁ В ПРОЦЕНТАХ полотна. На экране редактора полотно уменьшено, в снимке —
 * настоящего размера; в пикселях раскладка поехала бы.
 */

import { brandFontCss, metallicTextStyle } from '@/lib/brandStyle'
import { focalCssForPoster } from '@/lib/photoFocal'
import {
  applyManualOrder, splitRows, personLines, defaultPerRow,
  BADGE_LABELS, ORGANIZER_ROLES, type PosterPerson,
} from '@/lib/posterLayout'

export type PosterOrientation = 'horizontal' | 'vertical' | 'square'

/** Настоящий размер полотна. Снимок делается ровно в этих пикселях. */
export const POSTER_SIZE: Record<PosterOrientation, { w: number; h: number }> = {
  horizontal: { w: 1920, h: 1080 },
  vertical:   { w: 1080, h: 1920 },
  square:     { w: 1440, h: 1440 },
}

export type PosterLayout = {
  orientation: PosterOrientation
  bg_url?: string | null
  bg_dim?: number
  speakers_top?: number
  speakers_bottom?: number
  speakers_side?: number
  mask_shape?: 'portrait' | 'square' | 'circle' | 'oval' | 'egg' | 'cutout'
  mask_radius?: number
  per_row?: number | null
  gap?: number
  row_overlap?: number
  show_names?: boolean
  name_order?: 'first_last' | 'last_first'
  name_lines?: 1 | 2
  name_font?: string | null
  name_size?: number
  name_color?: string | null
  name_shadow?: boolean
  name_place?: 'below' | 'over'
  hl_style?: 'none' | 'border' | 'glow' | 'both'
  hl_color?: string | null
  hl_border_w?: number
  hl_glow?: number
  role_badge?: 'none' | 'pill' | 'ribbon' | 'suffix'
  role_badge_color?: string | null
  role_badge_text_color?: string | null
  title?: string | null
  subtitle?: string | null
  show_title?: boolean
  show_subtitle?: boolean
  title_font?: string | null
  title_size?: number
  title_color?: string | null
  title_metallic?: boolean
  title_underline?: 'none' | 'line' | 'gradient'
  title_align?: 'left' | 'center' | 'right'
  subtitle_font?: string | null
  subtitle_size?: number
  subtitle_color?: string | null
  subtitle_metallic?: boolean
  subtitle_underline?: 'none' | 'line' | 'gradient'
  subtitle_align?: 'left' | 'center' | 'right'
  text_top?: number
  show_pill?: boolean
  pill_text?: string | null
  pill_text_2?: string | null
  pill_style?: 'border' | 'filled' | 'underline' | 'plain'
  pill_radius?: number
  pill_border_color?: string | null
  pill_border_color_2?: string | null
  pill_border_w?: number
  pill_bg_color?: string | null
  pill_text_color?: string | null
  pill_font?: string | null
  pill_size?: number
  show_brand_logo?: boolean
  brand_logo_variant?: 'light' | 'dark'
  brand_logo_x?: number
  brand_logo_y?: number
  brand_logo_size?: number
  show_partners?: boolean
  partners_y?: number
  partners_size?: number
  speaker_order?: number[]
}

export type PosterTheme = {
  fonts?: { key: string; label: string }[]
  lp_bg_color?: string
  lp_bg_color_2?: string
  lp_bg_angle?: number
  lp_bg_gradient?: boolean
  lp_font_heading?: string
  lp_font_body?: string
  lp_color_heading?: string
  lp_color_body?: string
  brand_logo_url?: string | null
  brand_logo_light_url?: string | null
}

/** Золото бренда — запасной цвет выделения и заголовка. */
const GOLD = '#FFCFA4'

export default function PosterCanvas({
  layout: L, theme: th, people, scale = 1,
}: {
  layout: PosterLayout
  theme: PosterTheme
  /** Все люди события: организаторы, спикеры, партнёры. */
  people: PosterPerson[]
  /** Во сколько раз уменьшить на экране. В снимке всегда 1. */
  scale?: number
}) {
  const size = POSTER_SIZE[L.orientation] || POSTER_SIZE.vertical
  const { w: W, h: H } = size

  const label = (k?: string | null) => th.fonts?.find(f => f.key === k)?.label
  const gold = L.hl_color || th.lp_color_heading || GOLD

  // ⚠️ Кегли и отступы задаются в процентах, но CSS нужен px. Считаем от ШИРИНЫ
  // полотна: тогда на горизонтальной и вертикальной афише буква одного размера
  // относительно карточки, а не «на вертикальной вдвое мельче».
  const px = (percent: number) => (percent * W) / 100

  // Разделяем людей: партнёры-компании идут логотипами сверху, все остальные —
  // в сетку. Галочка `is_company` — единственный признак (миграция 425).
  const visible = people.filter(p => p.photo_url || p.cutout_photo_url)
  const companies = visible.filter(p => p.is_company)
  const persons = visible.filter(p => !p.is_company)

  // Организаторы — всегда отдельной строкой сверху блока людей.
  const organizers = persons.filter(p => ORGANIZER_ROLES.includes(p.role))
  const others = applyManualOrder(
    persons.filter(p => !ORGANIZER_ROLES.includes(p.role)),
    L.speaker_order || [],
  )

  const perRow = L.per_row || defaultPerRow(others.length, L.orientation)
  const rows = splitRows(others, perRow)

  const cutout = L.mask_shape === 'cutout'
  const sideGap = L.speakers_side ?? 5
  // ⚠️ Умолчание своё у каждого формата — как и на бэкенде (_TOP_BY_ORIENTATION).
  // Общие 45 % на горизонтальной афише оставляли людям треть высоты, и карточки
  // выходили втрое мельче, чем на макетах заказчика.
  const top = L.speakers_top ?? (L.orientation === 'horizontal' ? 33 : L.orientation === 'square' ? 38 : 45)
  const bottom = L.speakers_bottom ?? 97
  const gap = L.gap ?? 2

  // ⚠️⚠️ РАЗМЕР КАРТОЧКИ ОГРАНИЧЕН И ШИРИНОЙ, И ВЫСОТОЙ. Считать только по
  // ширине нельзя: на горизонтальной афише (1920×1080) под людей остаётся
  // всего около трети высоты полотна, и карточки, посчитанные по ширине,
  // вылезали за нижний край — на экране редактора их обрезало, а в снимке
  // часть спикеров просто пропадала. Берём меньшее из двух.
  const ratio = cutout ? 2.0 : shapeRatio(L.mask_shape)
  const avail = 100 - sideGap * 2
  // По ширине: промежутки вычитаем ДО деления, иначе ряд вылезет за края.
  const byWidth = (avail - gap * (perRow - 1)) / Math.max(1, perRow)

  // По высоте. Всё в процентах ШИРИНЫ полотна — в этих же единицах задан
  // `ratio`, поэтому высоту полотна переводим в них же.
  const hPctOfW = (H / W) * 100
  const rowsCount = rows.length + (organizers.length > 0 ? 1 : 0)
  // Наложение рядов уменьшает суммарную высоту — учитываем, иначе при плотной
  // группе вырезок карточки ужимались бы зря.
  const overlapK = cutout ? 1 - (L.row_overlap ?? 0) / 100 : 1
  const rowsK = Math.max(1, 1 + (rowsCount - 1) * overlapK)
  const availH = Math.max(1, (bottom - top)) / 100 * hPctOfW

  // ⚠️ Подпись и плашка роли занимают высоту СВЕРХ фото, и вычитать их как
  // фиксированную величину нельзя: на шести рядах они съедали всё место, и
  // карточка ужималась до ниточки — фото исчезало, оставались одни буквы.
  // Поэтому считаем их ДОЛЕЙ от карточки: мельче карточка — мельче подпись,
  // как и должно быть на афише.
  const nameShare = L.show_names === false || L.name_place === 'over'
    ? 0
    : 0.16 * (L.name_lines ?? 2)
  const badgeShare = (L.role_badge ?? 'pill') === 'pill' ? 0.14 : 0
  const rowUnit = ratio + nameShare + badgeShare   // полная высота ряда в долях ширины карточки

  const byHeight = Math.max(
    1,
    (availH - gap * (rowsCount - 1)) / (rowUnit * rowsK),
  )

  const cardW = Math.max(1, Math.min(byWidth, byHeight))
  const cardH = cardW * ratio
  // Кегль подписи: либо заданный клиентом, либо ужатый под карточку — иначе
  // на плотной сетке фамилии наезжают друг на друга.
  const nameSizeFit = Math.min(L.name_size ?? 1.6, cardW * 0.19)

  const bodyFont = brandFontCss(th.lp_font_body || 'Roboto', label(th.lp_font_body))

  return (
    <div
      data-poster-canvas
      style={{
        width: W, height: H, position: 'relative', overflow: 'hidden',
        // ⚠️ Масштабируем трансформом, а не размерами: вёрстка внутри остаётся
        // в тех же пикселях, что и в снимке, — переносы и кегль совпадут.
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: 'top left',
        fontFamily: bodyFont,
        ...bgStyle(L, th),
      }}
    >
      {/* Затемнение — только поверх своей картинки. */}
      {!!L.bg_url && (L.bg_dim ?? 0) > 0 && (
        <div style={{ position: 'absolute', inset: 0, background: `rgba(0,0,0,${(L.bg_dim ?? 0) / 100})` }} />
      )}

      {/* Логотипы партнёров-компаний — рядком сверху. */}
      {L.show_partners !== false && companies.length > 0 && (
        <div style={{
          position: 'absolute', left: `${sideGap}%`, right: `${sideGap}%`,
          top: `${L.partners_y ?? 5}%`,
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          gap: px(2.5), flexWrap: 'wrap',
        }}>
          {companies.map(c => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={c.id} src={c.photo_url || c.cutout_photo_url || ''} alt=""
                 style={{ height: px(L.partners_size ?? 5), objectFit: 'contain' }} />
          ))}
        </div>
      )}

      {/* Логотип бренда. Место задаёт клиент: фон у каждого свой, жёсткий угол
          наехал бы на рисунок фона или на логотипы партнёров. */}
      {L.show_brand_logo !== false && brandLogo(L, th) && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brandLogo(L, th)!} alt=""
             style={{
               position: 'absolute',
               left: `${L.brand_logo_x ?? 50}%`, top: `${L.brand_logo_y ?? 5}%`,
               transform: 'translate(-50%, -50%)',
               height: px(L.brand_logo_size ?? 6), objectFit: 'contain',
             }} />
      )}

      {/* Текстовый блок: пилюля, заголовок, подзаголовок. Всё можно выключить —
          тогда фон приезжает со своим готовым заголовком. */}
      <div style={{
        position: 'absolute', left: `${sideGap}%`, right: `${sideGap}%`,
        top: `${L.text_top ?? 18}%`,
      }}>
        {L.show_pill !== false && (L.pill_text || L.pill_text_2) && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: px(1.5), flexWrap: 'wrap', marginBottom: px(1.6) }}>
            {[L.pill_text, L.pill_text_2].filter(Boolean).map((txt, i) => (
              <Pill key={i} text={txt as string} L={L} px={px} gold={gold} font={brandFontCss(L.pill_font || th.lp_font_body, label(L.pill_font || th.lp_font_body))} />
            ))}
          </div>
        )}

        {L.show_title !== false && !!L.title && (
          <Heading
            text={L.title}
            align={L.title_align || 'center'}
            font={brandFontCss(L.title_font || th.lp_font_heading || 'BebasNeue', label(L.title_font || th.lp_font_heading))}
            sizePx={px(L.title_size ?? 6)}
            color={L.title_color || th.lp_color_heading || GOLD}
            metallic={L.title_metallic !== false}
            underline={L.title_underline || 'none'}
            px={px}
          />
        )}

        {L.show_subtitle !== false && !!L.subtitle && (
          <div style={{ marginTop: px(1.2) }}>
            <Heading
              text={L.subtitle}
              align={L.subtitle_align || 'center'}
              font={brandFontCss(L.subtitle_font || th.lp_font_body || 'Roboto', label(L.subtitle_font || th.lp_font_body))}
              sizePx={px(L.subtitle_size ?? 2.4)}
              color={L.subtitle_color || th.lp_color_body || '#FFFFFF'}
              metallic={!!L.subtitle_metallic}
              underline={L.subtitle_underline || 'none'}
              px={px}
            />
          </div>
        )}
      </div>

      {/* Блок людей. Начинается с заданной линии и растёт вниз. */}
      <div style={{
        position: 'absolute',
        left: `${sideGap}%`, right: `${sideGap}%`,
        top: `${top}%`,
        // ⚠️ Ограничиваем высоту и прячем лишнее: если спикеров больше, чем
        // влезает, они полезли бы за нижний край полотна и на снимке пропали бы
        // молча — клиент увидел бы это только в готовом файле.
        maxHeight: `${Math.max(5, bottom - top)}%`,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: cutout ? 0 : `${gap * W / 100}px`,
      }}>
        {/* Организаторы — сверху по центру, всегда отдельной строкой. */}
        {organizers.length > 0 && (
          <div style={{
            display: 'flex', justifyContent: 'center',
            gap: `${gap * W / 100}px`,
            marginBottom: cutout ? 0 : `${gap * W / 100}px`,
          }}>
            {organizers.map(p => (
              <PersonCard key={p.id} p={p} L={L} gold={gold} px={px} nameSize={nameSizeFit}
                          wPct={cardW} hPx={cardH * W / 100} highlighted theme={th} label={label} />
            ))}
          </div>
        )}

        {rows.map((row, ri) => (
          <div key={ri} style={{
            display: 'flex', justifyContent: 'center', alignItems: 'flex-end',
            gap: `${gap * W / 100}px`,
            // ⚠️ Наложение рядов — только у вырезанных людей: задний ряд
            // выглядывает из-за переднего, как в примере владельца. У карточек
            // с рамками это были бы наезжающие друг на друга прямоугольники.
            marginTop: ri > 0 && cutout ? `-${(L.row_overlap ?? 0) * cardH * W / 10000}px` : undefined,
            // Передние ряды поверх задних.
            position: 'relative', zIndex: ri + 1,
          }}>
            {row.map(p => (
              <PersonCard key={p.id} p={p} L={L} gold={gold} px={px} nameSize={nameSizeFit}
                          wPct={cardW} hPx={cardH * W / 100}
                          highlighted={p.role === 'headliner' || p.role === 'general_partner'}
                          theme={th} label={label} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Пропорция карточки (высота / ширина) по форме маски. */
function shapeRatio(shape?: string): number {
  switch (shape) {
    case 'square':   return 1
    case 'circle':   return 1
    case 'oval':     return 1.25
    case 'egg':      return 1.2
    default:         return 1.35   // portrait — вертикальный прямоугольник
  }
}

/** CSS-форма маски. */
function maskCss(L: PosterLayout): React.CSSProperties {
  switch (L.mask_shape) {
    case 'circle': return { borderRadius: '9999px' }
    case 'oval':   return { borderRadius: '50% / 50%' }
    // Яйцо: снизу круглее, сверху уже — несимметричное скругление.
    case 'egg':    return { borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%' }
    case 'cutout': return {}
    default:       return { borderRadius: `${L.mask_radius ?? 0}%` }
  }
}

function bgStyle(L: PosterLayout, th: PosterTheme): React.CSSProperties {
  if (L.bg_url) {
    return { backgroundImage: `url(${L.bg_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  }
  const c1 = th.lp_bg_color || '#25455D'
  const c2 = th.lp_bg_color_2 || '#0a1520'
  if (th.lp_bg_gradient === false) return { background: c1 }
  return { background: `linear-gradient(${th.lp_bg_angle ?? 45}deg, ${c1}, ${c2})` }
}

function brandLogo(L: PosterLayout, th: PosterTheme): string | null {
  if (L.brand_logo_variant === 'dark') return th.brand_logo_light_url || th.brand_logo_url || null
  return th.brand_logo_url || th.brand_logo_light_url || null
}

/** Заголовок с металлическим переливом и подчёркиванием. */
function Heading({ text, align, font, sizePx, color, metallic, underline, px }: {
  text: string
  align: 'left' | 'center' | 'right'
  font: string
  sizePx: number
  color: string
  metallic: boolean
  underline: 'none' | 'line' | 'gradient'
  px: (n: number) => number
}) {
  return (
    <div style={{ textAlign: align }}>
      <span style={{
        display: 'inline-block',
        fontFamily: font, fontSize: sizePx, lineHeight: 1.08,
        // Длинное слово иначе вылезает за край полотна.
        overflowWrap: 'anywhere',
        ...(metallic ? metallicTextStyle(color) : { color }),
        // Ровная линия — обычной рамкой снизу. Градиентная рисуется ОТДЕЛЬНЫМ
        // элементом ниже (на самом тексте свойство background уже занято
        // металлическим переливом, второй фон туда не положить).
        ...(underline === 'line' ? {
          paddingBottom: px(0.5),
          borderBottom: `${Math.max(2, px(0.15))}px solid ${color}`,
        } : {}),
      }}>{text}</span>
      {/* ⚠️ Градиентную линию рисуем ОТДЕЛЬНЫМ элементом: на самом тексте уже
          стоит градиент металла через background-clip, и второй фон туда не
          положить — они на одном свойстве. */}
      {underline === 'gradient' && (
        <div style={{
          height: Math.max(2, px(0.15)),
          margin: `${px(0.5)}px auto 0`,
          width: '55%',
          background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
        }} />
      )}
    </div>
  )
}

/** Пилюля с датой / форматом события. */
function Pill({ text, L, px, gold, font }: {
  text: string
  L: PosterLayout
  px: (n: number) => number
  gold: string
  font: string
}) {
  const style = L.pill_style || 'border'
  const textColor = L.pill_text_color || '#FFFFFF'
  const bw = Math.max(1, px(L.pill_border_w ?? 0.15))
  const c1 = L.pill_border_color || gold
  const c2 = L.pill_border_color_2

  const base: React.CSSProperties = {
    fontFamily: font, fontSize: px(L.pill_size ?? 1.8),
    color: textColor, lineHeight: 1.2,
    padding: `${px(0.6)}px ${px(1.6)}px`,
    display: 'inline-block', whiteSpace: 'nowrap',
  }

  if (style === 'plain') return <span style={{ ...base, padding: 0 }}>{text}</span>

  if (style === 'underline') {
    return (
      <span style={{ ...base, padding: `0 0 ${px(0.4)}px`, borderBottom: `${bw}px solid ${c1}` }}>{text}</span>
    )
  }

  if (style === 'filled') {
    return (
      <span style={{
        ...base,
        borderRadius: `${L.pill_radius ?? 50}px`,
        background: L.pill_bg_color || c1,
      }}>{text}</span>
    )
  }

  // border. ⚠️ Градиентная рамка делается ДВУМЯ слоями фона (внешний — градиент,
  // внутренний — свой фон), потому что CSS `border-color` градиент не принимает.
  const radius = `${L.pill_radius ?? 50}px`
  if (c2) {
    return (
      <span style={{
        display: 'inline-block', borderRadius: radius, padding: bw,
        background: `linear-gradient(90deg, ${c1}, ${c2})`,
      }}>
        <span style={{
          ...base, display: 'block', borderRadius: radius,
          background: L.pill_bg_color || 'rgba(0,0,0,0.35)',
        }}>{text}</span>
      </span>
    )
  }
  return (
    <span style={{
      ...base, borderRadius: radius,
      border: `${bw}px solid ${c1}`,
      background: L.pill_bg_color || 'transparent',
    }}>{text}</span>
  )
}

/** Карточка человека: фото в маске + подпись + выделение роли. */
function PersonCard({ p, L, gold, px, wPct, hPx, highlighted, theme, label, nameSize }: {
  p: PosterPerson
  L: PosterLayout
  gold: string
  px: (n: number) => number
  wPct: number
  hPx: number
  highlighted: boolean
  theme: PosterTheme
  label: (k?: string | null) => string | undefined
  /** Кегль подписи, уже ужатый под размер карточки (см. nameSizeFit). */
  nameSize: number
}) {
  const cutout = L.mask_shape === 'cutout'
  const hl = L.hl_style ?? 'border'
  const on = highlighted && hl !== 'none'
  const badge = L.role_badge ?? 'pill'
  const roleText = BADGE_LABELS[p.role]
  const showBadge = badge !== 'none' && !!roleText && highlighted

  // ⚠️ У вырезки своя точка лица: она кадрирована иначе, чем основное фото.
  const url = cutout ? (p.cutout_photo_url || p.photo_url) : (p.photo_url || p.cutout_photo_url)
  const focal = cutout ? (p.cutout_photo_focal || p.photo_focal) : p.photo_focal

  const lines = L.show_names === false ? [] : personLines(p, L.name_order || 'first_last', (L.name_lines || 2) as 1 | 2)
  const nameColor = L.name_color || theme.lp_color_body || '#FFFFFF'
  const nameFont = brandFontCss(L.name_font || theme.lp_font_body || 'Roboto', label(L.name_font || theme.lp_font_body))
  const borderW = Math.max(1, px(L.hl_border_w ?? 0.3))

  return (
    <div style={{ width: `${wPct}%`, position: 'relative', zIndex: on ? 3 : 1 }}>
      {/* ⚠️ МЕСТО ПОД ПЛАШКУ РЕЗЕРВИРУЕТСЯ У ВСЕХ, а не только у выделенных.
          Требование: имена всех людей стоят на ОДНОМ уровне. Плашка только у
          хедлайнера сдвинула бы его карточку вниз, и ряд поехал бы. */}
      {/* ⚠️ Размеры плашки считаем ОТ КАРТОЧКИ (`wPct`), а не от полотна: на
          плотной сетке из двадцати человек плашка фиксированного размера
          оказывалась шире самой карточки и наезжала на соседей. */}
      {badge === 'pill' && (
        <div style={{
          height: px(wPct * 0.14), marginBottom: px(wPct * 0.03),
          display: 'flex', justifyContent: 'center', alignItems: 'center',
        }}>
          {showBadge && (
            <span style={{
              fontFamily: nameFont,
              fontSize: px(Math.min(nameSize * 0.75, wPct * 0.1)), lineHeight: 1,
              padding: `${px(wPct * 0.025)}px ${px(wPct * 0.06)}px`,
              borderRadius: 9999,
              background: L.role_badge_color || gold,
              color: L.role_badge_text_color || '#1b2a36',
              whiteSpace: 'nowrap',
            }}>{roleText}</span>
          )}
        </div>
      )}

      {/* Рамка с фото. */}
      <div style={{
        position: 'relative', width: '100%', height: hPx,
        overflow: cutout ? 'visible' : 'hidden',
        ...maskCss(L),
        ...(!cutout && on && (hl === 'border' || hl === 'both')
          ? { border: `${borderW}px solid ${gold}` } : {}),
        ...(on && (hl === 'glow' || hl === 'both')
          ? { boxShadow: `0 0 ${px(L.hl_glow ?? 1.5)}px ${px((L.hl_glow ?? 1.5) / 3)}px ${gold}` } : {}),
        boxSizing: 'border-box',
      }}>
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt=""
               style={{
                 width: '100%', height: '100%',
                 // ⚠️ Вырезку НЕ режем (`contain`) и прижимаем к низу: человек
                 // стоит на афише, а не висит. Обычное фото — `cover` с точкой
                 // лица: правило «лицо не ниже середины карточки» вшито в
                 // focalCssForPoster.
                 objectFit: cutout ? 'contain' : 'cover',
                 objectPosition: cutout ? 'bottom center' : focalCssForPoster(focal),
                 // Свечение вырезки — по контуру человека, а не по прямоугольнику.
                 ...(cutout && on && (hl === 'glow' || hl === 'both')
                   ? { filter: `drop-shadow(0 0 ${px(L.hl_glow ?? 1.5)}px ${gold})` } : {}),
               }} />
        )}

        {/* Лента через угол — для прямоугольных карточек. */}
        {showBadge && badge === 'ribbon' && !cutout && (
          <div style={{
            position: 'absolute', top: hPx * 0.13, left: -hPx * 0.28,
            width: hPx * 0.9, transform: 'rotate(-45deg)',
            background: L.role_badge_color || gold,
            color: L.role_badge_text_color || '#1b2a36',
            fontFamily: nameFont, fontSize: px(Math.min(nameSize * 0.7, wPct * 0.09)), lineHeight: 1,
            padding: `${px(wPct * 0.025)}px 0`, textAlign: 'center', whiteSpace: 'nowrap',
          }}>{roleText}</div>
        )}

        {/* Подпись поверх нижнего края карточки. */}
        {L.name_place === 'over' && lines.length > 0 && (
          <NameBlock lines={lines} roleText={showBadge && badge === 'suffix' ? roleText : null}
                     L={L} px={px} font={nameFont} color={nameColor} size={nameSize}
                     style={{ position: 'absolute', left: 0, right: 0, bottom: px(wPct * 0.05) }} />
        )}
      </div>

      {/* Подпись под фото. */}
      {L.name_place !== 'over' && lines.length > 0 && (
        <NameBlock lines={lines} roleText={showBadge && badge === 'suffix' ? roleText : null}
                   L={L} px={px} font={nameFont} color={nameColor} size={nameSize}
                   style={{ marginTop: px(wPct * 0.06) }} />
      )}
    </div>
  )
}

function NameBlock({ lines, roleText, L, px, font, color, style, size }: {
  lines: string[]
  roleText: string | null
  L: PosterLayout
  px: (n: number) => number
  font: string
  color: string
  style?: React.CSSProperties
  /** Кегль, уже ужатый под карточку: на плотной сетке заданный клиентом
   *  размер не влез бы и фамилии наехали бы друг на друга. */
  size: number
}) {
  // ⚠️ Тень обязательна у вырезанных спикеров: подпись ложится прямо на людей
  // и фон, и на светлой одежде белые буквы пропадают.
  const shadow = L.name_shadow || L.mask_shape === 'cutout' || L.name_place === 'over'
  return (
    <div style={{
      textAlign: 'center', fontFamily: font, color,
      fontSize: px(size), lineHeight: 1.15,
      fontWeight: 700,
      // ⚠️ Тень — доля от КЕГЛЯ, а не фикс: на мелких подписях фиксированная
      // тень размазывала бы буквы в пятно.
      textShadow: shadow
        ? `0 ${px(size * 0.08)}px ${px(size * 0.22)}px rgba(0,0,0,0.85)`
        : undefined,
      overflowWrap: 'anywhere',
      ...style,
    }}>
      {lines.map((l, i) => (
        <div key={i}>
          {l}
          {/* Приписка роли через тире — на последней строке. */}
          {roleText && i === lines.length - 1 && (
            <span style={{ color: L.role_badge_color || undefined }}> — {roleText}</span>
          )}
        </div>
      ))}
    </div>
  )
}
