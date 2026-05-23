/**
 * Проверка HTML-разметки сообщения для Telegram (parse_mode=HTML).
 *
 * Поддерживаемые теги: b, strong, i, em, u, s, strike, del, code, pre,
 * a (с обязательным href), tg-spoiler, span (только class="tg-spoiler"),
 * blockquote.
 *
 * Возвращает массив человекочитаемых ошибок. Пустой массив = всё ок.
 */

const ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span', 'br',
])

const SELF_CLOSING = new Set(['br'])

export function validateTelegramHtml(text: string): string[] {
  const errors: string[] = []
  if (!text) return errors

  const stack: { name: string; pos: number }[] = []
  // Регулярка ловит и открывающие, и закрывающие, и самозакрывающиеся теги
  const tagRe = /<\s*(\/?)\s*([a-zA-Z][\w-]*)\b([^>]*?)(\/?)\s*>/g
  let m: RegExpExecArray | null

  while ((m = tagRe.exec(text)) !== null) {
    const isClose = m[1] === '/'
    const name = m[2].toLowerCase()
    const attrs = m[3] || ''
    const selfClose = m[4] === '/' || SELF_CLOSING.has(name)
    const pos = m.index

    if (!ALLOWED_TAGS.has(name)) {
      errors.push(`Тег <${name}> не поддерживается Telegram. Разрешены: b, i, u, s, code, pre, a href, tg-spoiler, blockquote.`)
      continue
    }

    if (isClose) {
      // Закрывающий: должен соответствовать последнему открытому того же типа
      if (stack.length === 0) {
        errors.push(`Закрывающий </${name}> без соответствующего открытия.`)
        continue
      }
      const top = stack[stack.length - 1]
      if (top.name !== name) {
        errors.push(`Тег <${top.name}> не закрыт — встречен </${name}> вместо </${top.name}>.`)
        // Снимаем со стека, чтобы не дублировать ошибку
        stack.pop()
        continue
      }
      stack.pop()
    } else if (!selfClose) {
      // Открывающий — для <a> нужен href
      if (name === 'a' && !/href\s*=\s*["'][^"']+["']/.test(attrs)) {
        errors.push('У тега <a> обязательно нужно указать href="...".')
      }
      stack.push({ name, pos })
    }
  }

  // Незакрытые в конце
  for (const t of stack) {
    errors.push(`Тег <${t.name}> открыт, но не закрыт. Добавьте </${t.name}>.`)
  }

  // Одинокие < без полноценного тега: <bэто, <b, < и т.п. Регулярка тегов
  // выше требует закрывающую >, поэтому такие конструкции остаются молча
  // в тексте. Telegram parse_mode=HTML на них падает с "can't parse entities",
  // плюс в email/VK это выглядит как сломанный кусок.
  // Сначала вырезаем нормальные теги — то что осталось с < явно бракованное.
  const withoutTags = text.replace(tagRe, '')
  const lones = withoutTags.match(/<[^\s<]*/g)
  if (lones) {
    for (const fragment of lones) {
      const sample = fragment.length > 20 ? fragment.slice(0, 20) + '…' : fragment
      errors.push(`Кусок «${sample}» похож на сломанный тег (нет закрывающей «>»). Уберите «<» или допишите тег целиком, например <b>…</b>.`)
    }
  }

  return errors
}


/**
 * Проверка одной inline-кнопки.
 * - text: не должен содержать HTML-теги (Telegram не парсит их в кнопках)
 * - url: должен быть валидной ссылкой (http/https/tg/mailto/tel/t.me)
 */
export function validateButton(text: string, url: string): string[] {
  const errors: string[] = []
  const t = (text || '').trim()
  const u = (url || '').trim()

  if (!t) errors.push('пустой текст кнопки')
  if (!u) errors.push('пустая ссылка кнопки')

  if (t && /<[^>]+>/.test(t)) {
    errors.push('в тексте кнопки нельзя использовать HTML-теги — там только обычный текст')
  }

  if (u) {
    const urlOk = /^(https?:\/\/|tg:\/\/|mailto:|tel:)/.test(u)
    if (!urlOk) {
      // Похоже что в URL вставили текст (или забыли http://)
      if (/<[^>]+>/.test(u) || /\s/.test(u)) {
        errors.push('в поле ссылки указан текст вместо URL — должно быть https://...')
      } else {
        errors.push('ссылка должна начинаться с https:// или http://')
      }
    }
  }

  return errors
}

