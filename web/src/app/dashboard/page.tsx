'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Раздел «Дашборд» убран из меню. Корень /dashboard сразу ведёт на «Мероприятия» —
// это стартовый экран после логина.
export default function DashboardPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/dashboard/events')
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
