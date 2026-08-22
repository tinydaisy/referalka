/**
 * Главная публичной базы знаний — /help
 *
 * Серверная обёртка ради метаданных; список рисует IndexView.
 */
import type { Metadata } from 'next'
import IndexView from './IndexView'

export const metadata: Metadata = {
  title: 'База знаний — iViSiON: ПЛЮСОН',
  description: 'Инструкции по шагам: события, спикеры, рассылки, воронки, коллаборации, вебинарная комната. Со скриншотами и без технических терминов.',
  alternates: { canonical: 'https://pluson.ru/help' },
  openGraph: {
    title: 'База знаний — iViSiON: ПЛЮСОН',
    description: 'Инструкции по шагам: события, спикеры, рассылки, воронки, коллаборации.',
    url: 'https://pluson.ru/help',
    siteName: 'iViSiON: ПЛЮСОН',
  },
}

export default function PublicHelpIndexPage() {
  return <IndexView />
}
