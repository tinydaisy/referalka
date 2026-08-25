'use client'

/**
 * Проверка разметки в тексте, который человек пишет сам (регалии, позиционирование).
 *
 * ⚠️ Зачем. Текст сюда вставляют из заметок и мессенджеров вместе с тегами, и
 * ошибаются в них молча: страница показывает не то, что человек ожидал, а
 * причину он не видит — в поле-то написано «правильно».
 *
 * Ловим три случая, которые реально встречались на проде:
 *  1. `<b/>` вместо `</b>` — браузер считает это ОТКРЫВАЮЩИМ тегом, жирный не
 *     закрывается и «течёт» до конца текста (у коллаба так пожирнели все
 *     регалии после слова «Регалии:»). На выводе это чинит fixReversedClosingTags
 *     в SafeHtml, но человеку всё равно надо сказать — иначе он копит ошибку.
 *  2. Тег открыт и не закрыт — тот же расползающийся жирный.
 *  3. Тег не из белого списка — он просто исчезнет при показе, и человек будет
 *     думать, что оформление «не работает».
 *
 * ⚠️ Список тегов держать в синхроне с ALLOWED_TAGS в SafeHtml.tsx и
 * mini-app/src/utils/htmlSanitize.ts — иначе подсказка начнёт врать про то,
 * что можно.
 */
const ALLOWED_MARKUP_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'br',
  'ul', 'ol', 'li', 'p', 'h2', 'h3', 'blockquote',
])
const SELF_CLOSING_MARKUP_TAGS = new Set(['br'])

export function checkMarkup(text: string): string[] {
  const raw = text || ''
  if (!/<\/?[a-z][\s\S]*?>/i.test(raw)) return []

  const problems: string[] = []
  const open: string[] = []
  const unknown = new Set<string>()
  let reversed = false

  const re = /<\s*(\/?)\s*([a-z0-9]+)\b[^>]*?(\/?)\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const selfClosed = m[3] === '/'

    if (!ALLOWED_MARKUP_TAGS.has(tag)) { unknown.add(tag); continue }
    if (SELF_CLOSING_MARKUP_TAGS.has(tag)) continue

    // `<b/>` — закрывающий тег, написанный задом наперёд.
    if (!closing && selfClosed) { reversed = true; continue }

    if (closing) {
      const i = open.lastIndexOf(tag)
      if (i !== -1) open.splice(i, 1)
    } else {
      open.push(tag)
    }
  }

  if (reversed) {
    problems.push('Закрывающий тег написан задом наперёд: нужно </b>, а не <b/>. Иначе жирным станет весь текст до конца.')
  }
  if (open.length > 0) {
    const list = Array.from(new Set(open)).map(t => `<${t}>`).join(', ')
    problems.push(`Тег открыт, но не закрыт: ${list}. Добавьте закрывающий — например </b>.`)
  }
  if (unknown.size > 0) {
    const list = Array.from(unknown).map(t => `<${t}>`).join(', ')
    problems.push(`Такие теги не поддерживаются и при показе исчезнут: ${list}.`)
  }
  return problems
}

/** Плашка с найденными ошибками разметки. Ничего не нашли — ничего не рисуем. */
export default function MarkupHints({ value }: { value: string }) {
  const problems = checkMarkup(value)
  if (problems.length === 0) return null
  return (
    <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
      {problems.map((p, i) => (
        <div key={i} className={i > 0 ? 'mt-1' : ''}>⚠️ {p}</div>
      ))}
    </div>
  )
}

/** Короткая подсказка «как выделить жирным» — под полем ввода. */
export function MarkupTip() {
  const code = 'rounded bg-gray-100 px-1 font-mono text-[11px] text-[#3a5a72]'
  return (
    <p className="mt-1 text-xs leading-relaxed text-gray-400">
      Выделить жирным: <code className={code}>&lt;b&gt;текст&lt;/b&gt;</code>,
      {' '}курсивом: <code className={code}>&lt;i&gt;текст&lt;/i&gt;</code>.
      {' '}Тег обязательно закрывайте — <code className={code}>&lt;/b&gt;</code>, со слешем впереди.
    </p>
  )
}
