'use client'

/**
 * Новости платформы в кабинете клиента.
 *
 * ⚠️ ОДИН источник на плашку и колокольчик. Держать у каждого свою загрузку
 * нельзя: человек закрывает плашку крестиком — цифра на колокольчике обязана
 * упасть в тот же момент, иначе выглядит как поломка. Поэтому список и
 * счётчик живут здесь, а компоненты только рисуют.
 *
 * ⚠️ Обновление по таймеру и при возврате на вкладку — как у непрочитанных
 * сообщений и заявок в сайдбаре: новость публикуется, пока кабинет открыт.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type NewsItem = {
  id: number
  title: string
  body: string
  image_url: string | null
  published_at: string | null
  is_read: boolean
}

let cache: { news: NewsItem[]; unread: number } | null = null
const listeners = new Set<(v: { news: NewsItem[]; unread: number }) => void>()

function publish(v: { news: NewsItem[]; unread: number }) {
  cache = v
  listeners.forEach(fn => fn(v))
}

export function useNews() {
  const [state, setState] = useState(cache || { news: [] as NewsItem[], unread: 0 })
  const [loaded, setLoaded] = useState(!!cache)

  const load = useCallback(() => {
    // Ошибку глушим: новости — не повод показывать человеку сбой поверх работы.
    api.news.list()
      .then((r: any) => {
        publish({ news: r?.news || [], unread: r?.unread || 0 })
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  useEffect(() => {
    const fn = (v: { news: NewsItem[]; unread: number }) => setState(v)
    listeners.add(fn)
    if (!cache) load()
    const timer = setInterval(load, 60_000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      listeners.delete(fn)
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  /** Прочитана одна новость — обновляем список локально, не дожидаясь сети:
   *  иначе плашка «мигает» старой новостью до ответа сервера. */
  const markRead = useCallback((id: number) => {
    const next = (cache?.news || []).map(n => n.id === id ? { ...n, is_read: true } : n)
    publish({ news: next, unread: next.filter(n => !n.is_read).length })
    api.news.markRead(id).catch(() => {})
  }, [])

  const markAllRead = useCallback(() => {
    const next = (cache?.news || []).map(n => ({ ...n, is_read: true }))
    publish({ news: next, unread: 0 })
    api.news.markAllRead().catch(() => {})
  }, [])

  return { ...state, loaded, reload: load, markRead, markAllRead }
}
