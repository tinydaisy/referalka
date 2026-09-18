'use client'

/**
 * Обычное поле ввода с поддержкой HTML-тегов и проверкой их корректности.
 *
 * ⚠️ Почему ОБЫЧНОЕ поле, а не визуальный редактор. Редактор на contentEditable
 * терял набранный текст: значение уходило в сохранение из состояния формы, а не
 * из самого поля, и текст молча пропадал. Здесь текст — обычное значение поля,
 * потерять его нечем.
 *
 * Теги пишутся руками (<b>жирный</b>), как в рассылках, и сразу проверяются:
 * незакрытый или перевёрнутый тег ломает вид всей страницы, поэтому человек
 * должен увидеть ошибку до сохранения, а не после.
 */
import { useMemo, useState } from 'react'
import { findHtmlIssues, ALLOWED_HTML_TAGS } from '@/lib/htmlTags'

export default function HtmlTextArea({
  value, onChange, rows = 5, placeholder, className = '',
  allowedTags = ALLOWED_HTML_TAGS,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  className?: string
  /**
   * Набор разрешённых тегов. По умолчанию — веб-набор (там можно <br>, списки).
   * Для текста, уходящего в Telegram, передавать TELEGRAM_HTML_TAGS: там набор
   * уже, и лишний тег отвергает всё сообщение целиком.
   */
  allowedTags?: readonly string[]
}) {
  const [showHelp, setShowHelp] = useState(false)
  const issues = useMemo(() => findHtmlIssues(value, allowedTags), [value, allowedTags])

  return (
    <div className={className}>
      <textarea
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className={`w-full border rounded-xl px-3 py-2 text-sm ${issues.length ? 'border-red-400' : 'border-gray-300'}`}
      />

      {issues.length > 0 && (
        <div className="mt-1 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
          {issues.map((it, i) => (
            <div key={i} className="text-xs text-red-700">⚠️ {it.message}</div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowHelp(s => !s)}
        className="mt-1 text-xs text-gray-500 underline"
      >
        {showHelp ? 'Скрыть' : 'Как выделить текст жирным?'}
      </button>

      {showHelp && (
        <div className="mt-1 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 leading-relaxed">
          Оформление задаётся тегами — как в рассылках:
          <br />• <code>&lt;b&gt;жирный&lt;/b&gt;</code>
          <br />• <code>&lt;i&gt;курсив&lt;/i&gt;</code>
          <br />• <code>&lt;a href=&quot;https://…&quot;&gt;ссылка&lt;/a&gt;</code>
          <br />• новая строка — просто Enter, тег не нужен
          <br />
          <br />Каждый тег закрывается: открыли <code>&lt;b&gt;</code> — закройте <code>&lt;/b&gt;</code>.
          Доступны: {allowedTags.map(t => `<${t}>`).join(', ')}.
        </div>
      )}
    </div>
  )
}
