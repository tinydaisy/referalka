import type { PlatformAdapter } from './index'
import { webFallback } from './index'

/**
 * MAX Mini App адаптер. SDK подключается тегом в index_max.html:
 *   <script src="https://st.max.ru/js/max-web-app.js"></script>
 * После этого доступен global `window.WebApp` (без префикса `Telegram.`).
 * API почти идентичен Telegram WebApp — поэтому реализация — копия telegram.ts
 * с заменой источника объекта.
 *
 * Backend MAX уже работает (миграция 090, max_api/max_auth/max_event/max_webhook).
 * См. memory/project_mini_app_unification_plan.md.
 */
export async function initPlatform(): Promise<PlatformAdapter> {
  const w: any = window as any
  const max = w.WebApp
  if (!max) return webFallback()

  try { max.ready?.(); max.expand?.() } catch {}

  const u = max.initDataUnsafe?.user

  return {
    name: 'max',
    ready: async () => { try { max.ready?.(); max.expand?.() } catch {} },
    user: u
      ? { id: u.id, first_name: u.first_name, last_name: u.last_name, username: u.username }
      : null,
    startParam: max.initDataUnsafe?.start_param as string | undefined,
    launchParams: {},
    requestWriteAccess: (_opts, cb) => {
      if (typeof max.requestWriteAccess === 'function') {
        try { max.requestWriteAccess((granted: boolean) => cb(granted !== false)) }
        catch { cb(false) }
      } else { cb(false) }
    },
    openExternal: (url: string) => {
      if (typeof max.openLink === 'function') {
        try { max.openLink(url); return } catch {}
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    redirectTo: (url: string) => {
      // MAX SDK почти идентичен Telegram WebApp — внутри webview navigate работает
      // корректно. Если в будущем выяснится та же проблема что у VK на Android —
      // переписать на window.top.location или нативный метод SDK.
      window.location.replace(url)
    },
    close: () => { try { max.close?.() } catch {} },
    setHeaderColor: (h) => { try { max.setHeaderColor?.(h) } catch {} },
    setBackgroundColor: (h) => { try { max.setBackgroundColor?.(h) } catch {} },
  }
}
