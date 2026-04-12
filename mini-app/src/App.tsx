import { useState, useEffect } from 'react'
import Dashboard from './pages/Dashboard'
import EventPage from './pages/EventPage'
import LoadingScreen from './components/LoadingScreen'

// Парсит startapp Telegram: "ref_pgivision-7_pid5725111966_srcinsta"
// pg{slug} → event slug (напр. pgivision-7 → 'ivision-7')
// pid      → partnerId (промо-партнёр события)
// src      → utmSource
function parseStartParam(raw: string): { eventSlug?: string; partnerId?: string; utmSource?: string } {
  const result: { eventSlug?: string; partnerId?: string; utmSource?: string } = {}
  raw.split('_').forEach(p => {
    if (p.startsWith('pg'))  result.eventSlug  = p.slice(2)
    if (p.startsWith('pid')) result.partnerId  = p.slice(3)
    if (p.startsWith('src')) result.utmSource  = p.slice(3)
  })
  return result
}

// Отправляет событие на бэкенд (бот шлёт приветственное сообщение пользователю)
function sendTgEvent(eventName: string, user: any, partnerId?: string) {
  try {
    fetch(`${import.meta.env.VITE_API_URL}/api/v1/event`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id:    String(user.id || ''),
        event:      eventName,
        first_name: user.first_name  || '',
        last_name:  user.last_name   || '',
        username:   user.username    || '',
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
  // eventSlug — если задан, сразу открываем EventPage, минуя Dashboard
  const [eventSlug, setEventSlug] = useState<string | null>(() => parsePathSlug())
  // partnerId / utmSource из startapp — передаём в Dashboard для fallback-регистрации
  const [startParams, setStartParams] = useState<{ partnerId?: string; utmSource?: string }>({})

  useEffect(() => {
    const twa = (window as any).Telegram?.WebApp
    if (twa) {
      twa.ready()
      twa.expand()
      twa.setHeaderColor?.('#080B12')
      twa.setBackgroundColor?.('#080B12')

      const user = twa.initDataUnsafe?.user
      if (user) setTgUser(user)

      // Парсим startapp: ref_pgivision-7_pid123_srcinsta
      const sp = twa.initDataUnsafe?.start_param as string | undefined
      if (sp?.startsWith('ref')) {
        const parsed = parseStartParam(sp)
        // Если в startapp есть slug события — сразу открываем его
        if (parsed.eventSlug) setEventSlug(parsed.eventSlug)
        setStartParams({ partnerId: parsed.partnerId, utmSource: parsed.utmSource })
        // Уведомляем бэкенд — бот отправит приветственное сообщение
        if (user) sendTgEvent('event_start', user, parsed.partnerId)
      }

      // Запрашиваем разрешение боту писать пользователю (один раз, при первом визите)
      // Повторный визит: диалог не показывается, разрешение уже выдано
      twa.requestWriteAccess?.(() => {})
    }
    // Dev fallback
    setTgUser(prev => prev || MOCK_USER)
    const t = setTimeout(() => setLoading(false), 700)
    return () => clearTimeout(t)
  }, [])

  // Роутинг: popstate для кнопки "назад" внутри мини-апп
  useEffect(() => {
    const handler = () => setEventSlug(parsePathSlug())
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  if (loading) return <LoadingScreen />

  if (eventSlug) {
    return (
      <EventPage
        slug={eventSlug}
        tgUser={tgUser}
        partnerId={startParams.partnerId}
        utmSource={startParams.utmSource}
      />
    )
  }
  return <Dashboard tgUser={tgUser} startParams={startParams} onOpenEvent={setEventSlug} />
}
