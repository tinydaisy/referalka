import type { PlatformAdapter } from './index'
import { webFallback } from './index'

/** Telegram Mini App адаптер — на базе window.Telegram.WebApp */
export async function initPlatform(): Promise<PlatformAdapter> {
  const twa = (window as any).Telegram?.WebApp
  if (!twa) return webFallback()

  try { twa.ready?.(); twa.expand?.() } catch {}

  const u = twa.initDataUnsafe?.user

  return {
    name: 'telegram',
    ready: async () => { try { twa.ready?.(); twa.expand?.() } catch {} },
    user: u
      ? { id: u.id, first_name: u.first_name, last_name: u.last_name, username: u.username }
      : null,
    startParam: twa.initDataUnsafe?.start_param as string | undefined,
    launchParams: {},
    requestWriteAccess: (_opts, cb) => {
      if (typeof twa.requestWriteAccess === 'function') {
        try {
          twa.requestWriteAccess((granted: boolean) => cb(granted !== false))
        } catch { cb(false) }
      } else {
        cb(false)
      }
    },
    openExternal: (url: string) => {
      if (typeof twa.openTelegramLink === 'function' && /^https?:\/\/t\.me\//i.test(url)) {
        try { twa.openTelegramLink(url); return } catch {}
      }
      if (typeof twa.openLink === 'function') {
        try { twa.openLink(url); return } catch {}
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    close: () => { try { twa.close?.() } catch {} },
    setHeaderColor: (h) => { try { twa.setHeaderColor?.(h) } catch {} },
    setBackgroundColor: (h) => { try { twa.setBackgroundColor?.(h) } catch {} },
  }
}
