/**
 * Статья публичной базы знаний — /help/{slug}
 *
 * Серверная обёртка: её дело — отдать поисковику заголовок и описание.
 * Сама статья рисуется в ArticleView.
 *
 * ⚠️ Заголовок и описание берутся из `sections.ts` — они там уже написаны
 * под каждую статью. Без этого все 54 страницы отдавали бы одинаковые
 * метаданные, и поисковик считал бы их дублями.
 */
import type { Metadata } from 'next'
import { findPublicArticle } from '../../dashboard/help/sections'
import ArticleView from './ArticleView'

const SITE = 'https://pluson.ru'

export async function generateMetadata(
  { params }: { params: { slug: string } },
): Promise<Metadata> {
  const found = findPublicArticle(params.slug)
  if (!found) return { title: 'Статья не найдена — iViSiON: ПЛЮСОН' }

  const { article, section } = found
  // Описание режем: поисковик показывает ~160 символов, остальное отбрасывает.
  const description = article.description.slice(0, 160)
  const url = `${SITE}/help/${params.slug}`

  return {
    title: `${article.title} — iViSiON: ПЛЮСОН`,
    description,
    // ⚠️ Канонический адрес обязателен: та же статья открывается и в кабинете
    // (/dashboard/help/…). Без этого поисковик считает их дублями и понижает обе.
    alternates: { canonical: url },
    openGraph: {
      title: article.title,
      description,
      url,
      type: 'article',
      siteName: 'iViSiON: ПЛЮСОН',
    },
    other: { 'article:section': section.title },
  }
}

export default function PublicHelpArticlePage() {
  return <ArticleView />
}
