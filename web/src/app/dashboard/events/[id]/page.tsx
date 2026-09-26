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
import RequestFormTab from '@/components/RequestFormTab'
import TariffsTab from './tabs/TariffsTab'
import LandingTab from './tabs/LandingTab'
import EventParticipants from '@/components/EventParticipants'
import { EventStatusToggle } from '@/components/EventStatusToggle'
import ChangeEventTypeButton from '@/components/ChangeEventTypeButton'
import { useMe } from '@/hooks/useMe'
import FeatureLock from '@/components/FeatureLock'
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
import EventCrmTab from '@/components/analytics/EventCrmTab'
import PaymentsSubTabs from '@/components/PaymentsSubTabs'
import RequestResponsesTab from '@/components/RequestResponsesTab'

type TabKey = 'overview' | 'posters' | 'referral' | 'co_organizers' | 'collab_organizers' | 'participants' | 'nurture' | 'welcome' | 'tariffs' | 'request_form' | 'tariff_orders' | 'request_responses' | 'landing' | 'webinar' | 'program' | 'report' | 'dashboard' | 'crm'

export default function EventPage() {
  const { id } = useParams()
  const eventId = Number(id)
  const router = useRouter()
  const [event, setEvent] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useUrlTab<TabKey>('tab', 'overview')
  const { me, isLeadsAssistant } = useMe()
  // ⚠️ Программа у обычного мероприятия — фича Экстры (миграция 401). Механизм
  // тот же, что у конференции: своей реализации заводить нельзя.
  const hasEventProgram = (me?.features || []).includes('event_program')
  // Раздел «Тарифы» — по фиче event_tariffs (включается через tariff_features).
  const isVip = (me?.features || []).includes('event_tariffs')
  const hasLanding = (me?.features || []).includes('event_landing')
  const hasAnalyticsDashboard = (me?.features || []).includes('analytics_dashboard')
  // Вебинарные комнаты — по фиче webinar_room. У события без программы комната
  // одна: бэкенд отдаёт виртуальный «день 1».
  // ⚠️ Фича webinar_link («только ссылка») удалена миграцией 354 — она была у тех
  // же тарифов, что и webinar_room, и не решала ничего.
  const hasWebinar = (me?.features || []).includes('webinar_room')
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

  // ⚠️ Вкладка по умолчанию — 'overview', а менеджеру лидов (миграция 484)
  // доступна только CRM: без перевода он открывал бы событие на пустом месте.
  // ⚠️ Хук стоит ЗДЕСЬ, до `if (loading)` и `if (!event)`: после ранних
  // выходов порядок хуков на разных отрисовках разъехался бы и React упал.
  useEffect(() => {
    if (isLeadsAssistant && activeTab !== 'crm') setActiveTab('crm')
  }, [isLeadsAssistant, activeTab])

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
  type GroupKey = 'settings_grp' | 'people' | 'tracking' | 'payments' | 'landing_grp' | 'webinar_grp'
  // ⚠️ `locked` — вкладка ВИДНА, но закрыта. Раньше недоступные вкладки просто
  // вырезались, и раздел выглядел пропавшим: клиент решил, что «Лендинга» в
  // продукте нет вовсе. Показываем с замком и объяснением, что подключить.
  const GROUPS: { key: GroupKey; label: string; tabs: { key: TabKey; label: string; locked?: boolean }[] }[] = [
    {
      key: 'settings_grp', label: 'Настройки',
      tabs: [
        { key: 'overview', label: 'Описание' },
        // Программа — у КОЛЛАБ-события: организаторы выступают по очереди,
        // им нужно расписание, как у конференции. У обычного мероприятия
        // программы нет (там одно выступление), поэтому вкладка только в коллабе.
        // ⚠️⚠️ ПРОГРАММА ЕСТЬ У ЛЮБОГО СОБЫТИЯ — механизм один (conf_days +
        // conf_sessions), и доступ к нему проверяет ВЛАДЕНИЕ событием, а не
        // тип (`check_conference_access`). У коллабы она работала всегда;
        // мероприятию её просто не показывали, и трёхдневник приходилось
        // заводить конференцией.
        // ⚠️ У мероприятия — по фиче `event_program` (Экстра): у однодневного
        // события программа из одного слота не нужна и только путает, поэтому
        // включается осознанно, а не появляется у всех.
        ...(event.is_collab || hasEventProgram
            ? [{ key: 'program' as TabKey, label: 'Программа' }] : []),
        { key: 'posters',  label: 'Афиши' },
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
    // ⚠️ Раздел есть ВСЕГДА: CRM доступна всем тарифам. Раньше группа
    // появлялась только у коллабы или при фиче дашбордов, и у обычного
    // мероприятия «Отслеживаний» не было вовсе.
    {
      key: 'tracking' as GroupKey, label: 'Отслеживания',
      tabs: [
        { key: 'crm' as TabKey, label: 'CRM' },
        ...(event.is_collab ? [{ key: 'report' as TabKey, label: 'Отчёт по привлечению' }] : []),
        ...(hasAnalyticsDashboard ? [{ key: 'dashboard' as TabKey, label: 'Дашборд' }] : []),
      ],
    },
    // «Платежи» (бывшие «Тарифы») — только на тарифе клиента vip.
    // ⚠️ У КОЛЛАБ-события платежей нет — раздел скрыт.
    ...((isVip && !event.is_collab) ? [{
      key: 'payments' as GroupKey, label: 'Платежи/Заявки',
      tabs: [
        // ⚠️ Две группы (26.09.2026): «Тарифы → Заказы» и «Формы заявки →
        // Заявки». Рисует их PaymentsSubTabs — порядок и цвета там.
        { key: 'tariffs' as TabKey, label: 'Тарифы' },
        { key: 'tariff_orders' as TabKey, label: 'Заказы' },
        // «Формы заявки» (мигр. 363): заявка НЕ регистрирует и не берёт
        // денег — человек заполняет анкету, ответ идёт в её заявки.
        { key: 'request_form' as TabKey, label: 'Формы заявки' },
        { key: 'request_responses' as TabKey, label: 'Заявки' },
      ],
    }] : []),
    // ⚠️ «Лендинг» — ОТДЕЛЬНЫЙ раздел первого уровня, а не вкладка внутри
    // «Настроек» (решение владельца 07.09.2026): конструктор продающей
    // страницы — самостоятельная работа, внутри настроек его не находили.
    // Стоит после «Платежи/Заявки»: сначала что продаём, потом чем продаём.
    {
      key: 'landing_grp' as GroupKey, label: 'Лендинг',
      tabs: [
        { key: 'landing' as TabKey, label: 'Конструктор', locked: !hasLanding },
      ],
    },
    // «Вебинары» — отдельный раздел первого уровня, как в конференции.
    // Событие без программы тоже поддержано: бэкенд отдаёт виртуальный «день 1»
    // (webinar_room.py), поэтому комната создаётся и без conf_days.
    ...(hasWebinar ? [{
      key: 'webinar_grp' as GroupKey, label: 'Вебинары',
      tabs: [{ key: 'webinar' as TabKey, label: 'Вебинарные комнаты' }],
    }] : []),
  ]

  // ⚠️ «Менеджеру лидов» (миграция 484) внутри события оставляем ТОЛЬКО
  // отслеживание: он ведёт своих закреплённых людей, а не готовит событие.
  // Сервер ему всё остальное и так закроет — но пункты меню, каждый из
  // которых отвечает «нет доступа», выглядят поломкой кабинета.
  const visibleGroups = isLeadsAssistant
    ? GROUPS.filter(g => g.key === 'tracking').map(g => ({
        ...g, tabs: g.tabs.filter(tb => tb.key === 'crm'),
      }))
    : GROUPS

  // ⚠️ `|| GROUPS[0]` на конце — страховка: у менеджера лидов список групп
  // отфильтрован, и если однажды группы 'tracking' не окажется, `activeGroup`
  // стал бы undefined и страница упала бы белым экраном на первом же `.tabs`.
  const activeGroup =
    visibleGroups.find(g => g.tabs.some(tb => tb.key === activeTab))
    || visibleGroups[0] || GROUPS[0]


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
        {/* ⚠️ Менеджеру лидов в шапке не показываем ничего управляющего:
            публикацию, смену типа события и переход в настройки конференции.
            Он сюда заходит ради отслеживания своих людей, а не ради
            подготовки события — и сервер эти действия ему запретит. */}
        {!isLeadsAssistant && (
        <div className="flex gap-2">
          <EventStatusToggle
            eventId={eventId}
            status={event.status || 'draft'}
            onChange={(s) => setEvent((e: any) => ({ ...e, status: s }))}
            /* ⚠️ Подсказки, а не запреты. Вебинарную комнату и ссылку на эфир
               намеренно НЕ проверяем — их заводят перед самым эфиром, когда
               регистрации уже идут. */
            /* ⚠️ Про дату предупреждаем ЗАРАНЕЕ: без неё бэкенд откажет (409),
               и человек упирается в отказ уже после подтверждения. Отдельно
               называем галочку «Идёт постоянно» — она сохраняется кнопкой
               «Сохранить» на вкладке «Основное», а публикация живёт в шапке,
               и поставленная, но не сохранённая галочка выглядит как поломка.
               `is_evergreen` и даты берём из сохранённого события, а не из
               формы, — бэкенд видит ровно их. */
            warnings={[
              ...(!event.poster_url ? ['афиша — в календаре карточка будет пустой'] : []),
              ...(!event.is_evergreen && !event.start_at
                ? ['дата — без неё опубликовать не получится. '
                   + 'Если событие идёт постоянно и даты нет, поставьте на вкладке '
                   + '«Основное» галочку «Идёт постоянно» и нажмите «Сохранить»']
                : []),
            ]}
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
        )}
      </div>

      {/* Плашка про черновик — инструкция «опубликуйте в правом верхнем углу»,
          а у менеджера лидов этого переключателя нет: совет невыполним. */}
      {(event.status || 'draft') === 'draft' && !isLeadsAssistant && (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 leading-relaxed">
          ⚠️ <b>Это черновик.</b> Партнёрские ссылки и сторонний лендинг не работают —
          участник, открыв ссылку, ничего не получит. Чтобы запустить, переключите
          статус «Опубликовано» в правом верхнем углу.
        </div>
      )}

      {/* Уровень 1 — разделы (группы) + «Рассылки» как отдельная страница.
          У менеджера лидов раздел один («Отслеживания») с единственной
          вкладкой — переключатель из одной кнопки только занимает место. */}
      <div className={`overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-3 ${isLeadsAssistant ? 'hidden' : ''}`}>
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-max sm:w-fit">
          {visibleGroups.map(g => (
            <button key={g.key}
              onClick={() => { if (!g.tabs.some(tb => tb.key === activeTab)) setActiveTab(g.tabs[0].key) }}
              className={`px-3 sm:px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                activeGroup.key === g.key ? 'shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
              style={activeGroup.key === g.key ? { backgroundColor: '#FFCFA4', color: '#25455D' } : undefined}>
              {g.label}
            </button>
          ))}
          {/* Рассылки менеджеру лидов не показываем: он ведёт своих людей
              лично, а рассылка уходит всей аудитории события. */}
          {!isLeadsAssistant && (
            <Link href={`/dashboard/events/${eventId}/broadcasts/queue`}
              className="px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap text-gray-500 hover:text-gray-700 hover:bg-white/60">
              Рассылки
            </Link>
          )}
        </div>
      </div>

      {/* Уровень 2 — вкладки внутри активного раздела. У менеджера лидов
          вкладка одна (CRM) — ряд из одной кнопки не нужен. */}
      {!isLeadsAssistant && activeGroup.key === 'payments' && (
        <PaymentsSubTabs active={activeTab} eventId={eventId}
                         onSelect={k => setActiveTab(k as TabKey)} />
      )}
      {!isLeadsAssistant && activeGroup.key !== 'payments' && (
      <div className="flex gap-1 mb-8 border-b border-gray-200 overflow-x-auto">
        {activeGroup.tabs.map(tb => (
          <EventTabBtn key={tb.key} active={activeTab === tb.key}
            onClick={() => setActiveTab(tb.key)}
            label={tb.locked ? `🔒 ${tb.label}` : tb.label} />
        ))}
      </div>
      )}

      {/* Вкладка закрыта тарифом: показываем замок вместо содержимого — так
          видно, что раздел существует, и понятно, что подключить. */}
      {activeGroup.tabs.find(tb => tb.key === activeTab)?.locked && (
        <FeatureLock anyOf={activeTab === 'landing' ? ['event_landing'] : []} />
      )}

      {/* Tab content */}
      {activeTab === 'overview'      && <OverviewTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'posters'       && <PostersTab eventId={eventId} />}
      {activeTab === 'landing' && hasLanding && <LandingTab eventId={eventId} event={event} />}
      {activeTab === 'webinar' && hasWebinar && <WebinarTab eventId={eventId} event={event} />}
      {activeTab === 'program' && (event.is_collab || hasEventProgram) && <ProgramTab eventId={eventId} />}
      {activeTab === 'report'  && event.is_collab && <CollabReportTab eventId={eventId} />}
      {/* Дашборд события: движок общий с «Аналитикой», но считает только по
          участникам этого события — условие подставляет бэк. */}
      {activeTab === 'crm' && <EventCrmTab eventId={eventId} />}
      {activeTab === 'dashboard' && hasAnalyticsDashboard && <DashboardView eventId={eventId} />}
      {activeTab === 'referral'      && <ReferralProgramTab eventId={eventId} moduleSlug={event.module_slug} />}
      {activeTab === 'collab_organizers' && event.is_collab && <CollabOrganizersTab eventId={eventId} />}
      {activeTab === 'co_organizers' && !isConference && !event.is_collab && hasEventOrganizers && <CoOrganizersTab eventId={eventId} requireSubscription={!!event.require_subscription} />}
      {activeTab === 'nurture'       && <NurtureTab eventId={eventId} isCollab={!!event.is_collab} />}
      {activeTab === 'welcome' && <WelcomeTab event={event} eventId={eventId} onReload={reload} />}
      {activeTab === 'tariffs'       && isVip && !event.is_collab && <TariffsTab event={event} eventId={eventId} subTab="tariffs" hideSubNav onReload={reload} />}
      {activeTab === 'request_form' && isVip && !event.is_collab && <RequestFormTab ownerType="events" ownerId={eventId} />}
      {activeTab === 'tariff_orders' && isVip && !event.is_collab && <TariffsTab event={event} eventId={eventId} subTab="orders" hideSubNav onReload={reload} />}
      {activeTab === 'request_responses' && isVip && !event.is_collab && <RequestResponsesTab ownerType="events" ownerId={eventId} />}
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
