/**
 * Платформенный адаптер для VK Mini App.
 *
 * Этот файл — VK-вариант общего адаптера из mini-app/. Здесь VK Bridge основной,
 * fallback на «web» — для разработки в обычном браузере (без VK iframe).
 *
 * Launch params VK передаёт через query-string фрейма (`?vk_user_id=…&vk_app_id=…&sign=…`).
 * Их же надо передать на бэк для валидации подписи.
 *
 * Запуск с дополнительными параметрами (event_slug, partner_id и т.п.) VK прокидывает
 * через hash после `#` — это VK-аналог Telegram's startapp.
 */
import bridge from '@vkontakte/vk-bridge'

export type PlatformName = 'vk' | 'web'

export type PlatformUser = {
  id: number | string
  first_name?: string
  last_name?: string
  username?: string  // screen_name в VK
  photo_url?: string
}

export interface PlatformAdapter {
  name: PlatformName
  ready(): Promise<void>
  user: PlatformUser | null
  startParam: string | undefined  // VK: содержимое hash после `#` (или undefined)
  launchParams: Record<string, string>  // все vk_* + sign — для отправки на бэк
  requestWriteAccess(onDone: (granted: boolean) => void): void
  setHeaderColor?(hex: string): void
  setBackgroundColor?(hex: string): void
}

let _user: PlatformUser | null = null
let _launchParams: Record<string, string> = {}
let _startParam: string | undefined = undefined
let _isVk = false

export async function initPlatform(): Promise<PlatformAdapter> {
  // Собираем launch params из query-string
  const sp = new URLSearchParams(window.location.search)
  const params: Record<string, string> = {}
  sp.forEach((v, k) => { params[k] = v })
  _launchParams = params
  _isVk = !!(params.vk_user_id && params.sign)

  // startParam — содержимое hash (после '#'), Mini App VK так передаёт глубокие ссылки
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
  _startParam = hash || undefined

  if (_isVk) {
    try {
      await bridge.send('VKWebAppInit')
    } catch (e) {
      console.warn('VKWebAppInit failed', e)
    }
    try {
      const info: any = await bridge.send('VKWebAppGetUserInfo')
      _user = {
        id: info.id,
        first_name: info.first_name,
        last_name: info.last_name,
        username: info.screen_name,
        photo_url: info.photo_200,
      }
    } catch (e) {
      console.warn('VKWebAppGetUserInfo failed', e)
      // fallback: vk_user_id из launch params
      if (params.vk_user_id) {
        _user = { id: Number(params.vk_user_id) }
      }
    }
  }

  return {
    name: _isVk ? 'vk' : 'web',
    ready: async () => {},
    user: _user,
    startParam: _startParam,
    launchParams: _launchParams,
    requestWriteAccess: async (cb) => {
      if (!_isVk) { cb(false); return }
      const groupId = Number((import.meta as any).env.VITE_VK_GROUP_ID || 0)
      if (!groupId) { cb(false); return }
      try {
        const r: any = await bridge.send('VKWebAppAllowMessagesFromGroup', { group_id: groupId })
        cb(!!r?.result)
      } catch {
        cb(false)
      }
    },
    setHeaderColor: (hex) => {
      if (!_isVk) return
      bridge.send('VKWebAppSetViewSettings', { status_bar_style: 'light', action_bar_color: hex }).catch(() => {})
    },
    setBackgroundColor: () => {},
  }
}

// Synchronous getter (после initPlatform)
export function getUser(): PlatformUser | null {
  return _user
}
export function getLaunchParams(): Record<string, string> {
  return _launchParams
}
export function getStartParam(): string | undefined {
  return _startParam
}
export function isVk(): boolean {
  return _isVk
}
