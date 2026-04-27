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
    updateMe: (data: any) => request('/api/v1/auth/me', { method: 'PATCH', body: JSON.stringify(data) }),
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
    copy: (id: number) =>
      request(`/api/v1/events/${id}/copy`, { method: 'POST' }),
    analytics: (id: number) => request(`/api/v1/events/${id}/analytics`),
    participants: (id: number, registered: 'all' | 'yes' | 'no' = 'all') =>
      request(`/api/v1/events/${id}/participants?registered=${registered}`),
    setRegistered: (id: number, participantId: number, isRegistered: boolean) =>
      request(`/api/v1/events/${id}/participants/${participantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_registered: isRegistered }),
      }),
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
    import: (data: any) =>
      request('/api/v1/collaborators/import', { method: 'POST', body: JSON.stringify(data) }),
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
      verifyChannel: (eventId: number, speakerEventId: number) =>
        request(`/api/v1/events/${eventId}/conference/speakers/${speakerEventId}/verify-channel`, { method: 'POST' }),
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
    raffleTickets: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/raffle-tickets`),
    },
    reports: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/reports`),
      get: (eventId: number, reportId: number) => request(`/api/v1/events/${eventId}/conference/reports/${reportId}`),
      create: (eventId: number, data: { announcements: number }) =>
        request(`/api/v1/events/${eventId}/conference/reports`, { method: 'POST', body: JSON.stringify(data) }),
      delete: (eventId: number, reportId: number) =>
        request(`/api/v1/events/${eventId}/conference/reports/${reportId}`, { method: 'DELETE' }),
    },
    templates: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/broadcasts/templates`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/${id}`, { method: 'DELETE' }),
      test: (eventId: number, id: number, day: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/${id}/test?day=${day}`, { method: 'POST' }),
    },
    schedules: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/broadcasts/schedules`),
      generate: (eventId: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/generate`, { method: 'POST' }),
      cancel: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/cancel`, { method: 'POST' }),
      cancelAll: (eventId: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/cancel-all`, { method: 'POST' }),
      runAll: (eventId: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/run-all`, { method: 'POST' }),
      runSelected: (eventId: number, ids: number[]) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/run-selected`, {
          method: 'POST', body: JSON.stringify({ ids }),
        }),
      setFireAt: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/fire-at`, {
          method: 'PUT', body: JSON.stringify(data),
        }),
      addManual: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/add-manual`, {
          method: 'POST', body: JSON.stringify(data),
        }),
      addCustom: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/add-custom`, {
          method: 'POST', body: JSON.stringify(data),
        }),
      bulkAdd: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/bulk-add`, {
          method: 'POST', body: JSON.stringify(data),
        }),
      forceReset: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/force-reset`, { method: 'POST' }),
      copy: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/copy`, { method: 'POST' }),
      log: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/log`),
      preview: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/preview`),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}`, { method: 'DELETE' }),
    },
  },
  contacts: {
    list: (search: string, limit: number, offset: number, showUnsubscribed = false) =>
      request(`/api/v1/contacts?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}&show_unsubscribed=${showUnsubscribed}`),
    get: (id: number) => request(`/api/v1/contacts/${id}`),
    duplicates: (id: number) => request(`/api/v1/contacts/${id}/duplicates`),
    merge: (primaryId: number, targetId: number) =>
      request(`/api/v1/contacts/${primaryId}/merge`, { method: 'POST', body: JSON.stringify({ target_id: targetId }) }),
  },
  platforms: {
    list: () => request('/api/v1/platforms'),
  },
  channels: {
    list: () => request('/api/v1/channels'),
    get: (id: number) => request(`/api/v1/channels/${id}`),
    create: (data: any) =>
      request('/api/v1/channels', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) =>
      request(`/api/v1/channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/channels/${id}`, { method: 'DELETE' }),
  },
  broadcasts: {
    list: () => request('/api/v1/broadcasts/schedules'),
    addCustom: (data: any) =>
      request('/api/v1/broadcasts/schedules/add-custom', { method: 'POST', body: JSON.stringify(data) }),
    bulkAdd: (data: any) =>
      request('/api/v1/broadcasts/schedules/bulk-add', { method: 'POST', body: JSON.stringify(data) }),
    preview: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/preview`),
    log: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/log`),
    cancel: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/cancel`, { method: 'POST' }),
    delete: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}`, { method: 'DELETE' }),
    copy: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/copy`, { method: 'POST' }),
    setFireAt: (id: number, data: any) =>
      request(`/api/v1/broadcasts/schedules/${id}/fire-at`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  leadMagnets: {
    list: () => request('/api/v1/lead-magnets'),
    create: (data: any) =>
      request('/api/v1/lead-magnets', { method: 'POST', body: JSON.stringify(data) }),
    get: (id: number) => request(`/api/v1/lead-magnets/${id}`),
    update: (id: number, data: any) =>
      request(`/api/v1/lead-magnets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/lead-magnets/${id}`, { method: 'DELETE' }),
  },
  miniApp: {
    profile: {
      get:    () => request('/api/v1/clients/me/profile'),
      update: (data: any) => request('/api/v1/clients/me/profile', { method: 'PATCH', body: JSON.stringify(data) }),
    },
    offerings: {
      list:   () => request('/api/v1/client-offerings'),
      create: (data: any) => request('/api/v1/client-offerings', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: number, data: any) => request(`/api/v1/client-offerings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (id: number) => request(`/api/v1/client-offerings/${id}`, { method: 'DELETE' }),
    },
  },
  referralProgram: {
    posters: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/posters`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/posters`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/posters/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/posters/${id}`, { method: 'DELETE' }),
    },
    settings: {
      get: (eventId: number) => request(`/api/v1/events/${eventId}/referral/settings`),
      save: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/referral/settings`, { method: 'PUT', body: JSON.stringify(data) }),
    },
    thresholds: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/referral/thresholds`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/referral/thresholds`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/referral/thresholds/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/referral/thresholds/${id}`, { method: 'DELETE' }),
    },
    materials: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/referral/materials`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/referral/materials`, { method: 'POST', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/referral/materials/${id}`, { method: 'DELETE' }),
    },
    importSources: (eventId: number) =>
      request(`/api/v1/events/${eventId}/referral/import-sources`),
    importFrom: (eventId: number, fromEventId: number) =>
      request(`/api/v1/events/${eventId}/referral/import`, {
        method: 'POST', body: JSON.stringify({ from_event_id: fromEventId }),
      }),
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
