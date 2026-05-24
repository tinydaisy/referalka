/**
 * Регистрация партнёра (миграция 105).
 *
 * Открывается:
 *  - из бота, по web_app кнопке `Открыть форму регистрации` → URL вида
 *      `https://pluson.ru/c/{N}/tg/partner/{run_id}` (TG)
 *      `https://vk.com/app{id}#prt_{run_id}` (VK — startparam парсится в App.tsx)
 *
 *  В этом случае страница ТУТ ЖЕ делает `window.location.replace(...)` на
 *  сторонний партнёрский лендинг клиента с приклеенным `pluson_cid` (наш
 *  contact_id нового партнёра) и хвостом query-строки рефовода (партнёрский
 *  код во внешней системе клиента, например `gcpc=fdd97`).
 *
 *  - возврат с лендинга после сабмита формы (флаг `done`):
 *      `https://pluson.ru/c/{N}/tg/partner/{run_id}?done=1` (TG)
 *      `https://vk.com/app{id}#prt_{run_id}_done` (VK — парсится в App.tsx)
 *
 *  В этом случае страница показывает экран успеха и poll-ит API раз в секунду
 *  (до 15 сек) проверяя обновился ли `contacts.external_ref_param`. Если да —
 *  «✅ Вы зарегистрированы», если нет за таймаут — «😕 что-то пошло не так».
 */
import { useEffect, useState } from 'react'

type RunInfo = {
  run_id: number
  client_id: number
  platform: string
  landing_url: string | null
  referrer_query: string
  contact_id: number | null
  stage: string
  brand_name: string
  work_tg_username: string | null
}

type StatusInfo = {
  contact_id: number | null
  external_ref_param: string | null
  has_code: boolean
}

const API = import.meta.env.VITE_API_URL || ''

async function fetchRun(runId: number): Promise<RunInfo | null> {
  try {
    const r = await fetch(`${API}/api/v1/partner/runs/${runId}`)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function fetchStatus(runId: number): Promise<StatusInfo | null> {
  try {
    const r = await fetch(`${API}/api/v1/partner/runs/${runId}/contact-status`)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

function markLandingOpened(runId: number) {
  fetch(`${API}/api/v1/partner/runs/${runId}/mark-landing-opened`, { method: 'POST' })
    .catch(() => {})
}

function buildLandingUrl(landingUrl: string, contactId: number | null, referrerQuery: string): string {
  const sep = landingUrl.includes('?') ? '&' : '?'
  let url = landingUrl
  const parts: string[] = []
  if (contactId) parts.push(`pluson_cid=${contactId}`)
  if (referrerQuery) parts.push(referrerQuery.replace(/^[?&]+/, ''))
  if (parts.length) url = url + sep + parts.join('&')
  return url
}

export default function PartnerPage({ runId, done }: { runId: number; done: boolean }) {
  const [run, setRun] = useState<RunInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [timeoutReached, setTimeoutReached] = useState(false)

  // Загружаем run + ветвимся
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const r = await fetchRun(runId)
      if (cancelled) return
      if (!r) { setError('Партнёрский забег не найден'); return }
      setRun(r)

      if (!done) {
        // Режим «редирект на лендинг»
        if (!r.landing_url) {
          setError('У клиента не настроена партнёрская ссылка')
          return
        }
        markLandingOpened(runId)
        const target = buildLandingUrl(r.landing_url, r.contact_id, r.referrer_query)
        // Небольшая задержка чтобы splash успел сняться + чтобы у юзера
        // успел появиться брендированный фон, иначе на iOS виден белый прыжок.
        setTimeout(() => { window.location.replace(target) }, 200)
      }
    })()
    return () => { cancelled = true }
  }, [runId, done])

  // В режиме done — poll контакта раз в секунду (15 раз), потом таймаут
  useEffect(() => {
    if (!done) return
    let cancelled = false
    let attempts = 0
    const MAX = 15
    async function tick() {
      if (cancelled) return
      attempts += 1
      const s = await fetchStatus(runId)
      if (cancelled) return
      if (s) {
        setStatus(s)
        if (s.has_code) return  // готово, прекращаем поллинг
      }
      if (attempts >= MAX) { setTimeoutReached(true); return }
      setTimeout(tick, 1000)
    }
    tick()
    return () => { cancelled = true }
  }, [runId, done])

  // === Рендер ===

  if (error) {
    return (
      <ErrorScreen
        title="Что-то пошло не так"
        text={error}
        workTg={run?.work_tg_username || null}
      />
    )
  }

  if (!done) {
    // Режим редиректа — показываем splash «открываем форму…»
    return (
      <SplashScreen
        title={`Открываем форму регистрации ${run?.brand_name ? '— ' + run.brand_name : ''}`}
      />
    )
  }

  // done=1: режим экрана успеха
  if (status?.has_code) {
    return (
      <SuccessScreen
        brand={run?.brand_name || ''}
        code={status.external_ref_param || ''}
        workTg={run?.work_tg_username || null}
      />
    )
  }

  if (timeoutReached) {
    return (
      <ErrorScreen
        title="😕 Упс, что-то пошло не так"
        text={"Наша система не получила ваш партнёрский код. " +
              "Напишите Основателю для решения вопроса и пришлите скрин."}
        workTg={run?.work_tg_username || null}
      />
    )
  }

  // Ждём пока код придёт
  return (
    <SplashScreen title="Проверяем регистрацию…" />
  )
}

// ─── UI ──────────────────────────────────────────────────────────────────

const PAGE_STYLE: React.CSSProperties = {
  minHeight: '100vh',
  background: 'linear-gradient(45deg, #25455D, #0a1520)',
  color: '#fff',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24,
}

function SplashScreen({ title }: { title: string }) {
  return (
    <div style={PAGE_STYLE}>
      <div style={{ maxWidth: 380, textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          border: '4px solid rgba(255,207,164,0.25)',
          borderTopColor: '#FFCFA4',
          margin: '0 auto 22px',
          animation: 'plusson-spin 0.9s linear infinite',
        }} />
        <p style={{ fontSize: 16, opacity: 0.9, margin: 0 }}>{title}</p>
        <style>{`@keyframes plusson-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  )
}

function SuccessScreen({ brand, code, workTg }: { brand: string; code: string; workTg: string | null }) {
  return (
    <div style={PAGE_STYLE}>
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
          Вы зарегистрированы партнёром{brand ? ` у ${brand}` : ''}
        </h1>
        <p style={{ lineHeight: 1.5, opacity: 0.9, fontSize: 15, margin: '0 0 18px' }}>
          Ваш партнёрский код:
        </p>
        <div style={{
          display: 'inline-block',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,207,164,0.4)',
          borderRadius: 12, padding: '12px 20px',
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: 16, color: '#FFCFA4', fontWeight: 700,
          marginBottom: 24, wordBreak: 'break-all',
        }}>
          {code}
        </div>
        {workTg && (
          <p style={{ lineHeight: 1.5, opacity: 0.85, fontSize: 14, margin: '0 0 18px' }}>
            Чтобы отслеживать состояние вашего партнёрского кабинета —{' '}
            обратитесь к Основателю:{' '}
            <a href={`https://t.me/${workTg}`} target="_blank" rel="noreferrer"
               style={{ color: '#FFCFA4', fontWeight: 700 }}>
              @{workTg}
            </a>
          </p>
        )}
      </div>
    </div>
  )
}

function ErrorScreen({ title, text, workTg }: { title: string; text: string; workTg: string | null }) {
  return (
    <div style={PAGE_STYLE}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ color: '#FFCFA4', fontSize: 22, margin: '0 0 12px', fontWeight: 700 }}>
          {title}
        </h1>
        <p style={{ lineHeight: 1.5, opacity: 0.9, fontSize: 15, margin: '0 0 22px' }}>
          {text}
        </p>
        {workTg && (
          <a href={`https://t.me/${workTg}`} target="_blank" rel="noreferrer" style={{
            display: 'inline-block', background: '#FFCFA4', color: '#25455D',
            fontWeight: 700, padding: '12px 28px', borderRadius: 12, fontSize: 15,
            textDecoration: 'none',
          }}>
            Написать @{workTg}
          </a>
        )}
      </div>
    </div>
  )
}
