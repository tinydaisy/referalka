const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export async function req(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── Регистрация и участники ──
export const registerParticipant = (data: any) =>
  req('/api/v1/participants/register', { method: 'POST', body: JSON.stringify(data) })

export const getParticipantEvents = (tgId: number) =>
  req(`/api/v1/participants/telegram/${tgId}/events`)

// ── Селектор общего бота: события участника со всех клиентов ──
export const getMiniAppMyEvents = (tgId: number) =>
  req(`/api/v1/participants/miniapp/me/events?tg_id=${tgId}`)

export const getParticipantInEvent = (slug: string, tgId: number) =>
  req(`/api/v1/participants/event/${slug}/user/${tgId}`)

export const activateParticipant = (id: number) =>
  req(`/api/v1/participants/${id}/activate`, { method: 'POST' })

// ── Подарки и программа ──
export const getGifts = (slug: string) =>
  req(`/api/v1/events/slug/${slug}/gifts/`)

export const getSpeakers = (eventId: number) =>
  req(`/api/v1/events/${eventId}/conference/speakers/public`)

export const getSessions = (eventId: number, day: number) =>
  req(`/api/v1/events/${eventId}/conference/sessions/day/${day}`)

export const getCommercial = (eventId: number) =>
  req(`/api/v1/events/${eventId}/conference/commercial`)

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

export const getClientEvents = (clientId: number, bucket?: 'now' | 'upcoming' | 'past') =>
  req(`/api/v1/public/clients/${clientId}/events${bucket ? `?bucket=${bucket}` : ''}`)

export const getEventLanding = (slug: string) =>
  req(`/api/v1/public/events/${slug}/landing`)

// ── Розыгрыш (миграция 042) — публичные эндпоинты для Mini App ──
export const getRafflePrizes = (eventId: number) =>
  req(`/api/v1/public/events/${eventId}/raffle/prizes`).catch(() => ({ items: [] }))

export const getRaffleSettings = (eventId: number) =>
  req(`/api/v1/public/events/${eventId}/raffle/settings`).catch(() => ({ is_enabled: false }))
