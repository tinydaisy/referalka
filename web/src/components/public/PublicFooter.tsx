/**
 * Футер публичных страниц ПЛЮСОНа — один на всё, что НЕ кабинет.
 *
 * ⚠️ В кабинет не попадает: он живёт под /dashboard со своим макетом.
 *
 * ⚠️ Тёмный фон — логотип и текст светлые. Фирменный градиент как в шапках
 * платформы: #25455D → #0a1520 под 45°.
 */
import Link from 'next/link'

const DARK = 'linear-gradient(45deg, #25455D, #0a1520)'
const PEACH = '#FFCFA4'

/**
 * ⚠️ «Модуль» в названии у Конференций и Премий/Турниров — это части
 * платформы. Коллабораторная без приставки: отдельный продукт со своим
 * каталогом и механикой.
 *
 * Страниц под решения пока нет — временно ведут на тарифы.
 */
const PRODUCTS = [
  { label: 'Тарифы', href: '/pricing' },
  { label: 'Модуль «Конференции»', href: '/pricing' },
  { label: 'Модуль «Премии/Турниры»', href: '/pricing' },
  { label: 'Коллабораторная', href: '/pricing' },
]

const COMPANY = [
  { label: 'Конференция «ВИДЕНИЕ / iViSiON»', href: '/pr/ivision-for-speakers' },
  { label: 'Партнёрская программа', href: '/register' },
]

export default function PublicFooter() {
  const year = new Date().getFullYear()

  return (
    <footer className="text-white mt-16" style={{ background: DARK }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-10">

          <div className="lg:col-span-1">
            <div className="font-bold text-lg">iViSiON: ПЛЮСОН</div>
            <p className="mt-2 text-sm text-white/60 leading-relaxed">
              Платформа для экспертов, спикеров и организаторов
            </p>
            <Link href="/register"
                  className="btn-gold inline-block mt-4 px-4 py-2.5 rounded-xl text-sm font-semibold">
              Попробовать бесплатно
            </Link>
          </div>

          <FooterColumn title="Продукты" links={PRODUCTS} />
          <FooterColumn title="Компания" links={COMPANY} />

          <div>
            <div className="text-xs font-bold uppercase tracking-wide mb-3" style={{ color: PEACH }}>
              Поддержка
            </div>
            <ul className="space-y-2">
              <li>
                <Link href="/help" className="text-sm text-white/70 hover:text-white">
                  База знаний
                </Link>
              </li>
              <li>
                <a href="https://telegram.me/pluson_bot?start=question"
                   target="_blank" rel="noopener noreferrer"
                   className="text-sm text-white/70 hover:text-white">
                  Написать в поддержку
                </a>
              </li>
              <li>
                <Link href="/sp/1" className="text-sm text-white/70 hover:text-white">
                  Каналы основателя
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Реквизиты. ⚠️ Обязательны: платформа принимает оплату и работает
            с персональными данными (152-ФЗ). */}
        <div className="mt-10 pt-6 border-t border-white/10 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-white/50">
          <span>© iViSiON: ПЛЮСОН, {year}</span>
          <span>ИП Сахибгареева М. В., ИНН 890306512862</span>
          <Link href="/offer" className="hover:text-white/80">Оферта</Link>
          <Link href="/privacy" className="hover:text-white/80">Политика конфиденциальности</Link>
        </div>
      </div>
    </footer>
  )
}

function FooterColumn({ title, links }: {
  title: string
  links: { label: string; href: string }[]
}) {
  return (
    <div>
      <div className="text-xs font-bold uppercase tracking-wide mb-3" style={{ color: PEACH }}>
        {title}
      </div>
      <ul className="space-y-2">
        {links.map(l => (
          <li key={l.label}>
            <Link href={l.href} className="text-sm text-white/70 hover:text-white">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
