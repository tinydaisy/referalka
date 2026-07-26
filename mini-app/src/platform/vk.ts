import bridge from '@vkontakte/vk-bridge'
import type { PlatformAdapter, PlatformUser } from './index'
import { webFallback } from './index'

/**
 * VK Mini App адаптер. Launch params VK передаёт через query-string фрейма
 * (`?vk_user_id=…&vk_app_id=…&sign=…`). Глубокая ссылка — через hash `#…`.
 */

let _email: string | null = null
let _phone: string | null = null

export async function initPlatform(): Promise<PlatformAdapter> {
  const sp = new URLSearchParams(window.location.search)
  const launchParams: Record<string, string> = {}
  sp.forEach((v, k) => { launchParams[k] = v })
  const isVk = !!(launchParams.vk_user_id && launchParams.sign)
  if (!isVk) return webFallback()

  try { await bridge.send('VKWebAppInit') } catch (e) { console.warn('VKWebAppInit failed', e) }

  // Глубокая ссылка `vk.com/app{id}#m_...` приходит в hash. НО VK далеко не
  // всегда пробрасывает hash в iframe приложения — особенно при «холодном»
  // открытии через промежуточную страницу «Запустить» (непроверенное Mini App):
  // VK открывает наш iframe БЕЗ hash → `window.location.hash` пустой → ветка
  // m_/p_/evl_ не срабатывала → открывался дефолтный Mini App с вкладкой
  // событий вместо заглушки лид-магнита (баг Ольги Самоленковой, 2026-07-27).
  //
  // Надёжный источник — VKWebAppGetLaunchParams: VK возвращает оригинальный
  // `vk_ref` (наш payload после #) даже когда его нет в URL. Плюс небольшой
  // ретрай — VK иногда проставляет hash чуть позже инициализации.
  const readHash = (): string => {
    const h = window.location.hash
    return h.startsWith('#') ? h.slice(1) : h
  }
  let bridgeRef = ''
  try {
    const lp2: any = await bridge.send('VKWebAppGetLaunchParams')
    if (lp2 && typeof lp2 === 'object') {
      // vk_ref = наш payload (m_slug / p_slug / evl_… / spkinv_… / prtc_…).
      bridgeRef = String(lp2.vk_ref || lp2.hash || lp2.startapp || '')
      // Обогащаем launchParams значениями из Bridge (vk_group_id, vk_app_id и т.д.)
      for (const [k, v] of Object.entries(lp2)) {
        if (launchParams[k] === undefined && v != null) launchParams[k] = String(v)
      }
    }
  } catch (e) { console.warn('VKWebAppGetLaunchParams failed', e) }

  // Ретрай чтения hash: до 5 попыток по 100мс (VK может проставить его позже).
  let hash = readHash()
  if (!hash) {
    for (let i = 0; i < 5 && !hash; i++) {
      await new Promise(r => setTimeout(r, 100))
      hash = readHash()
    }
  }

  // vk_ref из URL — VK кладёт наш payload сюда при переходе по ссылке-приглашению.
  // Формат бывает `vk_ref=m_slug` ИЛИ `ref=m_slug`. Берём то, что похоже на payload.
  const looksLikePayload = (s: string) =>
    /^(m_|p_|evl_|ref_|spkinv_|spkreg_|prtc_|prtp_|prt_|partner_done_|fnl_)/.test(s)
  const urlRef = String(
    launchParams.vk_ref || launchParams.hash || launchParams.startapp ||
    launchParams.ref || launchParams.ref_source || '')

  const startParam =
    (hash && looksLikePayload(hash) ? hash : '') ||
    (bridgeRef && looksLikePayload(bridgeRef) ? bridgeRef : '') ||
    (urlRef && looksLikePayload(urlRef) ? urlRef : '') ||
    hash ||
    bridgeRef ||
    urlRef ||
    undefined

  let user: PlatformUser | null = null
  try {
    const info: any = await bridge.send('VKWebAppGetUserInfo')
    user = {
      id: info.id,
      first_name: info.first_name,
      last_name: info.last_name,
      username: info.screen_name,
      photo_url: info.photo_200,
    }
  } catch (e) {
    console.warn('VKWebAppGetUserInfo failed', e)
    if (launchParams.vk_user_id) {
      user = { id: Number(launchParams.vk_user_id) }
    }
  }

  return {
    name: 'vk',
    ready: async () => {},
    user,
    startParam,
    launchParams,
    requestWriteAccess: (opts, cb) => {
      const gid = Number(opts.vkGroupId || 0) || Number(launchParams.vk_group_id || 0)
      if (!gid) { cb(false); return }
      bridge.send('VKWebAppAllowMessagesFromGroup', { group_id: gid })
        .then((r: any) => cb(!!r?.result))
        .catch(() => cb(false))
    },
    joinGroup: (opts, cb) => {
      const gid = Number(opts.vkGroupId || 0) || Number(launchParams.vk_group_id || 0)
      if (!gid) { cb(false); return }
      bridge.send('VKWebAppJoinGroup', { group_id: gid })
        .then((r: any) => cb(!!r?.result))
        .catch(() => cb(false))
    },
    openExternal: (url: string) => {
      // Семантика «openExternal» в VK Mini App = «открыть во внешнем браузере,
      // не закрывая Mini App». VK Bridge API для этого нет (есть только
      // OpenApp/PayForm/QR/Contacts/WallPost). Рабочий путь — `<a target="_blank">`:
      // VK на мобильном обычно делегирует системному браузеру (Safari/Chrome),
      // на десктопе — открывает новую вкладку. Mini App остаётся.
      // window.top.location.href раньше использовался для universal-link iOS,
      // но он закрывал Mini App и грузил URL в VK in-app webview — это и было
      // «открывается внутри приложения». Оставлен как fallback.
      try {
        const a = document.createElement('a')
        a.href = url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        return
      } catch (_) { /* fall through */ }
      try {
        if (window !== window.top && window.top) {
          window.top.location.href = url
          return
        }
      } catch (_) { /* CORS */ }
      window.location.href = url
    },
    redirectTo: (url: string) => {
      // window.location.replace на VK iframe ведёт себя по-разному:
      //  - iOS: VK Bridge закрывает Mini App и открывает URL в встроенном
      //    Safari View (внутри VK app) — пользователь видит лендинг как часть
      //    приложения.
      //  - Android: VK выкидывает в системный Chrome ВНЕ приложения —
      //    пользователь не понимает что произошло, /r/{slug}-возврат ломается.
      // VKWebAppOpenApp (по слухам подходит) — это для других Mini App.
      // Рабочий универсальный способ — навигация ВЕРХНЕГО окна (window.top),
      // это закрывает Mini App и навигирует браузерный таб на лендинг
      // одинаково на iOS и Android (VK выгрузит свой UI и юзер увидит сайт).
      try {
        if (window !== window.top && window.top) {
          window.top.location.replace(url)
          return
        }
      } catch (_) { /* CORS — fallback */ }
      window.location.replace(url)
    },
    close: () => {
      bridge.send('VKWebAppClose', { status: 'success' }).catch(() => {})
    },
    setHeaderColor: (hex) => {
      bridge.send('VKWebAppSetViewSettings', { status_bar_style: 'light', action_bar_color: hex }).catch(() => {})
    },
    setBackgroundColor: () => { /* нет аналога в VK */ },
  }
}

/** Запрос email через VK Bridge — показывает диалог. */
export async function requestVkEmail(): Promise<string | null> {
  try {
    const r: any = await bridge.send('VKWebAppGetEmail')
    _email = r?.email || null
    return _email
  } catch { return null }
}

/** Запрос телефона через VK Bridge. До модерации может быть отказ. */
export async function requestVkPhone(): Promise<string | null> {
  try {
    const r: any = await bridge.send('VKWebAppGetPhoneNumber')
    _phone = r?.phone_number || null
    return _phone
  } catch { return null }
}
