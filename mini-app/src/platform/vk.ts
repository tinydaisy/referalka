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

  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  const startParam = hash || undefined

  try { await bridge.send('VKWebAppInit') } catch (e) { console.warn('VKWebAppInit failed', e) }

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
