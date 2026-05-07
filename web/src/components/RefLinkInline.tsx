'use client'
import { useState } from 'react'
import { Copy, Check, Link2 } from 'lucide-react'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://pluson.ru'

interface Props {
  slug: string | null | undefined
  refCode: string | null | undefined
  /** compact = без заголовка, занимает одну строку (для карточек в списке) */
  compact?: boolean
  /** Если 'draft' — ссылка затуманена, копирование заблокировано (партнёру отдавать нельзя). */
  eventStatus?: 'draft' | 'published' | 'ended' | null
}

/**
 * Блок «Партнёрская ссылка» для карточки спикера/организатора.
 * Формат — тот же, что в Mini App у участников: web-лендинг с pid и app=tg,
 * лендинг сам перебрасывает в Mini App при открытии в Telegram.
 */
export default function RefLinkInline({ slug, refCode, compact = false, eventStatus }: Props) {
  const [copied, setCopied] = useState(false)
  const isDraft = eventStatus === 'draft'

  if (!slug || !refCode) {
    return (
      <div className="text-[11px] text-gray-400 italic">
        Партнёрская ссылка появится после первого сохранения карточки
      </div>
    )
  }

  const link = `${APP_URL}/l/${slug}?app=tg&pid=${refCode}`

  async function handleCopy(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    if (isDraft) {
      alert('Событие в черновике — ссылка не сработает у партнёра. Сначала опубликуйте событие (статус справа сверху).')
      return
    }
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (_) { /* ignore */ }
  }

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 mt-1">
        <code
          className="text-[10px] text-gray-600 font-mono bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 truncate flex-1 min-w-0"
          style={isDraft ? { filter: 'blur(3px)', userSelect: 'none' } : undefined}
          title={isDraft ? 'Опубликуйте событие, чтобы открыть ссылку' : undefined}
        >
          {link}
        </code>
        <button type="button" onClick={handleCopy}
          className={`p-1 rounded shrink-0 ${isDraft ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-[#25455D] hover:bg-gray-100'}`}
          title={isDraft ? 'Сначала опубликуйте событие' : 'Скопировать'}>
          {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        <Link2 size={14} className="text-amber-900" />
        <span className="text-xs font-semibold text-amber-900">Партнёрская ссылка</span>
      </div>
      <p className="text-[11px] text-amber-800 mb-2 leading-relaxed">
        {isDraft
          ? <><b>Событие в черновике</b> — ссылка не сработает у партнёра. Опубликуйте событие, чтобы запустить.</>
          : 'Если человек придёт по этой ссылке и зарегистрируется на событие — он будет привязан к этому контакту как привёдшему.'}
      </p>
      <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-amber-200">
        <code
          className="text-[11px] text-gray-700 font-mono flex-1 break-all"
          style={isDraft ? { filter: 'blur(4px)', userSelect: 'none' } : undefined}
          title={isDraft ? 'Опубликуйте событие, чтобы открыть ссылку' : undefined}
        >
          {link}
        </code>
        <button type="button" onClick={handleCopy}
          className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded shrink-0 ${isDraft ? 'text-gray-300 cursor-not-allowed' : 'text-amber-900 hover:text-amber-700'}`}
          title={isDraft ? 'Сначала опубликуйте событие' : 'Скопировать'}>
          {copied ? <><Check size={13} /> Скопировано</> : <><Copy size={13} /> Копировать</>}
        </button>
      </div>
    </div>
  )
}
