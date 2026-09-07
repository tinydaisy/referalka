'use client'

/**
 * Шапка кабинета купившего — логотип и название бренда клиента.
 *
 * ⚠️ Нужна на всех экранах кабинета (`/my`, продукт, урок). Человек купил у
 * КОНКРЕТНОГО эксперта: без логотипа и имени кабинет выглядит безымянным
 * чужим сервисом, и непонятно, чьи это материалы.
 *
 * ⚠️ Логотип берём СВЕТЛУЮ версию (`brand_logo_light_url`), а фон шапки —
 * тёмный из темы клиента: основной логотип обычно белый и на белом фоне
 * сливается. Нет светлой версии — берём основную на тёмной подложке.
 */
import Link from 'next/link'

export interface Brand {
  name?: string | null
  brand_name?: string | null
  brand_logo_url?: string | null
  brand_logo_light_url?: string | null
  lp_bg_color?: string | null
  lp_bg_color_2?: string | null
  lp_color_heading?: string | null
}

export default function CabinetBrand({ brand, href = '/my', inSidebar = false }: {
  brand?: Brand | null
  /** Куда ведёт клик по логотипу. */
  href?: string
  /** Логотип стоит ВНУТРИ левой полосы меню (кабинет покупателя): свой фон и
   *  ограничение ширины тогда не нужны — их задаёт сама полоса. */
  inSidebar?: boolean
}) {
  const title = brand?.brand_name || brand?.name || ''
  const logo = brand?.brand_logo_url || brand?.brand_logo_light_url || ''
  const c1 = brand?.lp_bg_color || '#25455D'
  const c2 = brand?.lp_bg_color_2 || '#0a1520'
  const accent = brand?.lp_color_heading || '#FFCFA4'

  return (
    <div
      className="w-full"
      style={inSidebar
        ? undefined
        : { background: `linear-gradient(100deg, ${c1}, ${c2})` }}
    >
      <div className={`flex items-center gap-3 px-4 py-4 ${
        inSidebar ? '' : 'mx-auto max-w-3xl'}`}>
        <Link href={href} className="flex items-center gap-3 no-underline">
          {logo
            ? <img src={logo} alt={title} className="h-9 w-auto object-contain" />
            : (
              <span className="text-lg font-bold" style={{ color: accent }}>
                {title || 'Мои материалы'}
              </span>
            )}
          {logo && title && (
            <span className="hidden text-sm font-medium sm:inline"
                  style={{ color: accent }}>
              {title}
            </span>
          )}
        </Link>
      </div>
    </div>
  )
}
