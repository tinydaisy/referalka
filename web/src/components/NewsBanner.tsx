'use client'

/**
 * Плашка с новостью платформы вверху кабинета.
 *
 * ⚠️ ОДНА новость за раз — самая свежая непрочитанная. Крестик отмечает её
 * прочитанной, и на её место встаёт следующая. Вываливать все разом нельзя:
 * при десятке новостей кабинет превращается в ленту уведомлений.
 *
 * ⚠️ Зелёная, в отличие от красной «подписка истекла» и янтарной «подтвердите
 * почту». Цвет здесь несёт смысл: у тебя ничего не сломано, это новость.
 * Поэтому и стоит НИЖЕ тревожных плашек — сначала проблемы, потом новости.
 *
 * ⚠️ Только заголовок и текст. Картинка новости живёт на странице
 * /dashboard/news: плашка узкая, рассматривать в ней нечего.
 */
import Link from 'next/link'
import { X } from 'lucide-react'
import { useNews } from '@/hooks/useNews'
import SafeHtml from './SafeHtml'

export default function NewsBanner() {
  const { news, unread, markRead, markAllRead } = useNews()

  const current = news.find(n => !n.is_read)
  if (!current) return null

  return (
    <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 leading-snug">
          <div className="font-semibold">{current.title}</div>
          {current.body && (
            <SafeHtml html={current.body} className="mt-1 text-emerald-900/90" />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link
              href="/dashboard/news"
              className="font-semibold underline underline-offset-2"
            >
              Посмотреть весь список
            </Link>
            {/* Менее заметная — уводить от чтения новостей не хотим, но выход
                из череды плашек у человека быть обязан. */}
            {unread > 1 && (
              <button
                onClick={markAllRead}
                className="text-emerald-800/70 hover:text-emerald-900 underline underline-offset-2"
              >
                Скрыть все ({unread})
              </button>
            )}
          </div>
        </div>
        <button
          onClick={() => markRead(current.id)}
          className="shrink-0 opacity-60 hover:opacity-100 transition"
          title="Прочитано — показать следующую"
          aria-label="Прочитано"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
