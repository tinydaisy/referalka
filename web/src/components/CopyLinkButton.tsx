'use client'

import { useState } from 'react'
import { Check, Link2 } from 'lucide-react'

/**
 * Кнопка «скопировать ссылку» рядом с адресом страницы.
 *
 * ⚠️ ОДИН компонент на все места, где показан публичный адрес. Копирование
 * писали в каждом экране заново (PublicLinks, CabinetPreviewBlock, RefLinkInline,
 * FileUploader) — и они разошлись: где-то есть запасной путь для браузеров без
 * `navigator.clipboard`, где-то нет; подтверждение держится то 1,5 с, то 2 с.
 *
 * ⚠️ Запасной путь через `<textarea>` + `execCommand` обязателен:
 * `navigator.clipboard` недоступен вне HTTPS и в части встроенных браузеров,
 * и без него кнопка молча ничего не делает — человек жмёт и не понимает,
 * скопировалось или нет.
 */
export default function CopyLinkButton({
  url, className = '', title = 'Скопировать ссылку',
}: {
  url: string
  className?: string
  title?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
        copied
          ? 'border-green-300 bg-green-50 text-green-700'
          : 'border-gray-300 text-gray-700 hover:bg-gray-50'
      } ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
      {copied ? 'Скопировано' : 'Копировать'}
    </button>
  )
}
