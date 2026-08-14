'use client'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { getSection } from '../../sections'
import { SectionsNav, ArticleList } from '../../_components'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

/**
 * Страница ОДНОГО раздела инструкций — `/dashboard/help/s/{id}`.
 *
 * ⚠️ Нужна именно отдельным адресом: клиенту дают ссылку сразу на нужный
 * раздел («вот инструкции по Коллабораторной»), а не на общий список,
 * где ещё надо найти и раскрыть нужный блок.
 *
 * ⚠️ Next 14.2.3 — `params` читаем через `useParams()`, НЕ через `use(params)`,
 * иначе Application error.
 */
export default function HelpSectionPage() {
  const params = useParams()
  const id = String(params?.section || '')
  const section = getSection(id)

  if (!section) {
    return (
      <div className="pb-24 max-w-3xl">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm text-gray-700">Раздел не найден</span>
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-6">
          <div className="text-base font-bold mb-1" style={{ color: BRAND }}>Такого раздела нет</div>
          <p className="text-sm text-gray-500 mb-4">
            Возможно, ссылка устарела. Откройте общий список — все разделы там.
          </p>
          <Link href="/dashboard/help"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium"
                style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <ArrowLeft size={15} /> Все инструкции
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="pb-24 max-w-6xl">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <Link href="/dashboard/help" className="text-sm text-gray-400 hover:text-gray-700">Инструкции</Link>
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

      {/* Содержимое слева, оглавление справа — разделителем служит левая
          граница колонки оглавления, и только на широком экране (на телефоне
          колонки идут друг под другом). */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-6 lg:gap-8">
        <div className="order-1 min-w-0">
          <ArticleList articles={section.articles} />

          <div className="mt-6 p-4 bg-gray-50 rounded-xl border border-gray-200">
            <div className="text-sm font-semibold text-gray-800 mb-1">Не нашли ответ?</div>
            <p className="text-sm text-gray-600">
              Напишите в поддержку —{' '}
              <Link href={SUPPORT_URL} className="text-blue-600 hover:underline">
                {SUPPORT_LABEL}
              </Link>
            </p>
          </div>
        </div>

        <aside className="order-2 lg:pl-8 lg:border-l lg:border-gray-200">
          <SectionsNav activeId={section.id} />
        </aside>
      </div>
    </div>
  )
}
