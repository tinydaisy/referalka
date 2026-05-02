import { useState, useEffect } from 'react'
import Hub from './pages/Hub'
import HubSelector from './pages/HubSelector'
import EventPage from './pages/EventPage'
import LoadingScreen from './components/LoadingScreen'
import { detectPlatform, type PlatformName } from './platform'

/*
 * Маршрутизация без startapp:
 * - Mini App в общем @pluson_bot   → HubSelector (список событий + промо ПЛЮСОН)
 * - Mini App в боте клиента (VIP)  → Hub этого клиента
 *
 * Идентификатор клиента берётся из URL пути `/c/{N}/tg/`:
 *   /tg/                            → общий бот (cid не задан)
 *   /c/1/tg/                        → бот клиента 1, Hub клиента 1
 *   /c/1/tg/event/{slug}            → бот клиента 1, конкретное событие
 * Также поддержан query `?cid=N` (legacy) и startapp `_cid{N}`.
 */
function detectClientIdFromPath(): number | null {
  const m = window.location.pathname.match(/^\/c\/(\d+)\//)
  if (m) return Number(m[1])
  const sp = new URLSearchParams(window.location.search)
  const cid = sp.get('cid')
  return cid ? Number(cid) : null
}

// Парсит startapp Telegram: "ref_pgivision-7_pid5725111966_srcinsta_cid1_live"
function parseStartParam(raw: string): {
  eventSlug?: string; partnerId?: string; utmSource?: string; clientId?: number; live?: boolean
} {
  const r: any = {}
  raw.split('_').forEach(p => {
    if (p.startsWith('pg'))  r.eventSlug  = p.slice(2)
    if (p.startsWith('pid')) r.partnerId  = p.slice(3)
    if (p.startsWith('src')) r.utmSource  = p.slice(3)
    if (p.startsWith('cid')) r.clientId   = Number(p.slice(3))
    if (p === 'live')        r.live       = true
  })
  return r
}

function sendPlatformEvent(
  eventName: string,
  user: any,
  partnerId?: string,
  eventSlug?: string,
  clientId?: number,
  platform: PlatformName = 'telegram',
) {
  try {
    fetch(`${import.meta.env.VITE_API_URL}/api/v1/event`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: String(user.id || ''),
        event: eventName,
        first_name: user.first_name || '',
        last_name:  user.last_name  || '',
        username:   user.username   || '',
        partner_id: partnerId || '',
        event_slug: eventSlug || '',
        client_id: clientId || 0,
        platform,
      }),
    })
  } catch (_) {}
}

// Mini App может быть смонтирован по любому базовому пути (например `/tg/`).
// Парсим slug события устойчиво к этому: ищем `event/{slug}` где угодно в пути.
function parsePathSlug(): string | null {
  const m = window.location.pathname.match(/event\/([^/]+)/)
  return m ? m[1] : null
}

// Vite собирает с фиксированным base="/tg/" — ассеты всегда грузятся с /tg/assets/...
// Но HTML может отдаваться по /c/{N}/tg/ через nginx alias — учитываем cid в URL.
const TG_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '') // напр. "/tg"
const cidPrefix = (cid: number | null) => (cid ? `/c/${cid}` : '')
const homePath  = (cid: number | null) =>
  `${cidPrefix(cid)}${TG_BASE}/`
const eventPath = (cid: number | null, slug: string) =>
  `${cidPrefix(cid)}${TG_BASE}/event/${slug}`

const MOCK_USER = { id: 123456789, first_name: 'Тест', username: 'test_user', last_name: '' }

export default function App() {
  const [loading, setLoading] = useState(true)
  const [tgUser, setTgUser] = useState<any>(null)
  const [eventSlug, setEventSlug] = useState<string | null>(() => parsePathSlug())
  const [clientId, setClientId] = useState<number | null>(() => detectClientIdFromPath())
  const [partnerId, setPartnerId] = useState<string | undefined>()
  const [utmSource, setUtmSource] = useState<string | undefined>()
  const [liveMode, setLiveMode] = useState<boolean>(false)

  useEffect(() => {
    const platform = detectPlatform()
    platform.ready()
    platform.setHeaderColor?.('#0a1520')
    platform.setBackgroundColor?.('#f7f8fa')

    const user = platform.user
    if (user) setTgUser(user)

    const sp = platform.startParam
    let parsed: ReturnType<typeof parseStartParam> = {}
    if (sp && (sp.startsWith('ref') || sp.startsWith('hub'))) {
      parsed = parseStartParam(sp)
      if (parsed.eventSlug) setEventSlug(parsed.eventSlug)
      if (parsed.clientId)  setClientId(parsed.clientId)
      setPartnerId(parsed.partnerId)
      setUtmSource(parsed.utmSource)
      if (parsed.live) setLiveMode(true)
    }

    // Live-метка: пользователь пришёл по публичной live-ссылке организатора —
    // сразу ставим event_participants.live_at = now() (окно «в эфире» 120 минут).
    if (parsed.live && parsed.eventSlug && user?.id) {
      fetch(`${import.meta.env.VITE_API_URL}/api/v1/events/${parsed.eventSlug}/live`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tg_id:      Number(user.id),
          first_name: user.first_name || '',
          last_name:  user.last_name  || '',
          username:   user.username   || '',
        }),
      }).catch(() => {})
    }

    // requestWriteAccess + event_start выполняются inline-скриптом в
    // mini-app/index.html ДО монтирования React — там это срабатывает в
    // контексте user gesture (открытие Mini App), как и было в исходном
    // ivision-conf bot.html. Здесь больше ничего по этому поводу не делаем.

    setTgUser(prev => prev || MOCK_USER)
    const t = setTimeout(() => setLoading(false), 600)
    return () => clearTimeout(t)
  }, [])

  // ?? URL роутинг: popstate
  useEffect(() => {
    const handler = () => setEventSlug(parsePathSlug())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  function openEvent(slug: string) {
    window.history.pushState({}, '', eventPath(clientId, slug))
    setEventSlug(slug)
  }

  function backToHub() {
    window.history.pushState({}, '', homePath(clientId))
    setEventSlug(null)
  }

  if (loading) return <LoadingScreen />

  if (eventSlug) {
    return (
      <EventPage
        slug={eventSlug}
        tgUser={tgUser}
        partnerId={partnerId}
        utmSource={utmSource}
        liveMode={liveMode}
        onBack={backToHub}
      />
    )
  }

  // Без startapp:
  // - в боте клиента (есть `?cid=…` или startapp с `_cid…`) → Hub этого клиента
  // - в общем @pluson_bot → HubSelector (список событий участника)
  if (clientId) {
    return <Hub clientId={clientId} tgUser={tgUser} onOpenEvent={openEvent} />
  }
  return <HubSelector tgUser={tgUser} onOpenEvent={openEvent} />
}
