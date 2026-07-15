'use client'
import { useState, useCallback, useRef, useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

/**
 * Ref для кнопки активной вкладки: при активации (и при первом монтировании —
 * важно после F5, когда вкладка восстановлена из URL) горизонтально
 * подматывает контейнер так, чтобы активная вкладка была видна по центру.
 *
 * Использование:
 *   const ref = useActiveTabRef(isActive)
 *   <button ref={ref} ...>
 */
export function useActiveTabRef<E extends HTMLElement = HTMLButtonElement>(active: boolean) {
  const ref = useRef<E>(null)
  useEffect(() => {
    if (active && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest', inline: 'center' })
    }
  }, [active])
  return ref
}

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

  // ⚠️ Подхватываем ВНЕШНЕЕ изменение URL без перемонтирования компонента.
  // Пример: со страницы спикера кнопка «Назад» (Link → ?tab=speakers) меняет
  // URL клиентской навигацией, но карточка события уже смонтирована — useState
  // повторно не читает, и вкладка оставалась старой (открывались «Настройки»).
  // usePathname меняется при такой навигации → перечитываем ?tab= из URL.
  const pathname = usePathname()
  const search = useSearchParams()
  useEffect(() => {
    const v = search?.get(key) as T | null
    const next = (v && (!valid || valid.includes(v))) ? v : def
    setTab(prev => (prev === next ? prev : next))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, search, key])

  return [tab, set]
}
