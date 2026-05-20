const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function getToken() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('plusson_token')
}

async function request(path: string, options?: RequestInit) {
  const token = getToken()
  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...options,
    })
  } catch (e: any) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('Нет подключения к интернету. Проверьте сеть и попробуйте ещё раз.')
    }
    throw new Error('Сервер недоступен. Попробуйте ещё раз через минуту или напишите в поддержку.')
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Что-то пошло не так')
  }
  return res.json()
}

export interface ContactFilters {
  subscription?: 'any' | 'subscribed' | 'unsubscribed'
  platforms?: string[]
  /** undefined = фильтр по каналам не активен (показать всех).
   *  Любой массив (даже пустой) = фильтр активен. Пустой = «ни один канал не выбран» = 0 контактов
   *  (если includeUnattached не выбран). */
  channelIds?: number[]
  /** Включать orphan-контакты (без подписки ни на один канал). */
  includeUnattached?: boolean
  utmSources?: string[]
  tags?: string[]
  eventIds?: number[]
  leadMagnetIds?: number[]
  packageIds?: number[]
  dateFrom?: string
  dateTo?: string
}

function buildContactsParams(
  search: string, limit: number, offset: number,
  showUnsubscribed: boolean, filters?: ContactFilters,
) {
  const params = new URLSearchParams({
    search,
    limit: String(limit),
    offset: String(offset),
    show_unsubscribed: String(showUnsubscribed),
  })
  if (filters?.subscription) params.set('subscription', filters.subscription)
  if (filters?.platforms?.length) params.set('platforms', filters.platforms.join(','))
  if (Array.isArray(filters?.channelIds)) {
    params.set('channel_ids', filters!.channelIds!.join(','))
  }
  if (filters?.includeUnattached) params.set('include_unattached', 'true')
  if (filters?.utmSources?.length) params.set('utm_sources', filters.utmSources.join(','))
  if (filters?.tags?.length) params.set('tags', filters.tags.join(','))
  if (filters?.eventIds?.length) params.set('event_ids', filters.eventIds.join(','))
  if (filters?.leadMagnetIds?.length) params.set('lead_magnet_ids', filters.leadMagnetIds.join(','))
  if (filters?.packageIds?.length) params.set('package_ids', filters.packageIds.join(','))
  if (filters?.dateFrom) params.set('date_from', filters.dateFrom)
  if (filters?.dateTo) params.set('date_to', filters.dateTo)
  return params
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
    changePassword: (current_password: string, new_password: string) =>
      request('/api/v1/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password, new_password }) }),
    regenerateIntegrationToken: () =>
      request('/api/v1/auth/me/regenerate-integration-token', { method: 'POST' }),
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
    deleteParticipant: (id: number, participantId: number) =>
      request(`/api/v1/events/${id}/participants/${participantId}`, {
        method: 'DELETE',
      }),
    addParticipantFromContact: (id: number, contactId: number, isRegistered = false) =>
      request(`/api/v1/events/${id}/participants/from-contact`, {
        method: 'POST',
        body: JSON.stringify({ contact_id: contactId, is_registered: isRegistered }),
      }),
    // Коллабораторы события (соорганизаторы / спикеры — общая таблица event_collaborators)
    listCollaborators: (id: number, role?: string) =>
      request(`/api/v1/events/${id}/collaborators${role ? `?role=${role}` : ''}`),
    addCollaborator: (id: number, collaboratorId: number, role: string = 'organizer') =>
      request(`/api/v1/events/${id}/collaborators`, {
        method: 'POST',
        body: JSON.stringify({ collaborator_id: collaboratorId, role }),
      }),
    removeCollaborator: (id: number, ecId: number) =>
      request(`/api/v1/events/${id}/collaborators/${ecId}`, { method: 'DELETE' }),
    sortCollaborator: (id: number, ecId: number, sortOrder: number) =>
      request(`/api/v1/events/${id}/collaborators/${ecId}/sort`, {
        method: 'PATCH',
        body: JSON.stringify({ sort_order: sortOrder }),
      }),
    updateCollaborator: (id: number, ecId: number, data: { exclude_channel_from_subscription?: boolean; is_visible?: boolean; priority?: number }) =>
      request(`/api/v1/events/${id}/collaborators/${ecId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    verifyCollaboratorChannel: (id: number, ecId: number) =>
      request(`/api/v1/events/${id}/collaborators/${ecId}/verify-channel`, { method: 'POST' }),
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
    list: (search: string, limit: number, offset: number, showUnsubscribed = false, filters?: ContactFilters) => {
      const params = buildContactsParams(search, limit, offset, showUnsubscribed, filters)
      return request(`/api/v1/contacts?${params.toString()}`)
    },
    exportCsv: async (search: string, showUnsubscribed: boolean, filters?: ContactFilters) => {
      const params = buildContactsParams(search, 0, 0, showUnsubscribed, filters)
      params.delete('limit'); params.delete('offset')
      const token = getToken()
      const res = await fetch(`${API_URL}/api/v1/contacts/export?${params.toString()}`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || 'Ошибка экспорта')
      }
      return res.blob()
    },
    get: (id: number) => request(`/api/v1/contacts/${id}`),
    update: (id: number, data: { name?: string; email?: string; phone?: string }) =>
      request(`/api/v1/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/contacts/${id}`, { method: 'DELETE' }),
    filterOptions: () => request('/api/v1/contacts/filter-options'),
    duplicates: (id: number) => request(`/api/v1/contacts/${id}/duplicates`),
    merge: (primaryId: number, targetId: number) =>
      request(`/api/v1/contacts/${primaryId}/merge`, { method: 'POST', body: JSON.stringify({ target_id: targetId }) }),
  },
  platforms: {
    list: () => request('/api/v1/platforms'),
  },
  eventNurture: {
    list: (eventId: number) => request(`/api/v1/events/${eventId}/nurture/steps`),
    previewUrls: (eventId: number) =>
      request(`/api/v1/events/${eventId}/nurture/preview-urls`),
    create: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/nurture/steps`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    update: (stepId: number, data: any) =>
      request(`/api/v1/events/nurture/steps/${stepId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    remove: (stepId: number) =>
      request(`/api/v1/events/nurture/steps/${stepId}`, { method: 'DELETE' }),
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
    connectTelegramBot: (bot_token: string) =>
      request('/api/v1/channels/connect-telegram-bot', {
        method: 'POST',
        body: JSON.stringify({ bot_token }),
      }),
    connectVkCommunity: (data: { access_token: string; app_id: number; secure_key: string; group_id: number }) =>
      request('/api/v1/channels/connect-vk-community', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    importCsv: async (id: number, file: File) => {
      const fd = new FormData()
      fd.append('file', file)
      const token = getToken()
      const res = await fetch(`${API_URL}/api/v1/channels/${id}/import-csv`, {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: fd,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || 'Ошибка импорта')
      }
      return res.json()
    },
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
    update: (id: number, data: any) =>
      request(`/api/v1/broadcasts/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    publish: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/publish`, { method: 'POST' }),
  },
  leadMagnets: {
    list: () => request('/api/v1/lead-magnets'),
    counts: () => request('/api/v1/lead-magnets/counts'),
    create: (data: any) =>
      request('/api/v1/lead-magnets', { method: 'POST', body: JSON.stringify(data) }),
    get: (id: number) => request(`/api/v1/lead-magnets/${id}`),
    update: (id: number, data: any) =>
      request(`/api/v1/lead-magnets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/lead-magnets/${id}`, { method: 'DELETE' }),
    analytics: (id: number) =>
      request(`/api/v1/lead-magnets/${id}/analytics`),
  },
  leadMagnetPackages: {
    list: () => request('/api/v1/lead-magnet-packages'),
    counts: () => request('/api/v1/lead-magnet-packages/counts'),
    create: (data: any) =>
      request('/api/v1/lead-magnet-packages', { method: 'POST', body: JSON.stringify(data) }),
    get: (id: number) => request(`/api/v1/lead-magnet-packages/${id}`),
    update: (id: number, data: any) =>
      request(`/api/v1/lead-magnet-packages/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/lead-magnet-packages/${id}`, { method: 'DELETE' }),
    analytics: (id: number) =>
      request(`/api/v1/lead-magnet-packages/${id}/analytics`),
  },
  funnelTemplates: {
    get: (type: string = 'lead_magnet') =>
      request(`/api/v1/funnel-templates/${type}`),
    update: (type: string, data: any) =>
      request(`/api/v1/funnel-templates/${type}`, { method: 'PATCH', body: JSON.stringify(data) }),
  },
  utils: {
    /** Резолвит @username канала в числовой chat_id (через Bot API getChat).
     *  Принимает username (с @ или без) или полный URL. Сохранение делает вызывающая
     *  сторона через PATCH соответствующего ресурса. */
    resolveTgChatId: (input: { username?: string; url?: string }) =>
      request('/api/v1/utils/resolve-tg-chat-id', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },
  miniApp: {
    profile: {
      get:    () => request('/api/v1/clients/me/profile'),
      update: (data: any) => request('/api/v1/clients/me/profile', { method: 'PATCH', body: JSON.stringify(data) }),
      resolveTelegramChatId: (username?: string) =>
        request('/api/v1/clients/me/profile/resolve-telegram-chat-id', {
          method: 'POST',
          body: JSON.stringify(username ? { username } : {}),
        }),
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
    shareTexts: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/referral/share-texts`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/referral/share-texts`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/referral/share-texts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/referral/share-texts/${id}`, { method: 'DELETE' }),
    },
    importSources: (eventId: number) =>
      request(`/api/v1/events/${eventId}/referral/import-sources`),
    importFrom: (eventId: number, fromEventId: number) =>
      request(`/api/v1/events/${eventId}/referral/import`, {
        method: 'POST', body: JSON.stringify({ from_event_id: fromEventId }),
      }),
  },
  raffle: {
    settings: {
      get:  (eventId: number) => request(`/api/v1/events/${eventId}/raffle/settings`),
      save: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/raffle/settings`, { method: 'PUT', body: JSON.stringify(data) }),
    },
    prizes: {
      list:   (eventId: number) => request(`/api/v1/events/${eventId}/raffle/prizes`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/raffle/prizes`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/raffle/prizes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/raffle/prizes/${id}`, { method: 'DELETE' }),
    },
    keywords: {
      list:   (eventId: number) => request(`/api/v1/events/${eventId}/raffle/keywords`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/raffle/keywords`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/raffle/keywords/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/raffle/keywords/${id}`, { method: 'DELETE' }),
    },
    participants: (eventId: number, onlyLive: boolean) =>
      request(`/api/v1/events/${eventId}/raffle/participants${onlyLive ? '?only_live=true' : ''}`),
    tickets: (eventId: number, onlyLive: boolean) =>
      request(`/api/v1/events/${eventId}/raffle/tickets${onlyLive ? '?only_live=true' : ''}`),
    winners: (eventId: number) => request(`/api/v1/events/${eventId}/raffle/winners`),
    draw: (eventId: number, speakerEventId: number, onlyLive: boolean) =>
      request(`/api/v1/events/${eventId}/raffle/draw`, {
        method: 'POST',
        body: JSON.stringify({ speaker_event_id: speakerEventId, only_live: onlyLive }),
      }),
    deleteWinner: (eventId: number, winnerId: number) =>
      request(`/api/v1/events/${eventId}/raffle/winners/${winnerId}`, { method: 'DELETE' }),
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
