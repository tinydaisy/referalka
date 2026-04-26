'use client'
import Link from 'next/link'
import { Send, ArrowRight } from 'lucide-react'

export default function BroadcastsTab({ eventId, isConference }: {
  eventId: number
  isConference: boolean
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
      <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center mb-3 text-white"
           style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        <Send size={20} />
      </div>
      <h3 className="font-semibold text-gray-800 mb-2">Рассылки этого мероприятия</h3>
      <p className="text-sm text-gray-500 mb-5">
        {isConference
          ? 'Для конференций рассылки настраиваются в разделе настроек конференции — там есть шаблоны спикеров и автоматические серии.'
          : 'Произвольные рассылки по аудитории события — в общем разделе «Рассылки».'}
      </p>
      <Link
        href={isConference ? `/dashboard/events/${eventId}/conference` : `/dashboard/broadcasts`}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
        style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
      >
        Открыть {isConference ? 'настройки конференции' : 'рассылки'}
        <ArrowRight size={14} />
      </Link>
    </div>
  )
}
