'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import OverviewTab from './tabs/OverviewTab'
import PostersTab from './tabs/PostersTab'
import ReferralProgramTab from './tabs/ReferralProgramTab'
import CoOrganizersTab from './tabs/CoOrganizersTab'
import CollabOrganizersTab from './tabs/CollabOrganizersTab'
import NurtureTab from './tabs/NurtureTab'
import WelcomeTab from './tabs/WelcomeTab'
import TariffsTab from './tabs/TariffsTab'
import LandingTab from './tabs/LandingTab'
import EventParticipants from '@/components/EventParticipants'
import { EventStatusToggle } from '@/components/EventStatusToggle'
import ChangeEventTypeButton from '@/components/ChangeEventTypeButton'
import { useMe } from '@/hooks/useMe'
import { useUrlTab, useActiveTabRef } from '@/hooks/useUrlTab'
import WebinarTab from '@/app/dashboard/conferences/[id]/tabs/WebinarTab'
// Программа и отчёт по привлечению — те же компоненты, что у конференции.
// Бэкенд у них не привязан к типу события: check_conference_access проверяет
// владение через event_owners, а не module_slug.
import ProgramTab from '@/app/dashboard/conferences/[id]/tabs/ProgramTab'
// Отчёт у коллабы СВОЙ: конференционный ReportTab считает клики по соцсетям
// спикеров и завязан на снимки-отчёты, а в коллабе нужен вклад организаторов
// в привлечение людей + Win-Win коэффициент.
import CollabReportTab from './tabs/CollabReportTab'
import DashboardView from '@/components/analytics/DashboardView'

type TabKey = 'overview' | 'posters' | 'referral' | 'co_organizers' | 'collab_organizers' | 'participants' | 'nurture' | 'welcome' | 'tariffs' | 'tariff_orders' | 'landing' | 'webinar' | 'program' | 'report' | 'dashboard'

export default function EventPage() {
  const { id } = useParams()
  const eventId = Number(id)
  const router = useRouter()
  const [event, setEvent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useUrlTab<TabKey>('tab', 'overview')
  const { me } = useMe()
  // Раздел «Тарифы» — по фиче event_tariffs (включается через tariff_features).
  const isVip = (me?.features || []).includes('event_tariffs')
  const hasLanding = (me?.features || []).includes('event_landing')
  const hasAnalyticsDashboard = (me?.features || []).includes('analytics_dashboard')
  // Вебинарные комнаты — по фиче webinar_room (своя комната) или webinar_link
  // (ссылка на сторонний). У события без программы комната одна: бэкенд
  // отдаёт виртуальный «день 1».
  const hasWebinar = (me?.features || []).includes('webinar_room')
    || (me?.features || []).includes('webinar_link')
  // Несколько организаторов у событий — по фиче event_organizers (vip + admin).
  const hasEventOrganizers = (me?.features || []).includes('event_organizers')

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

  // «Рассылки» — отдельная страница со своими подвкладками (Шаблоны / Очередь).
  // Группировка вкладок в разделы: Настройки / Люди / Платежи / Рассылки.
  type GroupKey = 'settings_grp' | 'people' | 'tracking' | 'payments' | 'webinar_grp'
  const GROUPS: { key: GroupKey; label: string; tabs: { key: TabKey; label: string }[] }[] = [
    {
      key: 'settings_grp', label: 'Настройки',
      tabs: [
        { key: 'overview', label: 'Описание' },
        // Программа — у КОЛЛАБ-события: организаторы выступают по очереди,
        // им нужно расписание, как у конференции. У обычного мероприятия
        // программы нет (там одно выступление), поэтому вкладка только в коллабе.
        ...(event.is_collab ? [{ key: 'program' as TabKey, label: 'Программа' }] : []),
        { key: 'posters',  label: 'Афиши' },
        // Конструктор лендинга — по фиче event_landing (миграция 240).
        // У КОЛЛАБ-события скрыт: страница собирается для одного организатора.
        // Лендинг доступен и коллаб-событию: у коллабы такая же продающая
        // страница, как у обычного события — прятать её было незачем.
        ...(hasLanding ? [{ key: 'landing' as TabKey, label: 'Лендинг' }] : []),
        // ⚠️ Вебинар вынесен ОТДЕЛЬНЫМ разделом первого уровня (как в
        // конференции) — внутри «Настроек» его не найти.
        { key: 'referral', label: 'Реф-программа' },
        { key: 'nurture',  label: 'Воронка догрева' },
        // ⚠️ «Приветствие» (welcome-email) показываем И У КОЛЛАБЫ. Раньше
        // вкладка у неё пряталась — было неясно, от чьего имени письмо при
        // нескольких организаторах. Но письмо о регистрации уходит всем
        // событиям, включая коллабу, и без вкладки его нельзя было ни
        // прочитать, ни поправить (2026-08-17).
        { key: 'welcome', label: 'Приветствие' },
      ],
    },
    {
      key: 'people', label: 'Люди',
      tabs: [
        // КОЛЛАБ-событие: «Организаторы» = клиенты-совладельцы (event_owners), у каждого
        // своя реф-ссылка через СВОЕГО бота. Показываем всегда (без гейта фичей) —
        // коллаба по определению про нескольких организаторов.
        ...(event.is_collab ? [{ key: 'collab_organizers' as TabKey, label: 'Организаторы' }] : []),
        // «Организаторы»-карточки (event_collaborators) — только для не-конф мероприятий И при фиче event_organizers.
        ...((!isConference && !event.is_collab && hasEventOrganizers) ? [{ key: 'co_organizers' as TabKey, label: 'Организаторы' }] : []),
        { key: 'participants', label: 'Участники' },
      ],
    },
    // «Отслеживания» — отчёт по привлечению. У КОЛЛАБ-события это главный
    // раздел: видно, кто из организаторов сколько людей привёл и каков его
    // Win-Win коэффициент. У обычного мероприятия отчёт не показываем —
    // привлекает один человек, сравнивать не с кем.
    // ⚠️ Раздел появляется, если внутри есть хоть одна вкладка: отчёт (только
    // у коллабы) или дашборд (по фиче). Иначе получилась бы пустая группа.
    ...((event.is_collab || hasAnalyticsDashboard) ? [{
      key: 'tracking' as GroupKey, label: 'Отслеживания',
      tabs: [
        ...(event.is_collab ? [{ key: 'report' as TabKey, label: 'Отчёт по привлечению' }] : []),
        ...(hasAnalyticsDashboard ? [{ key: 'dashboard' as TabKey, label: 'Дашборд' }] : []),
      ],
    }] : []),
    // «Платежи» (бывшие «Тарифы») — только на тарифе клиента vip.
    // ⚠️ У КОЛЛАБ-события платежей нет — раздел скрыт.
    ...((isVip && !event.is_collab) ? [{
      key: 'payments' as GroupKey, label: 'Платежи',
      tabs: [
        { key: 'tariffs' as TabKey, label: 'Тарифы' },
        { key: 'tariff_orders' as TabKey, label: 'Заказы' },
      ],
    }] : []),
    // «Вебинары» — отдельный раздел первого уровня, как в конференции.
    // Событие без программы тоже поддержано: бэкенд отдаёт виртуальный «день 1»
    // (webinar_room.py), поэтому комната создаётся и без conf_days.
    ...(hasWebinar ? [{
      key: 'webinar_grp' as GroupKey, label: 'Вебинары',
      tabs: [{ key: 'webinar' as TabKey, label: 'Вебинарные комнаты' }],
    }] : []),
  ]

  const activeGroup = GROUPS.find(g => g.tabs.some(tb => tb.key === activeTab)) || GROUPS[0]

  return (
    <div>
      {/* Breadcrumb — для коллаб-события ведёт в Коллабораторную, не в Мероприятия */}
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
        {event.is_collab ? (
          <Link href="/dashboard/collab-hub/events" className="hover:text-gray-700">Коллабораторная · Коллабы</Link>
        ) : (
          <Link href="/dashboard/events" className="hover:text-gray-700">Мероприятия</Link>
        )}
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
            /* ⚠️ Подсказки, а не запреты. Вебинарную комнату и ссылку на эфир
               намеренно НЕ проверяем — их заводят перед самым эфиром, когда
               регистрации уже идут. */
            warnings={!event.poster_url ? ['афиша — в календаре карточка будет пустой'] : []}
          />
          {/* Событие могло перерасти обычное мероприятие — переводим в
              конференцию или турнир без потери заполненного. */}
          <ChangeEventTypeButton eventId={eventId} currentType={event?.module_slug || 'base'} />
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
          <EventTabBtn key={tb.key} active={activeTab === tb.key}
            onClick={() => setActiveTab(tb.key)} label={tb.label} />
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview'      && <OverviewTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'posters'       && <PostersTab eventId={eventId} />}
      {activeTab === 'landing' && hasLanding && <LandingTab eventId={eventId} event={event} />}
      {activeTab === 'webinar' && hasWebinar && <WebinarTab eventId={eventId} event={event} />}
      {activeTab === 'program' && event.is_collab && <ProgramTab eventId={eventId} />}
      {activeTab === 'report'  && event.is_collab && <CollabReportTab eventId={eventId} />}
      {/* Дашборд события: движок общий с «Аналитикой», но считает только по
          участникам этого события — условие подставляет бэк. */}
      {activeTab === 'dashboard' && hasAnalyticsDashboard && <DashboardView eventId={eventId} />}
      {activeTab === 'referral'      && <ReferralProgramTab eventId={eventId} moduleSlug={event.module_slug} />}
      {activeTab === 'collab_organizers' && event.is_collab && <CollabOrganizersTab eventId={eventId} />}
      {activeTab === 'co_organizers' && !isConference && !event.is_collab && hasEventOrganizers && <CoOrganizersTab eventId={eventId} requireSubscription={!!event.require_subscription} />}
      {activeTab === 'nurture'       && <NurtureTab eventId={eventId} isCollab={!!event.is_collab} />}
      {activeTab === 'welcome' && <WelcomeTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'tariffs'       && isVip && !event.is_collab && <TariffsTab event={event} eventId={eventId} subTab="tariffs" hideSubNav onReload={reload} />}
      {activeTab === 'tariff_orders' && isVip && !event.is_collab && <TariffsTab event={event} eventId={eventId} subTab="orders" hideSubNav onReload={reload} />}
      {activeTab === 'participants'  && <EventParticipants eventId={eventId} moduleSlug={event.module_slug} isCollab={!!event.is_collab} />}
    </div>
  )
}

// Кнопка вкладки с автоскроллом в видимую область, когда активна (в т.ч. после F5).
function EventTabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  const ref = useActiveTabRef<HTMLButtonElement>(active)
  return (
    <button ref={ref} onClick={onClick}
      className="px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap"
      style={active ? { borderBottomColor: '#25455D', color: '#25455D' } : { borderBottomColor: 'transparent' }}
    >
      {label}
    </button>
  )
}
