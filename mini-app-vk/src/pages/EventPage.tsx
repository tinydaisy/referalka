import { useState, useEffect } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import LandingTab from '../tabs/LandingTab'
import ProgramTab from '../tabs/ProgramTab'
import ContestProgramTab from '../tabs/ContestProgramTab'
import GameTab from '../tabs/GameTab'
import RaffleTab from '../tabs/RaffleTab'
import ResultsTab from '../tabs/ResultsTab'
import CalendarTab from '../tabs/CalendarTab'
import EcosystemTab from '../tabs/EcosystemTab'
import RegistrationFlow from '../components/RegistrationFlow'
import WelcomePage from '../components/WelcomePage'
import { getEventLanding, getParticipantInEvent, registerParticipant, markParticipantWelcomed } from '../api'

type State = 'not_registered' | 'registered' | 'ended'

interface Props {
  slug: string
  tgUser: any
  partnerId?: string
  utmSource?: string
  regFromLanding?: boolean   // флаг `_reg` в startapp — вернулись с лендинга клиента
  initialTab?: string        // флаг `_tabXXX` в startapp — открыть на конкретной вкладке (game, raffle, ...)
  onBack: () => void
  onOpenEvent?: (slug: string) => void  // открыть другое событие (для блока «А дальше» в Итогах)
}

const NAV_NOT_REG: NavItem[] = [
  { id: 'landing',   label: 'Лендинг',    icon: 'landing'   },
  { id: 'program',   label: 'Программа',  icon: 'program',   locked: true },
  { id: 'game',      label: 'Подарки',       icon: 'game',      locked: true },
  { id: 'raffle',    label: 'Розыгрыш',   icon: 'raffle',    locked: true },
  { id: 'ecosystem', label: 'Экосистема', icon: 'ecosystem', locked: true },
]
const NAV_REGISTERED: NavItem[] = [
  { id: 'welcome',   label: 'Интро',      icon: 'welcome'   },
  { id: 'program',   label: 'Программа',  icon: 'program'   },
  { id: 'game',      label: 'Подарки',       icon: 'game'      },
  { id: 'raffle',    label: 'Розыгрыш',   icon: 'raffle'    },
  { id: 'ecosystem', label: 'Экосистема', icon: 'ecosystem' },
]
const NAV_ENDED: NavItem[] = [
  { id: 'results',   label: 'Итоги',      icon: 'results'   },
  { id: 'game',      label: 'Подарки',       icon: 'game'      },
  { id: 'calendar',  label: 'Календарь',  icon: 'calendar'  },
  { id: 'ecosystem', label: 'Экосистема', icon: 'ecosystem' },
]

function isEnded(event: any): boolean {
  if (event?.status === 'ended') return true
  if (event?.end_at && new Date(event.end_at) < new Date()) return true
  return false
}

function eventDateLabel(event: any): string {
  const start = event?.start_at ? new Date(event.start_at) : null
  const end   = event?.end_at   ? new Date(event.end_at)   : null
  const now   = new Date()
  if (!start) return ''
  if (start <= now && (!end || end >= now)) return '· идёт сейчас'
  if (start > now) {
    const days = Math.ceil((start.getTime() - now.getTime()) / 86400000)
    return `· через ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`
  }
  if (end && end < now) return '· завершено'
  return ''
}

export default function EventPage({ slug, tgUser, partnerId, utmSource, regFromLanding, initialTab, onBack, onOpenEvent }: Props) {
  const [event, setEvent] = useState<any>(null)
  const [participant, setParticipant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTabState] = useState<string>('landing')
  const [showReg, setShowReg] = useState(false)
  const [prefill, setPrefill] = useState<{ name?: string; email?: string; phone?: string } | null>(null)
  const [autoRegToast, setAutoRegToast] = useState<{ email: string; phone: string } | null>(null)
  // Счётчик «свежести»: увеличивается при переключении вкладок и заставляет
  // GameTab/ProgramTab перезапросить данные у бэка/пересчитать «активное сейчас».
  const [refreshKey, setRefreshKey] = useState(0)

  // Только participant: для GameTab при возврате на вкладку — данные могли
  // обновиться (новые регистрации, изменения в дашборде).
  async function reloadParticipant() {
    if (!tgUser?.id) return
    try {
      const part: any = await getParticipantInEvent(slug, tgUser.id)
      setParticipant(part?.participant ? {
        ...part.participant,
        referrals_count:      part.referrals_count,
        visited_count:        part.visited_count,
        registered_count:     part.registered_count,
        gifts_received_count: part.gifts_received_count,
        my_people:            part.my_people || [],
        top:                  part.top       || [],
        my_rank:              part.my_rank,
      } : null)
      setPrefill(part?.prefill || null)
    } catch (_) { /* offline / 5xx — оставляем то, что было */ }
  }

  // Обёртка над setTab: при каждом переходе перечитываем данные участника.
  // Reload без условий — счётчики/топ могли поменяться от чужих действий.
  function setTab(next: string) {
    // Уход с «Интро» на любую другую вкладку → отмечаем welcomed_at и
    // вкладка исчезает из навигации (не возвращается).
    if (tab === 'welcome' && next !== 'welcome'
        && participant?.id && participant?.welcomed_at == null) {
      setParticipant((p: any) => ({ ...(p || {}), welcomed_at: new Date().toISOString() }))
      markParticipantWelcomed(participant.id).catch(() => { /* offline ok */ })
    }
    setTabState(next)
    setRefreshKey(k => k + 1)
    reloadParticipant()
  }

  // Загружаем лендинг события (публично) + проверяем участие (если есть tg_id)
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    Promise.all([
      getEventLanding(slug).catch(() => null),
      tgUser?.id ? getParticipantInEvent(slug, tgUser.id).catch(() => null) : Promise.resolve(null),
    ]).then(async ([landing, part]) => {
      if (cancelled) return
      setEvent(landing)
      setParticipant(part?.participant ? {
        ...part.participant,
        referrals_count:      part.referrals_count,
        visited_count:        part.visited_count,
        registered_count:     part.registered_count,
        gifts_received_count: part.gifts_received_count,
        my_people:            part.my_people || [],
        top:                  part.top       || [],
        my_rank:              part.my_rank,
      } : null)
      setPrefill(part?.prefill || null)

      const alreadyRegistered = !!part?.participant?.is_registered
      const ended = isEnded(landing)

      // VK Mini App не дёргает /api/v1/event (TG-endpoint) — приветствие про
      // событие приходит из /api/v1/vk/event при первом открытии Mini App
      // (см. App.tsx). Здесь второй раз слать не нужно — иначе TG-эндпойнт
      // будет пытаться отправить sendMessage на VK_ID как на tg_id и 400'ить.

      // Если человек пришёл по ссылке `?startapp=...?_reg` — он только что
      // зарегистрировался на лендинге клиента. Помечаем is_registered=true
      // (через регистрацию без email/phone — данные у клиента, мы их пока
      // не знаем; webhook от клиента — отдельная фича на будущее).
      if (regFromLanding && tgUser?.id && slug && !alreadyRegistered) {
        try {
          const r: any = await registerParticipant({
            event_slug: slug,
            tg_id: tgUser.id,
            username: tgUser.username,
            first_name: tgUser.first_name || '',
            last_name:  tgUser.last_name  || '',
            ref_code: partnerId,
            utm_source: utmSource,
          })
          const reg = r?.participant || r
          if (!cancelled) setParticipant({ ...reg, is_registered: true })
          // Только что зарегистрировался → стартовая вкладка = «Интро»,
          // для контестов «Интро» пропускаем и идём сразу в «Программу».
          if (!cancelled) setTabState(landing?.module_slug === 'contest' ? 'program' : 'welcome')
        } catch (_) { /* fallback на обычный flow — лендинг */ }
      } else if (ended) {
        setTabState('results')
      } else if (alreadyRegistered) {
        // initialTab из startapp (_tabgame, _tabraffle и т.п.) — приоритет над дефолтом.
        // Доступен только зарегистрированным; для нерег. остаётся landing.
        const allowed = ['welcome', 'program', 'game', 'raffle', 'ecosystem']
        if (initialTab && allowed.includes(initialTab)) {
          setTabState(initialTab)
        } else if (part?.participant?.welcomed_at == null && landing?.module_slug !== 'contest') {
          // Только что зарегистрировался (welcomed_at пуст) → «Интро» по умолчанию.
          // После первого открытия welcomed_at проставится и дефолт станет «Программа».
          // Для конкурсов «Интро» пропускаем — сразу в «Программу».
          setTabState('welcome')
        } else {
          setTabState('program')
        }
      } else {
        setTabState('landing')
      }
    }).finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [slug, tgUser?.id])

  // Определяем состояние и набор вкладок (вычисляется ДО early return —
  // иначе useEffect ниже сломает порядок хуков React).
  const ended      = isEnded(event)
  const registered = !!participant?.is_registered
  const state: State = ended ? 'ended' : registered ? 'registered' : 'not_registered'

  // Welcome — отдельная вкладка «Интро» в нижней навигации (всегда доступна
  // зарегистрированному участнику). По умолчанию открывается у тех, у кого
  // welcomed_at пуст; после первого открытия дефолт переключается на «Программу».

  // Активность игры/розыгрыша определяется тогглами в дашборде клиента.
  // Если клиент не включил — соответствующая вкладка вообще не показывается.
  const refOn    = !!event?.referral_enabled
  const raffleOn = !!event?.raffle_enabled

  // Welcome-вкладка («Интро») видна только до того момента, как человек
  // ушёл с неё на любую другую вкладку. После этого welcomed_at != NULL и
  // вкладка пропадает — обратно вернуться нельзя.
  // Для конкурсов «Интро» не показываем — сразу в «Программу».
  const isContestEvent = event?.module_slug === 'contest'
  const showWelcomeTab = registered && participant?.welcomed_at == null && !isContestEvent

  // Если событие завершено и участника нет — Игру тоже не показываем.
  const filterByEnabled = (items: NavItem[]) => items.filter(n =>
    (n.id !== 'welcome' || showWelcomeTab) &&
    (n.id !== 'game'    || refOn)          &&
    (n.id !== 'raffle'  || raffleOn)
  )

  const navItemsEnded = participant
    ? filterByEnabled(NAV_ENDED)
    : filterByEnabled(NAV_ENDED).filter(n => n.id !== 'game')
  const navItems = state === 'not_registered' ? filterByEnabled(NAV_NOT_REG)
                 : state === 'registered'     ? filterByEnabled(NAV_REGISTERED)
                 :                              navItemsEnded

  // Если текущая вкладка пропала из navItems (например клиент выключил
  // рефералку/розыгрыш) — переключаем на первую доступную.
  useEffect(() => {
    if (!event) return
    if (!navItems.some(n => n.id === tab)) {
      setTab(navItems[0]?.id || 'landing')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOn, raffleOn, state, event])

  // Авто-редирект на сторонний лендинг клиента (миграция 057).
  // Inline-скрипт в mini-app/index.html делает редирект ДО React при прямом
  // заходе по ссылке `?startapp=ref_pgSLUG`. Но при ВНУТРЕННЕЙ навигации SPA
  // (клик по событию в Хабе организатора) index.html заново не загружается,
  // поэтому здесь дублируем логику. Используется window.location.href
  // (а не Telegram.WebApp.openLink), чтобы iOS не блокировал как popup.
  // См. documentation/MINI-APP-WEBVIEW-REDIRECT.md
  useEffect(() => {
    if (!event) return
    if (loading) return
    if (registered || ended) return
    const landingUrl: string = (event.landing_url || '').trim()
    if (!landingUrl) return
    redirectToExternalLanding(landingUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, loading, registered, ended])

  // Резолвит партнёрский параметр внешней платформы клиента (например, gcpc=fdd97)
  // по pid, склеивает финальный URL и делает webview-навигацию.
  // Дублирует логику бэка из app/services/external_landing.py для случаев,
  // когда /landing-redirect ДО React не сработал (status='draft' / SPA-навигация).
  async function redirectToExternalLanding(landingUrl: string) {
    const params = new URLSearchParams()
    if (tgUser?.id) params.set('tg_id', String(tgUser.id))
    if (partnerId)  params.set('pid', partnerId)
    if (utmSource)  params.set('utm_source', utmSource)
    params.set('event_slug', slug)
    const sep = landingUrl.includes('?') ? '&' : '?'
    let fullUrl = landingUrl + sep + params.toString()

    if (partnerId) {
      try {
        const apiBase = import.meta.env.VITE_API_URL || ''
        const r = await fetch(
          `${apiBase}/api/v1/public/events/${encodeURIComponent(slug)}/external-ref?pid=${encodeURIComponent(partnerId)}`,
        )
        if (r.ok) {
          const data = await r.json()
          const extra = (data?.external_ref_param as string) || ''
          if (extra) fullUrl += '&' + extra.replace(/^[?&]+/, '')
        }
      } catch { /* тихо игнорим, основной редирект не ломаем */ }
    }
    window.location.href = fullUrl
  }

  if (loading || !event) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Загружаем...
      </div>
    )
  }

  function handleRegistered(p: any) {
    setParticipant({ ...p, is_registered: true })
    setShowReg(false)
    setTab('program')
  }

  // Клик по «Хочу участвовать»: если контакты этого человека уже есть
  // в базе клиента (email+phone) — регистрируем без формы, иначе показываем форму.
  async function handleWantParticipate() {
    // Если у события заполнен сторонний лендинг — переходим на него навигацией
    // webview (как в auto-useEffect выше). На iOS это работает без user-gesture
    // ограничений и согласуется с авто-открытием.
    const landingUrl: string = (event?.landing_url || '').trim()
    if (landingUrl) {
      await redirectToExternalLanding(landingUrl)
      return
    }

    // Клиент в дашборде включил «Регистрировать без ввода контактных данных»:
    // регистрируем по tg_id без формы, имя из Telegram, email/phone пустые.
    if (event?.skip_contact_form && tgUser?.id) {
      try {
        const r: any = await registerParticipant({
          event_slug: slug,
          tg_id: tgUser.id,
          username: tgUser.username,
          first_name: tgUser.first_name || '',
          last_name:  tgUser.last_name  || '',
          ref_code: partnerId,
          utm_source: utmSource,
        })
        const reg = r?.participant || r
        setParticipant({ ...reg, is_registered: true })
        setTab('program')
        return
      } catch (_) {
        // Не получилось — fallback на форму.
      }
    }

    const canAutoRegister = !!(prefill?.email?.trim() && prefill?.phone?.trim())
    if (canAutoRegister && tgUser?.id) {
      try {
        const r: any = await registerParticipant({
          event_slug: slug,
          tg_id: tgUser.id,
          username: tgUser.username,
          first_name: tgUser.first_name || prefill!.name || '',
          last_name:  tgUser.last_name  || '',
          email: prefill!.email!,
          phone: prefill!.phone!,
          ref_code: partnerId,
          utm_source: utmSource,
        })
        const reg = r?.participant || r
        setParticipant({ ...reg, is_registered: true })
        setAutoRegToast({ email: prefill!.email!, phone: prefill!.phone! })
        setTab('program')
        setTimeout(() => setAutoRegToast(null), 6000)
        return
      } catch (_) {
        // Не получилось — fallback на форму.
      }
    }
    setShowReg(true)
  }

  // Если у события подключён сторонний лендинг и человек ещё не зарегистрирован —
  // useEffect выше делает window.location.replace на этот лендинг. Между моментом
  // снятия loading и заменой URL React успевает отрендерить LandingTab, и
  // пользователь на долю секунды видит «Хочу участвовать» (иногда платное
  // событие — кнопка опасна). Поэтому ДО рендера прячем всё под loader, пока
  // редирект ещё не сработал.
  const willRedirectToLanding =
    !!event && !!(event.landing_url || '').trim() && !registered && !ended && !regFromLanding
  if (willRedirectToLanding) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(45deg, #25455D, #0a1520)',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          border: '4px solid rgba(255,207,164,0.25)', borderTopColor: '#FFCFA4',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <div className="grad-header" style={{ padding: '14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
          <button onClick={onBack}
                  style={{ background: 'rgba(255, 207, 164, 0.15)', border: 'none', color: 'white',
                           width: 36, height: 36, borderRadius: 10, cursor: 'pointer', fontSize: 20,
                           display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            ‹
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ color: 'white', fontSize: 15, fontWeight: 700, lineHeight: 1.25,
                         whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {event.title}
            </h1>
            <p style={{ color: 'rgba(255, 207, 164, 0.85)', fontSize: 12, marginTop: 2, fontWeight: 500 }}>
              {eventDateLabel(event)}
            </p>
          </div>
          {event.client_brand_logo && (
            <img src={event.client_brand_logo} alt=""
                 onClick={() => setTab('ecosystem')}
                 style={{
                   width: 36, height: 36, borderRadius: 8, objectFit: 'contain',
                   background: 'transparent',
                   cursor: 'pointer', flexShrink: 0,
                 }} />
          )}
        </div>
      </div>

      {autoRegToast && (
        <div style={{
          background: '#FFCFA4', color: '#25455D', padding: '10px 14px',
          fontSize: 12, lineHeight: 1.45, fontWeight: 700,
          borderBottom: '1px solid #f0b87a',
        }}>
          ✓ Вы зарегистрированы — данные взяты из вашей карточки:
          <div style={{ marginTop: 4, fontWeight: 600, wordBreak: 'break-all' }}>
            {autoRegToast.email} · {autoRegToast.phone}
          </div>
        </div>
      )}

      <div className="page">
        {tab === 'welcome'   && registered && participant?.id && (
          <WelcomePage
            event={event}
            participantId={participant.id}
            raffleEnabled={raffleOn}
            referralEnabled={refOn}
            tgUser={tgUser}
            onContinue={() => {
              setParticipant((p: any) => ({ ...(p || {}), welcomed_at: new Date().toISOString() }))
              setTab('program')
            }}
          />
        )}
        {tab === 'landing'   && <LandingTab  event={event} onRegister={handleWantParticipate} />}
        {tab === 'program'   && (event?.module_slug === 'contest'
          ? <ContestProgramTab event={event} tgUser={tgUser} refreshKey={refreshKey} />
          : <ProgramTab        event={event} tgUser={tgUser} refreshKey={refreshKey} />
        )}
        {tab === 'game'      && <GameTab     event={event} participant={participant} tgUser={tgUser} />}
        {tab === 'raffle'    && <RaffleTab   event={event} participant={participant} tgUser={tgUser} />}
        {tab === 'results'   && <ResultsTab  event={event} participant={participant} onOpenEvent={onOpenEvent} />}
        {tab === 'calendar'  && event.client_id && <CalendarTab clientId={event.client_id} onOpenEvent={(s) => {
          const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
          window.location.assign(`${base}/event/${s}`)
        }} />}
        {tab === 'ecosystem' && event.client_id && <EcosystemTab clientId={event.client_id} />}
      </div>

      <BottomNav items={navItems} active={tab} onTab={setTab} />

      {showReg && (
        <RegistrationFlow
          event={event}
          tgUser={tgUser}
          partnerId={partnerId}
          utmSource={utmSource}
          onClose={() => setShowReg(false)}
          onDone={handleRegistered}
        />
      )}
    </div>
  )
}
