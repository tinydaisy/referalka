'use client'
import { useEffect, useState } from 'react'
import { MessageCircle, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { HubHeader } from '../_components/shared'

/** Закрытый чат Коллабораторной — площадок две (Telegram и MAX), поэтому пункт
 *  меню ведёт сюда, а не прямо в мессенджер: одной ссылкой их не уместить.
 *  Кнопка рисуется только для заполненной площадки — ссылки задаёт админ
 *  платформы (миграции 264 и 266). */
export default function CollabChatPage() {
  const [loading, setLoading] = useState(true)
  const [tg, setTg] = useState('')
  const [max, setMax] = useState('')

  useEffect(() => {
    api.collabHub.settings()
      .then((r: any) => { setTg(r?.chat_url || ''); setMax(r?.chat_url_max || '') })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const platforms = [
    { key: 'tg', label: 'Telegram', url: tg, bg: 'linear-gradient(45deg,#25455D,#0a1520)' },
    { key: 'max', label: 'MAX', url: max, bg: 'linear-gradient(45deg,#25455D,#0a1520)' },
  ].filter(p => p.url)

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <HubHeader subtitle="Закрытый чат участников Коллабораторной." />

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 max-w-xl">
        <div className="flex items-center gap-2 mb-1">
          <MessageCircle size={18} className="text-gray-400" />
          <h2 className="font-semibold text-gray-800">Войти в чат</h2>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          Чат один, просто живёт на двух площадках — выберите удобную. Если вы
          уже состоите в чате, ссылка просто откроет его.
        </p>

        {loading ? (
          <div className="text-sm text-gray-400">Загружаем…</div>
        ) : platforms.length === 0 ? (
          <div className="text-sm text-gray-500">
            Ссылки на чат пока не заданы. Загляните сюда позже.
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-3">
            {platforms.map(p => (
              <a
                key={p.key}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ background: p.bg }}
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
