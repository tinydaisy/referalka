'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Copy, Check, ExternalLink } from 'lucide-react'
import { SECTIONS, type Article } from './sections'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

/**
 * Боковое меню разделов. Показывается и на общей странице инструкций,
 * и внутри конкретного раздела — чтобы из «Коллабораторной» можно было
 * перейти в «Турниры», не возвращаясь назад.
 *
 * На узком экране колонки нет — меню уезжает вниз обычным списком
 * (`order-2 lg:order-none`), иначе на телефоне пришлось бы пролистывать
 * весь список разделов, чтобы добраться до статей.
 */
export function SectionsNav({ activeId }: { activeId?: string }) {
  return (
    <nav className="lg:sticky lg:top-4 space-y-1">
      <div className="text-xs font-bold uppercase tracking-wide text-gray-400 px-2 mb-2">
        Разделы
      </div>
      {SECTIONS.map(s => {
        const active = s.id === activeId
        return (
          <Link
            key={s.id}
            href={`/dashboard/help/s/${s.id}`}
            className={`flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-colors ${
              active ? '' : 'hover:bg-gray-100'
            }`}
            style={active ? { background: 'linear-gradient(45deg, #25455D, #0a1520)' } : {}}
          >
            <span className="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0"
                  style={{ background: active ? 'rgba(255,255,255,0.14)' : `linear-gradient(135deg, #fff4e0, ${PEACH})` }}>
              {s.emoji}
            </span>
            <span className={`text-sm leading-tight flex-1 min-w-0 ${active ? 'font-bold text-white' : 'font-medium text-gray-700'}`}>
              {s.title}
            </span>
            <span className={`text-xs flex-shrink-0 ${active ? 'text-white/60' : 'text-gray-400'}`}>
              {s.articles.length}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}

/** Карточка статьи. Одна на обе страницы — вёрстка не должна разъезжаться. */
export function ArticleCard({ article }: { article: Article }) {
  const [origin, setOrigin] = useState('https://pluson.ru')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])
  const publicUrl = `${origin}${article.href}`
  function copyPublic(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(publicUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }
  return (
    <Link
      href={article.href}
      className="block bg-white rounded-xl border border-gray-100 hover:border-gray-300 hover:shadow-sm transition-all p-3.5"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl flex-shrink-0"
             style={{ background: '#f8fafc' }}>
          {article.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h2 className="text-sm font-bold" style={{ color: BRAND }}>{article.title}</h2>
            <ChevronRight size={18} className="text-gray-300 flex-shrink-0" />
          </div>
          <p className="text-xs text-gray-500 leading-snug">{article.description}</p>
          {article.isPublic && (
            <div className="mt-3 p-2.5 rounded-lg border border-amber-200 bg-amber-50">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 mb-1.5">
                <ExternalLink size={12} /> Публичная ссылка для шеринга
              </div>
              {article.publicNote && (
                <p className="text-xs text-amber-800 mb-2 leading-snug">{article.publicNote}</p>
              )}
              <div className="flex gap-2">
                <code className="flex-1 bg-white border border-amber-200 rounded px-2 py-1.5 text-xs font-mono overflow-x-auto whitespace-nowrap text-gray-700">
                  {publicUrl}
                </code>
                <button
                  onClick={copyPublic}
                  className="px-2.5 py-1.5 rounded text-white text-xs font-medium flex items-center gap-1 flex-shrink-0"
                  style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
                >
                  {copied ? <><Check size={12}/> Скопировано</> : <><Copy size={12}/> Копировать</>}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Link>
  )
}

/** Список статей раздела с подзаголовками групп. */
export function ArticleList({ articles }: { articles: Article[] }) {
  return (
    <div className="space-y-2">
      {articles.map((a, idx) => {
        const showGroup = a.group && a.group !== articles[idx - 1]?.group
        return (
          <div key={a.href}>
            {showGroup && (
              <div className="text-xs font-bold uppercase tracking-wide text-gray-400 mt-3 mb-1.5 px-1">
                {a.group}
              </div>
            )}
            <ArticleCard article={a} />
          </div>
        )
      })}
    </div>
  )
}
