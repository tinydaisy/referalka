'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import PostersTab from '../../events/[id]/tabs/PostersTab'
import ReferralProgramTab from '../../events/[id]/tabs/ReferralProgramTab'
import WelcomeTab from '../../events/[id]/tabs/WelcomeTab'
import EventParticipants from '@/components/EventParticipants'
import { EventStatusToggle } from '@/components/EventStatusToggle'
import ContestOverviewTab from './tabs/ContestOverviewTab'
import ContestReportTab from './tabs/ContestReportTab'

type TabKey = 'overview' | 'posters' | 'referral' | 'voters' | 'welcome' | 'report'

export default function ContestPage() {
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
      .then(e => {
        if (e.event?.module_slug !== 'contest') {
          // Чужой тип — отправляем на /dashboard/events, чтобы не показывать
          // обычное мероприятие в layout'е для конкурса.
          router.replace(`/dashboard/events/${eventId}`)
          return
        }
        setEvent(e.event)
      })
      .catch(() => router.push('/dashboard/contests'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-2 rounded-full border-t-transparent animate-spin" style={{ borderColor: '#25455D', borderTopColor: 'transparent' }} />
    </div>
  )
  if (!event) return null

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'overview',  label: 'Основное' },
    { key: 'posters',   label: 'Афиши' },
    { key: 'referral',  label: 'Реф-программа' },
    { key: 'voters',    label: 'Голосующие' },
    { key: 'welcome',   label: 'Приветствие' },
    { key: 'report',    label: 'Отчёт' },
  ]

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        <Link href="/dashboard/contests" className="hover:text-gray-700">Участие в конкурсах</Link>
        <span>/</span>
        <span className="text-gray-700">{event.title}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold" style={{ color: '#25455D' }}>{event.title}</h1>
        </div>
        <div className="flex gap-2">
          <EventStatusToggle
            eventId={eventId}
            status={event.status || 'draft'}
            onChange={(s) => setEvent((e: any) => ({ ...e, status: s }))}
          />
        </div>
      </div>

      {(event.status || 'draft') === 'draft' && (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 leading-relaxed">
          ⚠️ <b>Это черновик.</b> Партнёрские ссылки не работают —
          голосующий, открыв ссылку, ничего не увидит. Чтобы запустить, переключите
          статус «Опубликовано» в правом верхнем углу.
        </div>
      )}

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
        {/* Рассылки — отдельная страница со своими подвкладками */}
        <Link href={`/dashboard/events/${eventId}/broadcasts/queue`}
          className="px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap border-transparent text-gray-500 hover:text-gray-700">
          Рассылки
        </Link>
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && <ContestOverviewTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'posters'  && <PostersTab eventId={eventId} />}
      {activeTab === 'referral' && <ReferralProgramTab eventId={eventId} moduleSlug="contest" />}
      {activeTab === 'voters'   && <EventParticipants eventId={eventId} moduleSlug="contest" />}
      {activeTab === 'welcome'  && <WelcomeTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'report'   && <ContestReportTab eventId={eventId} />}
    </div>
  )
}
