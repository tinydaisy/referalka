'use client'
import { useEffect, useState } from 'react'
import { Copy, Check, Link2 } from 'lucide-react'
import { api } from '@/lib/api'

/**
 * Блок «Партнёрская ссылка» для карточки спикера/организатора.
 * Показывает прямые deeplink-ссылки на все активные площадки клиента (TG, VK, MAX) —
 * каждая с pid=refCode партнёра. Источник — /events/slug/{slug}/share-links
 * (бэк сам выбирает бот клиента или системный @pluson_bot).
 */

interface Props {
  slug: string | null | undefined
  refCode: string | null | undefined
  /** compact = без заголовка, занимает одну строку (для карточек в списке) */
  compact?: boolean
  /** Если 'draft' — ссылка затуманена, копирование заблокировано (партнёру отдавать нельзя). */
  eventStatus?: 'draft' | 'published' | 'ended' | null
}

export default function RefLinkInline({ slug, refCode, compact = false, eventStatus }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const isDraft = eventStatus === 'draft'
  const [shareLinks, setShareLinks] = useState<{ telegram?: string; vk?: string; max?: string }>({})

  useEffect(() => {
    if (!slug || !refCode) { setShareLinks({}); return }
    api.events.shareLinks(slug, refCode)
      .then((r: any) => setShareLinks(r?.links || {}))
      .catch(() => setShareLinks({}))
  }, [slug, refCode])

  if (!slug || !refCode) {
    return (
      <div className="text-[11px] text-gray-400 italic">
        Партнёрская ссылка появится после первого сохранения карточки
      </div>
    )
  }

  const allLinks = [
    { key: 'telegram', badge: 'TG',  label: 'Telegram',   url: shareLinks.telegram || '' },
    { key: 'vk',       badge: 'VK',  label: 'ВКонтакте',  url: shareLinks.vk || '' },
    { key: 'max',      badge: 'MAX', label: 'MAX',        url: shareLinks.max || '' },
  ]
  // Показываем только те платформы, по которым бэк вернул URL (есть свой канал
  // ИЛИ есть боевой системный для этой платформы).
  const links = allLinks.filter(l => !!l.url)

  async function handleCopy(e: React.MouseEvent, key: string, url: string) {
    e.preventDefault(); e.stopPropagation()
    if (isDraft) {
      alert('Событие в черновике — ссылка не сработает у партнёра. Сначала опубликуйте событие (статус справа сверху).')
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch (_) { /* ignore */ }
  }

  if (compact) {
    // В компактном виде (на карточках в списке) — только TG-ссылка одной строкой,
    // чтобы не раздувать ряды. Полный набор площадок открывается в карточке спикера.
    const tg = links[0]
    if (!tg) {
      return <div className="text-[11px] text-gray-400 italic mt-1">загрузка ссылки…</div>
    }
    return (
      <div className="flex items-center gap-1.5 mt-1">
        <code
          className="text-[10px] text-gray-600 font-mono bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 truncate flex-1 min-w-0"
          style={isDraft ? { filter: 'blur(3px)', userSelect: 'none' } : undefined}
          title={isDraft ? 'Опубликуйте событие, чтобы открыть ссылку' : undefined}
        >
          {tg.url}
        </code>
        <button type="button" onClick={(e) => handleCopy(e, tg.key, tg.url)}
          className={`p-1 rounded shrink-0 ${isDraft ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-[#25455D] hover:bg-gray-100'}`}
          title={isDraft ? 'Сначала опубликуйте событие' : 'Скопировать'}>
          {copied === tg.key ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        <Link2 size={14} className="text-amber-900" />
        <span className="text-xs font-semibold text-amber-900">Партнёрские ссылки</span>
      </div>
      <p className="text-[11px] text-amber-800 mb-3 leading-relaxed">
        {isDraft
          ? <><b>Событие в черновике</b> — ссылки не сработают у партнёра. Опубликуйте событие, чтобы запустить.</>
          : 'Если человек придёт по любой из этих ссылок и зарегистрируется на событие — он будет привязан к этому контакту как привёдшему.'}
      </p>
      <div className="space-y-2">
        {links.map(l => (
          <div key={l.key} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-amber-200">
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0"
                  style={{ background: '#25455D', color: '#FFCFA4' }}>
              {l.badge}
            </span>
            <code
              className="text-[11px] text-gray-700 font-mono flex-1 break-all min-w-0"
              style={isDraft ? { filter: 'blur(4px)', userSelect: 'none' } : undefined}
              title={isDraft ? 'Опубликуйте событие, чтобы открыть ссылку' : undefined}
            >
              {l.url}
            </code>
            <button type="button" onClick={(e) => handleCopy(e, l.key, l.url)}
              className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded shrink-0 ${isDraft ? 'text-gray-300 cursor-not-allowed' : 'text-amber-900 hover:text-amber-700'}`}
              title={isDraft ? 'Сначала опубликуйте событие' : 'Скопировать'}>
              {copied === l.key ? <><Check size={13} /> Скопировано</> : <><Copy size={13} /> Копировать</>}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
