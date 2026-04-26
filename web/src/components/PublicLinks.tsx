'use client'
import { useState } from 'react'
import { Copy, Check, Globe } from 'lucide-react'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://plusson.app'

interface LinkRow {
  key: string
  label: string
  badge: string         // 'TG' | 'MAX' | 'WEB' и т.д.
  color: string
  url: string
  hint?: string
}

export default function PublicLinks({ slug }: { slug: string | null | undefined }) {
  const [copied, setCopied] = useState<string | null>(null)

  if (!slug) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="flex items-center gap-2 mb-3">
          <Globe size={18} className="text-gray-500" />
          <h2 className="font-semibold text-gray-800">Публичные ссылки</h2>
        </div>
        <p className="text-sm text-gray-400">
          Появятся после сохранения мероприятия (нужен slug).
        </p>
      </div>
    )
  }

  const links: LinkRow[] = [
    {
      key: 'web',
      label: 'Веб-страница',
      badge: 'WEB',
      color: '#25455D',
      url: `${APP_URL}/l/${slug}`,
      hint: 'Лендинг события — публикуй в соцсетях, рассылках, на сайте',
    },
    {
      key: 'telegram',
      label: 'Telegram (Mini App)',
      badge: 'TG',
      color: '#229ED9',
      url: `${APP_URL}/l/${slug}?app=tg`,
      hint: 'Открывает событие в @ivision_conf_bot. Используй в TG-постах и личке',
    },
    {
      key: 'max',
      label: 'MAX',
      badge: 'MAX',
      color: '#FFCFA4',
      url: `${APP_URL}/l/${slug}?app=max`,
      hint: 'Открывает событие в MAX-канале (как только подключим бота в MAX)',
    },
  ]

  const copy = async (key: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6">
      <div className="flex items-center gap-2 mb-1">
        <Globe size={18} className="text-gray-500" />
        <h2 className="font-semibold text-gray-800">Публичные ссылки</h2>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        Генерируются автоматически из slug события. Под каждую площадку — своя ссылка.
      </p>

      <div className="space-y-2">
        {links.map(l => (
          <div key={l.key} className="border border-gray-100 rounded-xl p-3">
            <div className="flex items-center gap-3">
              <span
                className="inline-flex items-center justify-center w-9 h-9 rounded-full text-[10px] font-bold text-white shrink-0"
                style={{ background: l.color }}
              >
                {l.badge}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800">{l.label}</p>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-[#25455D] truncate block hover:underline"
                >
                  {l.url}
                </a>
              </div>
              <button
                onClick={() => copy(l.key, l.url)}
                className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"
                title="Скопировать ссылку"
              >
                {copied === l.key ? (
                  <Check size={15} className="text-green-600" />
                ) : (
                  <Copy size={15} />
                )}
              </button>
            </div>
            {l.hint && <p className="text-xs text-gray-400 mt-1.5 ml-12">{l.hint}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
