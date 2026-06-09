/**
 * Web-адаптер: тот же Mini App, открытый в обычном браузере (вне Telegram/VK),
 * под путём `pluson.ru/event/{slug}`. Публичная веб-витрина события — те же
 * вкладки, та же вёрстка, узкая центральная колонка (см. index_web.html).
 *
 * Главное отличие от TG/VK: в браузере нет подписанного initData с tg_id.
 * Человек идентифицируется по `contact_id` из query (?c=123) — его кладёт бэк,
 * когда даёт ссылку из бота, либо мы сами после регистрации на встроенном
 * лендинге (этап 2). Без contact_id — анонимный просмотр (только лендинг/витрина).
 *
 * Вкладка открывается по `#hash` (например `/event/cygum#speakers`) — это даёт
 * прямые ссылки на любую вкладку без отдельных HTML-страниц.
 */
import type { PlatformAdapter } from './index'

export async function initPlatform(): Promise<PlatformAdapter> {
  const sp = new URLSearchParams(window.location.search)

  // slug события — из пути `/event/{slug}` (как parsePathSlug в App.tsx).
  const slugMatch = window.location.pathname.match(/event\/([^/]+)/)
  const slug = slugMatch ? slugMatch[1] : ''

  // contact_id — кто этот человек (из бота / после регистрации). Опционально.
  const contactId = sp.get('c') || sp.get('contact_id') || ''

  // Начальная вкладка — из `#hash` (#speakers, #program, …) или ?_tab=.
  const hashTab = (window.location.hash || '').replace(/^#/, '').trim()
  const qsTab = sp.get('_tab') || ''
  const initialTab = hashTab || qsTab

  // Собираем startParam в формате, который понимает App.parseStartParam:
  // ref_pg{slug}[_pid..][_src..][_tab..]. Так веб-режим переиспользует ту же
  // логику открытия события и выбора начальной вкладки, что TG/VK.
  let startParam: string | undefined
  if (slug) {
    const parts = [`ref_pg${slug}`]
    const pid = sp.get('pid')
    const src = sp.get('utm_source') || sp.get('src')
    if (pid) parts.push(`pid${pid}`)
    if (src) parts.push(`src${src}`)
    if (initialTab) parts.push(`tab${initialTab}`)
    startParam = parts.join('_')
  }

  // «Пользователь» в вебе: если есть contact_id — отдаём его как id, чтобы
  // нижестоящая логика (проверка участия, регистрация) могла к нему привязаться.
  // Иначе null — анонимный гость (видит только публичную витрину).
  const user = contactId
    ? { id: contactId, first_name: sp.get('name') || '', username: '' }
    : null

  return {
    name: 'web',
    ready: async () => {},
    user,
    startParam,
    launchParams: { contact_id: contactId },
    requestWriteAccess: (_opts, cb) => cb(false),
    openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    redirectTo: (url) => { window.location.replace(url) },
    close: () => { /* в браузере закрывать нечего */ },
  }
}
