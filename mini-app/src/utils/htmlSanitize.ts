// Безопасный рендер пользовательского HTML в описаниях события.
// Клиент в дашборде вводит HTML в textarea — мы пропускаем его через
// allowlist тегов и атрибутов, чтобы исключить <script>, on*-handlers,
// javascript:-ссылки и прочее.
//
// Используется в LandingTab + *ProgramTab. На бэке для рассылок
// (telegram-шаблоны pre_conf/custom) теги стрипятся отдельно
// (см. backend/app/services/message_builder.py).

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR',
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL',
  'A',
  'UL', 'OL', 'LI',
  'H2', 'H3', 'H4',
  'BLOCKQUOTE',
  'SPAN', 'DIV',
])

// Атрибуты разрешены только для <a>. На остальных тегах — атрибуты
// вообще не пропускаем (style/class могут сломать вёрстку или подложить
// position:fixed-overlay).
const ALLOWED_A_ATTRS = new Set(['href', 'target', 'rel'])
const ALLOWED_URL_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:']

function isSafeHref(value: string): boolean {
  const v = (value || '').trim()
  if (!v) return false
  // Относительные ссылки (#anchor, /path) — безопасны.
  if (v.startsWith('#') || v.startsWith('/')) return true
  try {
    const u = new URL(v, 'https://example.com/')
    return ALLOWED_URL_SCHEMES.includes(u.protocol)
  } catch {
    return false
  }
}

function sanitizeNode(node: Element): void {
  // Сначала рекурсивно проходим детей (копируем список — будем мутировать).
  const children = Array.from(node.children)
  for (const child of children) sanitizeNode(child)

  // Запрещённый тег — заменяем сам элемент на его текстовое содержимое.
  if (!ALLOWED_TAGS.has(node.tagName)) {
    const parent = node.parentNode
    if (!parent) return
    while (node.firstChild) parent.insertBefore(node.firstChild, node)
    parent.removeChild(node)
    return
  }

  // Чистим атрибуты.
  const attrs = Array.from(node.attributes)
  for (const attr of attrs) {
    const name = attr.name.toLowerCase()
    if (node.tagName === 'A' && ALLOWED_A_ATTRS.has(name)) {
      if (name === 'href' && !isSafeHref(attr.value)) {
        node.removeAttribute(attr.name)
      }
      continue
    }
    node.removeAttribute(attr.name)
  }

  // Для внешних ссылок ставим target=_blank + rel=noopener noreferrer.
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  }
}

export function sanitizeHtml(input: string): string {
  if (!input) return ''
  try {
    const doc = new DOMParser().parseFromString(`<div>${input}</div>`, 'text/html')
    const root = doc.body.firstElementChild
    if (!root) return ''
    sanitizeNode(root)
    return root.innerHTML
  } catch {
    return ''
  }
}

// Грубый детектор: содержит ли строка HTML-теги. Нужен чтобы старые
// тексты без тегов продолжали рендериться как plain (с pre-wrap),
// а не сжимать переносы строк в один абзац.
export function looksLikeHtml(s: string): boolean {
  if (!s) return false
  return /<\/?[a-z][\s\S]*?>/i.test(s)
}
