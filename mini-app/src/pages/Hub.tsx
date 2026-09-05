import { useState, useEffect } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import PartnerTab from '../tabs/PartnerTab'
import CalendarTab from '../tabs/CalendarTab'
import EcosystemTab from '../tabs/EcosystemTab'
import { getClientProfile, getClientEvents, getPartnerMiniApp } from '../api'
import { getPlatformName } from '../platform'
import { applyTheme } from '../utils/theme'

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
const PARTNER_TAB: NavItem = { id: 'partner',   label: 'Партнёру',   icon: 'game' }

const PEACH = 'var(--peach)'

export default function Hub({ clientId, tgUser, onOpenEvent, initialTab }: Props) {
  const [profile, setProfile] = useState<any>(null)
  // null — ещё считаем (есть активные / есть любые события); решает видимость «Календаря»
  const [eventsState, setEventsState] = useState<{ hasActive: boolean; hasAny: boolean } | null>(null)
  const tgId = tgUser?.id ? Number(tgUser.id) : undefined
  // null — ещё не знаем (запрос не завершён); решает видимость вкладки «Партнёру»
  // в режиме 'partners'.
  const [isPartner, setIsPartner] = useState<boolean | null>(null)

  useEffect(() => {
    getClientProfile(clientId).then((p: any) => {
      // Фирменные цвета клиента (мигр. 331); `theme: null` — ничего не меняет.
      applyTheme(p?.theme)
      setProfile(p)
    }).catch(() => {})
    // считаем, есть ли активные (now/upcoming) и любые события — для видимости вкладки
    getClientEvents(clientId, undefined, tgId).then((r: any) => {
      const now = r?.now || [], up = r?.upcoming || [], past = r?.past || []
      setEventsState({ hasActive: now.length + up.length > 0, hasAny: now.length + up.length + past.length > 0 })
    }).catch(() => setEventsState({ hasActive: true, hasAny: true }))  // ошибка — не прячем
  }, [clientId, tgId])

  // Партнёр ли этот человек — нужно только в режиме 'partners', чтобы не
  // показывать вкладку тем, для кого клиент её закрыл.
  // ⚠️ Спрашиваем один раз и только при заданной площадочной идентичности:
  // без неё бэкенд всё равно ответит «не партнёр».
  useEffect(() => {
    if (!tgUser?.id) { setIsPartner(false); return }
    getPartnerMiniApp(clientId, getPlatformName(), String(tgUser.id))
      .then((r: any) => setIsPartner(!!r?.is_partner))
      .catch(() => setIsPartner(false))
  }, [clientId, tgUser?.id])

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
  // Вкладка «Партнёру» (миграция 351): 'off' — нет вовсе, 'partners' — только
  // партнёрам, 'all' — всем (тогда внутри приглашение в программу).
  // ⚠️ При 'partners' вкладку показываем, только когда бэкенд подтвердил, что
  // человек партнёр: иначе он ткнёт в раздел и упрётся в приглашение, которое
  // клиент как раз просил не показывать.
  const partnerVis = profile?.partner_tab_visibility || 'off'
  const showPartner = partnerVis === 'all'
    || (partnerVis === 'partners' && isPartner === true)
  const partnerTab: NavItem = profile?.tab_label_partner
    ? { ...PARTNER_TAB, label: profile.tab_label_partner }
    : PARTNER_TAB

  const NAV: NavItem[] = [
    ...(showCalendar ? [CALENDAR_TAB] : []),
    ecoTab,
    ...(showPartner ? [partnerTab] : []),
  ]
  const VALID_TABS = new Set(NAV.map(n => n.id))
  const defaultTab = showCalendar ? 'calendar' : 'ecosystem'

  // ⚠️ 'partner' тоже принимаем: без него deeplink `_tabpartner` молча
  // открывал бы «Календарь», и ссылка на партнёрский раздел не работала бы.
  const [tab, setTab] = useState(
    initialTab && ['calendar', 'ecosystem', 'partner'].includes(initialTab)
      ? initialTab : 'calendar')
  // если активная вкладка стала недоступной (скрыли календарь) — переключаемся
  useEffect(() => {
    if (!VALID_TABS.has(tab)) setTab(defaultTab)
  }, [showCalendar])  // eslint-disable-line react-hooks/exhaustive-deps

  const brand = profile?.brand_name || profile?.name || 'Организатор'
  const tagline = profile?.positioning || ''
  const brandLogo = profile?.brand_logo_url

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Шапка только на Календаре. На Экосистеме — её собственная шапка-визитка.
          ⚠️ paddingTop НЕ задаём инлайном — он придёт из .grad-header вместе
          с запасом под кнопки мессенджера (--msgr-btns-top, см. global.css).
          Инлайновое число перебило бы общее правило, и шапка снова оказалась
          бы под крестиком. */}
      {tab === 'calendar' && (
        <div className="grad-header" style={{ paddingBottom: 18, position: 'relative' }}>
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
              border: '1px solid rgba(var(--peach-rgb), 0.4)',
              color: 'var(--peach)',
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
          {/* ⚠️ Своего paddingTop тут нет: запас под кнопки мессенджера уже
              в самой шапке (.grad-header). Раньше стояло 28 — вместе с общим
              отступом содержимое ушло бы вниз дважды. */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
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
        {tab === 'partner'   && <PartnerTab   clientId={clientId} tgUser={tgUser} />}
      </div>

      <BottomNav items={NAV} active={tab} onTab={setTab} />
    </div>
  )
}
