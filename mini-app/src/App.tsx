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

// Парсит startapp: "ref_pg{slug}[_pid{ref}][_src{utm}][_cid{n}][_tab{name}][_q{flag}…][_live][_reg]"
// Флаги `_q{flag}` (повторяемые) — произвольные маркеры для активации блоков на
// стороннем лендинге клиента (например `_qshpw` → к URL лендинга приклеится `&shpw=1`).
const FLAG_RE = /^[a-z0-9-]{1,16}$/
function parseStartParam(raw: string): {
  eventSlug?: string; partnerId?: string; utmSource?: string; clientId?: number; contactId?: number;
  live?: boolean; regFromLanding?: boolean; noLanding?: boolean; initialTab?: string; flags?: string[]
} {
  const r: any = {}
  const flags: string[] = []
  raw.split('_').forEach(p => {
    if (p.startsWith('pg'))  r.eventSlug  = p.slice(2)
    else if (p.startsWith('pid')) r.partnerId  = p.slice(3)
    else if (p.startsWith('src')) r.utmSource  = p.slice(3)
    else if (p.startsWith('cid')) r.clientId   = Number(p.slice(3))
    // `_ct{N}` — наш contact_id (НЕ путать с `cid`=client_id). Бэк привяжет
    // платформенную идентичность к этому контакту, чтобы не плодить дубль.
    else if (p.startsWith('ct')) r.contactId = Number(p.slice(2))
    else if (p === 'live')        r.live       = true
    else if (p === 'reg')         r.regFromLanding = true
    // `_nolend` — не показывать сторонний лендинг даже если он задан у события.
    // Регистрируем через внутренний LandingTab. Обрабатываем ДО `tab`/`q`,
    // т.к. это самостоятельный флаг без значения.
    else if (p === 'nolend')      r.noLanding  = true
    else if (p.startsWith('tab')) r.initialTab = p.slice(3)
    else if (p.startsWith('q') && p.length > 1) {
      const k = p.slice(1).toLowerCase()
      if (FLAG_RE.test(k) && !flags.includes(k) && flags.length < 5) flags.push(k)
    }
  })
  if (flags.length) r.flags = flags
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
  setFunnelKind: (k: 'leadmagnet' | 'speaker' | 'partner' | 'event') => void,
  setFunnelEventTitle: (s: string) => void,
  setFunnelPosterUrl: (s: string) => void,
  setFunnelGroupScreen: (s: string) => void,
): Promise<boolean> {
  if (adapter.name !== 'vk') return false
  const sp = adapter.startParam
  if (!sp) return false
  const lp = adapter.launchParams

  // Лёгкая заглушка открытия СОБЫТИЯ: `evl_<slug>[_pid..][_src..][_ct..]`.
  // Альтернатива полному Mini App (`ref_pg`): показываем лёгкий экран
  // «подробности в чате», бэк шлёт в ЛС порт TG-воронки события.
  if (sp.startsWith('evl_')) {
    const rest = sp.slice(4)
    const parts = rest.split('_')
    const slug = parts[0] || ''
    let pid = '', src = '', ct = 0
    for (const chunk of parts.slice(1)) {
      if (chunk.startsWith('pid')) pid = chunk.slice(3)
      else if (chunk.startsWith('src')) src = chunk.slice(3)
      else if (chunk.startsWith('ct')) { const n = Number(chunk.slice(2)); if (Number.isFinite(n) && n > 0) ct = n }
    }
    setFunnelKind('event')
    let ok = false
    let groupId = 0
    if (slug && lp.vk_user_id) {
      let gid = Number(lp.vk_group_id || 0)
      if (!gid && lp.vk_app_id) {
        try {
          const g: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/group-for-app?app_id=${lp.vk_app_id}`)
            .then(x => x.ok ? x.json() : null)
          if (g?.group_id) gid = Number(g.group_id)
        } catch (_) {}
      }
      // Разрешение на ЛС + подписка на сообщество (как у m_/p_).
      await new Promise<void>((resolve) => {
        if (!gid) return resolve()
        adapter.requestWriteAccess({ vkGroupId: gid }, () => resolve())
      })
      if (adapter.joinGroup && gid) {
        try { adapter.joinGroup({ vkGroupId: gid }, () => {}) } catch (_) {}
      }
      const user = adapter.user
      try {
        const r: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/event-landing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            launch_params: lp,
            slug,
            partner_id: pid,
            utm_source: src,
            contact_id: ct,
            first_name: user?.first_name || '',
            last_name:  user?.last_name  || '',
            username:   user?.username   || '',
          }),
        }).then(x => x.ok ? x.json() : null)
        if (r?.ok) {
          ok = true
          groupId = Number(r.group_id || gid || 0)
          if (r.event_title) setFunnelEventTitle(String(r.event_title))
          if (r.poster_url) setFunnelPosterUrl(String(r.poster_url))
          if (r.group_screen) setFunnelGroupScreen(String(r.group_screen))
        }
      } catch (e) { console.warn('vk event-landing failed', e) }
    }
    setFunnelStatus(ok ? 'ok' : 'fail')
    setFunnelGroupId(groupId)
    setLoading(false)
    return true
  }

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
      // Подписка на само сообщество (стену) — отдельное действие от AllowMessages.
      if (adapter.joinGroup && gid) {
        try { adapter.joinGroup({ vkGroupId: gid }, () => {}) } catch (_) {}
      }
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

  // Самообслуживание спикера: `spkinv_<access_code>` (миграция 108).
  // Mini App клиента открывается по `vk.com/app{vk_app_id}#spkinv_<code>` →
  // бэк находит коллаба по коду, апсертит platform_users (vk), шлёт в личку
  // сообщение с кодом доступа и кнопкой «📝 Открыть мой кабинет».
  if (sp.startsWith('spkinv_')) {
    const accessCode = sp.slice(7)
    setFunnelKind('speaker')
    let ok = false
    let groupId = 0
    if (accessCode && lp.vk_user_id) {
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
        const r: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/speaker-invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ launch_params: lp, access_code: accessCode }),
        }).then(x => x.ok ? x.json() : null)
        if (r?.ok) {
          ok = true
          groupId = Number(r.group_id || gid || 0)
        }
      } catch (e) { console.warn('vk speaker-invite failed', e) }
    }
    setFunnelStatus(ok ? 'ok' : 'fail')
    setFunnelGroupId(groupId)
    setLoading(false)
    return true
  }

  // Саморегистрация спикером события (2026-05-29): `spkreg_<event_id>`.
  // Mini App клиента открывается по `vk.com/app{vk_app_id}#spkreg_<id>` →
  // бэк проверяет: если контакт уже в списке спикеров — шлёт ссылку на
  // кабинет с access_code; иначе создаёт коллаба + cse и шлёт ссылку.
  if (sp.startsWith('spkreg_')) {
    const eventId = Number(sp.slice(7))
    setFunnelKind('speaker')
    let ok = false
    let groupId = 0
    if (eventId && lp.vk_user_id) {
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
        const r: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/speaker-self-register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ launch_params: lp, event_id: eventId }),
        }).then(x => x.ok ? x.json() : null)
        if (r?.ok) {
          ok = true
          groupId = Number(r.group_id || gid || 0)
        }
      } catch (e) { console.warn('vk speaker-self-register failed', e) }
    }
    setFunnelStatus(ok ? 'ok' : 'fail')
    setFunnelGroupId(groupId)
    setLoading(false)
    return true
  }

  // Регистрация партнёра — новые форматы (миграция 105+):
  //   `prtc_<client_id>`  — корневая ссылка клиента
  //   `prtp_<contact_id>` — личная ссылка партнёра (рефовод по contact_id)
  // Mini App открывается по vk.com/app{vk_app_id}#prtc_X или #prtp_X.
  // Бэк парсит start_arg, создаёт partner_run, шлёт партнёру в личку
  // приветствие + url-кнопку на лендинг.
  if (sp.startsWith('prtc_') || sp.startsWith('prtp_')) {
    setFunnelKind('partner')
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
        const r: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/partner-invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ launch_params: lp, start_arg: sp }),
        }).then(x => x.ok ? x.json() : null)
        if (r?.ok) {
          ok = true
          groupId = Number(r.group_id || gid || 0)
        }
      } catch (e) { console.warn('vk partner-invite failed', e) }
    }
    setFunnelStatus(ok ? 'ok' : 'fail')
    setFunnelGroupId(groupId)
    setLoading(false)
    return true
  }

  // Legacy формат (миграция 105 первая версия): `prt_<run_id>` для уже разосланных
  // старых ссылок. Используется /api/v1/vk/partner-run-start с уже созданным run_id.
  if (sp.startsWith('prt_')) {
    const runId = Number(sp.slice(4))
    setFunnelKind('partner')
    let ok = false
    let groupId = 0
    if (runId && lp.vk_user_id) {
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
        const r: any = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/vk/partner-run-start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ launch_params: lp, run_id: runId }),
        }).then(x => x.ok ? x.json() : null)
        if (r?.ok) {
          ok = true
          groupId = Number(r.group_id || gid || 0)
        }
      } catch (e) { console.warn('vk partner-run-start failed', e) }
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
    // Помимо разрешения на ЛС — предлагаем подписаться на само сообщество (стену).
    // Это разные действия во ВК: AllowMessages ≠ JoinGroup. group_join на бэке
    // зафиксирует подписавшегося в базе.
    if (adapter.joinGroup) {
      try { adapter.joinGroup({ vkGroupId: groupId }, () => {}) } catch { /* skip */ }
    }
    const status = await sendVkEvent(lp, user, parsed.partnerId, parsed.eventSlug,
      parsed.clientId, parsed.utmSource, parsed.initialTab, null, null, parsed.contactId)

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
        parsed.utmSource, parsed.initialTab, emailVal, phoneVal, parsed.contactId)
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
  contactId?: number,
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
        contact_id: contactId || 0,
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
  const [contactId, setContactId] = useState<number | undefined>()
  const [flags, setFlags] = useState<string[] | undefined>()
  const [regFromLanding, setRegFromLanding] = useState<boolean>(false)
  const [noLanding, setNoLanding] = useState<boolean>(false)
  const [initialTab, setInitialTab] = useState<string | undefined>()
  const [pendingOpen, setPendingOpen] = useState<boolean>(false)
  // VK-only: экран статуса после m_/p_/fnl_/spkinv_/prt_/evl_ landing
  const [funnelStatus, setFunnelStatus] = useState<'ok' | 'fail' | null>(null)
  const [funnelGroupId, setFunnelGroupId] = useState<number>(0)
  const [funnelKind, setFunnelKind] = useState<'leadmagnet' | 'speaker' | 'partner' | 'event'>('leadmagnet')
  const [funnelEventTitle, setFunnelEventTitle] = useState<string>('')
  const [funnelPosterUrl, setFunnelPosterUrl] = useState<string>('')
  const [funnelGroupScreen, setFunnelGroupScreen] = useState<string>('')

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
        if (parsed.contactId) setContactId(parsed.contactId)
        if (parsed.flags && parsed.flags.length) setFlags(parsed.flags)
        if (parsed.regFromLanding) setRegFromLanding(true)
        if (parsed.noLanding) setNoLanding(true)
        if (parsed.initialTab) setInitialTab(parsed.initialTab)
      }

      // VK-only: воронка лид-магнита по startparam (m_/p_/fnl_).
      // Если сработала — показываем FunnelStatusScreen и прерываем стандартный flow.
      const handled = await handleVkFunnelIfNeeded(adapter, setFunnelStatus, setFunnelGroupId, setLoading, setFunnelKind, setFunnelEventTitle, setFunnelPosterUrl, setFunnelGroupScreen)
      if (handled) return

      // Флаг ?_reg=1 — пришли с /r/{slug} в fallback-режиме.
      const qsReg = new URLSearchParams(window.location.search).get('_reg')
      if (qsReg === '1') setRegFromLanding(true)

      // ?_tab=… — Mini App открыт через web_app inline-кнопку без startapp.
      const qsTab = new URLSearchParams(window.location.search).get('_tab')
      if (qsTab && !parsed.initialTab) setInitialTab(qsTab)

      // ?c=… — наш contact_id через query (fallback к `_ct{N}` из startapp).
      if (!parsed.contactId) {
        const qsCt = new URLSearchParams(window.location.search).get('c')
        const ctNum = qsCt ? Number(qsCt) : NaN
        if (Number.isFinite(ctNum) && ctNum > 0) setContactId(ctNum)
      }

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
    })().catch((e) => {
      // Защита: любая ошибка в init не должна вешать splash навсегда.
      console.error('App init failed:', e)
      setLoading(false)
    })
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
      if (flags && flags.length) qs.set('q', flags.join(','))
      const url = `${import.meta.env.VITE_API_URL}/api/v1/public/events/${encodeURIComponent(slug)}/landing-redirect${qs.toString() ? `?${qs}` : ''}`
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        if (data && data.redirect_url) {
          // На VK iframe window.location.replace на Android выкидывает в
          // системный Chrome — используем platform.redirectTo (navigate
          // window.top) для одинакового поведения на iOS и Android.
          getPlatform().redirectTo(data.redirect_url)
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
    return <FunnelStatusScreen status={funnelStatus} groupId={funnelGroupId} kind={funnelKind}
                               eventTitle={funnelEventTitle} posterUrl={funnelPosterUrl}
                               groupScreen={funnelGroupScreen} />
  }

  if (eventSlug) {
    return (
      <>
        <EventPage
          slug={eventSlug}
          tgUser={tgUser}
          partnerId={partnerId}
          utmSource={utmSource}
          contactId={contactId}
          flags={flags}
          regFromLanding={regFromLanding}
          noLanding={noLanding}
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
function FunnelStatusScreen({ status, groupId, kind, eventTitle, posterUrl, groupScreen }: {
  status: 'ok' | 'fail';
  groupId: number;
  kind?: 'leadmagnet' | 'speaker' | 'partner' | 'event';
  eventTitle?: string;
  posterUrl?: string;
  groupScreen?: string;
}) {
  const variant = kind || 'leadmagnet'
  // Для события — кнопка ведёт в чат с ПРЕДЗАПОЛНЕННЫМ текстом (vk.me/{handle}?text=),
  // чтобы человек нажал «отправить» → VK гарантированно регистрирует разрешение на
  // ЛС, и бот сразу отвечает воронкой (страховка от задержки AllowMessages).
  const PREFILL = 'Здравствуйте! Хочу участвовать в событии'
  const chatUrl =
    variant === 'event' && groupScreen
      ? `https://vk.me/${groupScreen}?text=${encodeURIComponent(PREFILL)}`
      : groupId ? `https://vk.com/im?sel=-${groupId}` : ''
  function close() {
    getPlatform().close()
    if (chatUrl) {
      try { window.top!.location.href = chatUrl } catch { window.location.href = chatUrl }
    }
  }
  const TITLE: Record<string, string> = {
    leadmagnet: 'Подарки уже в чате',
    speaker:    'Код доступа уже в чате',
    partner:    'Инструкция уже в чате',
    event:      eventTitle ? `«${eventTitle}»` : 'Подробности в чате',
  }
  const BODY: Record<string, string> = {
    leadmagnet: 'Откройте диалог с сообществом — там лежит сообщение со списком ваших подарков и кнопкой «ГОТОВО».',
    speaker:    'Откройте диалог с сообществом — там сообщение с кодом доступа и кнопкой «Открыть мой кабинет», чтобы заполнить информацию о себе.',
    partner:    'Откройте диалог с сообществом — там сообщение с кнопкой для регистрации вас как партнёра.',
    event:      'Подробности о событии отправлены вам в чат сообщества. Нажмите на кнопку, чтобы открыть диалог.',
  }
  const BTN: Record<string, string> = {
    leadmagnet: 'Открыть чат',
    speaker:    'Открыть чат',
    partner:    'Открыть чат',
    event:      'Открыть чат',
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
          {variant === 'event' && posterUrl ? (
            <img src={posterUrl} alt="" style={{
              width: '100%', maxWidth: 340, borderRadius: 16, marginBottom: 20,
              boxShadow: '0 6px 24px rgba(0,0,0,0.3)',
            }} />
          ) : (
            <div style={{
              width: 72, height: 72, borderRadius: '50%', background: '#FFCFA4',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 24px',
            }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#25455D" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          )}
          <h1 style={{ color: '#FFCFA4', fontSize: 24, margin: '0 0 12px', fontWeight: 700 }}>
            {TITLE[variant]}
          </h1>
          <p style={{ lineHeight: 1.5, opacity: 0.9, fontSize: 15, margin: '0 0 28px' }}>
            {BODY[variant]}
          </p>
          {chatUrl && (
            <a href={chatUrl} target="_top" style={{
              display: 'inline-block', background: '#FFCFA4', color: '#25455D',
              fontWeight: 700, padding: '14px 32px', borderRadius: 12, fontSize: 16,
              textDecoration: 'none', boxShadow: '0 4px 14px rgba(255,207,164,0.4)',
              marginBottom: 12,
            }}>{BTN[variant]}</a>
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
