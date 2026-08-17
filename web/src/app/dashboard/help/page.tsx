'use client'
import Link from 'next/link'
import { BookOpen, ChevronRight } from 'lucide-react'
import { SUPPORT_URL, SUPPORT_LABEL } from '@/lib/support'
import { SECTIONS } from './sections'
import { SectionsNav, HelpSearch } from './_components'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

/**
 * Общий список разделов инструкций.
 *
 * ⚠️ Разделы больше НЕ раскрываются здесь аккордеоном — клик ведёт на
 * отдельную страницу раздела `/dashboard/help/s/{id}`. Так у каждого раздела
 * есть свой адрес, который можно дать ссылкой («инструкции по Коллабораторной»),
 * а не «откройте список и найдите нужный блок». Раскрытый по умолчанию первый
 * раздел тоже убран: он занимал экран и прятал остальные.
 */
export default function HelpIndexPage() {
  return (
    <div className="pb-24 max-w-6xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Тех.поддержка / Инструкции</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <BookOpen size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Инструкции</h1>
          <p className="text-sm text-gray-500 mt-1">
            Все инструкции по работе с iViSiON: ПЛЮСОН, собранные по разделам. Откройте раздел и выберите тему.
          </p>
        </div>
      </div>

      {/* Содержимое слева, оглавление справа. Разделитель — левая граница
          колонки оглавления (`lg:border-l`), только на широком экране: на
          телефоне колонки стоят друг под другом, и вертикальная линия там
          повисла бы поперёк вёрстки. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-6 lg:gap-8">
        <div className="order-1 min-w-0">
          <HelpSearch />

          <div className="space-y-3">
          {SECTIONS.map(s => (
            <Link
              key={s.id}
              href={`/dashboard/help/s/${s.id}`}
              className="flex items-center gap-3 p-4 bg-white rounded-2xl border border-gray-100 hover:border-gray-300 hover:shadow-sm transition-all"
            >
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
                   style={{ background: `linear-gradient(135deg, #fff4e0, ${PEACH})` }}>
                {s.emoji}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-base font-bold" style={{ color: BRAND }}>{s.title}</div>
                {s.hint && <div className="text-xs text-gray-400 mt-0.5">{s.hint}</div>}
              </div>
              <span className="text-xs text-gray-400 flex-shrink-0">{s.articles.length}</span>
              <ChevronRight size={20} className="text-gray-300 flex-shrink-0" />
            </Link>
          ))}
          </div>

          <div className="mt-8 p-4 bg-gray-50 rounded-xl border border-gray-200">
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
          <SectionsNav />
        </aside>
      </div>
    </div>
  )
}
