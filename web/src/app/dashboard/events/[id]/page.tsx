'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import OverviewTab from './tabs/OverviewTab'
import PostersTab from './tabs/PostersTab'
import ReferralProgramTab from './tabs/ReferralProgramTab'
import CoOrganizersTab from './tabs/CoOrganizersTab'
import NurtureTab from './tabs/NurtureTab'
import EventParticipants from '@/components/EventParticipants'
import { EventStatusToggle } from '@/components/EventStatusToggle'

type TabKey = 'overview' | 'posters' | 'referral' | 'co_organizers' | 'participants' | 'nurture'

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

  // Конференции — отдельный модуль, в нём своя обширная UI; оставляем кнопку перехода
  const isConference = ['conference','turnir'].includes(event.module_slug)

  // «Рассылки» — отдельная страница со своими подвкладками (Шаблоны / Очередь),
  // как в карточке конференции. Здесь это `<Link>`, не таб контента (см. рендер ниже).
  const TABS: { key: TabKey; label: string }[] = [
    { key: 'overview',      label: 'Основное' },
    // «Организаторы» — только для не-конф мероприятий, второй вкладкой после «Основного».
    // У конференций есть свой UI спикеров — туда не дублируем.
    ...(isConference ? [] : [{ key: 'co_organizers' as TabKey, label: 'Организаторы' }]),
    { key: 'posters',       label: 'Афиши' },
    { key: 'referral',      label: 'Реф-программа' },
    { key: 'nurture',       label: 'Воронка догрева' },
    { key: 'participants',  label: 'Участники' },
  ]

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
          <h1 className="text-2xl font-bold" style={{ color: '#25455D' }}>{event.title}</h1>
        </div>
        <div className="flex gap-2">
          <EventStatusToggle
            eventId={eventId}
            status={event.status || 'draft'}
            onChange={(s) => setEvent((e: any) => ({ ...e, status: s }))}
          />
          {isConference && (
            <Link href={`/dashboard/conferences/${id}`}
                  className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-300 hover:bg-gray-50">
              Настройки конференции
            </Link>
          )}
        </div>
      </div>

      {(event.status || 'draft') === 'draft' && (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 leading-relaxed">
          ⚠️ <b>Это черновик.</b> Партнёрские ссылки и сторонний лендинг не работают —
          участник, открыв ссылку, ничего не получит. Чтобы запустить, переключите
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
        {/* «Рассылки» как ссылка на отдельную страницу с подвкладками — как у конференции */}
        <Link href={`/dashboard/events/${eventId}/broadcasts/queue`}
          className="px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap border-transparent text-gray-500 hover:text-gray-700">
          Рассылки
        </Link>
      </div>

      {/* Tab content */}
      {activeTab === 'overview'      && <OverviewTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'posters'       && <PostersTab eventId={eventId} />}
      {activeTab === 'referral'      && <ReferralProgramTab eventId={eventId} moduleSlug={event.module_slug} />}
      {activeTab === 'co_organizers' && <CoOrganizersTab eventId={eventId} requireSubscription={!!event.require_subscription} />}
      {activeTab === 'nurture'       && <NurtureTab eventId={eventId} />}
      {activeTab === 'participants'  && <EventParticipants eventId={eventId} moduleSlug={event.module_slug} />}
    </div>
  )
}
