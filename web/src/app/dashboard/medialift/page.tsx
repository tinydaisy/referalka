'use client'

/**
 * МедиаЛифт — служебный раздел сервисного аккаунта («ПЛЮСОН Сервис»).
 *
 * В отличие от Конференций/Премий тут НЕ список: МедиаЛифт — ОДНО событие
 * (многоуровневая система автоподписки) на всю платформу. Поэтому пункт сайдбара
 * ведёт сразу внутрь единственного события: находим его по module_slug='medialift'
 * и открываем карточку.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

export default function MediaLiftPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.events.list('medialift')
        const ev = (res.events || [])[0]
        if (cancelled) return
        if (!ev) {
          setError('Событие МедиаЛифт не найдено. Оно создаётся один раз для сервисного аккаунта.')
          return
        }
        router.replace(`/dashboard/events/${ev.id}`)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Не удалось открыть МедиаЛифт')
      }
    })()
    return () => { cancelled = true }
  }, [router])

  return (
    <div className="p-8 text-sm text-slate-500">
      {error ? <span className="text-red-600">{error}</span> : 'Открываем МедиаЛифт…'}
    </div>
  )
}
