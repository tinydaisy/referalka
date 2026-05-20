import { useState, useEffect } from 'react'
import Hub from './pages/Hub'
import HubSelector from './pages/HubSelector'
import EventPage from './pages/EventPage'
import LoadingScreen from './components/LoadingScreen'
import SpinnerOverlay from './components/SpinnerOverlay'
import { detectPlatform, type PlatformName } from './platform'

/*
 * Маршрутизация без startapp:
 * - Mini App в общем @pluson_bot   → HubSelector (список событий + промо iViSiON: ПЛЮСОН)
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
// Флаг `_reg` — человек только что зарегистрировался на стороннем лендинге
// клиента и редиректнулся обратно. Mini App тогда сразу ставит is_registered=true
// (без формы) и показывает welcome-экран.
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
    // _tabgame / _tabprogram / _tabraffle / _tabecosystem — открыть на конкретной вкладке
    if (p.startsWith('tab')) r.initialTab = p.slice(3)
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
  const [regFromLanding, setRegFromLanding] = useState<boolean>(false)
  const [initialTab, setInitialTab] = useState<string | undefined>()
  // pendingOpen — на время fetch /landing-redirect показываем LoadingScreen,
  // чтобы пользователь видел что клик принят (а не «ничего не происходит»).
  const [pendingOpen, setPendingOpen] = useState<boolean>(false)

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
      if (parsed.regFromLanding) setRegFromLanding(true)
      if (parsed.initialTab) setInitialTab(parsed.initialTab)
    }

    // Флаг ?_reg=1 — пришли с /r/{slug} в fallback-режиме (Telegram.WebApp
    // не было на странице /r/, поэтому регистрация перенесена сюда — Mini App
    // зарегистрирует пользователя при первом event_start).
    const qsReg = new URLSearchParams(window.location.search).get('_reg')
    if (qsReg === '1') setRegFromLanding(true)

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

    // Если inline-script в index.html запустил fetch на /landing-redirect и
    // ещё не получил ответ — НЕ снимаем loading, чтобы React не отрендерил
    // EventPage до redirect. Опрашиваем флаг каждые 50ms, фолбэк через
    // 3.5 сек (страховка от зависшего бэка).
    const minDelayMs = 600
    const startTs = Date.now()
    let cancelled = false
    function tick() {
      if (cancelled) return
      const pending = (window as any).__redirectPending === true
      const elapsed = Date.now() - startTs
      if (!pending && elapsed >= minDelayMs) {
        setLoading(false)
        return
      }
      if (elapsed >= 3500) {
        setLoading(false)
        return
      }
      setTimeout(tick, 50)
    }
    tick()
    return () => { cancelled = true }
  }, [])

  // ?? URL роутинг: popstate
  useEffect(() => {
    const handler = () => setEventSlug(parsePathSlug())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // Перед открытием события через SPA-навигацию (клик из Хаба) проверяем
  // у бэка — нет ли редиректа на сторонний лендинг клиента. Если есть —
  // window.location.replace сразу, без рендера EventPage и без заглушки.
  // Если нет — обычный flow (pushState + setEventSlug → EventPage).
  // На время fetch показываем LoadingScreen — иначе кажется, что клик не сработал.
  // См. documentation/MINI-APP-WEBVIEW-REDIRECT.md
  async function openEvent(slug: string) {
    setPendingOpen(true)
    try {
      const tgId = tgUser?.id ? String(tgUser.id) : ''
      const qs = new URLSearchParams()
      if (tgId)     qs.set('tg_id', tgId)
      if (partnerId) qs.set('pid', partnerId)
      if (utmSource) qs.set('utm_source', utmSource)
      const url = `${import.meta.env.VITE_API_URL}/api/v1/public/events/${encodeURIComponent(slug)}/landing-redirect${qs.toString() ? `?${qs}` : ''}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        if (data && data.redirect_url) {
          window.location.replace(data.redirect_url)
          return  // не сбрасываем pendingOpen — webview уже уплывает
        }
      }
    } catch (_) { /* offline / 5xx — fallback на обычный flow */ }
    window.history.pushState({}, '', eventPath(clientId, slug))
    setEventSlug(slug)
    setPendingOpen(false)
  }

  function backToHub() {
    window.history.pushState({}, '', homePath(clientId))
    setEventSlug(null)
  }

  if (loading) return null  // splash в index.html виден поверх #root

  // Когда React готов показать настоящий контент — снимаем HTML-splash.
  // useEffect не подойдёт (рендер уже произошёл): делаем синхронно.
  const splash = typeof document !== 'undefined' ? document.getElementById('plusson-splash') : null
  if (splash) splash.remove()

  if (eventSlug) {
    return (
      <>
        <EventPage
          slug={eventSlug}
          tgUser={tgUser}
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

  // Без startapp:
  // - в боте клиента (есть `?cid=…` или startapp с `_cid…`) → Hub этого клиента
  // - в общем @pluson_bot → HubSelector (список событий участника)
  if (clientId) {
    return (
      <>
        <Hub clientId={clientId} tgUser={tgUser} onOpenEvent={openEvent} initialTab={initialTab} />
        {pendingOpen && <SpinnerOverlay />}
      </>
    )
  }
  return (
    <>
      <HubSelector tgUser={tgUser} onOpenEvent={openEvent} initialTab={initialTab} />
      {pendingOpen && <SpinnerOverlay />}
    </>
  )
}
