const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function getToken() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('plusson_token')
}

async function request(path: string, options?: RequestInit) {
  const token = getToken()
  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Что-то пошло не так')
  }
  return res.json()
}

export const api = {
  auth: {
    register: (data: any) =>
      request('/api/v1/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    login: (data: any) =>
      request('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(data) }),
    adminLogin: (data: any) =>
      request('/api/v1/auth/admin/login', { method: 'POST', body: JSON.stringify(data) }),
    me: () => request('/api/v1/auth/me'),
  },
  events: {
    list: (moduleSlug?: string) => request(`/api/v1/events/${moduleSlug ? `?module_slug=${moduleSlug}` : ''}`),
    get: (id: number) => request(`/api/v1/events/${id}`),
    create: (data: any) =>
      request('/api/v1/events/', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) =>
      request(`/api/v1/events/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/events/${id}`, { method: 'DELETE' }),
    analytics: (id: number) => request(`/api/v1/events/${id}/analytics`),
    participants: (id: number) => request(`/api/v1/events/${id}/participants`),
  },
  collaborators: {
    list: (q?: string) => request(`/api/v1/collaborators/${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    get: (id: number) => request(`/api/v1/collaborators/${id}`),
    create: (data: any) =>
      request('/api/v1/collaborators/', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) =>
      request(`/api/v1/collaborators/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/collaborators/${id}`, { method: 'DELETE' }),
  },
  gifts: {
    list: (eventId: number) => request(`/api/v1/events/${eventId}/gifts/`),
    create: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/gifts/`, { method: 'POST', body: JSON.stringify(data) }),
    update: (eventId: number, giftId: number, data: any) =>
      request(`/api/v1/events/${eventId}/gifts/${giftId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (eventId: number, giftId: number) =>
      request(`/api/v1/events/${eventId}/gifts/${giftId}`, { method: 'DELETE' }),
  },
  conference: {
    get: (eventId: number) => request(`/api/v1/events/${eventId}/conference/`),
    init: (eventId: number) =>
      request(`/api/v1/events/${eventId}/conference/init`, { method: 'POST' }),
    update: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/conference/`, { method: 'PATCH', body: JSON.stringify(data) }),
    speakers: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/speakers`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/speakers`, { method: 'POST', body: JSON.stringify(data) }),
      addFromBase: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/speakers/add-from-base`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, speakerEventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/speakers/${speakerEventId}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, speakerEventId: number) =>
        request(`/api/v1/events/${eventId}/conference/speakers/${speakerEventId}`, { method: 'DELETE' }),
    },
    days: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/days`),
      upsert: (eventId: number, dayNumber: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/days/${dayNumber}`, { method: 'PUT', body: JSON.stringify(data) }),
    },
    sessions: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/sessions`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/sessions`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/conference/sessions/${id}`, { method: 'DELETE' }),
      generate: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/sessions/generate`, { method: 'POST', body: JSON.stringify(data) }),
    },
    broadcasts: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/broadcasts`),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/broadcasts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      approve: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/conference/broadcasts/${id}/approve`, { method: 'POST' }),
      cancel: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/conference/broadcasts/${id}/cancel`, { method: 'POST' }),
      test: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/conference/broadcasts/${id}/test`, { method: 'POST' }),
      generateFromSchedule: (eventId: number) =>
        request(`/api/v1/events/${eventId}/conference/broadcasts/generate-from-schedule`, { method: 'POST' }),
    },
    commercial: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/commercial`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/commercial`, { method: 'POST', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/conference/commercial/${id}`, { method: 'DELETE' }),
    },
    codes: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/codes`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/codes`, { method: 'POST', body: JSON.stringify(data) }),
    },
    promoPartners: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/promo-partners`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/promo-partners`, { method: 'POST', body: JSON.stringify(data) }),
    },
  },
  admin: {
    stats: () => request('/api/v1/admin/stats'),
    clients: (params?: string) => request(`/api/v1/admin/clients${params ? '?' + params : ''}`),
    getClient: (id: number) => request(`/api/v1/admin/clients/${id}`),
    partners: () => request('/api/v1/admin/partners'),
    createPartner: (data: any) =>
      request('/api/v1/admin/partners', { method: 'POST', body: JSON.stringify(data) }),
    tariffs: () => request('/api/v1/admin/tariffs'),
    createTariff: (data: any) =>
      request('/api/v1/admin/tariffs', { method: 'POST', body: JSON.stringify(data) }),
  },
}
