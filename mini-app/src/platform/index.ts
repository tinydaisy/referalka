/**
 * Единый platform-адаптер для Mini App.
 *
 * Один и тот же исходный код (табы, страницы, компоненты, api) собирается
 * под разные платформы (Telegram / VK / MAX). Всё что специфично для
 * платформы — инициализация SDK, юзер, startParam, разрешение на сообщения,
 * открытие внешних ссылок — проходит через PlatformAdapter.
 *
 * Точка входа выбирает реализацию через `import { initPlatform } from './platform/<name>'`.
 *
 * См. memory/project_mini_app_unification_plan.md и
 * memory/feedback_check_duplicated_packages.md.
 */

export type PlatformName = 'telegram' | 'vk' | 'max' | 'web'

export type PlatformUser = {
  id: number | string
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
}

export interface PlatformAdapter {
  /** Имя платформы — для условной логики и подстановки в query API */
  name: PlatformName

  /** SDK init (для VK — VKWebAppInit, для TG — ready/expand). Идемпотентна. */
  ready(): Promise<void>

  /** Юзер из SDK (после init). Может быть null если SDK не отдал. */
  user: PlatformUser | null

  /** TG: initDataUnsafe.start_param; VK: hash после `#`; MAX: аналог TG. */
  startParam: string | undefined

  /** VK launch params (vk_user_id, vk_app_id, vk_group_id, sign, …). У TG — {}. */
  launchParams: Record<string, string>

  /**
   * Просит у пользователя разрешение писать ему в личку.
   * - TG: requestWriteAccess (без аргументов).
   * - VK: VKWebAppAllowMessagesFromGroup (нужен group_id).
   * - MAX: аналог TG.
   * cb вызывается с granted=true/false (или мгновенно false если не поддержано).
   */
  requestWriteAccess(opts: { vkGroupId?: number }, cb: (granted: boolean) => void): void

  /**
   * Предложить подписаться на сообщество (только VK — VKWebAppJoinGroup).
   * Это ОТДЕЛЬНО от requestWriteAccess: разрешение писать в ЛС ≠ подписка на
   * сообщество (стену). На TG/MAX — no-op (cb(false)).
   */
  joinGroup?(opts: { vkGroupId?: number }, cb: (joined: boolean) => void): void

  /**
   * Открыть внешнюю ссылку.
   * - TG: openTelegramLink или openLink.
   * - VK: window.top.location (iframe → universal link iOS).
   * - MAX: аналог TG.
   */
  openExternal(url: string): void

  /**
   * Hard-redirect текущего webview на URL — для landing-redirect на сторонний
   * лендинг клиента (Tilda/GetCourse). НЕ open external — webview уходит, и
   * после регистрации клиент возвращает на /r/{slug} (см. recipe в docs).
   *
   * - TG: window.location.replace — работает внутри Telegram webview.
   * - VK: bridge.send('VKWebAppRedirect') — обязательно через мост, иначе на
   *   Android `window.location.replace` выкидывает пользователя в Chrome
   *   вне VK app (на iOS «случайно» работает).
   * - MAX: аналог TG.
   */
  redirectTo(url: string): void

  /** Закрыть Mini App (если поддержано). */
  close(): void

  /** Установить цвет шапки/фона (если поддержано). */
  setHeaderColor?(hex: string): void
  setBackgroundColor?(hex: string): void
}

/**
 * Глобальный текущий адаптер. Каждая точка входа (main-tg.tsx / main-vk.tsx
 * / main-max.tsx) после `initPlatform()` обязана вызвать `setPlatform(adapter)`.
 * После этого `getPlatform()` доступен из любого модуля (не только React).
 *
 * Зачем не Context: api.ts и helper-ы вызываются вне дерева компонентов
 * (через fetch / preact-like utility) — Context там недоступен.
 */
let _platform: PlatformAdapter | null = null

export function setPlatform(p: PlatformAdapter): void {
  _platform = p
}

export function getPlatform(): PlatformAdapter {
  if (!_platform) {
    // Поздний доступ до init — fallback, чтобы не валиться с null.
    return webFallback()
  }
  return _platform
}

export function getPlatformName(): PlatformName {
  return getPlatform().name
}

/**
 * Платформа определяется во время сборки: каждая точка входа (main-tg.tsx /
 * main-vk.tsx / main-max.tsx) импортирует свой адаптер и передаёт его в App.
 * Если адаптера нет — webFallback (для локальной отладки вне SDK).
 */
export function webFallback(): PlatformAdapter {
  return {
    name: 'web',
    ready: async () => {},
    user: null,
    startParam: undefined,
    launchParams: {},
    requestWriteAccess: (_opts, cb) => cb(false),
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    redirectTo: (url) => { window.location.replace(url) },
    close: () => { /* noop */ },
  }
}
