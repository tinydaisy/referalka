/**
 * Раздел публичной базы знаний — /help/s/{id}
 *
 * Серверная обёртка ради метаданных; сам раздел рисует SectionView.
 */
import type { Metadata } from 'next'
import { getPublicSection } from '../../../dashboard/help/sections'
import SectionView from './SectionView'

const SITE = 'https://pluson.ru'

export async function generateMetadata(
  { params }: { params: { section: string } },
): Promise<Metadata> {
  const section = getPublicSection(params.section)
  if (!section) return { title: 'Раздел не найден — iViSiON: ПЛЮСОН' }

  const description = section.hint
    || `${section.articles.length} инструкций по теме «${section.title}»`
  const url = `${SITE}/help/s/${params.section}`

  return {
    title: `${section.title} — база знаний iViSiON: ПЛЮСОН`,
    description: description.slice(0, 160),
    alternates: { canonical: url },
    openGraph: {
      title: section.title,
      description: description.slice(0, 160),
      url,
      siteName: 'iViSiON: ПЛЮСОН',
    },
  }
}

export default function PublicHelpSectionPage() {
  return <SectionView />
}
