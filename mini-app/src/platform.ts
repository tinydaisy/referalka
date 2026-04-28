/**
 * Адаптер платформы для Mini App.
 *
 * Один и тот же бандл планируется крепить и к Telegram, и к VK Mini App,
 * и к MAX Mini App. Всё, что специфично для платформы (юзер, startParam,
 * запрос разрешения боту/сообществу писать в ЛС, цвета шапки и фона) —
 * проходит через единый интерфейс PlatformAdapter.
 *
 * Чтобы добавить VK или MAX по-настоящему:
 *   1) поставить SDK: `npm i @vkontakte/vk-bridge` (для MAX — соответствующий)
 *   2) импортировать его в нужном адаптере ниже и заполнить методы
 *   3) detectPlatform() автоматически выберет нужный адаптер
 */

export type PlatformName = 'telegram' | 'vk' | 'max' | 'web'

export type PlatformUser = {
  id: number | string
  first_name?: string
  last_name?: string
  username?: string
}

export interface PlatformAdapter {
  name: PlatformName
  ready(): void
  user: PlatformUser | null
  startParam: string | undefined
  /**
   * Просит у пользователя разрешения боту/сообществу писать в ЛС.
   * Колбэк вызывается ПОСЛЕ ответа пользователя (или мгновенно, если
   * разрешение уже было выдано раньше). granted=false — отказ или
   * платформа не умеет такого запроса.
   *
   * Это критично: без разрешения Telegram возвращает 403 на sendMessage
   * и человек не получает приветствие = не становится подписчиком бота.
   */
  requestWriteAccess(onDone: (granted: boolean) => void): void
  setHeaderColor?(hex: string): void
  setBackgroundColor?(hex: string): void
}

function telegramAdapter(): PlatformAdapter | null {
  const twa = (window as any).Telegram?.WebApp
  // Просто проверяем наличие SDK. initData/initDataUnsafe могут быть
  // пустыми в момент первого открытия — это не повод считать что мы
  // не в Telegram, иначе уйдём в webFallback и потеряем startParam.
  if (!twa) return null
  const u = twa.initDataUnsafe?.user
  return {
    name: 'telegram',
    ready: () => { twa.ready?.(); twa.expand?.() },
    user: u
      ? { id: u.id, first_name: u.first_name, last_name: u.last_name, username: u.username }
      : null,
    startParam: twa.initDataUnsafe?.start_param as string | undefined,
    requestWriteAccess: (cb) => {
      if (typeof twa.requestWriteAccess === 'function') {
        try {
          twa.requestWriteAccess((granted: boolean) => cb(granted !== false))
        } catch {
          cb(false)
        }
      } else {
        cb(false)
      }
    },
    setHeaderColor: (h) => twa.setHeaderColor?.(h),
    setBackgroundColor: (h) => twa.setBackgroundColor?.(h),
  }
}

// Каркас VK-адаптера. Подключится когда поставим @vkontakte/vk-bridge.
function vkAdapter(): PlatformAdapter | null {
  const w = window as any
  const bridge = w.vkBridge || w.VKBridge
  if (!bridge) return null
  return {
    name: 'vk',
    ready: () => { try { bridge.send?.('VKWebAppInit') } catch {} },
    user: null,
    startParam: undefined,
    requestWriteAccess: (cb) => {
      // эквивалент в VK — VKWebAppAllowMessagesFromGroup (нужен group_id)
      cb(false)
    },
  }
}

// Каркас MAX-адаптера. Подключится когда добавим официальный SDK.
function maxAdapter(): PlatformAdapter | null {
  const w = window as any
  const bridge = w.maxBridge || w.MAX
  if (!bridge) return null
  return {
    name: 'max',
    ready: () => {},
    user: null,
    startParam: undefined,
    requestWriteAccess: (cb) => cb(false),
  }
}

function webFallback(): PlatformAdapter {
  return {
    name: 'web',
    ready: () => {},
    user: null,
    startParam: undefined,
    requestWriteAccess: (cb) => cb(false),
  }
}

export function detectPlatform(): PlatformAdapter {
  return telegramAdapter() || vkAdapter() || maxAdapter() || webFallback()
}
