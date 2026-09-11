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
    // ⚠️⚠️ Класс `event-desc` вешается ЗДЕСЬ, а не в местах вызова: точек
    // показа описания несколько (лендинг, «Программа», веб-витрина), и правило
    // «не забыть добавить класс» одна из них рано или поздно нарушит. Без
    // класса у `<li>` нет стилей вовсе, и списки растягиваются на экраны —
    // см. комментарий в global.css.
    return (
      <div
        className={className ? `event-desc ${className}` : 'event-desc'}
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
