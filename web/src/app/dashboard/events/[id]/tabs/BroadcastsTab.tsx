'use client'
import Link from 'next/link'
import { Send, ArrowRight, ListChecks } from 'lucide-react'

// Один компонент для мероприятий и конференций (унификация — см. memory/feedback_unified_event_features.md).
// Реальные страницы шаблонов и очереди живут под `/dashboard/conferences/{id}/...` исторически,
// но движок один и тот же (one broadcasts engine), URL-сегмент `conferences` тут просто namespace.
export default function BroadcastsTab({ eventId, isConference }: {
  eventId: number
  isConference: boolean
}) {
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0"
               style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <Send size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-800 mb-1">Шаблоны рассылок</h3>
            <p className="text-sm text-gray-500 mb-4">
              {isConference
                ? 'Тексты + кнопки + плейсхолдеры для каждого типа рассылки (за 2 часа, за 30/5 минут, спикерские, дневные).'
                : 'Тексты + кнопки + плейсхолдеры для каждого типа рассылки (за сутки в 09:12, за 2 часа, за 30/5 минут).'}
            </p>
            <Link
              href={`/dashboard/conferences/${eventId}/broadcasts/templates`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              Открыть шаблоны <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white shrink-0"
               style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
            <ListChecks size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-800 mb-1">Очередь рассылок</h3>
            <p className="text-sm text-gray-500 mb-4">
              Конкретные запланированные рассылки с временем отправки. Сюда же — превью, тестовая отправка
              на свой Telegram, лог доставки и переотправка.
            </p>
            <Link
              href={`/dashboard/conferences/${eventId}/broadcasts/queue`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium"
              style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
            >
              Открыть очередь <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
