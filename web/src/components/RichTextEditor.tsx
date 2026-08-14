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
 * ДВА РЕЖИМА (проп `mode`):
 *  - `telegram` (по умолчанию) — для рассылок. Allowlist: b/strong, i/em, u,
 *    s, a, br, code, pre. Блочные теги (div/p/li/h*) сворачиваются в <br>:
 *    Telegram их отвергает, сообщение с <ul> просто не уйдёт.
 *  - `web` — для страниц (Коллабораторная, визитка основателя, Mini App).
 *    Дополнительно разрешены ul/ol/li, p, h2/h3, blockquote; на панели
 *    появляются кнопки списков, а Enter внутри списка создаёт новый пункт.
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
  /**
   * Куда пойдёт текст — от этого зависит набор разрешённых тегов.
   *
   * `telegram` (по умолчанию) — для рассылок: Telegram отвергает списки и
   * абзацы, поэтому они превращаются в переносы строк. Менять это правило
   * нельзя: сообщение с `<ul>` просто не уйдёт («can't parse entities»).
   *
   * `web` — для страниц (Коллабораторная, визитка основателя, Mini App):
   * там обычный HTML, списки и абзацы отображаются как есть.
   */
  mode?: 'telegram' | 'web'
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

// ── Режим `web` ──
// Списки и абзацы на обычной странице отображаются нормально, поэтому здесь
// они разрешены. Заголовки оставляем со второго уровня: <h1> на странице уже
// занят названием, второй сломал бы структуру документа.
const ALLOWED_TAGS_WEB = new Set([
  ...ALLOWED_TAGS, 'ul', 'ol', 'li', 'p', 'h2', 'h3', 'blockquote',
])
// В web-режиме в <br> сворачиваем только то, что осталось лишним: <div> от
// contentEditable и заголовки, которые мы не разрешили.
const BLOCK_TAGS_TO_BR_WEB = new Set(['div', 'h1', 'h4', 'h5', 'h6'])

const ALLOWED_ATTRS_PER_TAG: Record<string, string[]> = {
  a: ['href', 'target', 'rel'],
}
const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']

function sanitize(html: string, mode: 'telegram' | 'web' = 'telegram'): string {
  if (typeof window === 'undefined') return html
  const allowedTags = mode === 'web' ? ALLOWED_TAGS_WEB : ALLOWED_TAGS
  const blockToBr = mode === 'web' ? BLOCK_TAGS_TO_BR_WEB : BLOCK_TAGS_TO_BR

  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  const walk = (node: Element) => {
    // ⚠️ Обходим ВСЕ узлы-потомки, а не срез `node.children` на момент входа.
    // Разворачивая блочный тег, мы поднимаем его детей в родителя — если
    // список зафиксирован заранее, поднятые узлы остаются необработанными
    // (Chrome вкладывает <div> в <div>, и внутренний уезжал сырым).
    let child = node.firstElementChild
    while (child) {
      const next = child.nextElementSibling
      walk(child)
      child = next
    }
    const tag = node.tagName.toLowerCase()
    if (blockToBr.has(tag)) {
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
    if (!allowedTags.has(tag)) {
      // ⚠️ Разворачиваем содержимое наружу, а НЕ заменяем на textContent.
      // Chrome оборачивает выделение в <span style="font-weight:bold">
      // (styleWithCSS), а вокруг всего содержимого — в <font>. Схлопывание
      // в голый текст убивало вложенное форматирование, а когда обёртка
      // накрывала весь текст — стирало его целиком при первом же нажатии «B».
      const parent = node.parentNode
      if (!parent) return
      // Сохраняем смысл обёртки: жирный/курсив через inline-style браузера
      // превращаем в <b>/<i>, иначе форматирование пропадёт при чистке.
      const style = node.getAttribute('style') || ''
      const wrapWith =
        /font-weight\s*:\s*(bold|[6-9]00)/i.test(style) ? 'b'
        : /font-style\s*:\s*italic/i.test(style) ? 'i'
        : /text-decoration[^;]*underline/i.test(style) ? 'u'
        : null
      if (wrapWith && allowedTags.has(wrapWith)) {
        const wrapper = doc.createElement(wrapWith)
        while (node.firstChild) wrapper.appendChild(node.firstChild)
        parent.replaceChild(wrapper, node)
        return
      }
      while (node.firstChild) {
        parent.insertBefore(node.firstChild, node)
      }
      parent.removeChild(node)
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
  value, onChange, placeholder, rows = 8, className = '', mode = 'telegram',
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
      return sanitize(el.innerHTML, mode)
    },
  }), [showSource, value, mode])

  // Инициализация и внешние изменения value (только если редактор НЕ в фокусе,
  // иначе курсор будет «прыгать» при каждом нажатии клавиши).
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (document.activeElement === el) return

    // ⚠️ ПОЛЕ — ХОЗЯИН СВОЕГО ТЕКСТА. Забираем содержимое из `value` только
    // пока пользователь ничего не набрал (первая загрузка данных с сервера)
    // либо когда родитель осознанно очистил поле.
    //
    // Раньше эффект перезаписывал поле на КАЖДОЕ изменение `value`, и это
    // стирало набранный текст: в форме с несколькими редакторами соседний
    // setForm со снимком старого состояния возвращал сюда пустую строку —
    // текст исчезал прямо во время ввода. Именно так терялась «Капелька
    // безумия» в карточке коллаба.
    const typed = (el.textContent || '').trim().length > 0
    const incomingEmpty = !(value || '').trim()
    if (typed && !incomingEmpty) return

    if (sanitize(el.innerHTML, mode) === value) return
    if (el.innerHTML !== value) el.innerHTML = value || ''
  }, [value, mode])

  // Native DOM listener — onInput от React в contentEditable срабатывает
  // ненадёжно (известный баг). Цепляем addEventListener напрямую.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    const handler = () => {
      const cleaned = sanitize(el.innerHTML, mode)
      onChange(cleaned)
    }
    el.addEventListener('input', handler)
    el.addEventListener('blur', handler)
    return () => {
      el.removeEventListener('input', handler)
      el.removeEventListener('blur', handler)
    }
  }, [onChange, mode])

  // Заставляем contentEditable вставлять <br> при Enter, а не <div> или <p>
  // (Telegram parse_mode=HTML отвергает div/p — см. sanitize).
  useEffect(() => {
    try {
      document.execCommand('defaultParagraphSeparator', false, 'br')
      // ⚠️ Просим браузер оформлять жирный/курсив ТЕГАМИ (<b>/<i>), а не
      // inline-стилями (<span style="font-weight:bold">). Со стилями чистка
      // была вынуждена разбирать CSS, а любая непокрытая форма означала бы
      // потерю форматирования.
      document.execCommand('styleWithCSS', false, 'false')
    } catch {
      /* not supported on some browsers */
    }
  }, [])

  // Перехватываем Enter и вставляем <br> вручную — самый надёжный способ
  // не получить <div> от движка contentEditable.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      // ⚠️ Внутри списка Enter НЕ перехватываем: браузер сам создаёт новый
      // пункт <li>. Подменишь на <br> — весь список схлопнется в один пункт
      // с переносами, и добавить второй пункт будет нечем.
      if (mode === 'web' && insideList()) return
      e.preventDefault()
      document.execCommand('insertLineBreak')
      flush()
    }
  }

  /** Курсор стоит внутри <ul>/<ol>? */
  function insideList(): boolean {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    let n: Node | null = sel.getRangeAt(0).startContainer
    while (n && n !== editorRef.current) {
      if (n.nodeType === 1) {
        const tag = (n as Element).tagName.toLowerCase()
        if (tag === 'li' || tag === 'ul' || tag === 'ol') return true
      }
      n = n.parentNode
    }
    return false
  }

  function exec(command: string, arg?: string) {
    // Возвращаем фокус в редактор: без него execCommand применяется к
    // документу без выделения внутри contentEditable и работает вхолостую.
    editorRef.current?.focus()
    document.execCommand(command, false, arg)
    flush()
  }

  /**
   * ⚠️ Кнопки панели НЕ должны забирать фокус у редактора.
   *
   * Без preventDefault на mousedown браузер сначала уводит фокус на кнопку —
   * выделение внутри contentEditable схлопывается, срабатывает blur→flush, и
   * только потом отрабатывает execCommand. В таком порядке команда либо не
   * применяется, либо Chrome применяет её ко ВСЕМУ содержимому: пользователь
   * жал «B» и терял весь набранный текст.
   */
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  function flush() {
    const el = editorRef.current
    if (!el) return
    const cleaned = sanitize(el.innerHTML, mode)
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
        <button type="button" onMouseDown={keepFocus} onClick={() => exec('bold')}
          className="px-3 py-1.5 rounded-lg text-sm font-bold hover:bg-gray-100"
          title="Жирный (Ctrl/Cmd + B)">B</button>
        <button type="button" onMouseDown={keepFocus} onClick={() => exec('italic')}
          className="px-3 py-1.5 rounded-lg text-sm italic hover:bg-gray-100"
          title="Курсив (Ctrl/Cmd + I)">I</button>
        <button type="button" onMouseDown={keepFocus} onClick={() => exec('underline')}
          className="px-3 py-1.5 rounded-lg text-sm underline hover:bg-gray-100"
          title="Подчёркнутый (Ctrl/Cmd + U)">U</button>
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button type="button" onMouseDown={keepFocus} onClick={insertLink}
          className="px-3 py-1.5 rounded-lg text-sm hover:bg-gray-100"
          title="Вставить ссылку">🔗 Ссылка</button>
        {/* ⚠️ Списки — только в web-режиме. В telegram-режиме кнопка была бы
            обманом: санитайз тут же схлопывает <ul> в переносы строк, потому
            что Telegram списки не принимает. */}
        {mode === 'web' && (
          <>
            <button type="button" onMouseDown={keepFocus} onClick={() => exec('insertUnorderedList')}
              className="px-3 py-1.5 rounded-lg text-sm hover:bg-gray-100"
              title="Маркированный список">• Список</button>
            <button type="button" onMouseDown={keepFocus} onClick={() => exec('insertOrderedList')}
              className="px-3 py-1.5 rounded-lg text-sm hover:bg-gray-100"
              title="Нумерованный список">1. Список</button>
          </>
        )}
        <span className="w-px h-5 bg-gray-200 mx-1" />
        <button type="button" onMouseDown={keepFocus} onClick={clearFormatting}
          className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100"
          title="Снять форматирование">⌫ Очистить</button>
        <span className="flex-1" />
        <button type="button" onMouseDown={keepFocus} onClick={() => setShowSource(s => !s)}
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
