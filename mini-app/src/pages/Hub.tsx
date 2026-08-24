import { useState, useEffect } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import CalendarTab from '../tabs/CalendarTab'
import EcosystemTab from '../tabs/EcosystemTab'
import { getClientProfile, getClientEvents } from '../api'

interface Props {
  clientId: number
  tgUser: any
  onOpenEvent: (slug: string) => void
  initialTab?: string
}

// Mini App base ('/tg' для TG, '/vk' для VK). Возврат «к списку лидеров» ведёт
// на корень Mini App без cid-префикса — там App.tsx покажет HubSelector.
const APP_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')

const CALENDAR_TAB: NavItem = { id: 'calendar',  label: 'Календарь',   icon: 'calendar'  }
const ECOSYSTEM_TAB: NavItem = { id: 'ecosystem', label: 'О проекте',  icon: 'ecosystem' }

const PEACH = '#FFCFA4'

export default function Hub({ clientId, tgUser, onOpenEvent, initialTab }: Props) {
  const [profile, setProfile] = useState<any>(null)
  // null — ещё считаем (есть активные / есть любые события); решает видимость «Календаря»
  const [eventsState, setEventsState] = useState<{ hasActive: boolean; hasAny: boolean } | null>(null)
  const tgId = tgUser?.id ? Number(tgUser.id) : undefined

  useEffect(() => {
    getClientProfile(clientId).then(setProfile).catch(() => {})
    // считаем, есть ли активные (now/upcoming) и любые события — для видимости вкладки
    getClientEvents(clientId, undefined, tgId).then((r: any) => {
      const now = r?.now || [], up = r?.upcoming || [], past = r?.past || []
      setEventsState({ hasActive: now.length + up.length > 0, hasAny: now.length + up.length + past.length > 0 })
    }).catch(() => setEventsState({ hasActive: true, hasAny: true }))  // ошибка — не прячем
  }, [clientId, tgId])

  // Видимость вкладки «Календарь» по настройке клиента + наличию событий.
  // Пока события не посчитаны — показываем (не мигаем скрытием).
  const vis = profile?.events_tab_visibility || 'always'
  const showCalendar = vis === 'always' || eventsState == null
    || (vis === 'active' && eventsState.hasActive)
    || (vis === 'any' && eventsState.hasAny)

  // Кастомное название вкладки «О проекте» из настроек клиента.
  const ecoTab: NavItem = profile?.tab_label_ecosystem
    ? { ...ECOSYSTEM_TAB, label: profile.tab_label_ecosystem }
    : ECOSYSTEM_TAB
  const NAV: NavItem[] = showCalendar ? [CALENDAR_TAB, ecoTab] : [ecoTab]
  const VALID_TABS = new Set(NAV.map(n => n.id))
  const defaultTab = showCalendar ? 'calendar' : 'ecosystem'

  const [tab, setTab] = useState(initialTab && (initialTab === 'calendar' || initialTab === 'ecosystem') ? initialTab : 'calendar')
  // если активная вкладка стала недоступной (скрыли календарь) — переключаемся
  useEffect(() => {
    if (!VALID_TABS.has(tab)) setTab(defaultTab)
  }, [showCalendar])  // eslint-disable-line react-hooks/exhaustive-deps

  const brand = profile?.brand_name || profile?.name || 'Организатор'
  const tagline = profile?.positioning || ''
  const brandLogo = profile?.brand_logo_url

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Шапка только на Календаре. На Экосистеме — её собственная шапка-визитка. */}
      {tab === 'calendar' && (
        <div className="grad-header" style={{ paddingTop: 18, paddingBottom: 18, position: 'relative' }}>
          {/* ⚠️ «К списку лидеров» — только если человек ДЕЙСТВИТЕЛЬНО пришёл
              из списка (общий @pluson_bot, экран выбора). В боте КЛИЕНТА
              никакого «списка лидеров» нет: кнопка уводила в чужой кабинет —
              открыт Mini App Нурии, а показывался кабинет другого человека
              с его событиями (жалоба 2026-08-18).
              Признак: в адресе есть `/c/{N}/`, но пришли мы туда переходом
              из селектора — тогда в истории остаётся откуда. Проще и надёжнее
              — показывать кнопку только в ОБЩЕМ приложении (без `/c/{N}/`). */}
          {!/^\/c\/\d+\//.test(window.location.pathname) && (
          <button
            onClick={() => {
              // Сохраняем launch params VK / TG initData при возврате
              const qs = window.location.search || ''
              const hash = window.location.hash || ''
              window.location.assign(`${APP_BASE}/${qs}${hash}`)
            }}
            style={{
              position: 'absolute', top: 14, left: 12,
              background: 'rgba(255,255,255,0.10)',
              border: '1px solid rgba(255,207,164,0.4)',
              color: '#FFCFA4',
              fontSize: 12, fontWeight: 600,
              padding: '4px 10px', borderRadius: 999,
              cursor: 'pointer',
            }}
            title="К списку лидеров"
          >← К списку лидеров</button>
          )}
          {/* ⚠️ Логотип — В ОДНОЙ СТРОКЕ с названием бренда, а не отдельно
              сверху справа. Раньше он висел `position:absolute; top:14`, то
              есть ВЫШЕ заголовка — и во ВКонтакте попадал ровно под крестик и
              «…»: от логотипа была видна одна нижняя полоска (скриншот
              24.08.2026). Верхние правые углы во всех трёх мессенджерах заняты
              их собственными кнопками, поэтому ничего своего туда не кладём.
              В шапке события логотипы устроены так же — flex-строкой рядом с
              заголовком; держать одинаково. */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingTop: 28 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>
                {brand}
              </h1>
              {tagline && (
                <p style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, marginTop: 4 }}>
                  {tagline}
                </p>
              )}
            </div>
            {brandLogo && (
              <img src={brandLogo} alt=""
                   onClick={() => setTab('ecosystem')}
                   style={{
                     width: 36, height: 36, borderRadius: 8, objectFit: 'contain',
                     background: 'transparent',
                     cursor: 'pointer', flexShrink: 0,
                   }} />
            )}
          </div>
        </div>
      )}

      <div className="page">
        {tab === 'calendar'  && <CalendarTab  clientId={clientId} tgId={tgId} onOpenEvent={onOpenEvent} />}
        {tab === 'ecosystem' && <EcosystemTab clientId={clientId} />}
      </div>

      <BottomNav items={NAV} active={tab} onTab={setTab} />
    </div>
  )
}
