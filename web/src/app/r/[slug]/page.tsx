/**
 * Промежуточная страница после регистрации на стороннем лендинге.
 * URL: /r/{event_slug}  — например /r/ivision-7
 *
 * КАК ИСПОЛЬЗУЕТСЯ:
 * Клиент в редирект после успешной регистрации в своём конструкторе
 * (Tilda/GetCourse/...) ставит URL вида:
 *   https://pluson.ru/r/{event_slug}
 *
 * ЗАЧЕМ:
 * Без этой страницы лендинг редиректит сразу на t.me/.../?startapp=..._reg.
 * iOS перехватывает t.me как universal link → Telegram открывает НОВОЕ окно
 * Mini App ПОВЕРХ старого webview (с лендингом) → у юзера фантом-окно при
 * закрытии. С нашей промежуточной страницей навигация остаётся в ТОМ ЖЕ
 * webview — без второго окна.
 *
 * ЛОГИКА:
 * 1. Подгружаем telegram-web-app.js (SDK)
 * 2. Когда SDK готов — берём tg_id из Telegram.WebApp.initDataUnsafe.user
 * 3. POST /api/v1/participants/register → ставит is_registered=true
 * 4. window.location.replace('/tg/event/{slug}') → Mini App в том же webview
 * 5. Mini App видит welcomed_at IS NULL → автоматически открывает «Интро»
 *
 * FALLBACK:
 * Если Telegram.WebApp недоступен (открыли в обычном браузере, или объект
 * не сохранился между доменами) — редирект на t.me/.../?startapp=..._reg
 * (старое поведение с двумя окнами — деградация мягкая).
 */
'use client'

import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import Script from 'next/script'

const API_URL = process.env.NEXT_PUBLIC_API_URL || ''

// Tilda overlay-popup и GetCourse popup открывают success-URL ВНУТРИ iframe.
// `window.location.href = t.me-link` из iframe меняет URL только iframe, а не
// верхнего окна — Telegram-app не открывается, юзер сидит на спиннере. Поэтому
// навигация всегда идёт через top-window, и есть видимая кнопка как ручной
// фолбэк когда даже top-навигация заблокирована popup-blocker'ом.
function navigateTop(url: string) {
  try {
    if (window !== window.top && window.top) {
      // Writes в `window.top.location.href` разрешены даже для cross-origin
      // (same-origin policy запрещает только READ из window.top).
      window.top.location.href = url
      return
    }
  } catch (_) { /* CORS — пробуем обычный путь */ }
  try { window.location.href = url } catch (_) { /* last resort below */ }
}

export default function RegisteredReturnPage() {
  const { slug: rawSlug } = useParams()
  const slug = String(rawSlug || '')
  const sp = useSearchParams()
  // Опциональные данные из конструктора лендинга (GetCourse, Tilda и т.п.)
  // Передаются клиентом в редиректе: /r/{slug}?email={email}&phone={phone}&first_name={first_name}
  const qEmail     = sp.get('email')      || ''
  const qPhone     = sp.get('phone')      || ''
  const qFirstName = sp.get('first_name') || sp.get('firstname') || sp.get('name') || ''
  const qLastName  = sp.get('last_name')  || sp.get('lastname')  || sp.get('surname') || ''
  const qPid       = sp.get('pid')        || sp.get('partner_id') || ''
  const qUtmSource = sp.get('utm_source') || ''
  const [status, setStatus] = useState<'loading' | 'ok' | 'fallback' | 'error'>('loading')
  const [fallbackUrl, setFallbackUrl] = useState<string>('')
  const [errorMsg, setErrorMsg] = useState<string>('')

  useEffect(() => {
    if (!slug) return
    // Ждём пока SDK подгрузится. Telegram.WebApp инжектируется как глобал.
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      const tg: any = (window as any).Telegram?.WebApp
      if (!tg) {
        if (attempts > 30) {
          // 3 сек — SDK не подгрузился. Скорее всего открыли в обычном браузере.
          clearInterval(timer)
          await fallbackRedirect()
        }
        return
      }
      clearInterval(timer)
      try { tg.ready() } catch (_) { /* ignore */ }
      try { tg.expand() } catch (_) { /* ignore */ }

      const user = tg.initDataUnsafe?.user
      if (!user?.id) {
        // SDK подгрузился, но пользователя нет (открыли страницу не из Telegram).
        await fallbackRedirect()
        return
      }

      // Регистрация. Email/phone/имя — из query-параметров конструктора (если
      // клиент их передал) либо из Telegram-профиля. Если ни там ни там
      // нет — регаем по tg_id, контакт без email/phone.
      // В ответе бэк присылает redirect_path: для VIP-клиента —
      // /c/{client_id}/tg/event/{slug} (бот клиента), иначе /tg/event/{slug}
      // (общий @pluson_bot).
      let redirectPath = `/tg/event/${encodeURIComponent(slug)}?_reg=1`
      let botHandle = ''
      try {
        const ctrl = new AbortController()
        const tmo = setTimeout(() => ctrl.abort(), 5000)
        const resp = await fetch(`${API_URL}/api/v1/participants/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            event_slug: slug,
            tg_id: user.id,
            username: user.username || '',
            first_name: qFirstName || user.first_name || '',
            last_name:  qLastName  || user.last_name  || '',
            email: qEmail || undefined,
            phone: qPhone || undefined,
            ref_code:   qPid       || undefined,
            utm_source: qUtmSource || undefined,
          }),
        })
        clearTimeout(tmo)
        if (resp.ok || resp.status === 409 /* already registered */) {
          try {
            const j = await resp.json()
            if (j?.redirect_path) {
              const sep = j.redirect_path.includes('?') ? '&' : '?'
              redirectPath = `${j.redirect_path}${sep}_reg=1`
            }
            if (j?.bot_handle) botHandle = String(j.bot_handle)
          } catch (_) { /* ignore parse error */ }
        } else {
          console.warn('register non-2xx, navigating anyway:', resp.status)
        }
      } catch (e: any) {
        console.warn('register failed, navigating anyway:', e)
      }

      setStatus('ok')
      // Навигация в ТОМ ЖЕ webview → Mini App открывается в одном окне,
      // welcomed_at IS NULL → автоматически вкладка «Интро» (welcome-экран).
      // Бот клиента отдельно шлёт приветствие через event_welcome при event_start
      // в Mini App — пользователь увидит сообщение когда свернёт webview.
      // Через top на случай если /r/{slug} открыт в iframe (Tilda overlay).
      try {
        if (window !== window.top && window.top) window.top.location.href = redirectPath
        else window.location.replace(redirectPath)
      } catch (_) { window.location.replace(redirectPath) }
    }, 100)
    return () => clearInterval(timer)
  }, [slug])

  async function fallbackRedirect() {
    // Нет Telegram.WebApp или нет user.id — обычно потому что Tilda/GetCourse
    // после оплаты редиректит в Safari или в Tilda-overlay iframe (не в
    // Telegram webview). Универсальное решение — t.me-ссылка: iOS/Android
    // откроют Telegram через universal link, пользователь окажется в боте.
    // Mini App видит startapp `ref_pg{slug}_reg` → авто-регистрация + welcome.
    let handle = ''
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 4000)
      const r = await fetch(
        `${API_URL}/api/v1/public/events/${encodeURIComponent(slug)}/bot-handle`,
        { signal: ctrl.signal },
      )
      clearTimeout(t)
      if (r.ok) {
        const j = await r.json()
        if (j?.bot_handle) handle = String(j.bot_handle)
      }
    } catch (_) { /* ignore — уйдём на веб-страницу события */ }
    // Свой бот клиента → открываем его Mini App (short-name `pluson` уникален
    // per-бот). Нет своего бота → веб-страница события (без Telegram): системный
    // @pluson_bot больше не используется (2026-07-08).
    const url = handle
      ? `https://telegram.me/${handle}/pluson?startapp=ref_pg${encodeURIComponent(slug)}_reg`
      : `https://pluson.ru/event/${encodeURIComponent(slug)}`
    setFallbackUrl(url)
    setStatus('fallback')
    // Сначала пробуем top-window автоматом (Tilda overlay). Если заблокировано
    // popup-blocker'ом — пользователь увидит кнопку и нажмёт сам.
    navigateTop(url)
  }

  return (
    <>
      {/* Telegram WebApp SDK */}
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />

      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(45deg, #25455D, #0a1520)', color: 'white',
        padding: '24px', textAlign: 'center', fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{ maxWidth: 360 }}>
          {status === 'error' ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Не удалось завершить регистрацию</div>
              <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.5 }}>{errorMsg}</div>
            </>
          ) : status === 'fallback' && fallbackUrl ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 10 }}>
                Регистрация завершена ✓
              </div>
              <div style={{ fontSize: 14, opacity: 0.9, lineHeight: 1.5, marginBottom: 28 }}>
                Откройте Telegram, чтобы зайти в кабинет события
              </div>
              <a
                href={fallbackUrl}
                target="_top"
                rel="noopener"
                style={{
                  display: 'inline-block',
                  background: '#FFCFA4',
                  color: '#0a1520',
                  fontWeight: 700,
                  fontSize: 16,
                  padding: '16px 36px',
                  borderRadius: 12,
                  textDecoration: 'none',
                  boxShadow: '0 6px 24px rgba(255,207,164,0.25)',
                }}
              >
                Открыть в Telegram
              </a>
            </>
          ) : (
            <>
              <div style={{
                width: 56, height: 56, borderRadius: '50%', margin: '0 auto 18px',
                border: '3px solid rgba(255,207,164,0.3)', borderTopColor: '#FFCFA4',
                animation: 'spin 0.9s linear infinite',
              }} />
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
                Завершаем регистрацию…
              </div>
              <div style={{ fontSize: 13, opacity: 0.8 }}>
                Сейчас откроется ваш кабинет события
              </div>
            </>
          )}
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </>
  )
}
