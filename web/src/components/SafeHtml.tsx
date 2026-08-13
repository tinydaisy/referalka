'use client'

/**
 * Показ текста, сохранённого с форматированием (жирный, курсив, списки).
 *
 * ⚠️ Санитайз ОБЯЗАТЕЛЕН и делается здесь, при выводе. Редактор чистит теги
 * при вводе, но полагаться на это нельзя: значение приходит из базы, куда
 * могло попасть импортом, через API или из старых записей. Единственная
 * защита от чужого скрипта на странице — чистить в момент показа.
 *
 * Тот же allowlist, что у RichTextEditor в режиме `web`: форматирование,
 * ссылки, списки, абзацы. Ни <script>, ни <iframe>, ни обработчики событий
 * (onclick и подобные) не проходят.
 *
 * Если в строке тегов нет вовсе (старые записи — обычный текст), показываем
 * её как текст с сохранением переносов строк.
 */
import { useMemo } from 'react'

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'br', 'code', 'pre',
  'ul', 'ol', 'li', 'p', 'h2', 'h3', 'blockquote',
])
const ALLOWED_ATTRS: Record<string, string[]> = { a: ['href', 'target', 'rel'] }
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']

/** Похоже ли, что в строке есть разметка. */
function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(s)
}

function sanitize(html: string): string {
  if (typeof window === 'undefined') return ''
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) walk(child)

    const tag = node.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      // ⚠️ У <script>/<style> берём НЕ textContent, а выбрасываем целиком:
      // иначе тело скрипта вывалится на страницу текстом.
      if (tag === 'script' || tag === 'style') {
        node.remove()
        return
      }
      node.replaceWith(doc.createTextNode(node.textContent || ''))
      return
    }

    const allowed = ALLOWED_ATTRS[tag] || []
    for (const attr of Array.from(node.attributes)) {
      if (!allowed.includes(attr.name)) node.removeAttribute(attr.name)
    }

    if (tag === 'a') {
      const href = node.getAttribute('href') || ''
      try {
        const u = new URL(href, 'https://placeholder.local/')
        if (!ALLOWED_SCHEMES.includes(u.protocol)) {
          node.removeAttribute('href')
        } else {
          node.setAttribute('target', '_blank')
          node.setAttribute('rel', 'noopener noreferrer')
        }
      } catch {
        node.removeAttribute('href')
      }
    }
  }
  walk(root)
  return root.innerHTML
}

export default function SafeHtml({
  html, className = '', style,
}: {
  html?: string | null
  className?: string
  style?: React.CSSProperties
}) {
  const value = (html || '').trim()
  const clean = useMemo(() => (value && looksLikeHtml(value) ? sanitize(value) : ''), [value])

  if (!value) return null

  // Старая запись без разметки — показываем текстом, сохраняя переносы.
  if (!clean) {
    return (
      <div className={`whitespace-pre-wrap ${className}`} style={style}>{value}</div>
    )
  }

  // ⚠️ Смешанная запись: обычный текст с переносами \n + редкие теги (<b>).
  // Такие регалии заводили вручную и вставкой из мессенджера. HTML схлопывает
  // \n в пробел — на странице профиля текст слипался в сплошную простыню.
  // Блочной разметки тут нет (её бы браузер и так расставил), поэтому
  // сохраняем переносы, как в текстовой ветке выше.
  const hasBlockMarkup = /<\s*(br|p|ul|ol|li|h2|h3|blockquote)\b/i.test(clean)

  return (
    <div
      className={`rich-text ${hasBlockMarkup ? '' : 'whitespace-pre-wrap'} ${className}`}
      style={style}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  )
}
