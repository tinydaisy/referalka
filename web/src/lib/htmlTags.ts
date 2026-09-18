/**
 * Проверка HTML-тегов в тексте, который человек пишет руками.
 *
 * Зачем. Регалии и блоки карточки коллаба — обычные поля, где можно поставить
 * <b>жирный</b> или ссылку. Ошибиться в теге легко, а последствия неочевидны:
 * незакрытый <b> красит жирным ВЕСЬ остаток текста, а перевёрнутый «<b/>»
 * браузер считает открывающим — ровно так у одного коллаба пожирнели все
 * регалии после слова «Регалии:».
 *
 * Поэтому проверяем при вводе и говорим человеку, что именно не так, — а не
 * молча ломаем страницу.
 */

/** Теги, которые разрешены в этих полях (те же, что понимает показ). */
export const ALLOWED_HTML_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'p',
  'ul', 'ol', 'li', 'h2', 'h3', 'blockquote',
] as const

/**
 * Теги, разрешённые в тексте, который уходит В ТЕЛЕГРАМ (приветствие /start).
 *
 * ⚠️ Набор УЖЕ, чем у веб-полей: Telegram не понимает <br>, <p>, <ul>, <li>,
 * <h2> — и отвергает ВСЁ сообщение целиком, а человек вместо приветствия
 * клиента видит системный фолбэк «Я бот ПЛЮСОН». Список обязан совпадать с
 * TG_ALLOWED_TAGS в backend/app/services/start_greeting.py: разойдутся —
 * кабинет разрешит то, что бэкенд не сохранит, и человек попадёт в тупик.
 */
export const TELEGRAM_HTML_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'span', 'tg-spoiler', 'a', 'code', 'pre', 'blockquote', 'tg-emoji',
] as const

/** Теги без закрывающей пары — их не нужно закрывать. */
const VOID_TAGS = new Set(['br'])

export interface HtmlIssue {
  /** Готовый текст для показа человеку. */
  message: string
}

/**
 * Ищет ошибки в разметке. Пустой массив = всё в порядке.
 *
 * Проверяем ровно три вещи, которые реально ломают страницу:
 *  1. перевёрнутый закрывающий тег — «<b/>» вместо «</b>»;
 *  2. незакрытый тег — «<b>текст» без «</b>»;
 *  3. неизвестный тег — опечатка вроде «<bb>» или запрещённый «<script>».
 */
export function findHtmlIssues(
  text: string,
  allowed: readonly string[] = ALLOWED_HTML_TAGS,
): HtmlIssue[] {
  const src = text || ''
  if (!src.includes('<')) return []

  const issues: HtmlIssue[] = []
  const seen = new Set<string>()
  const add = (message: string) => {
    if (seen.has(message)) return
    seen.add(message)
    issues.push({ message })
  }

  // 1. Перевёрнутый закрывающий тег: <b/> вместо </b>
  // ⚠️ Дефис в имени тега обязателен в шаблоне: у Telegram есть <tg-spoiler>
  // и <tg-emoji>, без дефиса они читались бы как неизвестный тег «tg».
  for (const m of src.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9-]*)\s*\/\s*>/g)) {
    const tag = m[1].toLowerCase()
    if (VOID_TAGS.has(tag)) continue   // <br/> — законная запись
    add(`Тег «${m[0]}» написан задом наперёд — нужно «</${tag}>». Иначе жирным (или курсивом) станет весь текст после него.`)
  }

  // 2 и 3. Разбираем теги по порядку, следим за парами.
  const stack: string[] = []
  for (const m of src.matchAll(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(\/?)\s*>/g)) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const selfClosed = m[3] === '/'

    if (!allowed.includes(tag)) {
      add(`Тег «<${tag}>» не поддерживается. Можно: ${allowed.map(t => `<${t}>`).join(', ')}.`)
      continue
    }
    if (VOID_TAGS.has(tag) || selfClosed) continue

    if (!closing) {
      stack.push(tag)
      continue
    }
    // Закрывающий: ищем ближайший открытый такой же.
    const idx = stack.lastIndexOf(tag)
    if (idx === -1) {
      add(`Есть закрывающий «</${tag}>», но нет открывающего «<${tag}>».`)
    } else {
      // Всё, что осталось открытым внутри, закрыто не было.
      for (const orphan of stack.splice(idx + 1)) {
        add(`Тег «<${orphan}>» не закрыт — добавьте «</${orphan}>».`)
      }
      stack.pop()
    }
  }
  for (const orphan of stack) {
    add(`Тег «<${orphan}>» не закрыт — добавьте «</${orphan}>».`)
  }

  return issues
}
