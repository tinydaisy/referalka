// Авто-линкификация plain-текста: «...текст https://foo.bar/x текст...» →
// React-узлы с обычными <a> на http(s)-ссылках. Без HTML-инъекций
// (передаём строки и JSX, не dangerouslySetInnerHTML).
//
// Используется в описаниях, которые клиент вводит как обычный текст
// (продукты Экосистемы, программа конкурса и т.п.) — переносы строк
// сохраняются через whiteSpace:pre-wrap в обёртке, а ссылки кликабельны.

import { ReactNode } from 'react'

const URL_RE = /(https?:\/\/[^\s<>"']+)/gi

export function linkify(text: string, linkColor = '#25455D'): ReactNode[] {
  if (!text) return []
  const parts: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const url = m[0]
    parts.push(
      <a key={parts.length} href={url} target="_blank" rel="noreferrer"
         style={{ color: linkColor, textDecoration: 'underline', wordBreak: 'break-word' }}>
        {url}
      </a>
    )
    last = m.index + url.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
