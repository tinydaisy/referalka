'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type MeRole = 'owner' | 'assistant'
export type AssistantAccessLevel = 'full' | 'limited' | 'orders'

export interface Me {
  id?: number
  name?: string
  email?: string
  features?: string[]
  role?: MeRole
  /** Только у role='assistant': 'full' — права как у владельца, 'limited' — урезанные. */
  assistant_access_level?: AssistantAccessLevel | null
  is_system_service?: boolean
  /** Адрес ПУБЛИЧНЫХ страниц клиента: его домен, если подключён, иначе pluson.ru. */
  public_base?: string
  /** Адрес самой платформы — всегда pluson.ru (вебхуки, регистрация, Mini App). */
  platform_base?: string
  [k: string]: any
}

/** Домен без схемы: «https://peregovorka.online» → «peregovorka.online». */
export function hostOf(url?: string | null): string {
  return (url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/**
 * Загружает /auth/me один раз и кеширует в памяти модуля на время сессии страницы.
 *
 * ⚠️ `isAssistant` означает «ассистент с ОГРАНИЧЕННЫМИ правами» (миграция 208) —
 * именно по нему компоненты скрывают кнопки удаления и закрытые разделы.
 * Ассистент с полным доступом (`access_level='full'`) видит кабинет как владелец,
 * поэтому для него `isAssistant=false`, `isOwner=true`.
 * Признак «это вообще ассистент» — `isAnyAssistant` (нужен только для бейджа в сайдбаре).
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
  const isAnyAssistant = me?.role === 'assistant'
  const isFullAssistant = isAnyAssistant && me?.assistant_access_level === 'full'
  // Менеджер заказов: открыты только «Контакты» и «Анкеты».
  const isOrdersAssistant = isAnyAssistant && me?.assistant_access_level === 'orders'
  // «Ограниченный» ассистент — тот, кому режем UI. Полный ведёт себя как владелец.
  const isAssistant = isAnyAssistant && !isFullAssistant
  const isOwner = !isAssistant

  // ⚠️ Ссылку, которую клиент копирует и отдаёт СВОЕЙ аудитории, собирать
  // только через publicBase/publicHost — иначе он раздаёт наш домен вместо
  // своего. Внутреннее (вебхуки, регистрация в ПЛЮСОН, адрес Mini App)
  // остаётся на platformBase: там смена домена сломала бы приём данных.
  const publicBase = me?.public_base || me?.platform_base || 'https://pluson.ru'
  const platformBase = me?.platform_base || 'https://pluson.ru'
  return {
    me, isAssistant, isOwner, isAnyAssistant, isFullAssistant, isOrdersAssistant,
    publicBase, platformBase,
    publicHost: hostOf(publicBase),
    platformHost: hostOf(platformBase),
    hasCustomDomain: !!me?.public_base && me.public_base !== me?.platform_base,
  }
}
