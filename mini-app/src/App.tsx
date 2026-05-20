import { useState, useEffect } from 'react'
import Hub from './pages/Hub'
import HubSelector from './pages/HubSelector'
import EventPage from './pages/EventPage'
import LoadingScreen from './components/LoadingScreen'
import SpinnerOverlay from './components/SpinnerOverlay'
import { getPlatform, getPlatformName, type PlatformAdapter } from './platform'

/*
 * Единый App для всех платформ (Telegram / VK / MAX).
 * Платформа уже инициализирована точкой входа (main-tg / main-vk / main-max).
 * Здесь — только общая логика приложения. Места где поведение различается
 * (init event_start, регистрация контакта, обработка funnel-ссылок, allowlist
 * VK, FunnelStatusScreen) — обёрнуты в `if (platform.name === 'vk')` и т.п.
 *
 * Маршрутизация без startapp:
 * - Mini App в общем @pluson_bot   → HubSelector (список событий + промо iViSiON: ПЛЮСОН)
 * - Mini App в боте клиента (VIP)  → Hub этого клиента
 *
 * Идентификатор клиента берётся из URL `/c/{N}/tg/` или `/c/{N}/vk/`.
 */
function detectClientIdFromPath(): number | null {
  const m = window.location.pathname.match(/^\/c\/(\d+)\//)
  if (m) return Number(m[1])
  const sp = new URLSearchParams(window.location.search)
  const cid = sp.get('cid')
  return cid ? Number(cid) : null
}

// Парсит startapp: "ref_pg{slug}[_pid{ref}][_src{utm}][_cid{n}][_tab{name}][_live][_reg]"
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

function parsePathSlug(): string | null {
  const m = window.location.pathname.match(/event\/([^/]+)/)
  return m ? m[1] : null
}

// Vite собирает с фиксированным base="/tg/" или "/vk/" — ассеты грузятся с
// /<base>/assets/... HTML может отдаваться по /c/{N}/<base>/ через nginx alias.
const APP_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
const cidPrefix = (cid: number | null) => (cid ? `/c/${cid}` : '')
const homePath  = (cid: number | null) => `${cidPrefix(cid)}${APP_BASE}/`
const eventPath = (cid: number | null, slug: string) =>
  `${cidPrefix(cid)}${APP_BASE}/event/${slug}`

const MOCK_USER = { id: 0, first_name: 'Гость', username: '', last_name: '' }

// ── VK-специфичная обработка funnel-ссылок (m_<slug> / p_<slug> / fnl_<id>) ──
// На TG бот сам обрабатывает /start m_<slug>; на VK мы приземляемся в Mini App
// и должны сами стартовать воронку через /api/v1/vk/funnel-landing.
async function handleVkFunnelIfNeeded(
  adapter: PlatformAdapter,
  setFunnelStatus: (s: 'ok' | 'fail' | null) => void,
  setFunnelGroupId: (n: number) => void,
  setLoading: (b: boolean) => void,
): Promise<boolean> {
  if (adapter.name !== 'vk') return false
  const sp = adapter.startParam
  if (!sp) return false
  const lp = adapter.launchParams

  // Новый формат `m_<slug>[_pid_src]` / `p_<slug>[_pid_src]`
  const funnelMatch = /^([mp])_([^_]+)((?:_pid[^_]+)?(?:_src[^_]+)?(?:_pid[^_]+)?(?:_src[^_]+)?)$/.exec(sp)
  if (funnelMatch) {
    const kind = funnelMatch[1] as 'm' | 'p'
    const slug = funnelMatch[2]
    const rest = funnelMatch[3] || ''
    const pidMatch = /_pid([^_]+)/.exec(rest)
    const srcMatch = /_src([^_]+)/.exec(rest)
    let ok = false
    let groupId = 0
    if (lp.vk_user_id) {
      let gid = Number(lp.vk_group_id || 0)
      if (!gid && lp.vk_app_id) {
        try {
          const g: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/group-for-app?app_id=${lp.vk_app_id}`)
            .then(x => x.ok ? x.json() : null)
          if (g?.group_id) gid = Number(g.group_id)
        } catch (_) {}
      }
      await new Promise<void>((resolve) => {
        if (!gid) return resolve()
        adapter.requestWriteAccess({ vkGroupId: gid }, () => resolve())
      })
      try {
        const r: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/funnel-landing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            launch_params: lp,
            kind, slug,
            partner_id: pidMatch ? pidMatch[1] : '',
            utm_source: srcMatch ? srcMatch[1] : '',
          }),
        }).then(x => x.ok ? x.json() : null)
        if (r?.ok) {
          ok = true
          groupId = Number(r.group_id || gid || 0)
        }
      } catch (e) { console.warn('funnel-landing failed', e) }
    }
    setFunnelStatus(ok ? 'ok' : 'fail')
    setFunnelGroupId(groupId)
    setLoading(false)
    return true
  }

  // Старый формат `fnl_<run_id>` (через pluson.ru/m/{slug}?to=vk → 302)
  if (sp.startsWith('fnl_')) {
    const runId = Number(sp.slice(4))
    let ok = false
    let groupId = 0
    if (runId && lp.vk_user_id) {
      try {
        const r: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/funnel-start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ launch_params: lp, run_id: runId }),
        }).then(x => x.ok ? x.json() : null)
        if (r?.ok) {
          ok = true
          groupId = Number(r.group_id || lp.vk_group_id || 0)
        }
      } catch (e) { console.warn('funnel-start failed', e) }
    }
    setFunnelStatus(ok ? 'ok' : 'fail')
    setFunnelGroupId(groupId)
    setLoading(false)
    return true
  }

  return false
}

// ── VK event_start: /api/v1/vk/event с возможной повторной отправкой email/phone ──
async function sendVkEventStart(
  adapter: PlatformAdapter,
  user: any,
  parsed: ReturnType<typeof parseStartParam>,
) {
  if (adapter.name !== 'vk') return
  const lp = adapter.launchParams
  if (!lp.vk_user_id) return

  let groupId = Number(lp.vk_group_id || 0)
  if (!groupId && lp.vk_app_id) {
    try {
      const r: any = await fetch(`/api/v1/vk/group-for-app?app_id=${lp.vk_app_id}`)
        .then(x => x.ok ? x.json() : null)
      if (r?.group_id) groupId = Number(r.group_id)
    } catch { /* skip */ }
  }

  adapter.requestWriteAccess({ vkGroupId: groupId }, async () => {
    const status = await sendVkEvent(lp, user, parsed.partnerId, parsed.eventSlug,
      parsed.clientId, parsed.utmSource, parsed.initialTab)

    const needEmail = !status.has_email
    const needPhone = !status.has_phone
    if (!needEmail && !needPhone) return

    const { requestVkEmail, requestVkPhone } = await import('./platform/vk')
    const [emailVal, phoneVal] = await Promise.all([
      needEmail ? requestVkEmail() : Promise.resolve(null),
      needPhone ? requestVkPhone() : Promise.resolve(null),
    ])
    if (emailVal || phoneVal) {
      sendVkEvent(lp, user, parsed.partnerId, parsed.eventSlug, parsed.clientId,
        parsed.utmSource, parsed.initialTab, emailVal, phoneVal)
    }
  })
}

async function sendVkEvent(
  launchParams: Record<string, string>,
  user: any,
  partnerId?: string,
  eventSlug?: string,
  clientId?: number,
  utmSource?: string,
  initialTab?: string,
  email?: string | null,
  phone?: string | null,
): Promise<{ has_email: boolean; has_phone: boolean }> {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/event`, {
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
        email: email || '',
        phone: phone || '',
      }),
    })
    if (res.ok) {
      const data: any = await res.json()
      return { has_email: !!data?.has_email, has_phone: !!data?.has_phone }
    }
  } catch (_) {}
  return { has_email: true, has_phone: true }
}

export default function App() {
  const [loading, setLoading] = useState(true)
  const [tgUser, setTgUser] = useState<any>(null)
  const [eventSlug, setEventSlug] = useState<string | null>(() => parsePathSlug())
  const [clientId, setClientId] = useState<number | null>(() => detectClientIdFromPath())
  const [partnerId, setPartnerId] = useState<string | undefined>()
  const [utmSource, setUtmSource] = useState<string | undefined>()
  const [regFromLanding, setRegFromLanding] = useState<boolean>(false)
  const [initialTab, setInitialTab] = useState<string | undefined>()
  const [pendingOpen, setPendingOpen] = useState<boolean>(false)
  // VK-only: экран статуса воронки лид-магнита после m_/p_/fnl_ landing
  const [funnelStatus, setFunnelStatus] = useState<'ok' | 'fail' | null>(null)
  const [funnelGroupId, setFunnelGroupId] = useState<number>(0)

  useEffect(() => {
    (async () => {
      const adapter = getPlatform()
      adapter.setHeaderColor?.('#0a1520')
      adapter.setBackgroundColor?.('#f7f8fa')

      const user = adapter.user
      if (user) setTgUser(user)

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

      // VK-only: воронка лид-магнита по startparam (m_/p_/fnl_).
      // Если сработала — показываем FunnelStatusScreen и прерываем стандартный flow.
      const handled = await handleVkFunnelIfNeeded(adapter, setFunnelStatus, setFunnelGroupId, setLoading)
      if (handled) return

      // Флаг ?_reg=1 — пришли с /r/{slug} в fallback-режиме.
      const qsReg = new URLSearchParams(window.location.search).get('_reg')
      if (qsReg === '1') setRegFromLanding(true)

      // ?_tab=… — Mini App открыт через web_app inline-кнопку без startapp.
      const qsTab = new URLSearchParams(window.location.search).get('_tab')
      if (qsTab && !parsed.initialTab) setInitialTab(qsTab)

      // Live-метка (TG, общая): пришли по публичной live-ссылке.
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

      // VK event_start — диалог write_access → /vk/event → опционально GetEmail/GetPhone.
      // TG event_start — выполняется inline-скриптом в index_tg.html ДО React (в user-gesture).
      if (adapter.name === 'vk') {
        sendVkEventStart(adapter, user, parsed)
      }

      setTgUser(prev => prev || (user || MOCK_USER))

      // TG-only: ждём ответа от inline-скрипта /landing-redirect (см. index_tg.html).
      // VK сразу снимает loading.
      if (adapter.name === 'telegram') {
        const minDelayMs = 600
        const startTs = Date.now()
        let cancelled = false
        function tick() {
          if (cancelled) return
          const pending = (window as any).__redirectPending === true
          const elapsed = Date.now() - startTs
          if (!pending && elapsed >= minDelayMs) { setLoading(false); return }
          if (elapsed >= 3500) { setLoading(false); return }
          setTimeout(tick, 50)
        }
        tick()
        return () => { cancelled = true }
      } else {
        setLoading(false)
      }
    })()
  }, [])

  // URL роутинг: popstate
  useEffect(() => {
    const handler = () => setEventSlug(parsePathSlug())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // Перед открытием события через SPA-навигацию (клик из Хаба) — проверяем
  // у бэка нет ли редиректа на сторонний лендинг клиента.
  async function openEvent(slug: string) {
    setPendingOpen(true)
    try {
      const tgId = tgUser?.id ? String(tgUser.id) : ''
      const qs = new URLSearchParams()
      if (tgId) {
        // На бэке landing-redirect принимает И tg_id, И vk_id.
        qs.set(getPlatformName() === 'vk' ? 'vk_id' : 'tg_id', tgId)
      }
      if (partnerId) qs.set('pid', partnerId)
      if (utmSource) qs.set('utm_source', utmSource)
      const url = `${import.meta.env.VITE_API_URL}/api/v1/public/events/${encodeURIComponent(slug)}/landing-redirect${qs.toString() ? `?${qs}` : ''}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        if (data && data.redirect_url) {
          window.location.replace(data.redirect_url)
          return  // webview уплывает
        }
      }
    } catch (_) { /* offline / 5xx → обычный flow */ }
    window.history.pushState({}, '', eventPath(clientId, slug))
    setEventSlug(slug)
    setPendingOpen(false)
  }

  function backToHub() {
    window.history.pushState({}, '', homePath(clientId))
    setEventSlug(null)
  }

  if (loading) return null  // splash в index.html виден поверх #root

  const splash = typeof document !== 'undefined' ? document.getElementById('plusson-splash') : null
  if (splash) splash.remove()

  // VK-only: экран статуса воронки лид-магнита (Текст 1 уехал в личку)
  if (funnelStatus) {
    return <FunnelStatusScreen status={funnelStatus} groupId={funnelGroupId} />
  }

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

// VK-only экран: после успешного запуска воронки лид-магнита (или после фейла).
// Текст 1 уехал в личку сообщества — пользователю остаётся открыть чат.
function FunnelStatusScreen({ status, groupId }: { status: 'ok' | 'fail'; groupId: number }) {
  const chatUrl = groupId ? `https://vk.com/im?sel=-${groupId}` : ''
  function close() {
    getPlatform().close()
    if (chatUrl) {
      try { window.top!.location.href = chatUrl } catch { window.location.href = chatUrl }
    }
  }
  if (status === 'ok') {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
        color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%', background: '#FFCFA4',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 24px',
          }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#25455D" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h1 style={{ color: '#FFCFA4', fontSize: 24, margin: '0 0 12px', fontWeight: 700 }}>
            Подарки уже в чате
          </h1>
          <p style={{ lineHeight: 1.5, opacity: 0.9, fontSize: 15, margin: '0 0 28px' }}>
            Откройте диалог с сообществом — там лежит сообщение со списком ваших подарков
            и кнопкой «ГОТОВО» для их получения.
          </p>
          {chatUrl && (
            <a href={chatUrl} target="_top" style={{
              display: 'inline-block', background: '#FFCFA4', color: '#25455D',
              fontWeight: 700, padding: '14px 32px', borderRadius: 12, fontSize: 16,
              textDecoration: 'none', boxShadow: '0 4px 14px rgba(255,207,164,0.4)',
              marginBottom: 12,
            }}>Открыть чат</a>
          )}
          <div>
            <button onClick={close} style={{
              background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)',
              fontSize: 14, cursor: 'pointer', padding: '8px 16px',
            }}>Закрыть приложение</button>
          </div>
        </div>
      </div>
    )
  }
  // fail
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(45deg, #25455D, #0a1520)',
      color: '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ color: '#FFCFA4', fontSize: 22, margin: '0 0 12px', fontWeight: 700 }}>
          Что-то пошло не так
        </h1>
        <p style={{ lineHeight: 1.5, opacity: 0.9, fontSize: 15, margin: '0 0 24px' }}>
          Попробуйте перейти по ссылке ещё раз. Если ошибка повторится — напишите
          организатору в сообщество.
        </p>
        {chatUrl && (
          <a href={chatUrl} target="_top" style={{
            display: 'inline-block', background: '#FFCFA4', color: '#25455D',
            fontWeight: 700, padding: '12px 28px', borderRadius: 12, fontSize: 15,
            textDecoration: 'none',
          }}>Написать организатору</a>
        )}
      </div>
    </div>
  )
}
