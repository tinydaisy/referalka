'use client'
import { useState, useEffect } from 'react'
import { Users } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'

export default function ParticipantsTab({ eventId }: { eventId: number }) {
  const { lang } = useLang()
  const [participants, setParticipants] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.events.participants(eventId)
      .then(r => setParticipants(r.participants || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [eventId])

  if (loading) return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>

  if (participants.length === 0) {
    return (
      <div className="max-w-2xl">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-16 text-center">
          <div className="w-16 h-16 rounded-full gradient-bg flex items-center justify-center mx-auto mb-5">
            <Users size={28} className="text-white" />
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">
            {lang === 'ru' ? 'Участников пока нет' : 'No participants yet'}
          </h2>
          <p className="text-gray-500 text-sm max-w-xs mx-auto">
            {lang === 'ru'
              ? 'Здесь появятся пользователи Telegram, которые открыли бот по вашей реферальной ссылке на это событие.'
              : 'Telegram users who opened the bot via your referral link for this event will appear here.'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <p className="text-sm text-gray-500 mb-4">
        {lang === 'ru' ? `${participants.length} участников` : `${participants.length} participants`}
      </p>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {participants.map((p: any, i: number) => (
          <div key={p.id} className={`flex items-center gap-4 px-5 py-3.5 ${i > 0 ? 'border-t border-gray-50' : ''}`}>
            <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-sm font-medium text-gray-500">
              {p.first_name?.[0] || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900 text-sm truncate">
                {[p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Без имени'}
              </p>
              {p.username && <p className="text-xs text-gray-400">@{p.username}</p>}
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs text-gray-400">
                {p.registered_at ? new Date(p.registered_at).toLocaleDateString('ru') : ''}
              </p>
              {p.referral_count > 0 && (
                <p className="text-xs text-brand font-medium">
                  {p.referral_count} {lang === 'ru' ? 'реф.' : 'refs'}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
