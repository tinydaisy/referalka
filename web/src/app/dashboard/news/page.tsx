'use client'

/**
 * Все новости платформы в кабинете клиента.
 *
 * ⚠️ Здесь новость показывается ЦЕЛИКОМ и с картинкой — в отличие от плашки и
 * колокольчика, где только заголовок и текст. Место для этого есть только тут.
 *
 * ⚠️ Открыл страницу — новости считаются прочитанными. Человек их увидел,
 * держать после этого цифру на колокольчике незачем.
 */
import { useEffect } from 'react'
import Link from 'next/link'
import { Megaphone } from 'lucide-react'
import { useNews } from '@/hooks/useNews'
import SafeHtml from '@/components/SafeHtml'

const BRAND = '#25455D'

function formatDate(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow',
    })
  } catch { return '' }
}

export default function NewsPage() {
  const { news, unread, loaded, markAllRead } = useNews()

  // ⚠️ Гасим только когда есть что гасить: без проверки запрос уходил бы на
  // каждое открытие страницы впустую.
  useEffect(() => {
    if (loaded && unread > 0) markAllRead()
    // Намеренно только при первой загрузке: перечитывать при каждом изменении
    // счётчика не нужно, он и так обнулится.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  return (
    <div className="pb-24 max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-700">Дашборд</Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-700">Новости</span>
      </div>

      <div className="flex items-start gap-3 mb-6">
        <div className="p-2 rounded-lg text-white"
             style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          <Megaphone size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold" style={{ color: BRAND }}>Новости ПЛЮСОНа</h1>
          <p className="text-sm text-gray-500 mt-1">
            Что нового на платформе: возможности, изменения, полезное.
          </p>
        </div>
      </div>

      {!loaded && <div className="text-sm text-gray-400">Загружаем…</div>}

      {loaded && news.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-8 text-center text-gray-500">
          Пока новостей нет — здесь появится всё новое на платформе.
        </div>
      )}

      <div className="space-y-4">
        {news.map(n => (
          <article
            key={n.id}
            id={`news-${n.id}`}
            className="rounded-xl border border-gray-200 bg-white p-5 scroll-mt-4"
          >
            <div className="text-xs text-gray-400 mb-1">{formatDate(n.published_at)}</div>
            <h2 className="text-lg font-bold leading-snug" style={{ color: BRAND }}>{n.title}</h2>
            {n.image_url && (
              <img
                src={n.image_url}
                alt=""
                className="mt-3 w-full rounded-lg"
                style={{ maxHeight: 420, objectFit: 'cover' }}
              />
            )}
            {n.body && (
              <SafeHtml html={n.body} className="mt-3 text-sm text-gray-700 leading-relaxed" />
            )}
          </article>
        ))}
      </div>
    </div>
  )
}
