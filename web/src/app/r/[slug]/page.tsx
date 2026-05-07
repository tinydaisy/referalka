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
      let redirectPath = `/tg/event/${encodeURIComponent(slug)}`
      try {
        const resp = await fetch(`${API_URL}/api/v1/participants/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        if (resp.ok || resp.status === 409 /* already registered */) {
          try {
            const j = await resp.json()
            if (j?.redirect_path) redirectPath = String(j.redirect_path)
          } catch (_) { /* ignore parse error */ }
        } else {
          const txt = await resp.text().catch(() => '')
          setErrorMsg(`Ошибка регистрации (${resp.status}): ${txt.slice(0, 200)}`)
          setStatus('error')
          return
        }
      } catch (e: any) {
        // Сеть недоступна — всё равно редиректим в Mini App, оно само попробует
        // зарегистрировать (как было до этой страницы).
        console.warn('register failed, navigating anyway:', e)
      }

      setStatus('ok')
      // Навигация в том же webview → Mini App увидит slug и откроет «Интро»
      // (welcomed_at IS NULL после свежей регистрации).
      window.location.replace(redirectPath)
    }, 100)
    return () => clearInterval(timer)
  }, [slug])

  async function fallbackRedirect() {
    // Объект Telegram.WebApp недоступен — открываем t.me-ссылку.
    // Узнаём у бэка handle бота клиента (для VIP) или общего pluson_bot.
    setStatus('fallback')
    let handle = 'pluson_bot'
    let isVip = false
    try {
      const r = await fetch(`${API_URL}/api/v1/public/events/${encodeURIComponent(slug)}/bot-handle`)
      if (r.ok) {
        const j = await r.json()
        if (j?.bot_handle) handle = String(j.bot_handle)
        isVip = !!j?.is_vip_bot
      }
    } catch (_) { /* ignore */ }
    // VIP-бот без short-name (Mini App открывается главной кнопкой меню),
    // общий @pluson_bot имеет short-name `pluson`.
    const url = isVip
      ? `https://t.me/${handle}`
      : `https://t.me/${handle}/pluson?startapp=ref_pg${slug}_reg`
    window.location.replace(url)
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
