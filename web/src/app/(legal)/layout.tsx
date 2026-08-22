/**
 * Юридические страницы — оферта, политика ПД, партнёрская оферта.
 *
 * Шапка и футер те же, что на остальном публичном сайте: человек пришёл
 * с лендинга по ссылке в подвале и должен остаться в том же оформлении,
 * а не проваливаться в голый документ без выхода назад.
 */
import PublicShell from '@/components/public/PublicShell'

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>
}
