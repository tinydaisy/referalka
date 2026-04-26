'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import OverviewTab from './tabs/OverviewTab'
import PostersTab from './tabs/PostersTab'
import ReferralProgramTab from './tabs/ReferralProgramTab'
import BroadcastsTab from './tabs/BroadcastsTab'

const STATUS_LABELS: Record<string, { label: string; cls: string; next: string; nextLabel: string }> = {
  draft:  { label: 'Черновик',  cls: 'bg-gray-100 text-gray-600',   next: 'active', nextLabel: 'Активировать' },
  active: { label: 'Активно',   cls: 'bg-green-100 text-green-700', next: 'ended',  nextLabel: 'Завершить' },
  ended:  { label: 'Завершено', cls: 'bg-red-100 text-red-700',     next: 'active', nextLabel: 'Возобновить' },
}

type TabKey = 'overview' | 'posters' | 'referral' | 'broadcasts'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview',   label: 'Основное' },
  { key: 'posters',    label: 'Афиши' },
  { key: 'referral',   label: 'Реф-программа' },
  { key: 'broadcasts', label: 'Рассылки' },
]

export default function EventPage() {
  const { id } = useParams()
  const eventId = Number(id)
  const router = useRouter()
  const [event, setEvent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('overview')

  async function reload() {
    const e = await api.events.get(eventId)
    setEvent(e.event)
  }

  useEffect(() => {
    api.events.get(eventId)
      .then(e => setEvent(e.event))
      .catch(() => router.push('/dashboard/events'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 rounded-full border-t-transparent animate-spin" style={{ borderColor: '#25455D', borderTopColor: 'transparent' }} />
    </div>
  )
  if (!event) return null

  const status = STATUS_LABELS[event.status] || STATUS_LABELS.draft

  async function changeStatus() {
    await api.events.update(eventId, { status: status.next })
    setEvent((e: any) => ({ ...e, status: status.next }))
  }

  // Конференции — отдельный модуль, в нём своя обширная UI; оставляем кнопку перехода
  const isConference = event.module_slug === 'conference'

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link href="/dashboard/events" className="hover:text-gray-700">Мероприятия</Link>
        <span>/</span>
        <span className="text-gray-700">{event.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <h1 className="text-2xl font-bold" style={{ color: '#25455D' }}>{event.title}</h1>
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${status.cls}`}>{status.label}</span>
          </div>
          <p className="text-gray-500 text-sm">Модуль: {event.module_slug}</p>
        </div>
        <div className="flex gap-2">
          {isConference && (
            <Link href={`/dashboard/events/${id}/conference`}
                  className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-300 hover:bg-gray-50">
              Настройки конференции
            </Link>
          )}
          <button
            onClick={changeStatus}
            className="px-4 py-2 rounded-xl text-sm font-medium text-white"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            {status.nextLabel}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-8 border-b border-gray-200 overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              activeTab === tab.key
                ? 'text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            style={activeTab === tab.key ? { borderBottomColor: '#25455D', color: '#25455D' } : { borderBottomColor: 'transparent' }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview'   && <OverviewTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'posters'    && <PostersTab eventId={eventId} />}
      {activeTab === 'referral'   && <ReferralProgramTab eventId={eventId} />}
      {activeTab === 'broadcasts' && <BroadcastsTab eventId={eventId} isConference={isConference} />}
    </div>
  )
}
