const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function getToken() {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('plusson_token')
}

/** Запрос отменён браузером (уход со страницы, AbortController), а не упал сервер. */
function isAbortError(e: any): boolean {
  return e?.name === 'AbortError' || e?.code === 20
}

async function request(path: string, options?: RequestInit) {
  const token = getToken()
  const doFetch = () => fetch(`${API_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
  })

  let res: Response
  try {
    res = await doFetch()
  } catch (e: any) {
    // Уход со страницы обрывает fetch — это не сбой сервера, молча пробрасываем
    // с флагом, чтобы вызывающий код не рисовал красное «Сервер недоступен».
    if (isAbortError(e)) {
      const err = new Error('Запрос отменён')
      ;(err as any).aborted = true
      throw err
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('Нет подключения к интернету. Проверьте сеть и попробуйте ещё раз.')
    }
    // Одна тихая повторная попытка: мигание сети, спящий Wi-Fi, холодный старт
    // воркера — типичные разовые сбои, из-за которых пользователь видел ошибку
    // на первом же экране после логина, а после перехода туда-обратно всё работало.
    try {
      await new Promise(r => setTimeout(r, 600))
      res = await doFetch()
    } catch (e2: any) {
      if (isAbortError(e2)) {
        const err = new Error('Запрос отменён')
        ;(err as any).aborted = true
        throw err
      }
      throw new Error('Сервер недоступен. Попробуйте ещё раз через минуту или напишите в поддержку.')
    }
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    // Глобальный UX-фоллбек для ассистента: middleware возвращает 403
    // с фиксированными detail'ами «Ассистент не может удалять данные.» /
    // «Этот раздел доступен только владельцу кабинета.» / «Ассистент может
    // только смотреть этот раздел.». Если вызывающий код не обернул запрос
    // в try/catch, кнопка-удалить «тихо ничего не делает» — показываем alert,
    // чтобы пользователь видел причину. Глобально мешать другим 403 не должны —
    // эти 3 строки приходят ровно от нашего middleware.
    if (res.status === 403 && typeof window !== 'undefined') {
      const d = err.detail || ''
      if (d.startsWith('Ассистент') || d === 'Этот раздел доступен только владельцу кабинета.') {
        // setTimeout, чтобы alert не блокировал стек throw — текущий вызов
        // всё равно завершится ошибкой, но пользователь увидит сообщение.
        setTimeout(() => { try { window.alert(d) } catch {} }, 0)
      }
    }
    // detail может быть объектом (напр. предупреждение с кодом при 409) —
    // прокидываем его в свойство .detail, а message делаем строковым.
    const detailIsObj = err.detail && typeof err.detail === 'object'
    const e = new Error(detailIsObj ? (err.detail.message || 'Что-то пошло не так') : (err.detail || 'Что-то пошло не так'))
    ;(e as any).detail = err.detail
    ;(e as any).status = res.status
    throw e
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
  /** Работает только вместе с leadMagnetIds/packageIds: все | забрали | не забрали. */
  leadMagnetStage?: 'any' | 'delivered' | 'not_delivered'
  /** '' = все, 'yes' = только в чёрном списке, 'no' = только не в чёрном списке. */
  blacklisted?: string
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
  // Стадия имеет смысл только при выбранном лид-магните/пакете
  if (filters?.leadMagnetStage && filters.leadMagnetStage !== 'any'
      && (filters.leadMagnetIds?.length || filters.packageIds?.length)) {
    params.set('lead_magnet_stage', filters.leadMagnetStage)
  }
  if (filters?.blacklisted) params.set('blacklisted', filters.blacklisted)
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
    verifyEmailConfirm: (token: string) =>
      request('/api/v1/auth/verify-email/confirm', { method: 'POST', body: JSON.stringify({ token }) }),
    resendVerifyEmail: () =>
      request('/api/v1/auth/verify-email/resend', { method: 'POST' }),
    referrerInfo: (pid: string) =>
      request(`/api/v1/auth/referrer-info?pid=${encodeURIComponent(pid)}`),
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
    // Смена типа: мероприятие ↔ конференция ↔ турнир. Данные не теряются —
    // участники, подарки, рассылки и лендинг висят на событии, а не на типе.
    // Повышение возможно только на оплаченный модуль (проверяет бэкенд).
    changeType: (id: number, moduleSlug: 'base' | 'conference' | 'turnir') =>
      request(`/api/v1/events/${id}/change-type`, {
        method: 'POST', body: JSON.stringify({ module_slug: moduleSlug }),
      }),
    analytics: (id: number) => request(`/api/v1/events/${id}/analytics`),
    shareLinks: (slug: string, pid?: string, mode?: 'miniapp' | 'bot') => {
      const p = new URLSearchParams()
      if (pid) p.set('pid', pid)
      if (mode) p.set('mode', mode)
      const qs = p.toString() ? `?${p}` : ''
      return request(`/api/v1/events/slug/${encodeURIComponent(slug)}/share-links${qs}`)
    },
    // Реф-ссылки конкретного участника по его ref_code (pid). По eventId — для карточки участника.
    shareLinksById: (id: number, pid?: string) => {
      const p = new URLSearchParams()
      if (pid) p.set('pid', pid)
      const qs = p.toString() ? `?${p}` : ''
      return request(`/api/v1/events/${id}/share-links${qs}`)
    },
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
    // Сменить реферера участника (только владелец кабинета).
    // Передаём referrer_contact_id (выбран из контактов) или пустое — снять реферера.
    setReferrer: (
      id: number,
      participantId: number,
      payload: { referrer_contact_id?: number | null; referrer_ref_code?: string | null },
    ) =>
      request(`/api/v1/events/${id}/participants/${participantId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    // Массовая проверка членства участников в Telegram-чате события (только TG).
    checkChats: (id: number) =>
      request(`/api/v1/events/${id}/check-chats`, { method: 'POST' }),
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
    quick: (data: any) =>
      request('/api/v1/collaborators/quick', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) =>
      request(`/api/v1/collaborators/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/collaborators/${id}`, { method: 'DELETE' }),
    import: (data: any) =>
      request('/api/v1/collaborators/import', { method: 'POST', body: JSON.stringify(data) }),
    inviteMessage: (collabId: number, eventId: number) =>
      request(`/api/v1/collaborators/${collabId}/invite-message?event_id=${eventId}`),
    posters: {
      list: (collabId: number) =>
        request(`/api/v1/collaborators/${collabId}/posters`),
      add: (collabId: number, data: { url: string; label?: string }) =>
        request(`/api/v1/collaborators/${collabId}/posters`, { method: 'POST', body: JSON.stringify(data) }),
      update: (collabId: number, posterId: number, data: { label?: string; sort_order?: number }) =>
        request(`/api/v1/collaborators/${collabId}/posters/${posterId}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (collabId: number, posterId: number) =>
        request(`/api/v1/collaborators/${collabId}/posters/${posterId}`, { method: 'DELETE' }),
      reorder: (collabId: number, ids: number[]) =>
        request(`/api/v1/collaborators/${collabId}/posters/reorder`, { method: 'POST', body: JSON.stringify({ ids }) }),
    },
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
      clickStats: (eventId: number, speakerEventId: number) =>
        request(`/api/v1/events/${eventId}/conference/speakers/${speakerEventId}/click-stats`),
      clickReport: (eventId: number) =>
        request(`/api/v1/events/${eventId}/conference/click-report`),
      selfRegisterLinks: (eventId: number) =>
        request(`/api/v1/events/${eventId}/conference/speakers/self-register-links`),
      selfEditLinks: (eventId: number) =>
        request(`/api/v1/events/${eventId}/conference/speakers/self-edit-links`),
    },
    days: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/days`),
      upsert: (eventId: number, dayNumber: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/days/${dayNumber}`, { method: 'PUT', body: JSON.stringify(data) }),
      delete: (eventId: number, dayNumber: number) =>
        request(`/api/v1/events/${eventId}/conference/days/${dayNumber}`, { method: 'DELETE' }),
    },
    stages: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/conference/stages`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/stages`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, stageId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/stages/${stageId}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, stageId: number) =>
        request(`/api/v1/events/${eventId}/conference/stages/${stageId}`, { method: 'DELETE' }),
    },
    program: {
      public: (eventId: number) => request(`/api/v1/events/${eventId}/conference/program-public`),
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
      generateTiming: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/conference/sessions/generate-timing`, { method: 'POST', body: JSON.stringify(data) }),
      shiftTiming: (eventId: number, data: { day: number; from_session_id: number; minutes: number }) =>
        request(`/api/v1/events/${eventId}/conference/sessions/shift-timing`, { method: 'POST', body: JSON.stringify(data) }),
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
      presets: (eventId: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/presets`),
      createFromPreset: (eventId: number, type: string) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/from-preset`, { method: 'POST', body: JSON.stringify({ type }) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/${id}`, { method: 'DELETE' }),
      duplicate: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/${id}/duplicate`, { method: 'POST' }),
      test: (eventId: number, id: number, day: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/templates/${id}/test?day=${day}`, { method: 'POST' }),
    },
    schedules: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/broadcasts/schedules`),
      generate: (eventId: number, templateIds?: number[]) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/generate`, {
          method: 'POST',
          body: JSON.stringify(templateIds ? { template_ids: templateIds } : {}),
        }),
      cancel: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/cancel`, { method: 'POST' }),
      recall: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/recall`, { method: 'POST' }),
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
      shiftSpeakers: (eventId: number, day: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/shift-speakers?day=${day}`),
      shiftTiming: (eventId: number, data: { day: number; from_session_id: number; minutes: number }) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/shift-timing`, {
          method: 'POST', body: JSON.stringify(data),
        }),
      addManual: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/add-manual`, {
          method: 'POST', body: JSON.stringify(data),
        }),
      addCustom: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/add-custom`, {
          method: 'POST', body: JSON.stringify(data),
        }),
      testScheduleNow: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/test-now`, { method: 'POST' }),
      editCustom: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/broadcasts/schedules/${id}/custom`, {
          method: 'PUT', body: JSON.stringify(data),
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
    // Значение дополнительного поля у одного человека (миграция 280).
    // Пустая строка = очистка.
    setField: (contactId: number, data: { field_id: number; value: string | null }) =>
      request(`/api/v1/contacts/${contactId}/fields`, {
        method: 'PUT', body: JSON.stringify(data),
      }),
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
    update: (id: number, data: { name?: string; email?: string; phone?: string; is_staff?: boolean; external_ref_param?: string }) =>
      request(`/api/v1/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/contacts/${id}`, { method: 'DELETE' }),
    addToBlacklist: (id: number, reason?: string) =>
      request(`/api/v1/contacts/${id}/blacklist`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),
    removeFromBlacklist: (id: number) =>
      request(`/api/v1/contacts/${id}/blacklist`, { method: 'DELETE' }),
    filterOptions: () => request('/api/v1/contacts/filter-options'),
    duplicates: (id: number) => request(`/api/v1/contacts/${id}/duplicates`),
    merge: (primaryId: number, targetId: number) =>
      request(`/api/v1/contacts/${primaryId}/merge`, { method: 'POST', body: JSON.stringify({ target_id: targetId }) }),
  },
  platforms: {
    list: () => request('/api/v1/platforms'),
  },
  // Личные переписки (Диалоги) — миграция 160
  dialogs: {
    list: (search?: string) =>
      request(`/api/v1/dialogs${search ? `?search=${encodeURIComponent(search)}` : ''}`),
    messages: (contactId: number, platform?: string) =>
      request(`/api/v1/contacts/${contactId}/messages${platform ? `?platform=${platform}` : ''}`),
    reply: (contactId: number, data: { platform: string; text: string; channel_id?: number }) =>
      request(`/api/v1/contacts/${contactId}/reply`, { method: 'POST', body: JSON.stringify(data) }),
    edit: (messageId: number, text: string) =>
      request(`/api/v1/dialog-messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ text }) }),
    remove: (messageId: number) =>
      request(`/api/v1/dialog-messages/${messageId}`, { method: 'DELETE' }),
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
  // Воронка догрева для ЗАРЕГИСТРИРОВАННЫХ участников (миграция 129)
  eventNurtureReg: {
    list: (eventId: number) => request(`/api/v1/events/${eventId}/nurture-reg/steps`),
    previewUrls: (eventId: number) =>
      request(`/api/v1/events/${eventId}/nurture-reg/preview-urls`),
    create: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/nurture-reg/steps`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    update: (stepId: number, data: any) =>
      request(`/api/v1/events/nurture-reg/steps/${stepId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    remove: (stepId: number) =>
      request(`/api/v1/events/nurture-reg/steps/${stepId}`, { method: 'DELETE' }),
  },
  // Тарифы мероприятия (миграция 157) — только для тарифа клиента vip
  // Фирменная тема лендингов клиента (миграция 241) — подставляется в новые
  // страницы лендинга как оформление по умолчанию.
  landingTheme: {
    get: () => request('/api/v1/clients/me/landing-theme'),
    update: (data: any) =>
      request('/api/v1/clients/me/landing-theme', {
        method: 'PATCH', body: JSON.stringify(data),
      }),
  },

  // База оферт клиента (миграция 249). Гейт — фича offers.
  offers: {
    list: () => request('/api/v1/clients/me/offers'),
    get: (id: number) => request(`/api/v1/clients/me/offers/${id}`),
    create: (data: any) =>
      request('/api/v1/clients/me/offers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) =>
      request(`/api/v1/clients/me/offers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: number) =>
      request(`/api/v1/clients/me/offers/${id}`, { method: 'DELETE' }),
  },

  // База отзывов и кейсов (миграция 249). Гейт — фича testimonials.
  testimonials: {
    list: (params?: { kind?: string; tag?: string }) => {
      const q = new URLSearchParams()
      if (params?.kind) q.set('kind', params.kind)
      if (params?.tag) q.set('tag', params.tag)
      const qs = q.toString()
      return request(`/api/v1/clients/me/testimonials${qs ? `?${qs}` : ''}`)
    },
    create: (data: any) =>
      request('/api/v1/clients/me/testimonials', { method: 'POST', body: JSON.stringify(data) }),
    bulk: (data: any) =>
      request('/api/v1/clients/me/testimonials/bulk', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) =>
      request(`/api/v1/clients/me/testimonials/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: number) =>
      request(`/api/v1/clients/me/testimonials/${id}`, { method: 'DELETE' }),
  },

  // Конструктор лендинга события (миграция 240). Гейт — фича event_landing.
  // Конструктор лендинга ПРОДУКТА (миграция 293). ⚠️ Имена методов совпадают
  // с `eventLanding` намеренно: вкладка конструктора одна на обе сущности,
  // ей передаётся нужная api-группа. Разные имена = вторая копия вкладки.
  productLanding: {
    get: (productId: number) => request(`/api/v1/products/${productId}/landing`),
    patchPage: (productId: number, pageId: number, data: any) =>
      request(`/api/v1/products/${productId}/landing/pages/${pageId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    createBlock: (productId: number, pageId: number, data: any) =>
      request(`/api/v1/products/${productId}/landing/pages/${pageId}/blocks`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchBlock: (productId: number, blockId: number, data: any) =>
      request(`/api/v1/products/${productId}/landing/blocks/${blockId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    removeBlock: (productId: number, blockId: number) =>
      request(`/api/v1/products/${productId}/landing/blocks/${blockId}`, { method: 'DELETE' }),
    reorder: (productId: number, pageId: number, ids: number[]) =>
      request(`/api/v1/products/${productId}/landing/pages/${pageId}/reorder`, {
        method: 'POST', body: JSON.stringify({ ids }),
      }),
  },

  eventLanding: {
    get: (eventId: number) => request(`/api/v1/events/${eventId}/landing`),
    patchPage: (eventId: number, pageId: number, data: any) =>
      request(`/api/v1/events/${eventId}/landing/pages/${pageId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    createBlock: (eventId: number, pageId: number, data: any) =>
      request(`/api/v1/events/${eventId}/landing/pages/${pageId}/blocks`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchBlock: (eventId: number, blockId: number, data: any) =>
      request(`/api/v1/events/${eventId}/landing/blocks/${blockId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    removeBlock: (eventId: number, blockId: number) =>
      request(`/api/v1/events/${eventId}/landing/blocks/${blockId}`, { method: 'DELETE' }),
    copySources: (eventId: number) =>
      request(`/api/v1/events/${eventId}/landing/copy-sources`),
    copyFrom: (eventId: number, sourceEventId: number, withTariffs: boolean) =>
      request(`/api/v1/events/${eventId}/landing/copy-from/${sourceEventId}`, {
        method: 'POST', body: JSON.stringify({ with_tariffs: withTariffs }),
      }),
    reorder: (eventId: number, pageId: number, ids: number[]) =>
      request(`/api/v1/events/${eventId}/landing/pages/${pageId}/reorder`, {
        method: 'POST', body: JSON.stringify({ ids }),
      }),
    applyTheme: (eventId: number, pageId: number) =>
      request(`/api/v1/events/${eventId}/landing/pages/${pageId}/apply-theme`, {
        method: 'POST',
      }),
    setSeats: (eventId: number, data: {
      seats_total: number | null
      seats_label?: string | null
      seats_label_position?: string
      seats_size?: number | null
    }) =>
      request(`/api/v1/events/${eventId}/landing/seats`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
  },

  // Своя платёжная система клиента: ею покупатели оплачивают тарифы его
  // событий, деньги идут клиенту (миграция 257). Гейт — фича payments.
  paymentSettings: {
    get: () => request('/api/v1/clients/me/payment-settings'),
    update: (data: any) =>
      request('/api/v1/clients/me/payment-settings', {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    check: (data: any) =>
      request('/api/v1/clients/me/payment-settings/check', {
        method: 'POST', body: JSON.stringify(data),
      }),
  },

  eventTariffs: {
    list: (eventId: number) => request(`/api/v1/events/${eventId}/tariffs`),
    allOrders: (eventId: number) => request(`/api/v1/events/${eventId}/tariffs-orders`),
    create: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tariffs`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    update: (eventId: number, tariffId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tariffs/${tariffId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    remove: (eventId: number, tariffId: number) =>
      request(`/api/v1/events/${eventId}/tariffs/${tariffId}`, { method: 'DELETE' }),
    buyers: (eventId: number, tariffId: number) =>
      request(`/api/v1/events/${eventId}/tariffs/${tariffId}/buyers`),
    addBuyer: (eventId: number, tariffId: number, data: { participant_id?: number; contact_id?: number; amount?: number; status?: 'paid' | 'unpaid'; note?: string }) =>
      request(`/api/v1/events/${eventId}/tariffs/${tariffId}/buyers`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    removeBuyer: (eventId: number, tariffId: number, participantId: number) =>
      request(`/api/v1/events/${eventId}/tariffs/${tariffId}/buyers/${participantId}`, { method: 'DELETE' }),
    patchBuyer: (eventId: number, tariffId: number, participantId: number, data: { note?: string; status?: 'paid' | 'unpaid'; move_to_tariff_id?: number; amount?: number | null; amount_set?: boolean }) =>
      request(`/api/v1/events/${eventId}/tariffs/${tariffId}/buyers/${participantId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
  },
  // Приветствие в чатах — набор случайных фраз (миграция 163). Включатель и
  // кодовое слово хранятся в самом событии и правятся через api.events.update.
  chatGreetings: {
    list: (eventId: number) => request(`/api/v1/events/${eventId}/chat-greetings`),
    create: (eventId: number, data: { text: string; sort?: number }) =>
      request(`/api/v1/events/${eventId}/chat-greetings`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    update: (eventId: number, greetingId: number, data: { text?: string; sort?: number }) =>
      request(`/api/v1/events/${eventId}/chat-greetings/${greetingId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    remove: (eventId: number, greetingId: number) =>
      request(`/api/v1/events/${eventId}/chat-greetings/${greetingId}`, { method: 'DELETE' }),
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
    // Кто держит TG-ботов клиента: ПЛЮСОН или сторонний сервис (webhook)
    telegramHealth: () => request('/api/v1/channels/telegram-health'),
    // Забрать бота у стороннего сервиса: deleteWebhook + перезапуск polling
    restartPolling: (id: number) =>
      request(`/api/v1/channels/${id}/restart-polling`, { method: 'POST' }),
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
    connectMaxBot: (bot_token: string) =>
      request('/api/v1/channels/connect-max-bot', {
        method: 'POST',
        body: JSON.stringify({ bot_token }),
      }),
    // WhatsApp через мост (привязка по QR)
    connectWhatsapp: () =>
      request('/api/v1/channels/connect-whatsapp', { method: 'POST' }),
    whatsappStatus: () => request('/api/v1/channels/whatsapp/status'),
    whatsappQr: () => request('/api/v1/channels/whatsapp/qr'),
    whatsappChats: () => request('/api/v1/channels/whatsapp/chats'),
    whatsappLogout: () =>
      request('/api/v1/channels/whatsapp/logout', { method: 'POST' }),
    vkOauthUrl: (channel_id: number) =>
      request(`/api/v1/channels/vk/oauth-url?channel_id=${channel_id}`),
    vkDeleteAdminToken: (channel_id: number) =>
      request(`/api/v1/channels/vk/admin-token?channel_id=${channel_id}`, { method: 'DELETE' }),
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
    // Сколько человек попадёт в рассылку при выбранном фильтре тегов
    audienceCount: (data: { audience_tags_include?: string[]; audience_tags_exclude?: string[] }) =>
      request('/api/v1/broadcasts/audience-count', { method: 'POST', body: JSON.stringify(data) }),
    addCustom: (data: any) =>
      request('/api/v1/broadcasts/schedules/add-custom', { method: 'POST', body: JSON.stringify(data) }),
    testNow: (data: any) =>
      request('/api/v1/broadcasts/schedules/test-now', { method: 'POST', body: JSON.stringify(data) }),
    bulkAdd: (data: any) =>
      request('/api/v1/broadcasts/schedules/bulk-add', { method: 'POST', body: JSON.stringify(data) }),
    preview: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/preview`),
    log: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/log`),
    cancel: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/cancel`, { method: 'POST' }),
    recall: (id: number) =>
      request(`/api/v1/broadcasts/schedules/${id}/recall`, { method: 'POST' }),
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
  analytics: {
    utm: (params?: { group_by?: string; lead_magnet_id?: number; package_id?: number }) => {
      const qs = new URLSearchParams()
      if (params?.group_by) qs.set('group_by', params.group_by)
      if (params?.lead_magnet_id != null) qs.set('lead_magnet_id', String(params.lead_magnet_id))
      if (params?.package_id != null) qs.set('package_id', String(params.package_id))
      const s = qs.toString()
      return request(`/api/v1/analytics/utm${s ? `?${s}` : ''}`)
    },
    // Дашборды-квадратики. Разрез — поле контакта ИЛИ вопрос анкеты
    // (ключ вида 'field:3' / 'question:24').
    sources: () => request('/api/v1/analytics/sources'),
    /** Медийные активы: подписано/всего по площадкам. */
    platforms: () => request('/api/v1/analytics/platforms'),
    dashboards: (eventId?: number) =>
      request(`/api/v1/analytics/dashboards${eventId ? `?event_id=${eventId}` : ''}`),
    createDashboard: (data: { title?: string; event_id?: number }) =>
      request('/api/v1/analytics/dashboards', { method: 'POST', body: JSON.stringify(data) }),
    renameDashboard: (id: number, title: string) =>
      request(`/api/v1/analytics/dashboards/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
    // Общие настройки показа — действуют на все квадратики дашборда.
    updateDashboard: (id: number, data: {
      hide_absolute?: boolean; hide_percent?: boolean; primary_metric?: 'count' | 'percent'
    }) => request(`/api/v1/analytics/dashboards/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteDashboard: (id: number) =>
      request(`/api/v1/analytics/dashboards/${id}`, { method: 'DELETE' }),
    // Отдаёт квадратики уже с посчитанными цифрами.
    dashboard: (id: number) => request(`/api/v1/analytics/dashboards/${id}`),
    addCard: (dashId: number, data: any) =>
      request(`/api/v1/analytics/dashboards/${dashId}/cards`, { method: 'POST', body: JSON.stringify(data) }),
    updateCard: (dashId: number, cardId: number, data: any) =>
      request(`/api/v1/analytics/dashboards/${dashId}/cards/${cardId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteCard: (dashId: number, cardId: number) =>
      request(`/api/v1/analytics/dashboards/${dashId}/cards/${cardId}`, { method: 'DELETE' }),
    reorderCards: (dashId: number, ids: number[]) =>
      request(`/api/v1/analytics/dashboards/${dashId}/cards/reorder`, { method: 'POST', body: JSON.stringify({ ids }) }),
    // keys — какие именно разрезы добавить ('field:3'); view='tile' создаёт
    // по квадратику-цифре на каждый вариант ответа.
    autofill: (dashId: number, keys?: string[], view?: 'tile' | 'list') =>
      request(`/api/v1/analytics/dashboards/${dashId}/autofill`, {
        method: 'POST', body: JSON.stringify({ ...(keys ? { keys } : {}), ...(view ? { view } : {}) }),
      }),
    // Кто эти люди — за цифрой в квадратике.
    cardPeople: (dashId: number, cardId: number, option?: string, limit = 200) => {
      const qs = new URLSearchParams()
      if (option) qs.set('option', option)
      qs.set('limit', String(limit))
      return request(`/api/v1/analytics/dashboards/${dashId}/cards/${cardId}/people?${qs}`)
    },
    // ⚠️ Через fetch с токеном в заголовке, а не ссылкой: эндпоинт требует
    // авторизации, обычный <a href> ушёл бы без неё и получил 401.
    cardPeopleCsv: async (dashId: number, cardId: number, option?: string) => {
      const token = getToken()
      const qs = option ? `?option=${encodeURIComponent(option)}` : ''
      const res = await fetch(
        `${API_URL}/api/v1/analytics/dashboards/${dashId}/cards/${cardId}/people.csv${qs}`,
        { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      )
      if (!res.ok) throw new Error('Ошибка экспорта')
      return res.blob()
    },
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
  // Дополнительные поля контакта («Доход», «Ниша», «Статус») — создаются один
  // раз на весь кабинет и существуют сразу у всех контактов.
  contactFields: {
    list: () => request('/api/v1/contact-fields'),
    create: (data: any) =>
      request('/api/v1/contact-fields', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) =>
      request(`/api/v1/contact-fields/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/contact-fields/${id}`, { method: 'DELETE' }),
  },
  surveys: {
    list: () => request('/api/v1/surveys'),
    create: (data: any) =>
      request('/api/v1/surveys', { method: 'POST', body: JSON.stringify(data) }),
    get: (id: number) => request(`/api/v1/surveys/${id}`),
    update: (id: number, data: any) =>
      request(`/api/v1/surveys/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/surveys/${id}`, { method: 'DELETE' }),
    addQuestion: (id: number, data: any) =>
      request(`/api/v1/surveys/${id}/questions`, { method: 'POST', body: JSON.stringify(data) }),
    updateQuestion: (id: number, qid: number, data: any) =>
      request(`/api/v1/surveys/${id}/questions/${qid}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    reorderQuestions: (id: number, ids: number[]) =>
      request(`/api/v1/surveys/${id}/questions/reorder`, {
        method: 'POST', body: JSON.stringify({ ids }),
      }),
    deleteQuestion: (id: number, qid: number) =>
      request(`/api/v1/surveys/${id}/questions/${qid}`, { method: 'DELETE' }),
    analytics: (id: number) => request(`/api/v1/surveys/${id}/analytics`),
    responses: (id: number) => request(`/api/v1/surveys/${id}/responses`),
    response: (id: number, responseId: number) =>
      request(`/api/v1/surveys/${id}/responses/${responseId}`),
  },
  // Продукты/услуги вне событий (миграция 290): лендинг, тарифы, материалы.
  products: {
    list: () => request('/api/v1/products'),
    create: (data: any) =>
      request('/api/v1/products', { method: 'POST', body: JSON.stringify(data) }),
    get: (id: number) => request(`/api/v1/products/${id}`),
    update: (id: number, data: any) =>
      request(`/api/v1/products/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/products/${id}`, { method: 'DELETE' }),

    // Категории — внутренняя раскладка кабинета по направлениям.
    // Список приходит вместе с продуктами (`list()` → `categories`).
    createCategory: (data: any) =>
      request('/api/v1/product-categories', { method: 'POST', body: JSON.stringify(data) }),
    updateCategory: (id: number, data: any) =>
      request(`/api/v1/product-categories/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteCategory: (id: number) =>
      request(`/api/v1/product-categories/${id}`, { method: 'DELETE' }),

    tariffs: (id: number) => request(`/api/v1/products/${id}/tariffs`),
    createTariff: (id: number, data: any) =>
      request(`/api/v1/products/${id}/tariffs`, { method: 'POST', body: JSON.stringify(data) }),
    updateTariff: (id: number, tid: number, data: any) =>
      request(`/api/v1/products/${id}/tariffs/${tid}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteTariff: (id: number, tid: number) =>
      request(`/api/v1/products/${id}/tariffs/${tid}`, { method: 'DELETE' }),

    // Состав продукта — связки с материалами библиотеки
    materials: (id: number) => request(`/api/v1/products/${id}/materials`),
    attachMaterial: (id: number, data: any) =>
      request(`/api/v1/products/${id}/materials`, { method: 'POST', body: JSON.stringify(data) }),
    updateMaterial: (id: number, linkId: number, data: any) =>
      request(`/api/v1/products/${id}/materials/${linkId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    reorderMaterials: (id: number, ids: number[]) =>
      request(`/api/v1/products/${id}/materials/reorder`, {
        method: 'POST', body: JSON.stringify({ ids }),
      }),
    detachMaterial: (id: number, linkId: number) =>
      request(`/api/v1/products/${id}/materials/${linkId}`, { method: 'DELETE' }),

    // Разделы («Модуль» / «Блок» — по словарю продукта). Вложенность любая,
    // материал без раздела показывается первым уровнем.
    sections: (id: number) => request(`/api/v1/products/${id}/sections`),
    createSection: (id: number, data: any) =>
      request(`/api/v1/products/${id}/sections`, { method: 'POST', body: JSON.stringify(data) }),
    updateSection: (id: number, sid: number, data: any) =>
      request(`/api/v1/products/${id}/sections/${sid}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    reorderSections: (id: number, ids: number[]) =>
      request(`/api/v1/products/${id}/sections/reorder`, {
        method: 'POST', body: JSON.stringify({ ids }),
      }),
    deleteSection: (id: number, sid: number) =>
      request(`/api/v1/products/${id}/sections/${sid}`, { method: 'DELETE' }),

    // Покупатели: доступ можно выдать и вручную — без заказа и без денег.
    buyers: (id: number) => request(`/api/v1/products/${id}/buyers`),
    grantAccess: (id: number, data: any) =>
      request(`/api/v1/products/${id}/buyers`, { method: 'POST', body: JSON.stringify(data) }),
    revokeAccess: (id: number, accessId: number) =>
      request(`/api/v1/products/${id}/buyers/${accessId}`, { method: 'DELETE' }),
    orders: (id: number) => request(`/api/v1/products/${id}/orders`),
  },

  // Общая библиотека материалов кабинета: один материал — много продуктов.
  materials: {
    list: (q?: string) =>
      request(`/api/v1/materials${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    create: (data: any) =>
      request('/api/v1/materials', { method: 'POST', body: JSON.stringify(data) }),
    get: (id: number) => request(`/api/v1/materials/${id}`),
    update: (id: number, data: any) =>
      request(`/api/v1/materials/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: number) =>
      request(`/api/v1/materials/${id}`, { method: 'DELETE' }),
    copy: (id: number) =>
      request(`/api/v1/materials/${id}/copy`, { method: 'POST' }),

    // Содержимое материала — блоки (миграция 294): текст, картинки, видео по
    // ссылке, файлы, аудио, кнопки.
    blocks: (id: number) => request(`/api/v1/materials/${id}/blocks`),
    addBlock: (id: number, data: any) =>
      request(`/api/v1/materials/${id}/blocks`, { method: 'POST', body: JSON.stringify(data) }),
    updateBlock: (id: number, blockId: number, data: any) =>
      request(`/api/v1/materials/${id}/blocks/${blockId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    reorderBlocks: (id: number, ids: number[]) =>
      request(`/api/v1/materials/${id}/blocks/reorder`, {
        method: 'POST', body: JSON.stringify({ ids }),
      }),
    deleteBlock: (id: number, blockId: number) =>
      request(`/api/v1/materials/${id}/blocks/${blockId}`, { method: 'DELETE' }),
  },

  collabHub: {
    settings: () => request('/api/v1/collab-hub/settings'),
    niches: () => request('/api/v1/collab-hub/niches'),
    myCard: () => request('/api/v1/collab-hub/me/card'),
    publishCard: (data: any) =>
      request('/api/v1/collab-hub/me/card', { method: 'POST', body: JSON.stringify(data) }),
    catalog: (params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      return request(`/api/v1/collab-hub/catalog${qs}`)
    },
    profile: (clientId: number) => request(`/api/v1/collab-hub/profile/${clientId}`),
    // запросы / co-ownership / сват / отзывы
    matchmaker: () => request('/api/v1/collab/matchmaker'),
    requests: (direction: 'incoming' | 'outgoing' = 'incoming') =>
      request(`/api/v1/collab/requests?direction=${direction}`),
    createRequest: (data: any) =>
      request('/api/v1/collab/requests', { method: 'POST', body: JSON.stringify(data) }),
    respondRequest: (id: number, accept: boolean, reason?: string) =>
      request(`/api/v1/collab/requests/${id}/respond`, { method: 'POST', body: JSON.stringify({ accept, reason }) }),
    deleteRequest: (id: number) =>
      request(`/api/v1/collab/requests/${id}`, { method: 'DELETE' }),
    reconsiderRequest: (id: number) =>
      request(`/api/v1/collab/requests/${id}/reconsider`, { method: 'POST' }),
    eventOwners: (eventId: number) => request(`/api/v1/collab/events/${eventId}/owners`),
    // Организаторы коллаб-события — просто список людей (ссылки внутри карточки).
    eventOrganizers: (eventId: number) =>
      request(`/api/v1/collab/events/${eventId}/organizers`),
    // Карточка организатора: тема, подарки (только из ПЛЮСОНа, до 4), афиша + ссылки через ЕГО бота.
    organizerCard: (eventId: number, clientId: number) =>
      request(`/api/v1/collab/events/${eventId}/organizers/${clientId}`),
    updateOrganizerCard: (eventId: number, clientId: number, data: any) =>
      request(`/api/v1/collab/events/${eventId}/organizers/${clientId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    attractionReport: (eventId: number) =>
      request(`/api/v1/collab/events/${eventId}/attraction-report`),
    collabs: () => request('/api/v1/collab/collabs'),
    leaveCollab: (eventId: number) =>
      request(`/api/v1/collab/events/${eventId}/leave`, { method: 'POST' }),
    addReview: (data: any) =>
      request('/api/v1/collab/reviews', { method: 'POST', body: JSON.stringify(data) }),
    // Рассылки коллаб-события — подтверждение постановки по моей базе
    broadcastConfirmations: () => request('/api/v1/collab/broadcast-confirmations'),
    broadcastConfirmationsCount: () => request('/api/v1/collab/broadcast-confirmations/count'),
    respondBroadcastConfirmation: (batchId: string, accept: boolean) =>
      request(`/api/v1/collab/broadcast-confirmations/${batchId}`, { method: 'POST', body: JSON.stringify({ accept }) }),
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
    // Превью текста воронки: подставляет материалы выбранного лид-магнита/пакета,
    // бренд, канал подписки и контакты. platform влияет на {support_platform}.
    preview: (type: string, data: {
      step: 'text_1' | 'text_2' | 'text_3_delivered' | 'text_3_stuck'
      lead_magnet_id?: number | null
      package_id?: number | null
      platform?: 'telegram' | 'vk' | 'max'
      text?: string
    }) => request(`/api/v1/funnel-templates/${type}/preview`, {
      method: 'POST', body: JSON.stringify(data),
    }),
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
  /**
   * Ссылка-предпросмотр черновиков (лендинг события, страница продукта).
   *
   * ⚠️ Токен нужен именно в АДРЕСЕ открываемой страницы: `/e/{slug}` и
   * `/pr/{slug}` рендерятся на сервере, заголовка `Authorization` у них нет.
   * Живёт 2 часа — это ссылка на неготовую страницу, вечной ей быть нельзя.
   */
  previewToken: () => request('/api/v1/clients/me/preview-token'),

  miniApp: {
    profile: {
      get:    () => request('/api/v1/clients/me/profile'),
      update: (data: any) => request('/api/v1/clients/me/profile', { method: 'PATCH', body: JSON.stringify(data) }),
      // Подключено ли Mini App у TG-бота клиента (getMe.has_main_web_app / кнопка меню).
      miniAppStatus: () => request('/api/v1/clients/me/profile/mini-app-status'),
      resolveTelegramChatId: (params?: { username?: string; url?: string }) =>
        request('/api/v1/clients/me/profile/resolve-telegram-chat-id', {
          method: 'POST',
          body: JSON.stringify(params || {}),
        }),
      resolveMaxChatId: (params?: { url?: string }) =>
        request('/api/v1/clients/me/profile/resolve-max-chat-id', {
          method: 'POST',
          body: JSON.stringify(params || {}),
        }),
    },
    chatGates: {
      list:   () => request('/api/v1/clients/me/chat-gates'),
      // Готов ли клиент выдавать лид-магниты: бот админ во всех каналах основателя.
      founderChannelsStatus: () => request('/api/v1/clients/me/chat-gates/founder-channels-status'),
      create: (data: any) => request('/api/v1/clients/me/chat-gates', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: number, data: any) => request(`/api/v1/clients/me/chat-gates/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (id: number) => request(`/api/v1/clients/me/chat-gates/${id}`, { method: 'DELETE' }),
      verify: (id: number) => request(`/api/v1/clients/me/chat-gates/${id}/verify`, { method: 'POST' }),
    },
    // МедиаЛифт: моя карточка в системе автоподписки + выбор лид-магнита-подарка.
    medialift: {
      myCard: () => request('/api/v1/clients/me/medialift/my-card'),
      setCardGift: (leadMagnetId: number | null) =>
        request('/api/v1/clients/me/medialift/my-card/gift', {
          method: 'PATCH', body: JSON.stringify({ lead_magnet_id: leadMagnetId }),
        }),
    },
    offerings: {
      list:   () => request('/api/v1/client-offerings'),
      create: (data: any) => request('/api/v1/client-offerings', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: number, data: any) => request(`/api/v1/client-offerings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (id: number) => request(`/api/v1/client-offerings/${id}`, { method: 'DELETE' }),
    },
    // База внешних чатов/групп клиента для рассылок (миграция 170, фича broadcast_chats)
    broadcastChats: {
      list:    () => request('/api/v1/clients/me/broadcast-chats/'),
      resolve: (data: any) => request('/api/v1/clients/me/broadcast-chats/resolve', { method: 'POST', body: JSON.stringify(data) }),
      create:  (data: any) => request('/api/v1/clients/me/broadcast-chats/', { method: 'POST', body: JSON.stringify(data) }),
      update:  (id: number, data: any) => request(`/api/v1/clients/me/broadcast-chats/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete:  (id: number) => request(`/api/v1/clients/me/broadcast-chats/${id}`, { method: 'DELETE' }),
      // Проверить, что наш бот в чате и админ (только Telegram — у VK/MAX состав
      // чужой беседы боту недоступен).
      checkBot: (id: number) =>
        request(`/api/v1/clients/me/broadcast-chats/${id}/check-bot`, { method: 'POST' }),
    },
    // Свои домены клиента (миграция 270, фича custom_domain):
    // kind='landing' — публичные страницы через CNAME + сертификат,
    // kind='mail'    — адрес отправителя писем через SPF/DKIM/DMARC.
    domains: {
      list:   () => request('/api/v1/clients/me/domains'),
      create: (data: { kind: 'landing' | 'mail'; domain: string }) =>
        request('/api/v1/clients/me/domains', { method: 'POST', body: JSON.stringify(data) }),
      checkDns: (id: number) =>
        request(`/api/v1/clients/me/domains/${id}/check-dns`, { method: 'POST' }),
      // Выпуск доступен только после успешной проверки DNS — иначе Let's Encrypt
      // упрётся в лимит неудачных попыток (5 в час на домен).
      issueCert: (id: number) =>
        request(`/api/v1/clients/me/domains/${id}/issue-cert`, { method: 'POST' }),
      update: (id: number, data: any) =>
        request(`/api/v1/clients/me/domains/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      // Что открывается на КОРНЕ домена (миграция 278): витрина событий,
      // витрина на вкладке «О проекте» или лендинг конкретного события.
      setHome: (id: number, data: { home_kind: string; home_event_id?: number | null }) =>
        request(`/api/v1/clients/me/domains/${id}/home`, { method: 'PUT', body: JSON.stringify(data) }),
      homeEvents: () => request('/api/v1/clients/me/domains/home-events'),
      delete: (id: number) =>
        request(`/api/v1/clients/me/domains/${id}`, { method: 'DELETE' }),
    },
  },
  referralProgram: {
    posters: {
      // Без опций — все афиши (у каждой поле day: null у общей, номер дня у дневной).
      // { onlyCommon: true } — только общие афиши события.
      // { day: N } — только афиши дня N программы.
      list: (eventId: number, opts?: { day?: number; onlyCommon?: boolean }) => {
        const qs = opts?.day != null
          ? `?day=${opts.day}`
          : (opts?.onlyCommon ? '?only_common=true' : '')
        return request(`/api/v1/events/${eventId}/posters${qs}`)
      },
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
      move: (eventId: number, id: number, dir: 'up' | 'down') =>
        request(`/api/v1/events/${eventId}/referral/thresholds/${id}/move?dir=${dir}`, { method: 'POST' }),
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
    announcementTexts: {
      list: (eventId: number) => request(`/api/v1/events/${eventId}/announcement-texts`),
      create: (eventId: number, data: any) =>
        request(`/api/v1/events/${eventId}/announcement-texts`, { method: 'POST', body: JSON.stringify(data) }),
      update: (eventId: number, id: number, data: any) =>
        request(`/api/v1/events/${eventId}/announcement-texts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
      delete: (eventId: number, id: number) =>
        request(`/api/v1/events/${eventId}/announcement-texts/${id}`, { method: 'DELETE' }),
    },
    importSources: (eventId: number) =>
      request(`/api/v1/events/${eventId}/referral/import-sources`),
    importFrom: (eventId: number, fromEventId: number) =>
      request(`/api/v1/events/${eventId}/referral/import`, {
        method: 'POST', body: JSON.stringify({ from_event_id: fromEventId }),
      }),
    // ZIP-архив материалов для спикеров/жюри (реф-ссылки + тексты-анонсы +
    // афиши события + индивидуальные афиши + кодовые слова розыгрыша).
    exportMaterials: async (eventId: number) => {
      const token = getToken()
      const res = await fetch(`${API_URL}/api/v1/events/${eventId}/materials-export`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || 'Ошибка экспорта')
      }
      return res.blob()
    },
  },
  // Трекер анонсов спикеров (вкладка в карточке конференции/турнира/премии, миграция 124)
  announcementTracker: {
    get: (eventId: number) => request(`/api/v1/events/${eventId}/announcement-tracker`),
    addPlatform: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/platforms`, { method: 'POST', body: JSON.stringify(data) }),
    updatePlatform: (eventId: number, id: number, data: any) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/platforms/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deletePlatform: (eventId: number, id: number) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/platforms/${id}`, { method: 'DELETE' }),
    addColumn: (eventId: number, data: any = {}) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/columns`, { method: 'POST', body: JSON.stringify(data) }),
    updateColumn: (eventId: number, id: number, data: any) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/columns/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteColumn: (eventId: number, id: number) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/columns/${id}`, { method: 'DELETE' }),
    saveCell: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/cell`, { method: 'PUT', body: JSON.stringify(data) }),
    saveAgreement: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/announcement-tracker/agreement`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  // Оценки участников турнира жюри (миграция 132)
  tournament: {
    criteria: (eventId: number) => request(`/api/v1/events/${eventId}/tournament/criteria`),
    createPackage: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/packages`, { method: 'POST', body: JSON.stringify(data) }),
    updatePackage: (eventId: number, id: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/packages/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deletePackage: (eventId: number, id: number) =>
      request(`/api/v1/events/${eventId}/tournament/packages/${id}`, { method: 'DELETE' }),
    createCriterion: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/criteria`, { method: 'POST', body: JSON.stringify(data) }),
    updateCriterion: (eventId: number, id: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/criteria/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteCriterion: (eventId: number, id: number) =>
      request(`/api/v1/events/${eventId}/tournament/criteria/${id}`, { method: 'DELETE' }),
    assignments: (eventId: number, stageId?: number | null) =>
      request(`/api/v1/events/${eventId}/tournament/assignments${stageId ? `?stage_id=${stageId}` : ''}`),
    setAssignment: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/assignments`, { method: 'POST', body: JSON.stringify(data) }),
    setAllAssignments: (eventId: number, clear: boolean, stageId?: number | null) =>
      request(`/api/v1/events/${eventId}/tournament/assignments/all?clear=${clear}${stageId ? `&stage_id=${stageId}` : ''}`, { method: 'POST' }),
    autoAssignSuggest: (eventId: number, includeSpeakers: boolean, includeParticipants: boolean, stageId?: number | null) =>
      request(`/api/v1/events/${eventId}/tournament/assignments/auto-suggest?include_speakers=${includeSpeakers}&include_participants=${includeParticipants}${stageId != null ? `&stage_id=${stageId}` : ''}`),
    autoAssign: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/assignments/auto`, { method: 'POST', body: JSON.stringify(data) }),
    leaderboard: (eventId: number, stageId?: number | null) =>
      request(`/api/v1/events/${eventId}/tournament/leaderboard${stageId ? `?stage_id=${stageId}` : ''}`),
    juryReview: (eventId: number, stageId?: number | null) =>
      request(`/api/v1/events/${eventId}/tournament/jury-review${stageId ? `?stage_id=${stageId}` : ''}`),
    manualScore: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/manual-score`, { method: 'POST', body: JSON.stringify(data) }),
    feedback: (eventId: number) => request(`/api/v1/events/${eventId}/tournament/feedback`),
    snapshots: (eventId: number) => request(`/api/v1/events/${eventId}/tournament/snapshots`),
    createSnapshot: (eventId: number, data: any) =>
      request(`/api/v1/events/${eventId}/tournament/snapshots`, { method: 'POST', body: JSON.stringify(data) }),
    getSnapshot: (eventId: number, id: number) =>
      request(`/api/v1/events/${eventId}/tournament/snapshots/${id}`),
    deleteSnapshot: (eventId: number, id: number) =>
      request(`/api/v1/events/${eventId}/tournament/snapshots/${id}`, { method: 'DELETE' }),
    taskControl: (eventId: number, params?: { criterion_id?: number; subject?: string; recognized?: string; sort?: string }) => {
      const q = new URLSearchParams()
      if (params?.criterion_id) q.set('criterion_id', String(params.criterion_id))
      if (params?.subject) q.set('subject', params.subject)
      if (params?.recognized) q.set('recognized', params.recognized)
      if (params?.sort) q.set('sort', params.sort)
      const qs = q.toString()
      return request(`/api/v1/events/${eventId}/tournament/task-control${qs ? '?' + qs : ''}`)
    },
    toggleTaskListen: (eventId: number, enabled: boolean) =>
      request(`/api/v1/events/${eventId}/tournament/task-control`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    verifyChat: (eventId: number, platform: string) =>
      request(`/api/v1/events/${eventId}/tournament/task-control/verify-chat?platform=${platform}`, { method: 'POST' }),
    setStageAudience: (eventId: number, stageId: number, listen_audiences: string[]) =>
      request(`/api/v1/events/${eventId}/tournament/stages/${stageId}/listen-audience`, { method: 'PATCH', body: JSON.stringify({ listen_audiences }) }),
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
  // Помощники кабинета (миграция 209): у клиента их несколько, у помощника —
  // несколько кабинетов. grant_id — номер пропуска в ЭТОТ кабинет.
  // Пароль владельцу не отдаётся: новому уходит письмом, «Напомнить» шлёт письмо помощнику.
  assistant: {
    list:          () => request('/api/v1/clients/me/assistants'),
    create:        (email: string, access_level: 'full' | 'limited' = 'limited') =>
      request('/api/v1/clients/me/assistants', { method: 'POST', body: JSON.stringify({ email, access_level }) }),
    setAccessLevel: (grantId: number, access_level: 'full' | 'limited') =>
      request(`/api/v1/clients/me/assistants/${grantId}`, { method: 'PATCH', body: JSON.stringify({ access_level }) }),
    resetPassword: (grantId: number) =>
      request(`/api/v1/clients/me/assistants/${grantId}/reset-password`, { method: 'POST' }),
    delete:        (grantId: number) =>
      request(`/api/v1/clients/me/assistants/${grantId}`, { method: 'DELETE' }),
  },
  admin: {
    stats: () => request('/api/v1/admin/stats'),
    clients: (params?: string) => request(`/api/v1/admin/clients${params ? '?' + params : ''}`),
    getClient: (id: number) => request(`/api/v1/admin/clients/${id}`),
    // Бэк принимает параметры в QUERY STRING, не в body (PATCH /admin/clients/{id})
    updateClient: (id: number, data: { is_active?: boolean; tariff_slug?: string; collab_hub_blocked?: boolean }) => {
      const params = new URLSearchParams()
      if (data.is_active !== undefined) params.set('is_active', String(data.is_active))
      if (data.tariff_slug !== undefined) params.set('tariff_slug', data.tariff_slug)
      if (data.collab_hub_blocked !== undefined) params.set('collab_hub_blocked', String(data.collab_hub_blocked))
      return request(`/api/v1/admin/clients/${id}?${params.toString()}`, { method: 'PATCH' })
    },
    // Разметить контакты тегами сегментов plusson:* (для рассылок по сегментам)
    syncSegmentTags: (data: { target_client_id: number; exclude_client_ids?: number[] }) =>
      request('/api/v1/admin/clients/sync-segment-tags', { method: 'POST', body: JSON.stringify(data) }),
    partners: () => request('/api/v1/admin/partners'),
    createPartner: (data: any) =>
      request('/api/v1/admin/partners', { method: 'POST', body: JSON.stringify(data) }),
    tariffs: () => request('/api/v1/admin/tariffs'),
    createTariff: (data: any) =>
      request('/api/v1/admin/tariffs', { method: 'POST', body: JSON.stringify(data) }),
    updateTariff: (id: number, data: any) =>
      request(`/api/v1/admin/tariffs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    promotions: () => request('/api/v1/admin/promotions'),
    createPromotion: (data: any) =>
      request('/api/v1/admin/promotions', { method: 'POST', body: JSON.stringify(data) }),
    updatePromotion: (id: number, data: any) =>
      request(`/api/v1/admin/promotions/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deletePromotion: (id: number) =>
      request(`/api/v1/admin/promotions/${id}`, { method: 'DELETE' }),
  },
  publicData: {
    tariffs: () => request('/api/v1/public/tariffs'),
    activePromotions: () => request('/api/v1/public/promotions/active'),
    features: () => request('/api/v1/public/features'),
  },
  subscriptions: {
    createOrder: (tariff_slug: string, provider: 'prodamus' | 'leadpay' = 'prodamus') =>
      request('/api/v1/subscriptions/order', { method: 'POST', body: JSON.stringify({ tariff_slug, provider }) }),
    getOrder: (id: number) => request(`/api/v1/subscriptions/orders/${id}`),
    listOrders: () => request('/api/v1/subscriptions/orders'),
    payWithBonus: (tariff_slug: string) =>
      request('/api/v1/subscriptions/pay-with-bonus', { method: 'POST', body: JSON.stringify({ tariff_slug }) }),
  },
  addons: {
    list: () => request('/api/v1/addons'),
    createOrder: (feature_slug: string, months: number, provider: 'prodamus' | 'leadpay' = 'prodamus', bundle = false) =>
      request('/api/v1/addons/order', { method: 'POST', body: JSON.stringify({ feature_slug, months, provider, bundle }) }),
    getOrder: (id: number) => request(`/api/v1/addons/orders/${id}`),
  },
  referrals: {
    me: () => request('/api/v1/referrals/me'),
    withdraw: (amount_kopecks: number, payment_details: string) =>
      request('/api/v1/referrals/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount_kopecks, payment_details }),
      }),
  },
  adminOrders: {
    list: (params?: { status?: string; search?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.status) qs.set('status', params.status)
      if (params?.search) qs.set('search', params.search)
      if (params?.limit != null) qs.set('limit', String(params.limit))
      if (params?.offset != null) qs.set('offset', String(params.offset))
      const s = qs.toString()
      return request(`/api/v1/admin/orders${s ? '?' + s : ''}`)
    },
  },
  adminWithdrawals: {
    list: (status?: 'pending' | 'completed' | 'cancelled') =>
      request(`/api/v1/admin/withdrawals${status ? `?status=${status}` : ''}`),
    complete: (id: number, admin_note?: string) =>
      request(`/api/v1/admin/withdrawals/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ admin_note: admin_note || null }),
      }),
    cancel: (id: number, admin_note: string) =>
      request(`/api/v1/admin/withdrawals/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ admin_note }),
      }),
  },

  adminCollabHubSettings: {
    get: () => request('/api/v1/admin/collab-hub-settings'),
    update: (data: any) =>
      request('/api/v1/admin/collab-hub-settings', {
        method: 'PATCH', body: JSON.stringify(data),
      }),
  },
  adminReferralSettings: {
    get: () => request('/api/v1/admin/referral-settings'),
    update: (data: { percent?: number; signup_until?: string; accrual_until?: string }) =>
      request('/api/v1/admin/referral-settings', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  // Вебинарная комната (миграция 221) — комната на день события
  webinar: {
    listRooms: (eventId: number) => request(`/api/v1/events/${eventId}/webinar`),
    upcomingEvents: (eventId: number) => request(`/api/v1/events/${eventId}/webinar/upcoming-events`),
    upsertRoom: (eventId: number, day: number, data: any) =>
      request(`/api/v1/events/${eventId}/webinar/${day}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteRoom: (eventId: number, day: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}`, { method: 'DELETE' }),
    regenerateKey: (eventId: number, day: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/regenerate-key`, { method: 'POST' }),
    // текущий спикер: auto (по программе) или manual (ведущий выбрал)
    setCurrentSpeaker: (eventId: number, day: number, mode: 'auto' | 'manual', ecId?: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/current-speaker?mode=${mode}${ecId ? `&ec_id=${ecId}` : ''}`, { method: 'POST' }),
    // управление эфиром: поток идёт ≠ эфир начался (спикер настраивается в Zoom)
    goLive: (eventId: number, day: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/go-live`, { method: 'POST' }),
    endLive: (eventId: number, day: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/end-live`, { method: 'POST' }),
    openRoom: (eventId: number, day: number, opensAt?: string | null) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/open-room${opensAt ? `?opens_at=${encodeURIComponent(opensAt)}` : ''}`, { method: 'POST' }),
    closeRoom: (eventId: number, day: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/close-room`, { method: 'POST' }),
    resetRoom: (eventId: number, day: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/reset-room`, { method: 'POST' }),
    // блоки
    blocks: (eventId: number, day: number) => request(`/api/v1/events/${eventId}/webinar/${day}/blocks`),
    createBlock: (eventId: number, day: number, data: any) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/blocks`, { method: 'POST', body: JSON.stringify(data) }),
    updateBlock: (eventId: number, day: number, blockId: number, data: any) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/blocks/${blockId}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteBlock: (eventId: number, day: number, blockId: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/blocks/${blockId}`, { method: 'DELETE' }),
    pinBlock: (eventId: number, day: number, blockId: number, pinned: boolean) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/blocks/${blockId}/pin?pinned=${pinned}`, { method: 'POST' }),
    // модерация
    moderateMsg: (eventId: number, day: number, msgId: number, status: 'visible' | 'hidden') =>
      request(`/api/v1/events/${eventId}/webinar/${day}/chat/${msgId}/moderate?status=${status}`, { method: 'POST' }),
    removeParticipant: (eventId: number, day: number, params: { contact_id?: number; session_key?: string }) => {
      const qs = new URLSearchParams()
      if (params.contact_id != null) qs.set('contact_id', String(params.contact_id))
      if (params.session_key) qs.set('session_key', params.session_key)
      return request(`/api/v1/events/${eventId}/webinar/${day}/participant/remove?${qs.toString()}`, { method: 'POST' })
    },
    // опросы / батлы (пульт)
    createPoll: (eventId: number, day: number, data: { question: string; options: string[] }) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/poll`, { method: 'POST', body: JSON.stringify(data) }),
    closePoll: (eventId: number, day: number, pollId: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/poll/${pollId}/close`, { method: 'POST' }),
    createBattle: (eventId: number, day: number, data: any) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/battle`, { method: 'POST', body: JSON.stringify(data) }),
    endBattle: (eventId: number, day: number, battleId: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/battle/${battleId}/end`, { method: 'POST' }),
    // аналитика (session_id — по конкретному запуску эфира)
    sessions: (eventId: number, day: number) => request(`/api/v1/events/${eventId}/webinar/${day}/sessions`),
    sessionChat: (eventId: number, day: number, sessionId: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/sessions/${sessionId}/chat`),
    analytics: (eventId: number, day: number, step = 5, sessionId?: number | null) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/analytics?step=${step}${sessionId ? `&session_id=${sessionId}` : ''}`),
    viewers: (eventId: number, day: number, sessionId?: number | null) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/viewers${sessionId ? `?session_id=${sessionId}` : ''}`),
    // записи эфира
    recordings: (eventId: number, day: number) => request(`/api/v1/events/${eventId}/webinar/${day}/recordings`),
    deleteRecording: (eventId: number, day: number, recId: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/recordings/${recId}`, { method: 'DELETE' }),
    // обзор батлов события
    allBattles: (eventId: number) => request(`/api/v1/events/${eventId}/webinar/battles/all`),
    // реферальный отчёт: кто сколько привёл на вебинар
    referrals: (eventId: number, day: number) => request(`/api/v1/events/${eventId}/webinar/${day}/referrals`),
    // зрители вебинара
    audience: (eventId: number, day: number) => request(`/api/v1/events/${eventId}/webinar/${day}/audience`),
    audienceTimeline: (eventId: number, day: number, contactId: number) =>
      request(`/api/v1/events/${eventId}/webinar/${day}/audience/${contactId}/timeline`),
    segment: (eventId: number, day: number, from: string, to: string, tag?: string) => {
      const qs = new URLSearchParams({ from, to })
      if (tag) qs.set('tag', tag)
      return request(`/api/v1/events/${eventId}/webinar/${day}/segment?${qs.toString()}`, { method: 'POST' })
    },
  },
}
