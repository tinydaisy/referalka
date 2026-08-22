'use client'
/**
 * Страница одного раздела публичной базы знаний — /help/s/{id}
 *
 * ⚠️ Next 14.2.3 — `params` читаем через `useParams()`, НЕ через `use(params)`,
 * иначе Application error.
 */
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getPublicSection, PUBLIC_SECTIONS, toPublicHref } from '../../../dashboard/help/sections'
import { SectionsNav, ArticleList } from '../../../dashboard/help/_components'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function SectionView() {
  const params = useParams()
  const id = String(params?.section || '')
  const section = getPublicSection(id)

  if (!section) {
    return (
      <div className="max-w-6xl">
        <div className="bg-white rounded-2xl border border-gray-100 p-6">
          <div className="text-base font-bold mb-1" style={{ color: BRAND }}>Такого раздела нет</div>
          <p className="text-sm text-gray-500 mb-4">
            Возможно, ссылка устарела. Откройте общий список — все разделы там.
          </p>
          <Link href="/help"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <ArrowLeft size={15} /> Вся база знаний
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Link href="/help" className="text-sm text-gray-400 hover:text-gray-700">База знаний</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">{section.title}</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-2xl flex-shrink-0"
             style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH})` }}>
          {section.emoji}
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>{section.title}</h1>
          {section.hint && <p className="text-sm text-gray-500 mt-1">{section.hint}</p>}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-6 lg:gap-8">
        <div className="order-1 min-w-0">
          <ArticleList articles={section.articles} hrefOf={toPublicHref} />

          <div className="mt-8 rounded-2xl p-5 text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <div className="text-lg font-bold mb-1">Попробуйте сами</div>
            <p className="text-sm text-white/70 mb-4">
              7 дней бесплатно. Карта не нужна, автопродления нет.
            </p>
            <Link href="/register" className="btn-gold inline-block px-5 py-2.5 rounded-xl text-sm font-semibold">
              Зарегистрироваться
            </Link>
          </div>
        </div>

        <aside className="order-2 lg:pl-8 lg:border-l lg:border-gray-200">
          <SectionsNav activeId={section.id} sections={PUBLIC_SECTIONS} base="/help" />
        </aside>
      </div>
    </div>
  )
}
