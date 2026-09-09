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

export type CoverTemplate = {
  bg_url?: string | null
  bg_dim?: number
  logo_variant?: 'light' | 'dark' | 'none'
  photo_side?: 'left' | 'right' | 'none'
  photo_scale?: number
  photo_x?: number
  photo_y?: number
  text_x?: number
  text_y?: number
  text_w?: number
  text_align?: 'left' | 'center' | 'right'
  title_size?: number
  title_color?: string | null
  text_color?: string | null
  show_brand?: boolean
}

export type CoverTheme = {
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
  brand_name?: string | null
  name?: string | null
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
}: {
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
  const brand = th.brand_name || th.name || ''
  const logo = logoUrl(t, th)

  // ⚠️ Без фото текст идёт по центру во всю ширину: раскладка «текст справа»
  // при пустой левой половине выглядит как ошибка вёрстки.
  const tx = hasPhoto ? (t.text_x ?? 50) : 8
  const tw = hasPhoto ? (t.text_w ?? 45) : 84
  const align = hasPhoto ? (t.text_align || 'left') : 'center'

  const titleFont = `'${th.lp_font_heading || 'BebasNeue'}', 'Oswald', sans-serif`
  const bodyFont = `'${th.lp_font_body || 'Roboto'}', sans-serif`

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

      {/* Логотип бренда. Без фото — по центру над текстом, с фото — в углу со
          стороны текста, чтобы не наезжать на человека. */}
      {logo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          style={hasPhoto
            ? { position: 'absolute', top: 40, [t.photo_side === 'right' ? 'left' : 'right']: 56, height: 52, objectFit: 'contain' } as React.CSSProperties
            : { position: 'absolute', top: 48, left: 0, right: 0, height: 56, objectFit: 'contain', margin: '0 auto' }}
        />
      )}

      {/* Текстовый блок. */}
      <div style={{
        position: 'absolute',
        left: `${tx}%`,
        width: `${tw}%`,
        top: `${t.text_y ?? 50}%`,
        transform: 'translateY(-50%)',
        textAlign: align,
        fontFamily: bodyFont,
      }}>
        {!!overline && (
          <div style={{
            fontSize: 22, letterSpacing: 1.5, textTransform: 'uppercase',
            color: t.text_color || th.lp_color_body || '#FFFFFF',
            opacity: 0.85, marginBottom: 14,
          }}>{overline}</div>
        )}

        <div style={{
          fontFamily: titleFont,
          // Кегль в процентах ВЫСОТЫ полотна: на широком и узком тексте
          // заголовок остаётся одного размера, как задумано в шаблоне.
          fontSize: `${(t.title_size ?? 8) * COVER_H / 100}px`,
          lineHeight: 1.05,
          color: t.title_color || th.lp_color_heading || '#FFCFA4',
          // Длинное слово (ссылка, составной термин) иначе вылезает за край.
          overflowWrap: 'anywhere',
        }}>{title}</div>

        {!!subtitle && (
          <div style={{
            marginTop: 18, fontSize: 30,
            color: t.text_color || th.lp_color_body || '#FFFFFF',
          }}>{subtitle}</div>
        )}

        {t.show_brand !== false && !!brand && (
          <div style={{
            marginTop: 22, fontSize: 24, letterSpacing: 0.5,
            color: t.text_color || th.lp_color_body || '#FFFFFF', opacity: 0.75,
          }}>{brand}</div>
        )}
      </div>
    </div>
  )
}
