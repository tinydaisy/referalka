'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type MeRole = 'owner' | 'assistant'

export interface Me {
  id?: number
  name?: string
  email?: string
  features?: string[]
  role?: MeRole
  is_system_service?: boolean
  [k: string]: any
}

/**
 * Загружает /auth/me один раз и кеширует в памяти модуля на время сессии страницы.
 * Используется компонентами для определения роли (owner|assistant) и скрытия
 * кнопок удаления / разделов, недоступных ассистенту (миграция 106).
 */
let _cache: Me | null = null
let _pending: Promise<Me> | null = null

async function fetchMe(): Promise<Me> {
  if (_cache) return _cache
  if (_pending) return _pending
  _pending = api.auth.me().then((data: any) => {
    _cache = {
      id: data?.id,
      name: data?.name,
      email: data?.email,
      features: data?.features || [],
      role: (data?.role as MeRole) || 'owner',
      ...data,
    }
    return _cache!
  }).catch(() => {
    _cache = { role: 'owner', features: [] }
    return _cache!
  })
  return _pending
}

export function useMe() {
  const [me, setMe] = useState<Me | null>(_cache)
  useEffect(() => {
    if (_cache) return
    fetchMe().then(setMe)
  }, [])
  const isAssistant = me?.role === 'assistant'
  const isOwner = !me || me.role !== 'assistant'
  return { me, isAssistant, isOwner }
}
