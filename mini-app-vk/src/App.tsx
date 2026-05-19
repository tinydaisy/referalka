import { useState, useEffect } from 'react'
import Hub from './pages/Hub'
import HubSelector from './pages/HubSelector'
import EventPage from './pages/EventPage'
import LoadingScreen from './components/LoadingScreen'
import SpinnerOverlay from './components/SpinnerOverlay'
import { initPlatform, getLaunchParams, getStartParam, getUser } from './platform'

/*
 * Маршрутизация в VK Mini App:
 * - Запуск без startParam → если есть cid в пути → Hub клиента, иначе HubSelector
 * - Запуск с startParam (hash после #) формата "ref_pg{slug}[_pid{ref}][_src{utm}][_cid{n}][_tab{name}]"
 *   → открываем конкретное событие
 *
 * Аналог TG `startapp`, только в VK Mini App передаётся через `#…` (hash).
 *
 * vk_user_id, sign и прочие vk_* — приходят в query-string при загрузке iframe.
 * Они передаются на /api/v1/vk/event для валидации подписи и регистрации контакта.
 */

// ALLOWLIST: только эти vk_id могут использовать настоящее приложение в период разработки.
// После запуска для всех — очистить массив (пустой = пускать всех).
const ALLOWED_VK_IDS: number[] = [
  // Сюда добавим ваш vk_id когда будет известен (увидим в логах при первом открытии)
]

function detectClientIdFromPath(): number | null {
  const m = window.location.pathname.match(/^\/c\/(\d+)\//)
  if (m) return Number(m[1])
  const sp = new URLSearchParams(window.location.search)
  const cid = sp.get('cid')
  return cid ? Number(cid) : null
}

function parseStartParam(raw: string): {
  eventSlug?: string; partnerId?: string; utmSource?: string; clientId?: number;
  live?: boolean; regFromLanding?: boolean; initialTab?: string
} {
  const r: any = {}
  raw.split('_').forEach(p => {
    if (p.startsWith('pg'))  r.eventSlug  = p.slice(2)
    if (p.startsWith('pid')) r.partnerId  = p.slice(3)
    if (p.startsWith('src')) r.utmSource  = p.slice(3)
    if (p.startsWith('cid')) r.clientId   = Number(p.slice(3))
    if (p === 'live')        r.live       = true
    if (p === 'reg')         r.regFromLanding = true
    if (p.startsWith('tab')) r.initialTab = p.slice(3)
  })
  return r
}

function sendVkEvent(
  launchParams: Record<string, string>,
  user: any,
  partnerId?: string,
  eventSlug?: string,
  clientId?: number,
  utmSource?: string,
  initialTab?: string,
) {
  try {
    fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/event`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        launch_params: launchParams,
        first_name: user?.first_name || '',
        last_name:  user?.last_name  || '',
        username:   user?.username   || '',
        partner_id: partnerId || '',
        event_slug: eventSlug || '',
        utm_source: utmSource || '',
        initial_tab: initialTab || '',
        client_id: clientId || 0,
      }),
    })
  } catch (_) {}
}

function parsePathSlug(): string | null {
  const m = window.location.pathname.match(/event\/([^/]+)/)
  return m ? m[1] : null
}

// VK build base = "/vk/"
const VK_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
const cidPrefix = (cid: number | null) => (cid ? `/c/${cid}` : '')
const homePath  = (cid: number | null) => `${cidPrefix(cid)}${VK_BASE}/`
const eventPath = (cid: number | null, slug: string) =>
  `${cidPrefix(cid)}${VK_BASE}/event/${slug}`

const MOCK_USER = { id: 0, first_name: 'Гость', username: '', last_name: '' }

export default function App() {
  const [loading, setLoading] = useState(true)
  const [vkUser, setVkUser] = useState<any>(null)
  const [eventSlug, setEventSlug] = useState<string | null>(() => parsePathSlug())
  const [clientId, setClientId] = useState<number | null>(() => detectClientIdFromPath())
  const [partnerId, setPartnerId] = useState<string | undefined>()
  const [utmSource, setUtmSource] = useState<string | undefined>()
  const [regFromLanding, setRegFromLanding] = useState<boolean>(false)
  const [initialTab, setInitialTab] = useState<string | undefined>()
  const [pendingOpen, setPendingOpen] = useState<boolean>(false)
  const [accessDenied, setAccessDenied] = useState<boolean>(false)

  useEffect(() => {
    (async () => {
      const adapter = await initPlatform()
      const user = adapter.user
      if (user) setVkUser(user)

      // Allowlist (только в период разработки)
      const userId = user?.id ? Number(user.id) : 0
      if (ALLOWED_VK_IDS.length > 0 && userId && !ALLOWED_VK_IDS.includes(userId)) {
        setAccessDenied(true)
        setLoading(false)
        return
      }

      const sp = adapter.startParam
      let parsed: ReturnType<typeof parseStartParam> = {}
      if (sp && (sp.startsWith('ref') || sp.startsWith('hub'))) {
        parsed = parseStartParam(sp)
        if (parsed.eventSlug) setEventSlug(parsed.eventSlug)
        if (parsed.clientId)  setClientId(parsed.clientId)
        setPartnerId(parsed.partnerId)
        setUtmSource(parsed.utmSource)
        if (parsed.regFromLanding) setRegFromLanding(true)
        if (parsed.initialTab) setInitialTab(parsed.initialTab)
      }

      // Шлём event_start на бэк (асинхронно, не ждём ответа)
      const launchParams = getLaunchParams()
      if (Object.keys(launchParams).length > 0 && launchParams.vk_user_id) {
        sendVkEvent(
          launchParams,
          user,
          parsed.partnerId,
          parsed.eventSlug,
          parsed.clientId,
          parsed.utmSource,
          parsed.initialTab,
        )
      }

      setVkUser(prev => prev || (user || MOCK_USER))
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    const handler = () => setEventSlug(parsePathSlug())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  async function openEvent(slug: string) {
    setPendingOpen(true)
    try {
      const userId = vkUser?.id ? String(vkUser.id) : ''
      const qs = new URLSearchParams()
      // landing-redirect для VK работает аналогично TG: бэк проверяет landing_url
      // и возвращает redirect_url если нужно. Передаём vk_id вместо tg_id.
      if (userId)    qs.set('vk_id', userId)
      if (partnerId) qs.set('pid', partnerId)
      if (utmSource) qs.set('utm_source', utmSource)
      const url = `${import.meta.env.VITE_API_URL}/api/v1/public/events/${encodeURIComponent(slug)}/landing-redirect${qs.toString() ? `?${qs}` : ''}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        if (data && data.redirect_url) {
          window.location.replace(data.redirect_url)
          return
        }
      }
    } catch (_) {}
    window.history.pushState({}, '', eventPath(clientId, slug))
    setEventSlug(slug)
    setPendingOpen(false)
  }

  function backToHub() {
    window.history.pushState({}, '', homePath(clientId))
    setEventSlug(null)
  }

  if (loading) return null

  if (accessDenied) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{
            display: 'inline-block', background: '#FFCFA4', color: '#25455D',
            fontWeight: 600, padding: '6px 14px', borderRadius: 999, fontSize: 13, marginBottom: 20,
          }}>Закрытое тестирование</div>
          <h1 style={{ color: '#FFCFA4', fontSize: 28, margin: '0 0 12px' }}>
            iViSiON: ПЛЮСОН в ВК
          </h1>
          <p style={{ lineHeight: 1.5, opacity: 0.9, fontSize: 16 }}>
            Приложение в финальной стадии запуска. Скоро откроется для всех.
            Следите за анонсами в нашем сообществе.
          </p>
        </div>
      </div>
    )
  }

  const splash = typeof document !== 'undefined' ? document.getElementById('plusson-splash') : null
  if (splash) splash.remove()

  if (eventSlug) {
    return (
      <>
        <EventPage
          slug={eventSlug}
          tgUser={vkUser}
          partnerId={partnerId}
          utmSource={utmSource}
          regFromLanding={regFromLanding}
          initialTab={initialTab}
          onBack={backToHub}
          onOpenEvent={openEvent}
        />
        {pendingOpen && <SpinnerOverlay />}
      </>
    )
  }

  if (clientId) {
    return (
      <>
        <Hub clientId={clientId} tgUser={vkUser} onOpenEvent={openEvent} />
        {pendingOpen && <SpinnerOverlay />}
      </>
    )
  }
  return (
    <>
      <HubSelector tgUser={vkUser} onOpenEvent={openEvent} />
      {pendingOpen && <SpinnerOverlay />}
    </>
  )
}
