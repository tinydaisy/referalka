/**
 * Каркас публичной страницы: шапка сверху, футер снизу, содержимое между.
 *
 * Чтобы не собирать шапку и футер на каждой странице заново — страница просто
 * оборачивается в этот компонент. Правка меню в одном месте меняет его везде.
 *
 * ⚠️ В кабинете не используется: там свой макет (DashboardLayout) со своим
 * сайдбаром, и публичное меню там появиться не должно.
 */
import PublicHeader from './PublicHeader'
import PublicFooter from './PublicFooter'

export default function PublicShell({ children, wide, registerHref }: {
  children: React.ReactNode
  /** Широкая колонка (для лендингов во всю ширину). По умолчанию — 6xl. */
  wide?: boolean
  /** Адрес регистрации с реферальным кодом — см. PublicHeader. */
  registerHref?: string
}) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <PublicHeader registerHref={registerHref} />
      <main className={`flex-1 w-full ${wide ? '' : 'max-w-6xl mx-auto px-5 sm:px-8 py-8'}`}>
        {children}
      </main>
      <PublicFooter />
    </div>
  )
}
