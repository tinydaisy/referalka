'use client'

/**
 * Оболочка кабинета покупателя — шапка бренда + меню слева.
 *
 * ⚠️⚠️ ОДИН компонент на ВСЕ страницы кабинета: список (`/my`), страница
 * продукта (`/my/{slug}`) и урок (`/my/{slug}/m/{id}`). Рисовать меню на
 * каждой странице отдельно нельзя — они разъедутся, и человек, провалившись
 * внутрь продукта, останется без навигации (так и было: меню жило только на
 * главной, и внутри продукта кабинет выглядел «сломанным»).
 *
 * ⚠️ Меню — это вёрстка, к домену отношения не имеет: работает одинаково и на
 * pluson.ru с `?client_id=`, и на своём домене клиента.
 *
 * ⚠️ Цвета берём из темы клиента (`clients.lp_*`): человек купил у конкретного
 * эксперта, кабинет должен быть в его оформлении, а не безымянным серым.
 */
import Link from 'next/link'
import { BookOpen, Handshake, LifeBuoy, LogOut, User } from 'lucide-react'
import CabinetBrand, { type Brand } from './CabinetBrand'

export type CabinetTab = 'materials' | 'partner' | 'support' | 'profile'

const NAV: { key: CabinetTab; label: string; icon: any }[] = [
  { key: 'materials', label: 'Мои материалы', icon: BookOpen },
  { key: 'partner', label: 'Партнёрский кабинет', icon: Handshake },
  { key: 'support', label: 'Поддержка', icon: LifeBuoy },
  { key: 'profile', label: 'Мой профиль', icon: User },
]

/** Сохраняем номер кабинета: без него `/my` отдаёт «Не удалось определить кабинет». */
function withClientId(path: string): string {
  if (typeof window === 'undefined') return path
  const cid = new URLSearchParams(window.location.search).get('client_id')
  return cid ? `${path}${path.includes('?') ? '&' : '?'}client_id=${cid}` : path
}

export default function CabinetShell({
  brand, active, onPick, onLogout, children,
}: {
  brand?: Brand | null
  /** Какой пункт подсвечен. */
  active: CabinetTab
  /** Есть на главной — переключает раздел без перехода. Внутри продукта не
   *  передаётся: там пункт ведёт ссылкой на `/my`. */
  onPick?: (tab: CabinetTab) => void
  onLogout?: () => void
  children: React.ReactNode
}) {
  const c1 = brand?.lp_bg_color || '#25455D'
  const c2 = brand?.lp_bg_color_2 || '#0a1520'
  const accent = brand?.lp_color_heading || '#FFCFA4'

  const itemStyle = (on: boolean) =>
    on
      ? { background: 'rgba(255,255,255,.14)', color: accent, fontWeight: 600 }
      : { color: 'rgba(255,255,255,.78)' }

  const cls =
    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition no-underline'

  return (
    <div className="min-h-screen bg-gray-50">
      <CabinetBrand brand={brand} href={withClientId('/my')} />

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row md:py-10">
        <aside className="w-full shrink-0 md:w-64">
          <div
            className="rounded-2xl p-3 shadow-sm md:sticky md:top-6"
            style={{ background: `linear-gradient(160deg, ${c1}, ${c2})` }}
          >
            <nav className="flex flex-col gap-1">
              {NAV.map(({ key, label, icon: Icon }) => {
                const on = active === key
                // На главной переключаем раздел на месте, внутри продукта —
                // уводим на главную с нужным разделом в адресе.
                return onPick ? (
                  <button key={key} onClick={() => onPick(key)}
                          className={cls} style={itemStyle(on)}>
                    <Icon size={17} className="shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                ) : (
                  <Link key={key} href={withClientId(`/my?tab=${key}`)}
                        className={cls} style={itemStyle(on)}>
                    <Icon size={17} className="shrink-0" />
                    <span className="truncate">{label}</span>
                  </Link>
                )
              })}

              {/* ⚠️ «Выйти» — пункт меню, а не ссылка в углу: человек ищет
                  выход там же, где остальные разделы. */}
              {onLogout ? (
                <button onClick={onLogout} className={`${cls} mt-1`}
                        style={{ color: 'rgba(255,255,255,.55)' }}>
                  <LogOut size={17} className="shrink-0" />
                  <span>Выйти</span>
                </button>
              ) : (
                <Link href={withClientId('/my?logout=1')} className={`${cls} mt-1`}
                      style={{ color: 'rgba(255,255,255,.55)' }}>
                  <LogOut size={17} className="shrink-0" />
                  <span>Выйти</span>
                </Link>
              )}
            </nav>
          </div>
        </aside>

        <section className="min-w-0 flex-1">{children}</section>
      </div>
    </div>
  )
}
