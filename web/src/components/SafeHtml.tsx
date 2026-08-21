'use client'

/**
 * Показ текста, сохранённого с форматированием (жирный, курсив, списки).
 *
 * ⚠️ Санитайз ОБЯЗАТЕЛЕН и делается здесь, при выводе. Редактор чистит теги
 * при вводе, но полагаться на это нельзя: значение приходит из базы, куда
 * могло попасть импортом, через API или из старых записей. Единственная
 * защита от чужого скрипта на странице — чистить в момент показа.
 *
 * Allowlist как у полей ввода с HTML-тегами: форматирование,
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

/**
 * Чиним частую опечатку из текста, вставленного не из нашего редактора:
 * закрывающий тег написан задом наперёд — `<b/>` вместо `</b>`.
 *
 * ⚠️ Браузер считает `<b/>` ОТКРЫВАЮЩИМ тегом, поэтому жирный не закрывается
 * и «течёт» до конца записи: у одного коллаба так пожирнели все регалии после
 * слова «Регалии:». Правим на выводе, а не в базе — тем же способом текст
 * попадёт туда снова при следующей вставке из заметок или мессенджера.
 */
function fixReversedClosingTags(html: string): string {
  return html.replace(/<\s*([a-z][a-z0-9]*)\s*\/\s*>/gi, '</$1>')
}

/**
 * Голый адрес в тексте → кликабельная ссылка.
 *
 * ⚠️ Нужно потому, что тексты уроков пишут обычным набором: «изучи майндкарту
 * https://xmind.ai/…». Без этого адрес оставался простым текстом, и человек в
 * кабинете не понимал, что по нему можно перейти — приходилось выделять и
 * копировать вручную.
 *
 * Обрабатываем ТОЛЬКО текстовые узлы и не заходим внутрь уже существующих
 * `<a>`: иначе ссылка обернулась бы в ссылку.
 */
function linkifyTextNodes(root: Element, doc: Document): void {
  const RE = /(https?:\/\/[^\s<>"')]+)/g

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        if ((child as Element).tagName.toLowerCase() === 'a') continue
        walk(child)
        continue
      }
      if (child.nodeType !== 3) continue

      const text = child.nodeValue || ''
      if (!RE.test(text)) { RE.lastIndex = 0; continue }
      RE.lastIndex = 0

      const frag = doc.createDocumentFragment()
      let last = 0
      let m: RegExpExecArray | null
      while ((m = RE.exec(text))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)))
        // Хвостовая точка/запятая — часть предложения, а не адреса.
        const raw = m[1].replace(/[.,;:!?]+$/, '')
        const a = doc.createElement('a')
        a.setAttribute('href', raw)
        a.textContent = raw
        frag.appendChild(a)
        if (raw.length < m[1].length) frag.appendChild(doc.createTextNode(m[1].slice(raw.length)))
        last = m.index + m[1].length
      }
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)))
      child.parentNode?.replaceChild(frag, child)
    }
  }
  walk(root)
}

/** Экранирование, чтобы обычный текст можно было безопасно пропустить через DOM. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Очистка БЕЗ браузера — для страниц, которые рисует сервер.
 *
 * ⚠️ Нужна потому, что основной sanitize работает через DOMParser, а на сервере
 * его нет: он возвращал пустоту, и разметка вываливалась на экран сырыми тегами
 * («<b>Основатель…» на публичной странице спикера).
 *
 * Правило простое: оставляем только теги из ALLOWED_TAGS и БЕЗ атрибутов, всё
 * прочее срезаем. Атрибуты не разбираем намеренно — на сервере проверить схему
 * ссылки нечем, а пропустить `javascript:` или `onclick` нельзя. Ссылки в такой
 * записи станут обычным текстом; в браузере тот же текст пройдёт полный
 * sanitize и снова станет кликабельным.
 */
function sanitizeServer(html: string): string {
  return fixReversedClosingTags(html)
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(\/?)\s*([a-z0-9]+)\b[^>]*>/gi, (_m, slash: string, tag: string) =>
      ALLOWED_TAGS.has(tag.toLowerCase()) && tag.toLowerCase() !== 'a'
        ? `<${slash}${tag.toLowerCase()}>`
        : '')
}

function sanitize(html: string): string {
  if (typeof window === 'undefined') return sanitizeServer(html)
  const doc = new DOMParser().parseFromString(`<div>${fixReversedClosingTags(html)}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  // ⚠️ ДО очистки: созданные здесь <a> пройдут ту же проверку схемы и получат
  // target/rel — отдельных правил для них заводить не нужно.
  linkifyTextNodes(root, doc)

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
  // ⚠️ Через sanitize прогоняем и ТЕКСТ БЕЗ ТЕГОВ — ради автоссылок: в уроках
  // адреса пишут обычным набором («изучи майндкарту https://xmind.ai/…»), и
  // раньше такой текст шёл мимо обработки и оставался некликабельным.
  const clean = useMemo(() => {
    if (!value) return ''
    if (looksLikeHtml(value)) return sanitize(value)
    return /https?:\/\//i.test(value) ? sanitize(escapeHtml(value)) : ''
  }, [value])

  if (!value) return null

  // Старая запись без разметки и без ссылок — показываем текстом, сохраняя переносы.
  //
  // ⚠️ Если разметка ЕСТЬ, а очистить её не удалось, показывать `value` как
  // текст нельзя: теги вывалятся на экран. Так и было на серверных страницах
  // (`/sp/{код}`) — sanitize работает только в браузере (ему нужен DOMParser) и
  // на сервере возвращает пустоту, поэтому организатор видел «<b>Основатель…».
  // Здесь безопаснее убрать теги, чем показать их человеку.
  if (!clean) {
    const text = looksLikeHtml(value)
      ? value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
      : value
    return (
      <div className={`whitespace-pre-wrap ${className}`} style={style}>{text}</div>
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
