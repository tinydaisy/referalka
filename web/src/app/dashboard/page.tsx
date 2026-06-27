'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

// Раздел «Дашборд» убран из меню. Корень /dashboard ведёт на «Мероприятия» —
// стартовый экран. НО если у клиента ещё нет ни одного своего бота (TG/VK/MAX) —
// ведём в «Каналы»: без бота сервис не работает (там крупная плашка-подсказка).
export default function DashboardPage() {
  const router = useRouter()
  useEffect(() => {
    let done = false
    api.channels.list()
      .then((chs: any) => {
        const hasOwnBot = (chs.items || []).some((c: any) => !c.is_system)
        if (done) return
        router.replace(hasOwnBot ? '/dashboard/events' : '/dashboard/channels')
      })
      .catch(() => { if (!done) router.replace('/dashboard/events') })
    return () => { done = true }
  }, [router])

  return (
    <div className="flex items-center justify-center h-64">
      <div
        className="w-8 h-8 border-2 rounded-full border-t-transparent animate-spin"
        style={{ borderColor: '#25455D', borderTopColor: 'transparent' }}
      />
    </div>
  )
}
