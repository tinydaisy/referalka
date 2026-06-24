'use client'
import { useState, useEffect } from 'react'
import { useParams, usePathname } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Download } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import { EventStatusToggle } from '@/components/EventStatusToggle'
import SettingsTab  from './tabs/SettingsTab'
import SpeakersTab  from './tabs/SpeakersTab'
import ProgramTab   from './tabs/ProgramTab'
import TournamentProgramTab from './tabs/TournamentProgramTab'
import ParticipantsTab from './tabs/ParticipantsTab'
import RaffleTab  from './tabs/RaffleTab'
import PostersTab from './tabs/PostersTab'
import AnnouncementTrackerTab from './tabs/AnnouncementTrackerTab'
import { CriteriaTab, AssignmentsTab, LeaderboardTab, ReportsTab, TaskControlTab } from './tabs/ScoringTab'
import ReportTab from './tabs/ReportTab'
import ReferralProgramTab from '../../events/[id]/tabs/ReferralProgramTab'
import NurtureTab from '../../events/[id]/tabs/NurtureTab'
import WelcomeTab from '../../events/[id]/tabs/WelcomeTab'
import TariffsTab from '../../events/[id]/tabs/TariffsTab'
import BroadcastTemplatesView from './broadcasts/templates/page'
import BroadcastQueueView from './broadcasts/queue/page'
import { useMe } from '@/hooks/useMe'
import { useUrlTab, useActiveTabRef } from '@/hooks/useUrlTab'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type Tab = 'settings' | 'speakers' | 'speaker_links' | 'program' | 'participants' | 'raffle' | 'posters' | 'announcements' | 'referral' | 'nurture' | 'welcome' | 'report' | 'criteria' | 'assignments' | 'leaderboard' | 'reports' | 'taskcontrol' | 'tariffs' | 'tariff_orders' | 'broadcast_templates' | 'broadcast_queue'
const VALID_TABS: Tab[] = ['settings', 'speakers', 'speaker_links', 'program', 'participants', 'raffle', 'posters', 'announcements', 'referral', 'nurture', 'welcome', 'report', 'criteria', 'assignments', 'leaderboard', 'reports', 'taskcontrol', 'tariffs', 'tariff_orders', 'broadcast_templates', 'broadcast_queue']

export default function ConferencePage() {
  const { id } = useParams()
  const eventId = Number(id)
  const pathname = usePathname()
  const isTournament = !!pathname?.startsWith('/dashboard/tournaments')
  const basePath = isTournament ? '/dashboard/tournaments' : '/dashboard/conferences'
  const { t } = useLang()
  const [tab, setTab] = useUrlTab<Tab>('tab', 'settings', VALID_TABS as readonly Tab[])
  const [event, setEvent] = useState<any>(null)
  const [conf, setConf] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const { me } = useMe()
  // Раздел «Тарифы» — по фиче event_tariffs (включается через tariff_features).
  const isVip = (me?.features || []).includes('event_tariffs')

  async function handleSalebotExport() {
    setExporting(true)
    try {
      const token = localStorage.getItem('plusson_token')
      const res = await fetch(`${API_URL}/api/v1/events/${eventId}/conference/export/salebot`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error('Ошибка экспорта')
      const blob = await res.blob()
      const disposition = res.headers.get('content-disposition') || ''
      const nameMatch = disposition.match(/filename="?([^"]+)"?/)
      const filename = nameMatch ? nameMatch[1] : `${eventId}_info.txt`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Не удалось скачать файл')
    } finally {
      setExporting(false)
    }
  }

  // Группировка вкладок в разделы (двухуровневая навигация):
  //  Настройки / Люди / Отслеживания / Платежи / Рассылки.
  // Программа осталась внутри «Настроек» (часть наполнения события).
  type GroupKey = 'settings_grp' | 'people' | 'tracking' | 'tournament' | 'payments' | 'broadcasts'
  const GROUPS: { key: GroupKey; label: string; tabs: { id: Tab; label: string }[] }[] = [
    {
      key: 'settings_grp', label: 'Настройки',
      tabs: [
        { id: 'settings', label: 'Описание' },
        { id: 'program',  label: t.conferences.tabs.program },
        { id: 'posters',  label: t.conferences.tabs.posters },
        { id: 'referral', label: 'Реф-программа' },
        { id: 'raffle',   label: t.conferences.tabs.raffle },
        { id: 'nurture',  label: 'Воронка догрева' },
        { id: 'welcome',  label: 'Приветствие' },
      ],
    },
    {
      key: 'people', label: 'Люди',
      tabs: [
        { id: 'speakers',      label: t.conferences.tabs.speakers },
        { id: 'speaker_links', label: 'Ссылки спикеров' },
        { id: 'participants',  label: t.conferences.tabs.participants },
      ],
    },
    {
      key: 'tracking', label: 'Отслеживания',
      tabs: [
        { id: 'announcements', label: 'Анонсы спикеров' },
        { id: 'report', label: 'Отчёт по привлечению' },
      ],
    },
    // «Турнир» — раздел 1-го уровня (только для турниров). Внутри ровно 2-й уровень:
    // Критерии / Распределение / Турнирная таблица / Отчёты / Контроль заданий.
    ...(isTournament ? [{
      key: 'tournament' as GroupKey, label: 'Турнир',
      tabs: [
        { id: 'criteria' as Tab, label: 'Критерии' },
        { id: 'assignments' as Tab, label: 'Распределение' },
        { id: 'leaderboard' as Tab, label: 'Турнирная таблица' },
        { id: 'reports' as Tab, label: 'Отчёты' },
        { id: 'taskcontrol' as Tab, label: 'Контроль заданий' },
      ],
    }] : []),
    // «Платежи» (бывшие «Тарифы») — только на тарифе клиента vip. Внутри
    // TariffsTab свои подвкладки Тарифы / Заказы.
    ...(isVip ? [{
      key: 'payments' as GroupKey, label: 'Платежи',
      tabs: [
        { id: 'tariffs' as Tab, label: 'Тарифы' },
        { id: 'tariff_orders' as Tab, label: 'Заказы' },
      ],
    }] : []),
    {
      key: 'broadcasts', label: 'Рассылки',
      tabs: [
        { id: 'broadcast_templates', label: 'Шаблоны' },
        { id: 'broadcast_queue', label: 'Очередь рассылок' },
      ],
    },
  ]

  // Активная группа = та, что содержит текущий tab.
  const activeGroup = GROUPS.find(g => g.tabs.some(tb => tb.id === tab)) || GROUPS[0]

  useEffect(() => {
    Promise.all([
      api.events.get(eventId),
      api.conference.get(eventId),
    ]).then(([evRes, confRes]) => {
      setEvent(evRes.event)
      setConf(confRes.conference)
    }).finally(() => setLoading(false))
  }, [eventId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link href={basePath} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{event?.title || t.conferences.header.defaultTitle}</h1>
        </div>
        <EventStatusToggle
          eventId={eventId}
          status={event?.status || 'draft'}
          onChange={(s) => setEvent((e: any) => ({ ...e, status: s }))}
        />
        <button
          onClick={handleSalebotExport}
          disabled={exporting}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-[#25455D] text-[#FFCFA4] hover:opacity-90 transition-opacity disabled:opacity-50 whitespace-nowrap"
        >
          {exporting ? (
            <span className="animate-spin inline-block w-4 h-4 border-2 border-[#FFCFA4] border-t-transparent rounded-full" />
          ) : (
            <Download size={16} />
          )}
          Экспорт для Salebot
        </button>
      </div>

      {(event?.status || 'draft') === 'draft' && (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 leading-relaxed">
          ⚠️ <b>Это черновик.</b> Партнёрские ссылки и сторонний лендинг не работают —
          участник, открыв ссылку, ничего не получит. Чтобы запустить, переключите
          статус «Опубликовано» в правом верхнем углу.
        </div>
      )}

      {/* Уровень 1 — разделы (группы), включая «Рассылки» (внутри карточки) */}
      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-3">
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-max sm:w-fit">
          {GROUPS.map(g => (
            <button key={g.key}
              onClick={() => { if (!g.tabs.some(tb => tb.id === tab)) setTab(g.tabs[0].id) }}
              className={`px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                activeGroup.key === g.key ? 'shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
              style={activeGroup.key === g.key ? { backgroundColor: '#FFCFA4', color: '#25455D' } : undefined}>
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* Уровень 2 — вкладки внутри активного раздела.
          Если в разделе одна вкладка (напр. «Контроль заданий») — второй уровень
          не показываем, чтобы не дублировать заголовок раздела. */}
      {activeGroup.tabs.length > 1 && (
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-6 border-b border-gray-200">
          <div className="flex gap-1 w-max sm:w-fit">
            {activeGroup.tabs.map(tb => (
              <ConfTabBtn key={tb.id} active={tab === tb.id} onClick={() => setTab(tb.id)} label={tb.label} />
            ))}
          </div>
        </div>
      )}

      {tab === 'settings'     && <SettingsTab     eventId={eventId} conf={conf} event={event} onConfUpdated={setConf} onEventUpdated={(patch: any) => setEvent((e: any) => ({ ...e, ...patch }))} />}
      {tab === 'speakers'     && <SpeakersTab     eventId={eventId} moduleSlug={event?.module_slug} subTab="list" hideSubNav />}
      {tab === 'speaker_links' && <SpeakersTab    eventId={eventId} moduleSlug={event?.module_slug} subTab="links" hideSubNav />}
      {tab === 'program'      && (isTournament ? <TournamentProgramTab eventId={eventId} /> : <ProgramTab eventId={eventId} />)}
      {tab === 'participants' && <ParticipantsTab eventId={eventId} />}
      {tab === 'raffle'       && <RaffleTab />}
      {tab === 'posters'      && <PostersTab      eventId={eventId} moduleSlug={event?.module_slug} />}
      {tab === 'announcements' && <AnnouncementTrackerTab eventId={eventId} moduleSlug={event?.module_slug} />}
      {tab === 'criteria'     && <CriteriaTab eventId={eventId} />}
      {tab === 'assignments'  && <AssignmentsTab eventId={eventId} />}
      {tab === 'leaderboard'  && <LeaderboardTab eventId={eventId} />}
      {tab === 'reports'      && <ReportsTab eventId={eventId} />}
      {tab === 'taskcontrol'  && <TaskControlTab eventId={eventId} />}
      {tab === 'referral'     && <ReferralProgramTab eventId={eventId} moduleSlug="conference" />}
      {tab === 'nurture'      && <NurtureTab       eventId={eventId} />}
      {tab === 'welcome'      && <WelcomeTab       event={event} eventId={eventId} onReload={() => api.events.get(eventId).then(r => setEvent(r.event))} />}
      {tab === 'tariffs'      && isVip && <TariffsTab event={event} eventId={eventId} subTab="tariffs" hideSubNav onReload={() => api.events.get(eventId).then(r => setEvent(r.event))} />}
      {tab === 'tariff_orders' && isVip && <TariffsTab event={event} eventId={eventId} subTab="orders" hideSubNav onReload={() => api.events.get(eventId).then(r => setEvent(r.event))} />}
      {tab === 'report'       && <ReportTab       eventId={eventId} moduleSlug={event?.module_slug} />}
      {tab === 'broadcast_templates' && <BroadcastTemplatesView />}
      {tab === 'broadcast_queue'     && <BroadcastQueueView />}
    </div>
  )
}

// Кнопка вкладки с автоскроллом в видимую область, когда она активна
// (в т.ч. после F5 — чтобы выделенная вкладка не оставалась за кадром).
function ConfTabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  const ref = useActiveTabRef<HTMLButtonElement>(active)
  return (
    <button ref={ref} onClick={onClick}
      className="px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap"
      style={active ? { borderBottomColor: '#25455D', color: '#25455D' } : { borderBottomColor: 'transparent', color: '#6b7280' }}>
      {label}
    </button>
  )
}
