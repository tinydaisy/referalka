const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export async function req(path: string, options?: RequestInit) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export const registerParticipant = (data: any) =>
  req('/api/v1/participants/register', { method: 'POST', body: JSON.stringify(data) })

export const getParticipantEvents = (tgId: number) =>
  req(`/api/v1/participants/telegram/${tgId}/events`)

export const getParticipantInEvent = (slug: string, tgId: number) =>
  req(`/api/v1/participants/event/${slug}/user/${tgId}`)

export const activateParticipant = (id: number) =>
  req(`/api/v1/participants/${id}/activate`, { method: 'POST' })

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
