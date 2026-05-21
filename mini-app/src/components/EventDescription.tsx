// Единый рендер описания события — для лендинга и для вкладки «Программа»
// после регистрации. Поддерживает HTML-разметку (см. utils/htmlSanitize).
// Plain-текст (без HTML-тегов) рендерится как раньше — с whiteSpace:pre-wrap.

import { CSSProperties, ReactNode } from 'react'
import { sanitizeHtml, looksLikeHtml } from '../utils/htmlSanitize'

interface Props {
  text: string | null | undefined
  style?: CSSProperties
  className?: string
  /** Опциональный фолбэк для plain-текста — например, linkify(). */
  renderPlain?: (text: string) => ReactNode
}

export default function EventDescription({ text, style, className, renderPlain }: Props) {
  const raw = (text || '').trim()
  if (!raw) return null

  if (looksLikeHtml(raw)) {
    return (
      <div
        className={className}
        style={style}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(raw) }}
      />
    )
  }

  return (
    <div
      className={className}
      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...style }}
    >
      {renderPlain ? renderPlain(raw) : raw}
    </div>
  )
}
