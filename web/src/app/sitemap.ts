/**
 * Карта сайта — /sitemap.xml
 *
 * Без неё поисковик не знает, что у нас есть 54 статьи базы знаний: на них
 * почти нет внешних ссылок, сам он их не найдёт.
 *
 * ⚠️ Страницы клиентов (события, продукты, лендинги) сюда НЕ идут: они живут
 * на доменах клиентов и принадлежат им, а не платформе. Их продвигает клиент.
 */
import type { MetadataRoute } from 'next'
import { PUBLIC_SECTIONS, toPublicHref } from './dashboard/help/sections'

const SITE = 'https://pluson.ru'

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()

  const staticPages: MetadataRoute.Sitemap = [
    { url: SITE,               lastModified: now, changeFrequency: 'weekly',  priority: 1 },
    { url: `${SITE}/help`,     lastModified: now, changeFrequency: 'weekly',  priority: 0.8 },
    { url: `${SITE}/register`, lastModified: now, changeFrequency: 'monthly', priority: 0.7 },
    { url: `${SITE}/offer`,    lastModified: now, changeFrequency: 'yearly',  priority: 0.2 },
    { url: `${SITE}/privacy`,  lastModified: now, changeFrequency: 'yearly',  priority: 0.2 },
  ]

  const sections: MetadataRoute.Sitemap = PUBLIC_SECTIONS.map(s => ({
    url: `${SITE}/help/s/${s.id}`,
    lastModified: now,
    changeFrequency: 'monthly' as const,
    priority: 0.6,
  }))

  const articles: MetadataRoute.Sitemap = PUBLIC_SECTIONS.flatMap(s =>
    s.articles
      // В разделах есть внешние ссылки (напр. /docs/api) — в карту сайта
      // берём только собственные статьи базы знаний.
      .filter(a => a.href.startsWith('/dashboard/help/'))
      .map(a => ({
        url: `${SITE}${toPublicHref(a.href)}`,
        lastModified: now,
        changeFrequency: 'monthly' as const,
        priority: 0.5,
      })),
  )

  return [...staticPages, ...sections, ...articles]
}
