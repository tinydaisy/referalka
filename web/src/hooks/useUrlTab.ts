'use client'
import { useState, useCallback } from 'react'

/**
 * Состояние вкладки, синхронизированное с URL query-параметром.
 * Переживает обновление страницы (F5) — активная вкладка/подвкладка
 * восстанавливается из URL, а не сбрасывается на дефолт.
 *
 * Пишем в URL через history.replaceState (без перезагрузки и без записи
 * в историю навигации — кнопка «назад» не засоряется переключением вкладок).
 *
 * @param key   имя query-параметра (например 'tab' или 'sub')
 * @param def   значение по умолчанию (если в URL ничего нет / значение невалидно)
 * @param valid опционально — список допустимых значений; невалидное → def
 */
export function useUrlTab<T extends string>(key: string, def: T, valid?: readonly T[]): [T, (v: T) => void] {
  const read = (): T => {
    if (typeof window === 'undefined') return def
    const v = new URLSearchParams(window.location.search).get(key) as T | null
    if (v && (!valid || valid.includes(v))) return v
    return def
  }

  const [tab, setTab] = useState<T>(read)

  const set = useCallback((v: T) => {
    setTab(v)
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      if (v === def) url.searchParams.delete(key)
      else url.searchParams.set(key, v)
      window.history.replaceState(window.history.state, '', url.toString())
    }
  }, [key, def])

  return [tab, set]
}
