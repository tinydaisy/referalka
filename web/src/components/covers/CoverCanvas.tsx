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

import { brandFontCss, metallicTextStyle } from '@/lib/brandStyle'

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
  text_x?: number
  text_y?: number
  text_w?: number
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
  template: t, theme: th, title, subtitle, overline, photoUrl, logos, scale = 1,
  showGuides = false,
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
  /** Логотипы партнёров — рядком сверху (обложка спикера). */
  logos?: string[]
  /** Во сколько раз уменьшить на экране. В снимке всегда 1. */
  scale?: number
}) {
  const hasPhoto = !!photoUrl && t.photo_side !== 'none'

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

      {/* Фото на прозрачном фоне. Прижато к низу — человек «стоит» на обложке,
          а не висит в воздухе. */}
      {hasPhoto && (
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
      <div style={{
        position: 'absolute',
        left: `${tx}%`,
        width: `${tw}%`,
        top: `${t.text_y ?? 50}%`,
        transform: 'translateY(-50%)',
        textAlign: align,
        fontFamily: bodyFont,
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
        <div style={{ position: 'relative' }}>
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
          fontSize: `${(t.title_size ?? 8) * COVER_H / 100}px`,
          lineHeight: 1.05,
          // Длинное слово (ссылка, составной термин) иначе вылезает за край.
          overflowWrap: 'anywhere',
          ...(th.lp_heading_metallic !== false
            ? metallicTextStyle(t.title_color || th.lp_color_heading || '#FFCFA4')
            : { color: t.title_color || th.lp_color_heading || '#FFCFA4' }),
        }}>{title}</div>

        {!!subtitle && (
          <div style={{
            marginTop: 18, fontSize: 30,
            color: t.text_color || th.lp_color_body || '#FFFFFF',
          }}>{subtitle}</div>
        )}

        {t.brand_position !== 'above' && brandBlock}
        </div>
      </div>
    </div>
  )
}
