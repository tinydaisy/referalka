import bridge from '@vkontakte/vk-bridge'
import type { PlatformAdapter, PlatformUser } from './index'
import { webFallback } from './index'

/**
 * VK Mini App адаптер. Launch params VK передаёт через query-string фрейма
 * (`?vk_user_id=…&vk_app_id=…&sign=…`). Глубокая ссылка — через hash `#…`.
 */

/**
 * Спросить ВКонтакте, но не ждать вечно.
 *
 * ⚠️⚠️ ПОЧЕМУ ЭТО ОБЯЗАТЕЛЬНО. Приложение рисует экран только ПОСЛЕ ответа
 * ВКонтакте. А `VKWebAppGetUserInfo` показывает человеку окно «разрешить
 * доступ к профилю» — и пока он не нажал, обещание не выполняется НИКОГДА:
 * ни ответа, ни ошибки. Окно могло не появиться вовсе (медленная сеть,
 * встроенный браузер, блокировщик) — и человек видел ЗАСТЫВШИЙ ЛОГОТИП,
 * а `catch` не срабатывал, потому что ошибки нет, есть молчание.
 *
 * Так ВКонтакте не открывался у всех две-три недели (найдено 24.08.2026).
 *
 * ⚠️ Не ответил за отведённое время — работаем без этих данных. Кто человек,
 * мы и так знаем: его номер приходит в адресе (`vk_user_id`), заверенный
 * подписью ВКонтакте.
 */
function askVk<T = any>(method: string, params?: any, ms = 3000): Promise<T | null> {
  return Promise.race([
    (bridge.send as any)(method, params).catch((e: any) => {
      console.warn(`${method} отклонён`, e)
      return null
    }),
    new Promise<null>(resolve => setTimeout(() => {
      console.warn(`${method}: ВКонтакте не ответил за ${ms} мс — идём дальше`)
      resolve(null)
    }, ms)),
  ]) as Promise<T | null>
}

export async function initPlatform(): Promise<PlatformAdapter> {
  const sp = new URLSearchParams(window.location.search)
  const launchParams: Record<string, string> = {}
  sp.forEach((v, k) => { launchParams[k] = v })
  const isVk = !!(launchParams.vk_user_id && launchParams.sign)
  if (!isVk) return webFallback()

  // ⚠️⚠️ VKWebAppInit ОБРЫВАТЬ ПО ВРЕМЕНИ НЕЛЬЗЯ. Это рукопожатие: пока оно не
  // прошло, ВКонтакте считает приложение незапущенным и сам показывает
  // «приложение не инициализировано». Ограничение в 2 секунды рвало именно
  // его — экран не открывался вовсе (поймано на проде 24.08).
  //
  // Ждём столько, сколько нужно, но ошибку глушим: если ВКонтакте ответил
  // отказом, пробовать дальше всё равно надо.
  try { await bridge.send('VKWebAppInit') } catch (e) { console.warn('VKWebAppInit отклонён', e) }

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
  {
    const lp2: any = await askVk('VKWebAppGetLaunchParams', undefined, 2000)
    if (lp2 && typeof lp2 === 'object') {
      // vk_ref = наш payload (m_slug / p_slug / evl_… / spkinv_… / prtc_…).
      bridgeRef = String(lp2.vk_ref || lp2.hash || lp2.startapp || '')
      // Обогащаем launchParams значениями из Bridge (vk_group_id, vk_app_id и т.д.)
      for (const [k, v] of Object.entries(lp2)) {
        if (launchParams[k] === undefined && v != null) launchParams[k] = String(v)
      }
    }
  }

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

  // ДИАГНОСТИКА (fire-and-forget): что реально прислал VK при старте. Помогает
  // на ЖИВОМ первом-запуске (экран «Запустить») понять, куда VK кладёт payload,
  // если фронт его не поймал. Ничего не ломает — просто пишет в лог на бэке.
  try {
    fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/diag-launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        hash, bridge_ref: bridgeRef, url_ref: urlRef,
        resolved: startParam || '', launch_params: launchParams,
        raw_hash: window.location.hash, href: window.location.href,
      }),
    }).catch(() => {})
  } catch (_) { /* диагностика не должна ронять старт */ }

  // ⚠️ Имя и фото — приятное дополнение, а не условие запуска. Номер человека
  // мы и так знаем из адреса, он заверен подписью ВКонтакте.
  let user: PlatformUser | null = launchParams.vk_user_id
    ? { id: Number(launchParams.vk_user_id) }
    : null
  const info: any = await askVk('VKWebAppGetUserInfo', undefined, 3000)
  if (info && info.id) {
    user = {
      id: info.id,
      first_name: info.first_name,
      last_name: info.last_name,
      username: info.screen_name,
      photo_url: info.photo_200,
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

// requestVkEmail / requestVkPhone удалены (2026-07): VKWebAppGetEmail и
// VKWebAppGetPhoneNumber = «избыточные права», из-за которых модерация VK
// отклоняла приложение. Контакт из VK создаётся по vk_id + имени — email/телефон
// из VK не запрашиваем.
