'use client'

/**
 * Полотно обложки 1280×720.
 *
 * ⚠️⚠️ ОДИН КОМПОНЕНТ НА ПРЕДПРОСМОТР И НА ФАЙЛ. Картинку снимает браузер с той
 * же вёрстки, которую клиент видит на экране, — поэтому расхождения «в
 * предпросмотре одно, в скачанном файле другое» не бывает по построению.
 * Отдельного рисовальщика (Pillow, canvas) заводить нельзя: он неизбежно
 * разойдётся с предпросмотром на переносах строк и кегле.
 *
 * ⚠️ Размеры и координаты — в ПРОЦЕНТАХ полотна, а не в пикселях. Полотно на
 * экране масштабируется (в редакторе оно меньше 1280 px), и в пикселях всё
 * поехало бы. Проценты переживут и смену размера обложки.
 *
 * ⚠️ Шрифты — фирменные, из `/fonts/landing-fonts.css`. Страница, с которой
 * снимают картинку, обязана подключить этот файл, иначе в PNG попадёт запасной
 * шрифт: браузер ждёт `document.fonts.status === 'loaded'`, но грузит только
 * подключённое.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { brandFontCss, metallicTextStyle } from '@/lib/brandStyle'
import { cropStyle, type CropSettings, type CropShape } from '@/lib/photoCrop'

export type CoverTemplate = {
  bg_url?: string | null
  bg_dim?: number
  logo_variant?: 'light' | 'dark' | 'none'
  logo_size?: number
  logo_x?: number
  logo_y?: number
  photo_side?: 'left' | 'right' | 'none'
  photo_scale?: number
  photo_x?: number
  photo_y?: number
  /** Форма кадра. `cutout` — фото во всю высоту (верно для вырезок). */
  photo_shape?: 'cutout' | 'portrait' | 'square' | 'circle' | 'oval'
  /** Ширина фигуры, % полотна. Для `cutout` не применяется. */
  photo_w?: number
  photo_radius?: number
  /** Растушёвка края в сторону текста, % ширины фигуры. */
  photo_fade?: number
  text_x?: number
  text_y?: number
  text_w?: number
  /** Высота области текста, % полотна. 0 — не ограничивать. */
  text_h?: number
  /** Ужимать содержимое, если не помещается в область. */
  text_fit?: boolean
  text_align?: 'left' | 'center' | 'right'
  /** Подложка под текстом. Пусто — текста лежит прямо на фоне. */
  text_bg_color?: string | null
  text_bg_color_2?: string | null
  text_bg_angle?: number
  text_bg_opacity?: number
  text_bg_radius?: number
  text_bg_pad?: number
  text_border_color?: string | null
  text_border_width?: number
  title_size?: number
  /** Кегль темы выступления, % высоты полотна (4.2% ≈ 30px при 720px). */
  subtitle_size?: number
  /** Сколько строк темы показывать; дальше многоточие. 0 — без предела. */
  subtitle_lines?: number
  title_color?: string | null
  text_color?: string | null
  show_brand?: boolean
  show_owner_name?: boolean
  show_brand_name?: boolean
  brand_position?: 'above' | 'below' | 'none'
}

export type CoverTheme = {
  /** Справочник шрифтов (`fonts` из /clients/me/landing-theme) — нужен, чтобы
   *  превратить ключ `PlayfairDisplay` в семейство «Playfair Display». */
  fonts?: { key: string; label: string }[]
  lp_bg_color?: string
  lp_bg_color_2?: string
  lp_bg_angle?: number
  lp_bg_gradient?: boolean
  lp_font_heading?: string
  lp_font_body?: string
  lp_color_heading?: string
  /** Металлический перелив на заголовках — та же галочка, что на лендинге. */
  lp_heading_metallic?: boolean
  lp_color_body?: string
  /** Вырезка самого клиента — образец для предпросмотра. */
  sample_photo_url?: string | null
  brand_logo_url?: string | null
  brand_logo_light_url?: string | null
  brand_name?: string | null
  name?: string | null
  last_name?: string | null
}

export const COVER_W = 1280
export const COVER_H = 720

/** Фон: своя картинка либо градиент темы. */
function bgStyle(t: CoverTemplate, th: CoverTheme): React.CSSProperties {
  if (t.bg_url) {
    return { backgroundImage: `url(${t.bg_url})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  }
  const c1 = th.lp_bg_color || '#25455D'
  const c2 = th.lp_bg_color_2 || '#0a1520'
  // Градиент выключен в теме → ровная заливка первым цветом, как на лендинге.
  if (th.lp_bg_gradient === false) return { background: c1 }
  return { background: `linear-gradient(${th.lp_bg_angle ?? 45}deg, ${c1}, ${c2})` }
}

/** Какой логотип показать. Пусто у светлого → берём основной (он же тёмный фон). */
function logoUrl(t: CoverTemplate, th: CoverTheme): string | null {
  if (t.logo_variant === 'none') return null
  if (t.logo_variant === 'dark') return th.brand_logo_light_url || th.brand_logo_url || null
  return th.brand_logo_url || th.brand_logo_light_url || null
}

export default function CoverCanvas({
  template: t, theme: th, title, subtitle, overline, photoUrl, photoCrop,
  logos, scale = 1, showGuides = false,
}: {
  /** ⚠️ СЛУЖЕБНАЯ разметка области текста (красный пунктир) — ТОЛЬКО экран
   *  редактора. В снимок она не попадает: страница отрисовки её не включает,
   *  и в шаблоне этот признак не хранится. Иначе однажды клиент получил бы
   *  готовый файл с пунктиром поверх обложки. */
  showGuides?: boolean
  template: CoverTemplate
  theme: CoverTheme
  /** Главная строка: название материала или Имя Фамилия. */
  title: string
  /** Под заголовком: роль спикера, название бренда. */
  subtitle?: string | null
  /** Над заголовком: название конференции. */
  overline?: string | null
  /** Фото на прозрачном фоне. Нет — текст встаёт по центру полотна. */
  photoUrl?: string | null
  /** Кадр фото: точка лица, приближение, сдвиг — из карточки человека.
   *  ⚠️ Без него фото вставало как есть, и отмеченная точка лица не работала:
   *  на обложках лица оказывались обрезанными (26.09.2026). */
  photoCrop?: (CropSettings & {
    photo_focal?: string | null
    cutout_photo_focal?: string | null
  }) | null
  /** Логотипы партнёров — рядком сверху (обложка спикера). */
  logos?: string[]
  /** Во сколько раз уменьшить на экране. В снимке всегда 1. */
  scale?: number
}) {
  const hasPhoto = !!photoUrl && t.photo_side !== 'none'

  // ── Автоподгон под область ────────────────────────────────────────────────
  // ⚠️⚠️ ИЗМЕРЯЕМ ГОТОВУЮ ВЁРСТКУ, а не считаем длину строки в символах.
  // Посчитать «влезет ли» арифметикой нельзя: перенос по словам, кернинг и
  // ширина глифов у фирменного шрифта известны только браузеру. Поэтому
  // рисуем как есть, меряем и ужимаем, если вылезло.
  //
  // ⚠️ `useLayoutEffect` — до отрисовки на экран: с обычным `useEffect`
  // Chromium успел бы снять кадр с ещё неподогнанным текстом.
  const boxRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(1)
  const wantFit = !!t.text_fit && (t.text_h ?? 0) > 0

  // Сбрасываем подгон, когда меняется то, от чего она зависит: иначе при
  // правке ползунка коэффициент остался бы от прошлого текста.
  useEffect(() => { setFit(1) }, [
    title, subtitle, overline, t.text_h, t.text_w, t.title_size,
    t.subtitle_size, t.subtitle_lines, t.text_bg_pad, wantFit,
  ])

  useLayoutEffect(() => {
    if (!wantFit) { if (fit !== 1) setFit(1); return }
    const box = boxRef.current, inner = innerRef.current
    if (!box || !inner) return
    const avail = box.clientHeight
    const need = inner.scrollHeight
    if (!avail || !need) return
    // ⚠️ Шаг подгона делаем ОДИН за проход и через состояние: подгонять в
    // цикле внутри эффекта нельзя — браузер не пересчитает раскладку, пока не
    // отдаст кадр, и все замеры вернут одно и то же число.
    if (need > avail + 1 && fit > 0.45) {
      // ⚠️ Запас 0.98: ужимаем чуть сильнее, чем «впритык». Ровно в размер
      // текст упирается в кромку области, и это читается как обрезка.
      setFit(f => Math.max(0.45, f * Math.min(0.98, (avail / need) * 0.98)))
    }
  })

  // ⚠️ Шрифты приезжают ПОСЛЕ первой отрисовки, и с запасным шрифтом замер
  // врёт: подогнали бы под Arial, а сняли кадр с Bebas Neue.
  useEffect(() => {
    if (!wantFit || typeof document === 'undefined' || !document.fonts) return
    document.fonts.ready.then(() => setFit(1)).catch(() => {})
  }, [wantFit])

  // ⚠️ Две ОТДЕЛЬНЫЕ строки, а не одна склеенная: клиент выбирает галочками,
  // что показать — имя, бренд, обе или ничего. Союз «и» между ними не ставим,
  // это подписи, а не перечисление.
  const ownerName = [th.name, th.last_name].filter(Boolean).join(' ')
  const brandLines = t.brand_position === 'none' ? [] : [
    ...(t.show_owner_name ? [ownerName] : []),
    // Старая одиночная галочка `show_brand` — для шаблонов, сохранённых до
    // появления двух: без неё у них бренд пропал бы молча.
    ...((t.show_brand_name ?? t.show_brand) !== false ? [th.brand_name || ''] : []),
  ].filter(Boolean)
  const logo = logoUrl(t, th)

  // ⚠️ Текст встаёт с ПРОТИВОПОЛОЖНОЙ стороны от фото. Клиент двигает фото
  // вправо — текст обязан уйти влево сам, иначе они наложатся друг на друга и
  // обложка станет нечитаемой. Отступ считаем от того края, у которого текст.
  // ⚠️ Без фото — по центру во всю ширину: раскладка «текст справа» при пустой
  // левой половине выглядит как ошибка вёрстки.
  const photoRight = t.photo_side === 'right'
  const tw = hasPhoto ? (t.text_w ?? 45) : 84
  const tx = hasPhoto
    ? (photoRight ? Math.min(t.text_x ?? 6, 100 - tw) : (t.text_x ?? 50))
    : 8
  const align = hasPhoto ? (t.text_align || 'left') : 'center'

  // ⚠️ Через общий хелпер, а не подстановкой ключа: в теме лежит `BebasNeue`,
  // а семейство в CSS называется «Bebas Neue». Ключ как есть браузер не найдёт
  // и молча нарисует запасным шрифтом.
  const label = (k?: string | null) => th.fonts?.find(f => f.key === k)?.label
  // Сами подписи. ⚠️ Отступ зависит от места: над названием он снизу, под —
  // сверху, иначе строки слипаются с заголовком.
  const brandBlock = brandLines.length > 0 ? (
    <div style={{
      [t.brand_position === 'above' ? 'marginBottom' : 'marginTop']: 20,
      fontSize: 24, letterSpacing: 0.5, lineHeight: 1.35,
      color: t.text_color || th.lp_color_body || '#FFFFFF', opacity: 0.75,
    }}>
      {brandLines.map((line, i) => <div key={i}>{line}</div>)}
    </div>
  ) : null

  const titleFont = brandFontCss(th.lp_font_heading || 'BebasNeue', label(th.lp_font_heading))
  const bodyFont = brandFontCss(th.lp_font_body || 'Roboto', label(th.lp_font_body))

  return (
    <div
      data-cover-canvas
      style={{
        width: COVER_W, height: COVER_H, position: 'relative', overflow: 'hidden',
        // ⚠️ Масштабируем ТРАНСФОРМОМ, а не меняем размеры: вёрстка внутри
        // остаётся в тех же пикселях, что и в снимке, — значит переносы строк
        // и кегль совпадут ровно.
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: 'top left',
        ...bgStyle(t, th),
      }}
    >
      {/* Затемнение — только поверх своей картинки: градиент темы и так тёмный. */}
      {!!t.bg_url && (t.bg_dim ?? 0) > 0 && (
        <div style={{
          position: 'absolute', inset: 0,
          background: `rgba(0,0,0,${(t.bg_dim ?? 0) / 100})`,
        }} />
      )}

      {/* Логотипы партнёров — рядком сверху по центру (обложка спикера). */}
      {!!logos?.length && (
        <div style={{
          position: 'absolute', top: 32, left: 0, right: 0,
          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 28,
        }}>
          {logos.slice(0, 6).map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={u} alt="" style={{ height: 44, objectFit: 'contain' }} />
          ))}
        </div>
      )}

      {/* Фото.
          ⚠️ `cutout` — прежнее поведение: снимок во всю высоту, прижат к низу,
          человек «стоит» на обложке. Верно для вырезки на прозрачном фоне.

          ⚠️⚠️ ОСТАЛЬНЫЕ ФОРМЫ — ДЛЯ ОБЫЧНЫХ СНИМКОВ (25.09.2026). Вырезка есть
          хорошо если у половины спикеров (на событии 89 — у 9 из 18). У
          прямоугольного фото прозрачного фона нет, и во всю высоту оно
          закрывает свою половину полотна целиком — текст ложится прямо на
          фотографию. В фигуре снимок занимает ровно отведённое место, и
          область текста остаётся свободной. Тот же приём, что в афишах. */}
      {hasPhoto && (t.photo_shape ?? 'cutout') === 'cutout' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl!}
          alt=""
          style={{
            position: 'absolute', bottom: 0,
            [t.photo_side === 'right' ? 'right' : 'left']: `${t.photo_x ?? 0}%`,
            height: `${(t.photo_scale ?? 100) * 0.95}%`,
            transform: `translateY(${-(t.photo_y ?? 0)}%)`,
            objectFit: 'contain',
          } as React.CSSProperties}
        />
      )}

      {hasPhoto && (t.photo_shape ?? 'cutout') !== 'cutout' && (() => {
        const shape = t.photo_shape!
        const w = t.photo_w ?? 38
        // Пропорции те же, что у масок афиш: портрет выше ширины, квадрат
        // ровный, круг ровный, овал слегка вытянут.
        const ratio = shape === 'portrait' ? 1.35 : shape === 'oval' ? 1.25 : 1
        const h = w * COVER_W / COVER_H * ratio
        const radius = shape === 'circle' || shape === 'oval'
          ? '50%'
          : `${t.photo_radius ?? 0}%`
        const fade = t.photo_fade ?? 0
        // ⚠️ Растушёвка идёт В СТОРОНУ ТЕКСТА: фото справа — гаснет левый край,
        // и наоборот. Гасить не с той стороны значит стереть край у рамки
        // полотна, где и так ничего нет.
        const fadeSide = t.photo_side === 'right' ? 'to left' : 'to right'
        const maskImage = fade > 0
          ? `linear-gradient(${fadeSide}, #000 ${100 - fade}%, transparent 100%)`
          : undefined
        // ⚠️⚠️ КАДР СЧИТАЕТСЯ ОБЩИМ `cropStyle`, а не `objectPosition`
        // (26.09.2026). Здесь стояло `objectPosition: center top` — грубое
        // допущение «лицо всегда сверху». На деле точка лица отмечена в
        // карточке у каждого (у Катии Шведовой ещё и зум 3.0), и обложка её
        // игнорировала: лица обрезались, фото вставали вразнобой. Тот же
        // расчёт, что на афишах и в карточке, — иначе клиент настроит кадр в
        // одном месте, а на обложке получит другое.
        //
        // ⚠️ Форма для кадра берётся ближайшая из трёх, под которые кадр
        // настраивают: круг и овал → circle, портрет → portrait, квадрат →
        // square. Своих настроек у «овала» в карточке нет, и заводить их
        // значило бы пять ползунков вместо трёх.
        const cropShape: CropShape =
          shape === 'circle' || shape === 'oval' ? 'circle'
            : shape === 'portrait' ? 'portrait' : 'square'
        // Размер фигуры В ПИКСЕЛЯХ — `cropStyle` считает сдвиг в реальных
        // величинах, в процентах это посчитать нельзя.
        const maskW = w * COVER_W / 100
        const maskH = h * COVER_H / 100
        // ⚠️ У вырезки своя точка лица: она кадрирована иначе, чем основной
        // снимок. Правило то же, что в афишах.
        const focal = photoCrop?.cutout_photo_focal || photoCrop?.photo_focal
        // ⚠️⚠️ ЗУМ ИЗ КАРТОЧКИ НЕ БЕРЁМ — ТОЛЬКО ТОЧКУ ЛИЦА (26.09.2026).
        // Сначала я множил зум карточки на ползунок «Размер», и обложка Катии
        // Шведовой вышла хуже прежнего: лицо во весь кадр, фон полосой по
        // краям. Причина в смысле самого числа — зум в карточке отвечает на
        // вопрос «насколько приблизить, чтобы лицо заполнило МАЛЕНЬКИЙ
        // КРУЖОК-АВАТАРКУ», и у Катии там стоит 3.0 (максимум ползунка). На
        // крупной фигуре обложки то же значение превращает портрет в
        // лицо-крупным-планом.
        //
        // Точка лица переносится, а приближение — нет: точка отвечает на
        // вопрос «ЧТО должно быть в центре» и верна для любого размера, зум
        // же привязан к размеру той рамки, под которую его крутили.
        // Приближение на обложке задаёт ползунок «Размер» в шаблоне — один
        // на всех, поэтому люди и выглядят единообразно.
        const settings: CropSettings = {
          [`crop_zoom_${cropShape}`]: (t.photo_scale ?? 100) / 100,
          // Ручной сдвиг из карточки тоже не переносим: он задан в процентах
          // ТОЙ рамки и на другой пропорции увёл бы кадр вбок.
        }
        return (
          <div style={{
            position: 'absolute',
            [t.photo_side === 'right' ? 'right' : 'left']: `${t.photo_x ?? 0}%`,
            top: '50%',
            width: `${w}%`,
            height: `${h}%`,
            transform: `translateY(calc(-50% - ${t.photo_y ?? 0}%))`,
            borderRadius: radius,
            overflow: 'hidden',
            ...(maskImage ? {
              maskImage, WebkitMaskImage: maskImage,
            } : {}),
          } as React.CSSProperties}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoUrl!}
              alt=""
              style={cropStyle(cropShape, focal, settings, maskW, maskH)}
            />
          </div>
        )
      })()}

      {/* Логотип бренда. ⚠️ Положение задаёт клиент: фон у каждого свой, и в
          жёстком углу логотип наезжал бы на рисунок или на лицо человека.
          Координаты — центр логотипа, поэтому сдвигаем на половину себя. */}
      {logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          style={{
            position: 'absolute',
            left: `${t.logo_x ?? 88}%`,
            top: `${t.logo_y ?? 6}%`,
            transform: 'translate(-50%, -50%)',
            height: `${(t.logo_size ?? 7) * COVER_H / 100}px`,
            objectFit: 'contain',
          }}
        />
      )}

      {/* Текстовый блок.
          ⚠️ Подложка и рамка рисуются НА ЭТОМ ЖЕ элементе, а не отдельным
          слоем под ним: отдельный слой пришлось бы держать одного размера с
          текстом вручную, и он разъезжался бы на длинных названиях, которые
          переносятся на лишнюю строку. */}
      <div ref={boxRef} style={{
        position: 'absolute',
        left: `${tx}%`,
        width: `${tw}%`,
        top: `${t.text_y ?? 50}%`,
        transform: 'translateY(-50%)',
        textAlign: align,
        fontFamily: bodyFont,
        // ⚠️⚠️ ОБЛАСТЬ ОГРАНИЧИВАЛА ТОЛЬКО ШИРИНУ (25.09.2026). По высоте блок
        // центрировался по `text_y` и рос в обе стороны без предела — поэтому
        // на длинной теме «заданная область» переставала что-либо задавать, и
        // текст уезжал на фото. `text_h = 0` — прежнее поведение: у уже
        // сохранённых шаблонов вид не меняется.
        ...((t.text_h ?? 0) > 0 ? {
          height: `${t.text_h}%`,
          // ⚠️ `hidden`, а не `visible`: иначе ограничение чисто декоративное —
          // содержимое просто вылезет за рамку, как и раньше.
          overflow: 'hidden' as const,
          display: 'flex',
          flexDirection: 'column' as const,
          // Содержимое прижато к центру области — так надпись не липнет к
          // верхней кромке, когда текста меньше, чем места.
          justifyContent: 'center' as const,
          boxSizing: 'border-box' as const,
        } : {}),
        // Подложка: один цвет или градиент двумя. Пусто — ничего не рисуем.
        ...(t.text_bg_color ? {
          background: t.text_bg_color_2
            ? `linear-gradient(${t.text_bg_angle ?? 135}deg, ${t.text_bg_color}, ${t.text_bg_color_2})`
            : t.text_bg_color,
          // ⚠️ Прозрачность — у ПОДЛОЖКИ, а не у всего блока: `opacity` на
          // элементе погасил бы и текст вместе с ней.
          opacity: undefined,
        } : {}),
        ...(t.text_bg_color && (t.text_bg_opacity ?? 100) < 100
          ? { backgroundColor: undefined } : {}),
        ...(t.text_border_width ? {
          border: `${t.text_border_width}px solid ${t.text_border_color || '#FFFFFF'}`,
        } : {}),
        ...(t.text_bg_color || t.text_border_width ? {
          borderRadius: `${(t.text_bg_radius ?? 0) * 1280 / 100}px`,
          padding: `${(t.text_bg_pad ?? 0) * 1280 / 100}px`,
          // ⚠️ Отступ добавляет ширины: без коробочной модели border-box
          // блок вылез бы за отведённую область и наехал на фото.
          boxSizing: 'border-box' as const,
        } : {}),
      }}>
        {/* ⚠️ Прозрачную подложку рисуем ОТДЕЛЬНЫМ слоем позади текста:
            свойство `opacity` на самом блоке погасило бы и надписи. */}
        {t.text_bg_color && (t.text_bg_opacity ?? 100) < 100 && (
          <div style={{
            position: 'absolute', inset: 0,
            borderRadius: `${(t.text_bg_radius ?? 0) * 1280 / 100}px`,
            background: t.text_bg_color_2
              ? `linear-gradient(${t.text_bg_angle ?? 135}deg, ${t.text_bg_color}, ${t.text_bg_color_2})`
              : t.text_bg_color,
            opacity: (t.text_bg_opacity ?? 100) / 100,
            pointerEvents: 'none',
          }} />
        )}
        {/* Служебная разметка области — только в редакторе. */}
        {showGuides && (
          <div style={{
            position: 'absolute', inset: 0,
            border: '2px dashed #EF4444',
            borderRadius: `${(t.text_bg_radius ?? 0) * 1280 / 100}px`,
            pointerEvents: 'none',
          }} />
        )}
        <div ref={innerRef} style={{ position: 'relative' }}>
        {t.brand_position === 'above' && brandBlock}

        {!!overline && (
          <div style={{
            fontSize: 22, letterSpacing: 1.5, textTransform: 'uppercase',
            color: t.text_color || th.lp_color_body || '#FFFFFF',
            opacity: 0.85, marginBottom: 14,
          }}>{overline}</div>
        )}

        {/* ⚠️ Металл берётся из ТЕМЫ (галочка «Металлический градиент на
            заголовках»), а не настраивается отдельно: заголовок обложки и
            заголовок лендинга — одно фирменное оформление, две галочки
            разъехались бы. Свой цвет заголовка металл не отменяет — перелив
            строится из него же. */}
        <div style={{
          fontFamily: titleFont,
          // Кегль в процентах ВЫСОТЫ полотна: на широком и узком тексте
          // заголовок остаётся одного размера, как задумано в шаблоне.
          fontSize: `${(t.title_size ?? 8) * COVER_H / 100 * fit}px`,
          lineHeight: 1.05,
          // Длинное слово (ссылка, составной термин) иначе вылезает за край.
          overflowWrap: 'anywhere',
          ...(th.lp_heading_metallic !== false
            ? metallicTextStyle(t.title_color || th.lp_color_heading || '#FFCFA4')
            : { color: t.title_color || th.lp_color_heading || '#FFCFA4' }),
        }}>{title}</div>

        {/* Тема выступления.
            ⚠️⚠️ КЕГЛЬ ИЗ ШАБЛОНА, а не число в коде (25.09.2026). Здесь стояло
            `fontSize: 30`, и поправить размер темы было нечем: в конструкторе
            настраивался только заголовок. Тема у спикера длинная — в отличие
            от образца «спикер» в предпросмотре, — поэтому на реальных данных
            она вылезала за область и ложилась на фото.
            ⚠️ Предел по строкам обрезает многоточием: тема бывает на три
            предложения, и без предела она растянет блок на всю обложку. */}
        {!!subtitle && (
          <div style={{
            marginTop: 18 * fit,
            fontSize: `${(t.subtitle_size ?? 4.2) * COVER_H / 100 * fit}px`,
            lineHeight: 1.25,
            color: t.text_color || th.lp_color_body || '#FFFFFF',
            overflowWrap: 'anywhere',
            ...((t.subtitle_lines ?? 0) > 0 ? {
              display: '-webkit-box',
              WebkitLineClamp: t.subtitle_lines,
              WebkitBoxOrient: 'vertical' as const,
              overflow: 'hidden',
            } : {}),
          }}>{subtitle}</div>
        )}

        {t.brand_position !== 'above' && brandBlock}
        </div>
      </div>
    </div>
  )
}
