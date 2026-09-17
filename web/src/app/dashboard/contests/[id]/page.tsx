'use client'
import { useState, useEffect } from 'react'
import { useUrlTab } from '@/hooks/useUrlTab'
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
import LandingTab from '../../events/[id]/tabs/LandingTab'
import TariffsTab from '../../events/[id]/tabs/TariffsTab'
import RequestFormTab from '@/components/RequestFormTab'
import { useMe } from '@/hooks/useMe'

type TabKey = 'overview' | 'posters' | 'landing' | 'referral' | 'voters' | 'welcome' | 'report'
  | 'tariffs' | 'request_form' | 'tariff_orders'

export default function ContestPage() {
  const { id } = useParams()
  const eventId = Number(id)
  const router = useRouter()
  const [event, setEvent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useUrlTab<TabKey>('tab', 'overview')
  // ⚠️⚠️ ХУК ЗДЕСЬ, ВЫШЕ ранних return (правило проекта). Стоял ниже — после
  // `if (loading) return` и `if (!event) return null`: при первой отрисовке
  // компонент выходил раньше и хук не вызывался, а на второй вызывался. React
  // падал ошибкой #310 «Rendered more hooks than during the previous render»,
  // и ВСЯ страница конкурса открывалась Application error.
  const { me } = useMe()

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

  // Группировка вкладок: Настройки / Люди / Отслеживания / Рассылки.
  type GroupKey = 'settings_grp' | 'people' | 'tracking' | 'payments' | 'landing_grp'
  const hasLanding = (me?.features || []).includes('event_landing')
  const isVip = (me?.features || []).includes('event_tariffs')

  const GROUPS: { key: GroupKey; label: string; tabs: { key: TabKey; label: string }[] }[] = [
    {
      key: 'settings_grp', label: 'Настройки',
      tabs: [
        { key: 'overview', label: 'Описание' },
        { key: 'posters',  label: 'Афиши' },
        // ⚠️ «Лендинг» здесь НЕТ — он отдельный раздел первого уровня, ниже.
        { key: 'referral', label: 'Реф-программа' },
        { key: 'welcome',  label: 'Приветствие' },
      ],
    },
    { key: 'people',   label: 'Люди',         tabs: [{ key: 'voters', label: 'Голосующие' }] },
    { key: 'tracking', label: 'Отслеживания', tabs: [{ key: 'report', label: 'Отчёт по привлечению' }] },
    // «Платежи/Заявки» — по фиче `event_tariffs`, как у мероприятий и
    // конференций. ⚠️ Раньше раздела у премий не было вовсе: продать билет на
    // голосование или собрать заявки было нечем, хотя механизм общий для всех
    // событий (TariffsTab + RequestFormTab работают по event_id, тип события
    // им безразличен). Название раздела ОДНО на все типы событий.
    ...(isVip ? [{
      key: 'payments' as GroupKey, label: 'Платежи/Заявки',
      tabs: [
        { key: 'tariffs' as TabKey, label: 'Тарифы' },
        // «Формы заявки» (мигр. 363): заявка НЕ регистрирует и не берёт
        // денег — человек заполняет анкету, ответ идёт в её заявки.
        { key: 'request_form' as TabKey, label: 'Формы заявки' },
        { key: 'tariff_orders' as TabKey, label: 'Заказы' },
      ],
    }] : []),
    // ⚠️ «Лендинг» — ОТДЕЛЬНЫЙ раздел первого уровня, а не вкладка внутри
    // «Настроек» (решение владельца 07.09.2026): конструктор продающей
    // страницы — самостоятельная работа, внутри настроек его не находили.
    // ⚠️ Раньше правило применили только к мероприятиям, а у конференций и
    // премий лендинг так и остался в «Настройках» — разошлись три страницы.
    ...(hasLanding ? [{
      key: 'landing_grp' as GroupKey, label: 'Лендинг',
      tabs: [{ key: 'landing' as TabKey, label: 'Конструктор' }],
    }] : []),
  ]
  const activeGroup = GROUPS.find(g => g.tabs.some(tb => tb.key === activeTab)) || GROUPS[0]

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

      {/* Уровень 1 — разделы (группы) + «Рассылки» как отдельная страница */}
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-3">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-max sm:w-fit">
          {GROUPS.map(g => (
            <button key={g.key}
              onClick={() => { if (!g.tabs.some(tb => tb.key === activeTab)) setActiveTab(g.tabs[0].key) }}
              className={`px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                activeGroup.key === g.key ? 'shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
              style={activeGroup.key === g.key ? { backgroundColor: '#FFCFA4', color: '#25455D' } : undefined}>
              {g.label}
            </button>
          ))}
          <Link href={`/dashboard/events/${eventId}/broadcasts/queue`}
            className="px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap text-gray-500 hover:text-gray-700 hover:bg-white/60">
            Рассылки
          </Link>
        </div>
      </div>

      {/* Уровень 2 — вкладки внутри активного раздела */}
      <div className="flex gap-1 mb-8 border-b border-gray-200 overflow-x-auto">
        {activeGroup.tabs.map(tb => (
          <button
            key={tb.key}
            onClick={() => setActiveTab(tb.key)}
            className="px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap"
            style={activeTab === tb.key ? { borderBottomColor: '#25455D', color: '#25455D' } : { borderBottomColor: 'transparent', color: '#6b7280' }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && <ContestOverviewTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'posters'  && <PostersTab eventId={eventId} />}
      {activeTab === 'landing'  && hasLanding && <LandingTab eventId={eventId} event={event} />}
      {activeTab === 'referral' && <ReferralProgramTab eventId={eventId} moduleSlug="contest" />}
      {activeTab === 'voters'   && <EventParticipants eventId={eventId} moduleSlug="contest" />}
      {activeTab === 'welcome'  && <WelcomeTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'report'   && <ContestReportTab eventId={eventId} />}
      {activeTab === 'tariffs'       && isVip && <TariffsTab event={event} eventId={eventId} subTab="tariffs" hideSubNav onReload={reload} />}
      {activeTab === 'request_form'  && isVip && <RequestFormTab ownerType="events" ownerId={eventId} />}
      {activeTab === 'tariff_orders' && isVip && <TariffsTab event={event} eventId={eventId} subTab="orders" hideSubNav onReload={reload} />}
    </div>
  )
}
