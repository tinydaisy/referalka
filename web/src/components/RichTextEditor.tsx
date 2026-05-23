'use client'

/**
 * Минимальный визуальный редактор HTML — B, I, U, ссылка.
 *
 * Реализация — нативный contentEditable + execCommand. Без внешних редакторов
 * вроде TipTap/Slate (по правилу проекта «без UI-библиотек»).
 *
 * Что умеет:
 * - Жирный, курсив, подчёркивание
 * - Создание ссылок (с диалогом для ввода URL)
 * - Снятие форматирования
 * - Переключение «Текст ↔ HTML» (для редактирования сырого HTML)
 * - sanitizes на onChange: оставляем только разрешённые теги/атрибуты
 *
 * Allowlist: <b>/<strong>, <i>/<em>, <u>, <a href>, <br>.
 * Блочные теги (div/p/li) при sanitize заменяются на <br>.
 *
 * Использование:
 *   const editorRef = useRef<RichTextEditorHandle>(null)
 *   <RichTextEditor ref={editorRef} value={html} onChange={setHtml} />
 *   // перед save — editorRef.current?.getValue() возвращает АКТУАЛЬНОЕ
 *   // содержимое (важно если user не успел потерять фокус на редакторе).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

export interface RichTextEditorHandle {
  /** Возвращает текущее значение редактора (с sanitize), даже если onChange ещё не успел сработать. */
  getValue: () => string
}

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number      // примерная высота в «строках» (16px каждая)
  className?: string
}

// Совместимо с Telegram-парсером (parse_mode=HTML): b/strong, i/em, u, s, a, br, code, pre.
// Никаких div/p/span/ul/ol/li — Telegram такие теги отвергает.
const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'br', 'code', 'pre',
])
// Блочные теги, которые браузер вставляет в contentEditable вместо переносов.
// Заменяем содержимое на текст+<br> вместо тупого удаления — чтобы не терялись
// разрывы строк, которые пользователь видел в редакторе.
const BLOCK_TAGS_TO_BR = new Set(['div', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const ALLOWED_ATTRS_PER_TAG: Record<string, string[]> = {
  a: ['href', 'target', 'rel'],
}
const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']

function sanitize(html: string): string {
  if (typeof window === 'undefined') return html
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      walk(child)
    }
    const tag = node.tagName.toLowerCase()
    if (BLOCK_TAGS_TO_BR.has(tag)) {
      // Разворачиваем содержимое наружу + добавляем перенос строки <br>
      // перед следующим элементом (если это не первая обёртка).
      const parent = node.parentNode
      if (!parent) return
      const isLast = !node.nextSibling
      // Переносим всех детей наружу
      while (node.firstChild) {
        parent.insertBefore(node.firstChild, node)
      }
      // Вставляем <br> между блоками (не после последнего)
      if (!isLast) {
        const br = doc.createElement('br')
        parent.insertBefore(br, node)
      }
      parent.removeChild(node)
      return
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // Заменяем на текст-контент (сохраняем содержимое, но без обёртки)
      const text = node.textContent || ''
      const replacement = doc.createTextNode(text)
      node.replaceWith(replacement)
      return
    }
    // Срезаем недопустимые атрибуты
    const allowed = ALLOWED_ATTRS_PER_TAG[tag] || []
    for (const attr of Array.from(node.attributes)) {
      if (!allowed.includes(attr.name)) {
        node.removeAttribute(attr.name)
      }
    }
    // Для <a> — валидация URL-схемы
    if (tag === 'a') {
      const href = node.getAttribute('href') || ''
      try {
        const u = new URL(href, 'https://placeholder.local/')
        if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) {
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

const RichTextEditor = forwardRef<RichTextEditorHandle, Props>(function RichTextEditor({
  value, onChange, placeholder, rows = 8, className = '',
}, ref) {
  const editorRef = useRef<HTMLDivElement>(null)
  const sourceValueRef = useRef<string>(value)  // последнее значение в source-mode
  const [showSource, setShowSource] = useState(false)

  // Imperative API — позволяет родителю получить актуальное значение
  // напрямую из DOM (не дожидаясь, пока сработает onChange после onBlur).
  useImperativeHandle(ref, () => ({
    getValue: () => {
      if (showSource) return sourceValueRef.current
      const el = editorRef.current
      if (!el) return value
      return sanitize(el.innerHTML)
    },
  }), [showSource, value])

  // Инициализация и внешние изменения value (только если редактор НЕ в фокусе,
  // иначе курсор будет «прыгать» при каждом нажатии клавиши).
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (document.activeElement === el) return
    if (el.innerHTML !== value) el.innerHTML = value || ''
  }, [value])

  // Заставляем contentEditable вставлять <br> при Enter, а не <div> или <p>
  // (Telegram parse_mode=HTML отвергает div/p — см. sanitize).
  useEffect(() => {
    try {
      document.execCommand('defaultParagraphSeparator', false, 'br')
    } catch {
      /* not supported on some browsers */
    }
  }, [])

  // Перехватываем Enter и вставляем <br> вручную — самый надёжный способ
  // не получить <div> от движка contentEditable.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      document.execCommand('insertLineBreak')
      flush()
    }
  }

  function exec(command: string, arg?: string) {
    document.execCommand(command, false, arg)
    flush()
  }

  function flush() {
    const el = editorRef.current
    if (!el) return
    const cleaned = sanitize(el.innerHTML)
    onChange(cleaned)
  }

  function insertLink() {
    const url = window.prompt('Введите URL ссылки', 'https://')
    if (!url) return
    let normalized = url.trim()
    if (!/^(?:https?|mailto|tel):/.test(normalized)) {
      normalized = 'https://' + normalized
    }
    exec('createLink', normalized)
  }

  function clearFormatting() {
    exec('removeFormat')
    document.execCommand('unlink', false, undefined)
    flush()
  }

  const minH = `${Math.max(rows * 20, 80)}px`

  return (
    <div className={`border border-gray-200 rounded-xl bg-white ${className}`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 px-2 py-2">
        <button type="button" onClick={() => exec('bold')}
          className="px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-gray-100"
          title="Жирный (Ctrl/Cmd + B)">B</button>
        <button type="button" onClick={() => exec('italic')}
          className="px-3 py-1.5 rounded-lg text-sm italic hover:bg-gray-100"
          title="Курсив (Ctrl/Cmd + I)">I</button>
        <button type="button" onClick={() => exec('underline')}
          className="px-3 py-1.5 rounded-lg text-sm underline hover:bg-gray-100"
          title="Подчёркнутый (Ctrl/Cmd + U)">U</button>
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button type="button" onClick={insertLink}
          className="px-3 py-1.5 rounded-lg text-sm hover:bg-gray-100"
          title="Вставить ссылку">🔗 Ссылка</button>
        <button type="button" onClick={() => exec('insertUnorderedList')}
          className="px-3 py-1.5 rounded-lg text-sm hover:bg-gray-100"
          title="Маркированный список">• Список</button>
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button type="button" onClick={clearFormatting}
          className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
          title="Снять форматирование">⌫ Очистить</button>
        <span className="flex-1" />
        <button type="button" onClick={() => setShowSource(s => !s)}
          className="px-3 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-gray-100"
          title="Редактировать сырой HTML">
          {showSource ? '✓ Визуально' : '<> HTML'}
        </button>
      </div>

      {/* Editor */}
      {showSource ? (
        <textarea
          value={value}
          onChange={e => { sourceValueRef.current = e.target.value; onChange(e.target.value) }}
          placeholder={placeholder}
          className="w-full px-4 py-3 text-sm font-mono focus:outline-none rounded-b-xl"
          style={{ minHeight: minH, resize: 'vertical' }}
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={flush}
          onBlur={flush}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            // Запрет на богатый paste — берём только текст
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            document.execCommand('insertText', false, text)
          }}
          className="w-full px-4 py-3 text-sm focus:outline-none whitespace-pre-wrap"
          style={{ minHeight: minH, lineHeight: 1.5 }}
          data-placeholder={placeholder || ''}
        />
      )}

      {/* Подсказка-плейсхолдер через CSS-псевдо. Курсив + светло-серый —
          чтобы пользователь не путал с реальным введённым текстом. */}
      <style jsx>{`
        [contenteditable]:empty::before {
          content: attr(data-placeholder);
          color: #cbd5e1;
          font-style: italic;
          pointer-events: none;
          opacity: 0.8;
        }
        [contenteditable] a {
          color: #2563eb;
          text-decoration: underline;
        }
      `}</style>
    </div>
  )
})

export default RichTextEditor
