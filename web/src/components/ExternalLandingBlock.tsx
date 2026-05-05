'use client'
import { useState } from 'react'
import { Copy, Check, Globe } from 'lucide-react'

interface Props {
  slug?: string | null
  value: string
  onChange: (v: string) => void
}

export default function ExternalLandingBlock({ slug, value, onChange }: Props) {
  const [copied, setCopied] = useState(false)
  const redirectUrl = slug
    ? `https://t.me/pluson_bot/pluson?startapp=ref_pg${slug}_reg`
    : ''

  async function handleCopy() {
    if (!redirectUrl) return
    try {
      await navigator.clipboard.writeText(redirectUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch (_) { /* ignore */ }
  }

  return (
    <div className="border-t border-gray-100 pt-5 mt-5">
      <div className="flex items-center gap-2 mb-1.5">
        <Globe size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-800">
          Подключение стороннего лендинга
        </h3>
      </div>
      <p className="text-xs text-gray-500 mb-3 leading-relaxed">
        Если у вас уже есть лендинг события на Tilda, GetCourse, Taplink или
        другом конструкторе — вставьте сюда его адрес. Mini App будет
        открывать ваш лендинг для участников вместо встроенной страницы.
      </p>

      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        URL вашего лендинга
      </label>
      <input
        type="url"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="https://yoursite.com/event"
        className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
      />

      {redirectUrl && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
          <p className="text-xs font-semibold text-amber-900 mb-1">
            После регистрации направляйте людей сюда:
          </p>
          <p className="text-xs text-amber-800 mb-2.5 leading-relaxed">
            В настройках формы вашего лендинга укажите редирект после успешной
            регистрации на эту ссылку — человек попадёт обратно в Mini App
            и сразу увидит экран поздравления.
          </p>
          <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-amber-200">
            <code className="text-[11px] text-gray-700 font-mono flex-1 break-all">
              {redirectUrl}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 text-xs font-medium text-amber-900 hover:text-amber-700 px-2 py-1 rounded shrink-0"
            >
              {copied ? <><Check size={13} /> Скопировано</> : <><Copy size={13} /> Копировать</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
