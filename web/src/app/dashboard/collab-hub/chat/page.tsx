'use client'
import { useEffect, useState } from 'react'
import { MessageCircle, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { HubHeader } from '../_components/shared'

/** Закрытые чаты Коллабораторной. Это ДВА РАЗНЫХ чата — в Telegram и в MAX,
 *  переписка в них не общая и не дублируется. Поэтому пункт меню ведёт сюда,
 *  а не прямо в мессенджер: одной ссылкой два чата не уместить.
 *  Кнопка рисуется только для заполненной площадки — ссылки задаёт админ
 *  платформы (миграции 264 и 266). */
export default function CollabChatPage() {
  const [loading, setLoading] = useState(true)
  const [tg, setTg] = useState('')
  const [max, setMax] = useState('')
  // false → сервер не отдал ссылки: чат только для оплативших VIP (collab_hub.py)
  const [hasAccess, setHasAccess] = useState(true)

  useEffect(() => {
    api.collabHub.settings()
      .then((r: any) => { setTg(r?.chat_url || ''); setMax(r?.chat_url_max || ''); setHasAccess(r?.has_access !== false) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const platforms = [
    { key: 'tg', label: 'Telegram', url: tg },
    { key: 'max', label: 'MAX', url: max },
  ].filter(p => p.url)

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Закрытые чаты участников Коллабораторной." />

      <div className="bg-white rounded-2xl border card-border shadow-sm p-6 max-w-xl">
        <div className="flex items-center gap-2 mb-1">
          <MessageCircle size={18} className="text-gray-400" />
          <h2 className="font-semibold text-gray-800">Войти в чат</h2>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          Два отдельных чата — в Telegram и в MAX. Переписка в них разная,
          заходите куда удобно или сразу в оба.
        </p>

        {loading ? (
          <div className="text-sm text-gray-400">Загружаем…</div>
        ) : !hasAccess ? (
          <div className="text-sm text-gray-500">
            Чат открыт участникам с тарифом «VIP с Коллабораторной» и тем, кто на пробном периоде.
          </div>
        ) : platforms.length === 0 ? (
          <div className="text-sm text-gray-500">
            Ссылки на чат пока не заданы. Загляните сюда позже.
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-3">
            {platforms.map(p => (
              // Единый класс проекта (.btn-gold в globals.css), не свой градиент:
              // вход в чат — главное действие страницы, оно золотое.
              <a
                key={p.key}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-gold flex-1 py-3 text-sm"
              >
                {p.label}
                <ExternalLink size={15} />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
