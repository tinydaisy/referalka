/**
 * Футер публичных страниц ПЛЮСОНа — один на всё, что НЕ кабинет.
 *
 * ⚠️ В кабинет не попадает: он живёт под /dashboard со своим макетом.
 *
 * ⚠️ Тёмный фон — логотип и текст светлые. Фирменный градиент как в шапках
 * платформы: #25455D → #0a1520 под 45°.
 */
import Link from 'next/link'
import { BRAND_NAME, BRAND_TAGLINE } from '@/lib/brand'

const DARK = 'linear-gradient(45deg, #25455D, #0a1520)'
const PEACH = '#FFCFA4'

/**
 * ⚠️ «Модуль» в названии у Конференций и Премий/Турниров — это части
 * платформы. Коллабораторная без приставки: отдельный продукт со своим
 * каталогом и механикой.
 *
 * ⚠️ Отдельной страницы /pricing пока НЕТ — ведём на якорь блока тарифов
 * на главной. Появится страница — правим здесь и в шапке.
 */
const TARIFFS_HREF = '/#tariffs'

const PRODUCTS = [
  { label: 'Тарифы', href: TARIFFS_HREF },
  { label: 'Модуль «Конференции»', href: TARIFFS_HREF },
  { label: 'Модуль «Премии/Турниры»', href: TARIFFS_HREF },
  { label: 'Коллабораторная', href: TARIFFS_HREF },
]

/**
 * Каналы основателя. Своих каналов у платформы нет — есть каналы Марго Форбс,
 * так и подписано.
 *
 * ⚠️ Ссылки ведут В САМИ КАНАЛЫ, а не на страницу о них: человек, дочитавший
 * до футера, хочет подписаться, а не изучать материалы для организаторов.
 */
const CHANNELS = [
  { label: 'Telegram', href: 'https://telegram.me/+SXbkuWsH5ANhMzJi', icon: TelegramIcon },
  { label: 'ВКонтакте', href: 'https://vk.com/ivision_community', icon: VkIcon },
  { label: 'MAX', href: 'https://max.ru/id890306512862_biz', icon: MaxIcon },
  { label: 'YouTube', href: 'https://www.youtube.com/@margarita_forbs', icon: YoutubeIcon },
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
            <div className="flex items-center gap-2.5">
              {/* ⚠️ Белый вариант: фон тёмный, синий логотип на нём не виден. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/logo_no_ivision_wwhite.png" alt="" className="h-8 w-auto" />
              <span className="font-bold text-lg">{BRAND_NAME}</span>
            </div>
            <p className="mt-2 text-sm text-white/60 leading-relaxed">
              {BRAND_TAGLINE}
            </p>
            <Link href="/register"
                  className="inline-block mt-4 px-4 py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-90"
                  style={{ background: PEACH, color: '#25455D' }}>
              Попробовать бесплатно
            </Link>

            <div className="mt-6">
              <div className="text-xs text-white/40 mb-2">Каналы основателя</div>
              <div className="flex items-center gap-2">
                {CHANNELS.map(c => (
                  <a key={c.label} href={c.href} target="_blank" rel="noopener noreferrer"
                     title={c.label} aria-label={c.label}
                     className="w-9 h-9 rounded-lg flex items-center justify-center bg-white/10 hover:bg-white/20 transition-colors">
                    <c.icon />
                  </a>
                ))}
              </div>
            </div>
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
                {/* ⚠️ Ведём на страницу ВЫБОРА, а не на конкретного бота:
                    поддержка работает в двух мессенджерах — Telegram и MAX. */}
                <Link href="/support" className="text-sm text-white/70 hover:text-white">
                  Написать в поддержку
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

/* Иконки соцсетей. У lucide-react из этих есть только YouTube, а Telegram,
   ВКонтакте и MAX там нет — рисуем сами, чтобы не тянуть зависимость. */

function TelegramIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-white/80">
      <path d="M21.9 4.3 18.6 20c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1L18.1 6c.4-.4-.1-.6-.6-.2L6.1 12.9l-4.9-1.5c-1.1-.3-1.1-1 .2-1.5l19.2-7.4c.9-.3 1.6.2 1.3 1.8z"/>
    </svg>
  )
}

function VkIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" className="text-white/80">
      <path d="M12.8 16.7c-5.4 0-8.9-3.8-9-10h2.7c.1 4.6 2.2 6.5 3.8 6.9V6.7h2.6v3.9c1.6-.2 3.2-2 3.8-3.9h2.5c-.4 2.3-2.1 4.1-3.3 4.9 1.2.6 3.1 2.2 3.8 5.1h-2.8c-.6-1.8-2-3.2-4-3.5v3.5h-.1z"/>
    </svg>
  )
}

function MaxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-white/80">
      <path d="M3 20V4h3.2l5.8 9.3L17.8 4H21v16h-2.9V9.4l-5.2 8.1h-1.8L5.9 9.4V20H3z"/>
    </svg>
  )
}

function YoutubeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" className="text-white/80">
      <path d="M21.6 7.2c-.2-.9-.9-1.6-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4c-.9.2-1.6.9-1.8 1.8C2 8.8 2 12 2 12s0 3.2.4 4.8c.2.9.9 1.6 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4c.9-.2 1.6-.9 1.8-1.8.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15.2V8.8l5.2 3.2-5.2 3.2z"/>
    </svg>
  )
}
