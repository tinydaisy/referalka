'use client'
/**
 * Главная публичной базы знаний — /help
 *
 * Разделы и поиск те же, что в кабинете: список берётся из общего sections.ts,
 * только без технических разделов (флаг internalOnly). Копии списка нет —
 * добавленная статья появляется сразу в обоих местах.
 */
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { PUBLIC_SECTIONS, toPublicHref } from '../dashboard/help/sections'
import { SectionsNav, HelpSearch } from '../dashboard/help/_components'

const BRAND = '#25455D'
const PEACH = '#FFCFA4'

export default function IndexView() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold" style={{ color: BRAND }}>
          Как работает ПЛЮСОН
        </h1>
        <p className="text-sm text-gray-500 mt-2 max-w-2xl">
          Инструкции по шагам — со скриншотами и без технических терминов.
          Открыты всем: посмотрите, как всё устроено, до регистрации.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] gap-6 lg:gap-8">
        <div className="order-1 min-w-0">
          <HelpSearch sections={PUBLIC_SECTIONS} hrefOf={toPublicHref} />

          <div className="space-y-3">
            {PUBLIC_SECTIONS.map(s => (
              <Link
                key={s.id}
                href={`/help/s/${s.id}`}
                className="flex items-center gap-3 p-4 bg-white rounded-2xl border card-border hover:border-gray-300 hover:shadow-sm transition-all"
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

          <div className="mt-8 rounded-2xl p-5 text-white" style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <div className="text-lg font-bold mb-1">Всё это настраивается мышкой</div>
            <p className="text-sm text-white/70 mb-4">
              Без программиста, без технического задания и без подрядчиков.
              Первые 7 дней — бесплатно, карта не нужна.
            </p>
            <Link href="/register" className="btn-gold inline-block px-5 py-2.5 rounded-xl text-sm font-semibold">
              Попробовать бесплатно
            </Link>
          </div>
        </div>

        <aside className="order-2 lg:pl-8 lg:border-l lg:border-gray-200">
          <SectionsNav sections={PUBLIC_SECTIONS} base="/help" />
        </aside>
      </div>
    </div>
  )
}
