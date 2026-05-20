const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export async function req(path: string, options?: RequestInit) {
  // cache: 'no-store' — Telegram WebView (особенно iOS) активно кеширует GET,
  // из-за чего reload-ы при переключении вкладок возвращали старые данные.
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  })
  if (!res.ok) {
    const raw = await res.text()
    // FastAPI отдаёт {"detail": "..."} — достаём человеческий текст,
    // если не JSON — отдаём как есть.
    let msg = raw
    try {
      const j = JSON.parse(raw)
      if (j && typeof j.detail === 'string') msg = j.detail
      else if (Array.isArray(j?.detail)) msg = j.detail.map((d: any) => d?.msg || JSON.stringify(d)).join('; ')
    } catch { /* not JSON */ }
    throw new Error(msg || `Ошибка ${res.status}`)
  }
  return res.json()
}

// ── Проверка подписки на каналы конференции ──
export const checkConferenceSubscription = (eventId: number, tgId: number) =>
  req(`/api/v1/public/conference/${eventId}/check-subscription?tg_id=${tgId}`)

// ── Регистрация и участники ──
export const registerParticipant = (data: any) =>
  req('/api/v1/participants/register', { method: 'POST', body: JSON.stringify(data) })

// Клик по главной CTA-ссылке события (стрим / голосование). fire-and-forget.
export function trackLinkClick(eventSlug: string | undefined | null, tgUser: any) {
  if (!eventSlug || !tgUser?.id) return
  try {
    fetch(`${API_URL}/api/v1/event/link-click`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tg_id: Number(tgUser.id),
        event_slug: eventSlug,
        first_name: tgUser.first_name || '',
        last_name:  tgUser.last_name  || '',
        username:   tgUser.username   || '',
      }),
    }).catch(() => {})
  } catch (_) { /* ignore */ }
}

export const getParticipantEvents = (tgId: number) =>
  req(`/api/v1/participants/telegram/${tgId}/events`)

// ── Селектор общего бота: события участника со всех клиентов ──
export const getMiniAppMyEvents = (tgId: number) =>
  req(`/api/v1/participants/miniapp/me/events?tg_id=${tgId}`)

// ── Список «лидеров» (организаторов) участника для вкладки «Лидеры» ──
export const getMiniAppMyLeaders = (tgId: number) =>
  req(`/api/v1/participants/miniapp/me/leaders?tg_id=${tgId}`)

export const getParticipantInEvent = (slug: string, tgId: number) =>
  req(`/api/v1/participants/event/${slug}/user/${tgId}`)

// Карточка участника со списком его мессенджеров (TG/VK/MAX). Доступна
// только участникам того же события (защита на бэке).
export const getParticipantCard = (slug: string, participantId: number, viewerTgId: number) =>
  req(`/api/v1/participants/event/${slug}/participants/${participantId}/card?viewer_tg_id=${viewerTgId}`)

export const activateParticipant = (id: number) =>
  req(`/api/v1/participants/${id}/activate`, { method: 'POST' })

// Welcome-экран после первой регистрации (миграция 057). Mini App вызывает
// один раз — после показа экрана-поздравления. Дальше welcome не показывается.
export const markParticipantWelcomed = (id: number) =>
  req(`/api/v1/participants/${id}/welcomed`, { method: 'POST' })

// ── Подарки и программа ──
export const getGifts = (slug: string) =>
  req(`/api/v1/events/slug/${slug}/gifts/`)

export const getSpeakers = (eventId: number) =>
  req(`/api/v1/events/${eventId}/conference/speakers/public`)

export const getDays = (eventId: number) =>
  req(`/api/v1/events/${eventId}/conference/days/public`)

export const getSessions = (eventId: number, day: number) =>
  req(`/api/v1/events/${eventId}/conference/sessions/day/${day}`)

export const getCommercial = (eventId: number) =>
  req(`/api/v1/events/${eventId}/conference/commercial`)

// Коллабораторы события (для не-конференций — соорганизаторы с role='organizer')
export const getEventCollaborators = (eventId: number, role?: string) =>
  req(`/api/v1/public/events/${eventId}/collaborators${role ? `?role=${role}` : ''}`)

export const verifyCode = (eventId: number, code: string, participantId: number) =>
  req(`/api/v1/events/${eventId}/conference/codes/verify`, {
    method: 'POST',
    body: JSON.stringify({ code, participant_id: participantId })
  })

// ── Хаб организатора (миграция 039) ──
export const getClientProfile = (clientId: number) =>
  req(`/api/v1/public/clients/${clientId}/profile`)

export const getClientOfferings = (clientId: number) =>
  req(`/api/v1/public/clients/${clientId}/offerings`)

export const getClientEvents = (
  clientId: number,
  bucket?: 'now' | 'upcoming' | 'past',
  tgId?: number,
) => {
  const params = new URLSearchParams()
  if (bucket) params.set('bucket', bucket)
  if (tgId)   params.set('tg_id', String(tgId))
  const qs = params.toString()
  return req(`/api/v1/public/clients/${clientId}/events${qs ? `?${qs}` : ''}`)
}

export const getEventLanding = (slug: string) =>
  req(`/api/v1/public/events/${slug}/landing`)

// ── Реф-программа (миграция 059) — материалы для шеринга в GameTab ──
export const getShareTexts = (eventId: number) =>
  req(`/api/v1/public/events/${eventId}/share-texts`).catch(() => ({ items: [] }))

export const getShareMaterials = (eventId: number) =>
  req(`/api/v1/public/events/${eventId}/share-materials`).catch(() => ({ items: [] }))

// Отправить участнику в его бот афиши и тексты для шеринга. Бэкенд достаёт
// афиши из event_referral_materials по slug сам, шлёт каждую отдельным
// sendPhoto, потом каждый текст отдельным sendMessage. После ответа фронт
// делает Telegram.WebApp.close() — Telegram возвращает в чат с ботом, где
// всё готово к форварду друзьям.
export const sendShareTextToBot = (eventSlug: string, tgId: number, texts: string[]) =>
  req('/api/v1/event/share-to-bot', {
    method: 'POST',
    body: JSON.stringify({ event_slug: eventSlug, tg_id: tgId, texts }),
  })

// ── Розыгрыш (миграция 042) — публичные эндпоинты для Mini App ──
export const getRafflePrizes = (eventId: number) =>
  req(`/api/v1/public/events/${eventId}/raffle/prizes`).catch(() => ({ items: [] }))

export const getRaffleSettings = (eventId: number) =>
  req(`/api/v1/public/events/${eventId}/raffle/settings`).catch(() => ({ is_enabled: false }))

// ── Розыгрыш v2 (миграция 056) — новая модель: билеты, кодовые слова, live-метка ──

type TgUser = { tg_id: number; first_name?: string; last_name?: string; username?: string }

export const markLive = (slug: string, user: TgUser) =>
  req(`/api/v1/events/${slug}/live`, { method: 'POST', body: JSON.stringify(user) })

export const issueFreeTicket = (slug: string, user: TgUser) =>
  req(`/api/v1/events/${slug}/raffle/free-ticket`, { method: 'POST', body: JSON.stringify(user) })

export const submitRaffleKeyword = (slug: string, user: TgUser, keyword: string) =>
  req(`/api/v1/events/${slug}/raffle/keyword`, {
    method: 'POST',
    body: JSON.stringify({ ...user, keyword }),
  })

export const getMyRaffle = (slug: string, tgId: number) =>
  req(`/api/v1/events/${slug}/raffle/me?tg_id=${tgId}`)
