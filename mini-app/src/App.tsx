import { useState, useEffect } from 'react'
import Hub from './pages/Hub'
import EventPage from './pages/EventPage'
import LoadingScreen from './components/LoadingScreen'

// Fallback: в MVP клиент один (Марго). В будущем — определять через `?cid=N` или через startapp `_cid{N}`.
const DEFAULT_CLIENT_ID = Number(import.meta.env.VITE_DEFAULT_CLIENT_ID || '1')

// Парсит startapp Telegram: "ref_pgivision-7_pid5725111966_srcinsta_cid1"
function parseStartParam(raw: string): {
  eventSlug?: string; partnerId?: string; utmSource?: string; clientId?: number
} {
  const r: any = {}
  raw.split('_').forEach(p => {
    if (p.startsWith('pg'))  r.eventSlug  = p.slice(2)
    if (p.startsWith('pid')) r.partnerId  = p.slice(3)
    if (p.startsWith('src')) r.utmSource  = p.slice(3)
    if (p.startsWith('cid')) r.clientId   = Number(p.slice(3))
  })
  return r
}

function sendTgEvent(eventName: string, user: any, partnerId?: string) {
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
      }),
    })
  } catch (_) {}
}

function parsePathSlug(): string | null {
  const m = window.location.pathname.match(/^\/event\/([^/]+)/)
  return m ? m[1] : null
}

const MOCK_USER = { id: 123456789, first_name: 'Тест', username: 'test_user', last_name: '' }

export default function App() {
  const [loading, setLoading] = useState(true)
  const [tgUser, setTgUser] = useState<any>(null)
  const [eventSlug, setEventSlug] = useState<string | null>(() => parsePathSlug())
  const [clientId, setClientId] = useState<number>(DEFAULT_CLIENT_ID)
  const [partnerId, setPartnerId] = useState<string | undefined>()
  const [utmSource, setUtmSource] = useState<string | undefined>()

  useEffect(() => {
    const twa = (window as any).Telegram?.WebApp
    if (twa) {
      twa.ready()
      twa.expand()
      twa.setHeaderColor?.('#080B12')
      twa.setBackgroundColor?.('#080B12')

      const user = twa.initDataUnsafe?.user
      if (user) setTgUser(user)

      const sp = twa.initDataUnsafe?.start_param as string | undefined
      if (sp?.startsWith('ref') || sp?.startsWith('hub')) {
        const parsed = parseStartParam(sp)
        if (parsed.eventSlug) setEventSlug(parsed.eventSlug)
        if (parsed.clientId)  setClientId(parsed.clientId)
        setPartnerId(parsed.partnerId)
        setUtmSource(parsed.utmSource)
        if (user) sendTgEvent('event_start', user, parsed.partnerId)
      }

      twa.requestWriteAccess?.(() => {})
    }
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
    window.history.pushState({}, '', `/event/${slug}`)
    setEventSlug(slug)
  }

  function backToHub() {
    window.history.pushState({}, '', '/')
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
        onBack={backToHub}
      />
    )
  }

  return <Hub clientId={clientId} tgUser={tgUser} onOpenEvent={openEvent} />
}
