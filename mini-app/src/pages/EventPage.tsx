import { useState, useEffect } from 'react'
import BottomNav, { NavItem } from '../components/BottomNav'
import LandingTab from '../tabs/LandingTab'
import ProgramTab from '../tabs/ProgramTab'
import MapPage from './MapPage'
import TurnirProgramTab from '../tabs/TurnirProgramTab'
import ContestProgramTab from '../tabs/ContestProgramTab'
import SpeakersTab from '../tabs/SpeakersTab'
import GameTab from '../tabs/GameTab'
import RaffleTab from '../tabs/RaffleTab'
import ResultsTab from '../tabs/ResultsTab'
import CalendarTab from '../tabs/CalendarTab'
import EcosystemTab from '../tabs/EcosystemTab'
import MediaLiftTab from '../tabs/MediaLiftTab'
import RegistrationFlow from '../components/RegistrationFlow'
import TariffPicker from '../components/TariffPicker'
import WelcomePage from '../components/WelcomePage'
import { getEventLanding, getParticipantInEvent, registerParticipant, markParticipantWelcomed, checkRegistrationGate } from '../api'
import { getPlatformName, getPlatform } from '../platform'
import { applyTheme } from '../utils/theme'

type State = 'not_registered' | 'registered' | 'ended'

interface Props {
  slug: string
  tgUser: any
  partnerId?: string
  utmSource?: string
  contactId?: number         // `_ct{N}` в startapp — наш contact_id, чтобы бэк привязал идентичность к существующему контакту
  flags?: string[]           // флаги `_q{key}` в startapp — пробрасываем как `&{key}=1` на сторонний лендинг
  regFromLanding?: boolean   // флаг `_reg` в startapp — вернулись с лендинга клиента
  noLanding?: boolean        // флаг `_nolend` в startapp — не показывать сторонний лендинг, регать через внутренний
  initialTab?: string        // флаг `_tabXXX` в startapp — открыть на конкретной вкладке (game, raffle, ...)
  speakerEcId?: number        // `_spk{ec_id}` — открыть вкладку «Спикеры» и подсветить карточку
  // Клиент, ЧЕЙ БОТ открыл это Mini App (из `/c/{N}/tg/` или `_cid{N}`).
  // ⚠️ В КОЛЛАБЕ он ≠ владельцу события: у каждого организатора свой бот. Именно
  // его бренд и его политику показываем в согласиях 152-ФЗ.
  botClientId?: number | null
  onBack: () => void
  /** Есть ли куда возвращаться: в вебе клиент берётся из адреса или из
   *  контакта в ссылке. Нет клиента — стрелку «назад» не рисуем. */
  canGoBack?: boolean
  /** Сообщить наверх, чей это контакт (из ответа участия) — чтобы «назад»
   *  открыл календарь ЕГО организатора, а не пустой экран общего бота. */
  onContactClient?: (clientId: number) => void
  onOpenEvent?: (slug: string) => void  // открыть другое событие (для блока «А дальше» в Итогах)
}

const NAV_NOT_REG: NavItem[] = [
  { id: 'landing',   label: 'Лендинг',    icon: 'landing'   },
  { id: 'program',   label: 'Программа',  icon: 'program',   locked: true },
  // ⚠️ «Спикеры» показываем и до регистрации (под замком) — в вебе эта вкладка
  // в том же состоянии ОТКРЫТА, и человек видел разное в браузере и в
  // приложении. Замок объясняет, что нужно зарегистрироваться, — это честнее,
  // чем прятать раздел, который на витрине события заведомо есть.
  { id: 'speakers',  label: 'Спикеры',    icon: 'speakers',  locked: true },
  { id: 'game',      label: 'Привилегии',    icon: 'game',      locked: true },
  { id: 'raffle',    label: 'Розыгрыш',   icon: 'raffle',    locked: true },
  // ⚠️ «О проекте» — БЕЗ ЗАМКА, всегда. Это визитка организатора: кто он,
  // чем занимается, его каналы и продукты. Прятать её за регистрацией
  // бессмысленно — именно по ней человек и решает, регистрироваться ли.
  // Остальные вкладки закрыты потому, что там содержимое события; здесь
  // содержимое ОБЩЕЕ и публичное, оно же открыто на витрине клиента.
  { id: 'ecosystem', label: 'О проекте', icon: 'ecosystem' },
]
const NAV_REGISTERED: NavItem[] = [
  { id: 'welcome',   label: 'Интро',      icon: 'welcome'   },
  { id: 'program',   label: 'Программа',  icon: 'program'   },
  { id: 'speakers',  label: 'Спикеры',    icon: 'speakers'  },
  { id: 'game',      label: 'Привилегии',    icon: 'game'      },
  { id: 'raffle',    label: 'Розыгрыш',   icon: 'raffle'    },
  { id: 'ecosystem', label: 'О проекте', icon: 'ecosystem' },
]
const NAV_ENDED: NavItem[] = [
  { id: 'results',   label: 'Итоги',      icon: 'results'   },
  { id: 'game',      label: 'Привилегии',    icon: 'game'      },
  { id: 'calendar',  label: 'Календарь',  icon: 'calendar'  },
  { id: 'ecosystem', label: 'О проекте', icon: 'ecosystem' },
]
// ⚠️ Отдельного набора вкладок для веба БЫТЬ НЕ ДОЛЖНО. Раньше здесь лежал
// NAV_WEB_PUBLIC, где незарегистрированному гостю Программа и Спикеры были
// ОТКРЫТЫ, — и человек видел разное в браузере и в приложении, хотя код общий.
// Незарегистрированный везде видит один и тот же набор с замками (NAV_NOT_REG):
// замок объясняет, что нужно зарегистрироваться, и это одинаково честно на
// любой площадке.

function isEnded(event: any): boolean {
  if (event?.status === 'ended') return true
  if (event?.end_at && new Date(event.end_at) < new Date()) return true
  return false
}

function eventDateLabel(event: any): string {
  const start = event?.start_at ? new Date(event.start_at) : null
  const end   = event?.end_at   ? new Date(event.end_at)   : null
  const now   = new Date()
  if (!start) return ''
  if (start <= now && (!end || end >= now)) return '· идёт сейчас'
  if (start > now) {
    const days = Math.ceil((start.getTime() - now.getTime()) / 86400000)
    return `· через ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`
  }
  if (end && end < now) return '· завершено'
  return ''
}

export default function EventPage({ slug, tgUser, partnerId, utmSource, contactId, flags, regFromLanding, noLanding, initialTab, speakerEcId, botClientId, onBack, canGoBack = true, onContactClient, onOpenEvent }: Props) {
  const [event, setEvent] = useState<any>(null)
  const [participant, setParticipant] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [tab, setTabState] = useState<string>('landing')
  // ⚠️ Карта офлайн-события — ОТДЕЛЬНЫЙ ЭКРАН со стрелкой назад, а не переход
  // в браузер: выброшенный из мессенджера человек часто не возвращается.
  const [showMap, setShowMap] = useState(false)
  const [pendingSpeakerHighlight, setPendingSpeakerHighlight] = useState<number | null>(speakerEcId ?? null)
  const [showReg, setShowReg] = useState(false)
  // Выбор тарифа — открывается по кнопке участия при способе «простая форма»,
  // когда у события заданы тарифы (форма идёт после выбора).
  const [showTariffs, setShowTariffs] = useState(false)
  const [prefill, setPrefill] = useState<{ name?: string; email?: string; phone?: string } | null>(null)
  const [autoRegToast, setAutoRegToast] = useState<{ email: string; phone: string } | null>(null)
  // Счётчик «свежести»: увеличивается при переключении вкладок и заставляет
  // GameTab/ProgramTab перезапросить данные у бэка/пересчитать «активное сейчас».
  const [refreshKey, setRefreshKey] = useState(0)

  // Только participant: для GameTab при возврате на вкладку — данные могли
  // обновиться (новые регистрации, изменения в дашборде).
  async function reloadParticipant() {
    if (!tgUser?.id) return
    try {
      const part: any = await getParticipantInEvent(slug, tgUser.id)
      setParticipant(part?.participant ? {
        ...part.participant,
        referrals_count:      part.referrals_count,
        visited_count:        part.visited_count,
        registered_count:     part.registered_count,
        gifts_received_count: part.gifts_received_count,
        my_people:            part.my_people || [],
        top:                  part.top       || [],
        my_rank:              part.my_rank,
        // ⚠️ Эти четыре поля бэк отдаёт НА ВЕРХНЕМ УРОВНЕ ответа, а GameTab
        // читает их из participant. Без явного проброса там undefined:
        // `!participant.hide_rating` давало true и ТОП рейтинг показывался
        // всем, даже когда клиент его скрыл.
        hide_rating:          part.hide_rating,
        gift_count_mode:      part.gift_count_mode,
        gift_count_value:     part.gift_count_value,
        clicked_count:        part.clicked_count,
      } : null)
      setPrefill(part?.prefill || null)
    } catch (_) { /* offline / 5xx — оставляем то, что было */ }
  }

  // Обёртка над setTab: при каждом переходе перечитываем данные участника.
  // Reload без условий — счётчики/топ могли поменяться от чужих действий.
  function setTab(next: string) {
    // ⚠️ ШЛЮЗ ПОДПИСКИ: пока не подписался — с «Интро» уйти нельзя, там
    // единственное место, где можно подписаться и перепроверить.
    //
    // ⚠️ Считаем условие ЗДЕСЬ, а не берём `gateLocked` из внешней области:
    // тот объявлен ниже по файлу через const, и обращение к нему отсюда
    // работает лишь потому, что клик случается после отрисовки. Полагаться
    // на такую тонкость нельзя — при переносе кода она молча сломается.
    const lockedNow = tab === 'welcome' && next !== 'welcome'
      && !!event?.sub_check_at_registration
      && participant?.sub_checked_at == null
      && gateChannels.length > 0
    if (lockedNow) return

    // Уход с «Интро» на любую другую вкладку → отмечаем welcomed_at и
    // вкладка исчезает из навигации (не возвращается).
    if (tab === 'welcome' && next !== 'welcome'
        && participant?.id && participant?.welcomed_at == null) {
      setParticipant((p: any) => ({ ...(p || {}), welcomed_at: new Date().toISOString() }))
      markParticipantWelcomed(participant.id).catch(() => { /* offline ok */ })
    }
    setTabState(next)
    // Веб-витрина: пишем вкладку в #hash, чтобы ссылка на конкретную вкладку
    // (`/event/{slug}#speakers`) работала как прямая. На TG/VK — не трогаем URL.
    if (getPlatformName() === 'web' && typeof window !== 'undefined') {
      const newHash = '#' + next
      if (window.location.hash !== newHash) {
        history.replaceState(null, '', window.location.pathname + window.location.search + newHash)
      }
    }
    setRefreshKey(k => k + 1)
    reloadParticipant()
  }

  // Загружаем лендинг события (публично) + проверяем участие (если есть tg_id)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)

    // Бэк может зависнуть (CF/Beget ночью), а fetch без таймаута крутится бесконечно
    // и юзер видит «Загружаем...» вечно. Через 8 сек поднимаем флаг ошибки.
    const timeoutId = setTimeout(() => {
      if (!cancelled) setLoadError(true)
    }, 8000)

    Promise.all([
      getEventLanding(slug, tgUser?.id, contactId).catch(() => null),
      tgUser?.id ? getParticipantInEvent(slug, tgUser.id).catch(() => null) : Promise.resolve(null),
    ]).then(async ([landing, part]) => {
      if (cancelled) return
      clearTimeout(timeoutId)
      if (!landing) { setLoadError(true); return }
      // Фирменные цвета клиента (мигр. 331) — ставим ДО отрисовки, иначе
      // экран мигнёт стандартными цветами и перекрасится на глазах.
      // `theme: null` (галочка снята) ничего не трогает.
      applyTheme((landing as any).theme)
      setEvent(landing)
      setParticipant(part?.participant ? {
        ...part.participant,
        referrals_count:      part.referrals_count,
        visited_count:        part.visited_count,
        registered_count:     part.registered_count,
        gifts_received_count: part.gifts_received_count,
        my_people:            part.my_people || [],
        top:                  part.top       || [],
        my_rank:              part.my_rank,
        // ⚠️ Те же четыре поля с верхнего уровня ответа — см. reloadParticipant.
        hide_rating:          part.hide_rating,
        gift_count_mode:      part.gift_count_mode,
        gift_count_value:     part.gift_count_value,
        clicked_count:        part.clicked_count,
      } : null)
      setPrefill(part?.prefill || null)

      // Чей это контакт — нужно веб-витрине: по «назад» откроем календарь
      // ЭТОГО организатора, а не пустой экран выбора событий общего бота.
      const ccid = part?.participant?.contact_client_id
      if (ccid) onContactClient?.(Number(ccid))

      // Если человек когда-то отписался от email — мы заново показываем ему
      // landing с формой регистрации, чтобы он мог снова подписаться (re-opt-in).
      // Формально is_registered=true, но мы воспринимаем как «не зарегистрирован»
      // до повторного нажатия «Хочу участвовать».
      const emailUnsubscribed = !!part?.participant?.email_unsubscribed
      const alreadyRegistered = !!part?.participant?.is_registered && !emailUnsubscribed
      const ended = isEnded(landing)

      // event_start — сигнал «открыл событие». Шлём только для TG-эндпойнта
      // (бэк по статусу/датам выбирает контекстное приветствие register_cta /
      // referral_reminder / next_event_cta / ecosystem_thanks; дедуп через
      // last_open_msg_kind/at).
      //
      // VK-Mini-App шлёт свой event_start через /api/v1/vk/event ещё в App.tsx
      // при первом монтировании. Здесь второй раз слать не нужно — иначе
      // TG-эндпойнт попытается отправить sendMessage на vk_user_id под видом
      // tg_id и 400'ит.
      if (tgUser?.id && slug && getPlatformName() === 'telegram') {
        fetch(`${import.meta.env.VITE_API_URL}/api/v1/event`, {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id:    String(tgUser.id),
            event:      'event_start',
            first_name: tgUser.first_name || '',
            last_name:  tgUser.last_name  || '',
            username:   tgUser.username   || '',
            partner_id: partnerId || '',
            event_slug: slug,
            client_id:  0,
            contact_id: contactId || 0,
            platform:   'telegram',
          }),
        }).catch(() => {})
      }

      // Если человек пришёл по ссылке `?startapp=...?_reg` — он только что
      // зарегистрировался на лендинге клиента. Помечаем is_registered=true
      // (через регистрацию без email/phone — данные у клиента, мы их пока
      // не знаем; webhook от клиента — отдельная фича на будущее).
      if (regFromLanding && tgUser?.id && slug && !alreadyRegistered) {
        try {
          const r: any = await registerParticipant({
            event_slug: slug,
            tg_id: tgUser.id,
            username: tgUser.username,
            first_name: tgUser.first_name || '',
            last_name:  tgUser.last_name  || '',
            ref_code: partnerId,
            utm_source: utmSource,
            contact_id: contactId,
          })
          const reg = r?.participant || r
          if (!cancelled) setParticipant({ ...reg, is_registered: true })
          // Только что зарегистрировался → стартовая вкладка «Интро», если
          // клиент её оставил (галочка `show_welcome_tab`, мигр. 406). Выключил
          // — сразу «Программа». Конкурсам и турнирам «Интро» не показываем.
          const introOn = (landing as any)?.show_welcome_tab !== false
            && !['contest', 'turnir'].includes(landing?.module_slug)
          if (!cancelled) setTabState(introOn ? 'welcome' : 'program')
        } catch (_) { /* fallback на обычный flow — лендинг */ }
      } else if (speakerEcId && ['conference', 'turnir'].includes(landing?.module_slug)) {
        // Прямая ссылка на карточку спикера/жюри — вкладка «Спикеры» доступна
        // всем (витрина), даже до регистрации и после завершения.
        setTabState('speakers')
      } else if (ended) {
        setTabState('results')
      } else if (alreadyRegistered) {
        // initialTab из startapp (_tabgame, _tabraffle и т.п.) — приоритет над дефолтом.
        // Доступен только зарегистрированным; для нерег. остаётся landing.
        const allowed = ['welcome', 'program', 'speakers', 'game', 'raffle', 'ecosystem']
        if (initialTab && allowed.includes(initialTab)) {
          setTabState(initialTab)
        } else if (
          (landing as any)?.show_welcome_tab !== false
          && part?.participant?.welcomed_at == null
          && !['contest', 'turnir'].includes(landing?.module_slug)
        ) {
          // Только что зарегистрировался (welcomed_at пуст) → «Интро», если
          // клиент оставил галочку. После первого ухода с вкладки welcomed_at
          // проставляется и дефолтом становится «Программа».
          setTabState('welcome')
        } else {
          setTabState('program')
        }
      } else if (getPlatformName() === 'web') {
        // Веб-витрина без регистрации: открываем вкладку из #hash, если она
        // публичная; иначе — лендинг.
        const pub = ['landing', 'program', 'speakers', 'ecosystem']
        setTabState(initialTab && pub.includes(initialTab) ? initialTab : 'landing')
      } else {
        setTabState('landing')
      }
    }).finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true; clearTimeout(timeoutId) }
  }, [slug, tgUser?.id, reloadKey])

  // Определяем состояние и набор вкладок (вычисляется ДО early return —
  // иначе useEffect ниже сломает порядок хуков React).
  const ended      = isEnded(event)
  const registered = !!participant?.is_registered
  const state: State = ended ? 'ended' : registered ? 'registered' : 'not_registered'

  // Welcome — отдельная вкладка «Интро» в нижней навигации (всегда доступна
  // зарегистрированному участнику). По умолчанию открывается у тех, у кого
  // welcomed_at пуст; после первого открытия дефолт переключается на «Программу».

  // Активность игры/розыгрыша определяется тогглами в дашборде клиента.
  // Если клиент не включил — соответствующая вкладка вообще не показывается.
  const refOn    = !!event?.referral_enabled
  const raffleOn = !!event?.raffle_enabled

  // ⚠️⚠️ ШЛЮЗ ПОДПИСКИ ПРИ ВХОДЕ В КАБИНЕТ (мигр. 344).
  // Организатор включил `sub_check_at_registration` → зарегистрированный
  // участник не попадает в кабинет, пока не подпишется на каналы. Интро при
  // этом остаётся на экране, остальные вкладки ВИДНЫ, но под замком.
  //
  // ⚠️ Проверяется ДО ПЕРВОГО ФАКТА: как только `sub_checked_at` проставлен,
  // шлюз выключается навсегда — даже если человек потом отписался.
  //
  // ⚠️ Почему подписку просят здесь, а не при запуске Mini App: модерация
  // ВКонтакте запрещает просить её до просмотра функций (п.1.1.2).
  const gateNeeded = registered
    && !!event?.sub_check_at_registration
    && participant?.sub_checked_at == null
  const [gateChannels, setGateChannels] = useState<{ name: string; tg_channel_url: string | null }[]>([])

  // Спрашиваем бэкенд: пускать ли в кабинет. Он же поставит отметку, если
  // человек уже подписан, — тогда список каналов придёт пустым и замков не будет.
  useEffect(() => {
    if (!gateNeeded || !event?.id) { setGateChannels([]); return }
    let cancelled = false
    const p = getPlatform()
    const uid = p.user?.id || tgUser?.id || ''
    checkRegistrationGate(event.id, p.name, uid, participant?.contact_id)
      .then((r: any) => {
        if (cancelled) return
        if (r?.allowed) {
          // Прошёл (или проверять было нечем) — отметку поставил бэкенд,
          // отражаем её локально, чтобы шлюз не сработал повторно.
          setGateChannels([])
          setParticipant((prev: any) => prev?.sub_checked_at
            ? prev
            : { ...(prev || {}), sub_checked_at: new Date().toISOString() })
        } else {
          setGateChannels(r?.not_subscribed || [])
        }
      })
      .catch(() => {
        // ⚠️ Сбой проверки НЕ запирает кабинет: человек уже зарегистрирован,
        // и отказывать ему из-за нашей сетевой ошибки нельзя.
        if (!cancelled) setGateChannels([])
      })
    return () => { cancelled = true }
  }, [gateNeeded, event?.id, participant?.contact_id])
  // ⚠️ Пока проверка не ответила, замки НЕ вешаем: иначе на каждом заходе
  // кабинет на секунду «моргал» бы блокировкой у тех, кто давно подписан.
  const gateLocked = gateNeeded && gateChannels.length > 0

  // Welcome-вкладка («Интро») видна только до того момента, как человек
  // ушёл с неё на любую другую вкладку. После этого welcomed_at != NULL и
  // вкладка пропадает — обратно вернуться нельзя.
  // Для конкурсов и турниров «Интро» не показываем — сразу в «Программу».
  //
  // ⚠️ ИСКЛЮЧЕНИЕ: пока не пройден шлюз подписки, «Интро» показываем ВСЕГДА —
  // в том числе конкурсам и турнирам и тем, у кого welcomed_at уже стоит.
  // Иначе человеку негде подписаться: экран с каналами живёт именно здесь.
  //
  // ⚠️⚠️ ПОКАЗ «ИНТРО» — ГАЛОЧКА СОБЫТИЯ `show_welcome_tab` (мигр. 406).
  // 11.09.2026 экран отключили всем разом прямо в коде — то есть у клиентов,
  // которым он был нужен как онбординг, он пропал без спроса. Теперь это
  // настройка: одним нужен приветственный экран, другим — сразу содержимое.
  // Поле приходит из `/events/{slug}/landing`; старый бэк его не отдаёт,
  // поэтому `!== false` — отсутствие поля значит «показывать», как раньше.
  const welcomeTabEnabled = (event as any)?.show_welcome_tab !== false
  const hidesWelcome = ['contest', 'turnir'].includes(event?.module_slug)
  const showWelcomeTab = gateLocked
    || (welcomeTabEnabled && registered && participant?.welcomed_at == null && !hidesWelcome)

  // Вкладка «Спикеры» — если у события ЕСТЬ ЛЮДИ (карточки спикеров,
  // организаторов, жюри, партнёров), как это давно делает веб-страница
  // события (`has_people`). ⚠️ Раньше условие было по ТИПУ события
  // (только conference/turnir), и у КОЛЛАБЫ вкладки не было вовсе: карточки
  // организаторов есть, лента аватаров есть, а открыть их некуда — имена под
  // программой не вели никуда. Веб при этом спикеров показывал, и один и тот
  // же человек видел разное в приложении и в браузере.
  // `has_people` может не прийти со старого бэка → падаем на прежнее правило.
  const hasSpeakersTab = event?.has_people !== undefined
    ? !!event.has_people
    : ['conference', 'turnir'].includes(event?.module_slug)

  // Тарифы события — от них зависит, что открывает кнопка участия при способе
  // регистрации «простая форма»: выбор тарифа или сразу форму.
  const tariffs: any[] = Array.isArray(event?.tariffs) ? event.tariffs : []
  // Форма заявки (мигр. 363): «оставить заявку» вместо регистрации.
  const requestForm = event?.request_form || null

  // Кастомные названия вкладок из настроек клиента (пусто → дефолт из константы NAV_*).
  const tabLabels: Record<string, string | undefined> = {
    program:   event?.tab_label_program,
    speakers:  event?.tab_label_speakers,
    game:      event?.tab_label_game,
    ecosystem: event?.tab_label_ecosystem,
  }
  const applyLabel = (n: NavItem): NavItem => {
    const custom = tabLabels[n.id]
    return custom ? { ...n, label: custom } : n
  }

  // Если событие завершено и участника нет — Игру тоже не показываем.
  const filterByEnabled = (items: NavItem[]) => items.filter(n =>
    (n.id !== 'welcome'  || showWelcomeTab) &&
    (n.id !== 'speakers' || hasSpeakersTab) &&
    (n.id !== 'game'     || refOn)          &&
    (n.id !== 'raffle'   || raffleOn)
  ).map(applyLabel)

  const navItemsEnded = participant
    ? filterByEnabled(NAV_ENDED)
    : filterByEnabled(NAV_ENDED).filter(n => n.id !== 'game')
  // Вкладка «Подарки» открыта незарегистрированным, если клиент так настроил
  // (миграция 350). Реф-ссылка есть у каждого контакта, поэтому человек может
  // рекомендовать событие, ещё не решив, идёт ли сам.
  // ⚠️ Открывается ВКЛАДКА, а не подарки: сами подарки за пороги остаются под
  // замком внутри неё — иначе человек решит, что подарок уже его.
  const giftsOpenToGuests = !!event?.gifts_open_to_guests
  const unlockGifts = (items: NavItem[]) =>
    giftsOpenToGuests
      ? items.map(n => (n.id === 'game' ? { ...n, locked: false } : n))
      : items

  let navItems = state === 'not_registered'
                     // Один набор на все площадки: в вебе и в приложении
                     // незарегистрированный видит одинаковые вкладки с замками.
                     ? unlockGifts(filterByEnabled(NAV_NOT_REG))
                 : state === 'registered'     ? filterByEnabled(NAV_REGISTERED)
                 :                              navItemsEnded
  // Прямая ссылка на карточку спикера — вкладка «Спикеры» доступна как витрина,
  // даже если по обычным правилам её нет в навигации (нерег. в TG/VK).
  if (speakerEcId && hasSpeakersTab && !navItems.some(n => n.id === 'speakers')) {
    navItems = [...navItems, { id: 'speakers', label: tabLabels.speakers || 'Спикеры', icon: 'speakers' }]
  }

  // ⚠️ Шлюз подписки закрыт → все вкладки, кроме «Интро», под замком.
  // Именно ПОД ЗАМКОМ, а не спрятаны: человек должен видеть, что его ждёт
  // внутри, — иначе требование подписаться выглядит как пустое препятствие.
  if (gateLocked) {
    navItems = navItems.map(n => n.id === 'welcome' ? n : { ...n, locked: true })
  }

  // ⚠️ Шлюз подписки закрыт, а человек стоит не на «Интро» — возвращаем его
  // туда. Так бывает при заходе по ссылке с вкладкой (`_tabgame`) или при
  // обычном открытии уже зарегистрированного участника: экран с каналами
  // живёт на «Интро», и без этого человек упирался бы в замки, не понимая,
  // где подписаться.
  //
  // ⚠️ setTabState, а НЕ setTab: тот при закрытом шлюзе отказывается уходить
  // с «Интро», и такой вызов был бы съеден собственной защитой.
  useEffect(() => {
    if (gateLocked && tab !== 'welcome') setTabState('welcome')
  }, [gateLocked, tab])

  // Если текущая вкладка пропала из navItems (например клиент выключил
  // рефералку/розыгрыш) — переключаем на первую доступную.
  useEffect(() => {
    if (!event) return
    if (!navItems.some(n => n.id === tab)) {
      setTab(navItems[0]?.id || 'landing')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOn, raffleOn, state, event])

  // Авто-редирект на сторонний лендинг клиента (миграция 057).
  // Inline-скрипт в mini-app/index.html делает редирект ДО React при прямом
  // заходе по ссылке `?startapp=ref_pgSLUG`. Но при ВНУТРЕННЕЙ навигации SPA
  // (клик по событию в Хабе организатора) index.html заново не загружается,
  // поэтому здесь дублируем логику. Используется window.location.href
  // (а не Telegram.WebApp.openLink), чтобы iOS не блокировал как popup.
  // См. documentation/MINI-APP-WEBVIEW-REDIRECT.md
  //
  // ⚠️ Если юзер пришёл с `_reg`-флагом (возврат с лендинга после регистрации),
  // редирект НЕ делаем — Mini App в параллельном useEffect выше вызывает
  // registerParticipant. Без этой проверки была race condition: пока
  // registerParticipant летит, второй useEffect видит registered=false и
  // уносит юзера обратно на сторонний лендинг. Юзер видит «кольцо» и статус
  // регистрации не успевает закрепиться.
  useEffect(() => {
    if (!event) return
    if (loading) return
    // Веб-витрина (pluson.ru/event/{slug}) — НЕ улетаем на сторонний лендинг
    // клиента: показываем встроенную витрину (программа/спикеры/экосистема).
    if (getPlatformName() === 'web') return
    if (registered || ended) return
    if (regFromLanding) return  // ← возврат с лендинга: ждём registerParticipant
    if (noLanding) return       // ← флаг `_nolend`: показываем внутренний лендинг, внешний не открываем
    // ⚠️ Регистрация ещё не открыта (мигр. 345) — остаёмся здесь и показываем
    // заглушку. Сервер и так вернёт пусто, но проверяем ЯВНО: при недоступной
    // сети `redirectToExternalLanding` уходит на запасной `landing_url`, и
    // человека унесло бы на сторонний сайт вопреки настройке.
    if (event.registration_closed) return
    // ⚠️⚠️ ПРАВА ВКОНТАКТЕ ПРОСИМ ДО РЕДИРЕКТА НА ЛЕНДИНГ.
    //
    // Событие с режимом «лендинг» уводит webview на страницу регистрации —
    // Mini App при этом закрывается, и показать системные окна ВК уже некому.
    // Отсюда «по ссылке не приходит ни одного окна» при том, что событие
    // открывается (жалоба владельца 05.09.2026: мелькает форма, потом лендинг).
    //
    // ⚠️ Отметка времени общая с App.tsx: если права уже спрашивали в
    // последние 20 секунд, второй раз не показываем.
    // ⚠️⚠️ РЕДИРЕКТ ЖДЁТ ОТВЕТА НА ОКНА. Диагностика на проде 05.09.2026
    // показала: вызов окон происходит (`perms:call`, номер сообщества есть),
    // но человек их не видит — редирект на лендинг уводит webview раньше, чем
    // ВКонтакте успевает их нарисовать.
    //
    // Поэтому сначала окна, ответ, и только потом редирект.
    //
    // ⚠️ Отсечки «уже спрашивали недавно» тут быть НЕ должно: запрос из
    // App.tsx уходит в те же секунды и блокировал бы этот — а он главный,
    // потому что держит редирект.
    ;(async () => {
      if (getPlatformName() === 'vk') {
        const { getPlatform } = await import('../platform')
        const a = getPlatform()
        let gid = Number(a.launchParams?.vk_group_id || 0)
        if (!gid && a.launchParams?.vk_app_id) {
          try {
            const r: any = await fetch(
              `${import.meta.env.VITE_API_URL}/api/v1/vk/group-for-app?app_id=${a.launchParams.vk_app_id}`
            ).then(x => x.ok ? x.json() : null)
            if (r?.group_id) gid = Number(r.group_id)
          } catch { /* skip */ }
        }
        if (gid) {
          ;(window as any).__vkPermsAt = Date.now()
          // Порядок как в рабочей версии: подписка внутри колбэка разрешения.
          //
          // ⚠️ Страховка 8 секунд, а НЕ 45. С 45 человек висел на странице
          // события с кнопкой «Зарегистрироваться» почти минуту, если ВК не
          // отвечал (жалоба владельца 05.09.2026). Восьми хватает, чтобы окна
          // успели показаться, а зависание было незаметным.
          await new Promise<void>((resolve) => {
            let done = false
            const finish = () => { if (!done) { done = true; resolve() } }
            setTimeout(finish, 8000)
            try {
              a.requestWriteAccess({ vkGroupId: gid }, () => {
                if (a.joinGroup) {
                  try { a.joinGroup({ vkGroupId: gid }, () => finish()) } catch { finish() }
                } else finish()
              })
            } catch { finish() }
          })
        }
      }
      // ⚠️ Спрашиваем сервер ВСЕГДА, а не только при заполненном стороннем
      // адресе: способ регистрации может быть «Плюсоновский лендинг», у него
      // своего адреса в событии нет. Сервер вернёт пусто — остаёмся здесь.
      redirectToExternalLanding((event.landing_url || '').trim())
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, loading, registered, ended, regFromLanding, noLanding])

  // Стандартный набор GET-параметров для ЛЮБОГО внешнего URL клиента
  // (events.landing_url, events.vip_url, partner_landing_url):
  //   pluson_contact_id, pluson_participant_id, tg_id/vk_id, email, phone,
  //   name, tg_nickname, external_ref_param контакта/рефовода, pid, utm_source,
  //   event_slug.
  // Сборку делает бэк (/landing-redirect и /vip-redirect), фронт только
  // прокидывает контекст пользователя.
  function platformQuery(): string {
    const tgId = tgUser?.id ? String(tgUser.id) : ''
    const qs = new URLSearchParams()
    if (tgId) qs.set(getPlatformName() === 'vk' ? 'vk_id' : 'tg_id', tgId)
    if (partnerId) qs.set('pid', partnerId)
    if (utmSource) qs.set('utm_source', utmSource)
    if (flags && flags.length) qs.set('q', flags.join(','))
    return qs.toString()
  }

  // Партнёрский параметр клиента + полный набор полей контакта — берём
  // готовый URL с бэка (/landing-redirect), не собираем его на фронте.
  // Куда уводить на регистрацию по мнению сервера: сторонний сайт, наш
  // лендинг-конструктор или никуда (встроенная форма). Пусто = остаёмся здесь.
  async function resolveRegistrationTarget(): Promise<string> {
    try {
      const apiBase = import.meta.env.VITE_API_URL || ''
      const qs = platformQuery()
      const r = await fetch(
        `${apiBase}/api/v1/public/events/${encodeURIComponent(slug)}/landing-redirect${qs ? `?${qs}` : ''}`,
      )
      if (r.ok) {
        const data = await r.json()
        if (data?.redirect_url) return String(data.redirect_url)
      }
    } catch { /* сеть недоступна — остаёмся на встроенной странице */ }
    return ''
  }

  async function redirectToExternalLanding(landingUrl: string) {
    const target = await resolveRegistrationTarget()
    const fullUrl = target || landingUrl
    if (!fullUrl) return
    getPlatform().redirectTo(fullUrl)
  }

  // VIP-тариф — открывается во ВНЕШНЕМ браузере (платёжные страницы плохо
  // работают в webview). URL обогащается на бэке через /vip-redirect.
  async function redirectToVip(vipUrl: string) {
    let fullUrl = vipUrl
    try {
      const apiBase = import.meta.env.VITE_API_URL || ''
      const qs = platformQuery()
      const r = await fetch(
        `${apiBase}/api/v1/public/events/${encodeURIComponent(slug)}/vip-redirect${qs ? `?${qs}` : ''}`,
      )
      if (r.ok) {
        const data = await r.json()
        if (data?.redirect_url) fullUrl = data.redirect_url
      }
    } catch { /* fallback — открываем как есть */ }
    getPlatform().openExternal(fullUrl)
  }

  if (loadError && !event) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}>
        <div style={{ maxWidth: 360, textAlign: 'center' }}>
          <h2 style={{ fontSize: 18, margin: '0 0 12px', color: 'var(--dark)', fontWeight: 700 }}>
            Не удалось загрузить событие
          </h2>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 24px' }}>
            Похоже, связь с сервером прервалась. Попробуйте обновить страницу.
          </p>
          <button
            onClick={() => { setLoadError(false); setReloadKey(k => k + 1) }}
            style={{
              background: 'var(--peach)', color: 'var(--dark)',
              fontWeight: 700, padding: '12px 28px', borderRadius: 12, fontSize: 15,
              border: 'none', cursor: 'pointer',
              boxShadow: '0 4px 14px rgba(var(--peach-rgb), 0.4)',
            }}
          >Обновить</button>
        </div>
      </div>
    )
  }

  if (loading || !event) {
    return (
      <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Загружаем...
      </div>
    )
  }

  // МедиаЛифт — весь флоу на одном экране (карточки ветки → подписка на 3 →
  // регистрация → добавь свой канал → апселл). Обычная навигация события не нужна.
  if (event.module_slug === 'medialift') {
    return (
      <MediaLiftTab
        event={event}
        tgUser={tgUser}
        contactId={contactId}
        partnerId={partnerId}
        isRegistered={!!participant?.is_registered}
        onRegistered={() => setParticipant((p: any) => ({ ...(p || {}), is_registered: true }))}
      />
    )
  }

  function handleRegistered(p: any) {
    setParticipant({ ...p, is_registered: true })
    setShowReg(false)
    setTab('program')
  }

  // Клик по «Хочу участвовать»: если контакты этого человека уже есть
  // в базе клиента (email+phone) — регистрируем без формы, иначе показываем форму.
  async function handleWantParticipate() {
    // ⚠️ Регистрация ещё не открыта (мигр. 345). Кнопки участия при этом нет
    // вовсе, но обработчик зовётся и из других мест — а ниже по функции стоит
    // автозапись «без ввода контактных данных», которая записала бы человека
    // одним касанием туда, где запись закрыта.
    if (event?.registration_closed) return
    // Если у события заполнен сторонний лендинг — переходим на него навигацией
    // webview (как в auto-useEffect выше). На iOS это работает без user-gesture
    // ограничений и согласуется с авто-открытием.
    // Флаг `_nolend` — клиент намеренно гонит регистрацию через внутренний
    // лендинг, на сторонний не уводим даже по клику «Хочу участвовать».
    // ⚠️ Куда вести — решает СПОСОБ РЕГИСТРАЦИИ события, его знает сервер
    // (/landing-redirect). Раньше проверялся только сторонний адрес, и при
    // выбранном «Плюсоновском лендинге» человек оставался на простой форме.
    if (!noLanding) {
      const target = await resolveRegistrationTarget()
      if (target) {
        const { getPlatform } = await import('../platform')
        getPlatform().redirectTo(target)
        return
      }
    }

    // ⚠️ Способ регистрации — «простая форма», и у события ЕСТЬ ТАРИФЫ:
    // вместо формы показываем выбор варианта участия, форма откроется уже
    // после выбора бесплатного (платный уходит на оплату). Иначе человек
    // записывался бесплатно на событие, где вход продаётся.
    if (tariffs.length > 0 || requestForm) { setShowTariffs(true); return }

    // Клиент в дашборде включил «Регистрировать без ввода контактных данных»:
    // регистрируем по tg_id без формы, имя из Telegram, email/phone пустые.
    if (event?.skip_contact_form && tgUser?.id) {
      try {
        const r: any = await registerParticipant({
          event_slug: slug,
          tg_id: tgUser.id,
          username: tgUser.username,
          first_name: tgUser.first_name || '',
          last_name:  tgUser.last_name  || '',
          ref_code: partnerId,
          utm_source: utmSource,
          contact_id: contactId,
        })
        const reg = r?.participant || r
        setParticipant({ ...reg, is_registered: true })
        setTab('program')
        return
      } catch (_) {
        // Не получилось — fallback на форму.
      }
    }

    const canAutoRegister = !!(prefill?.email?.trim() && prefill?.phone?.trim())
    if (canAutoRegister && tgUser?.id) {
      try {
        const r: any = await registerParticipant({
          event_slug: slug,
          tg_id: tgUser.id,
          username: tgUser.username,
          first_name: tgUser.first_name || prefill!.name || '',
          last_name:  tgUser.last_name  || '',
          email: prefill!.email!,
          phone: prefill!.phone!,
          ref_code: partnerId,
          utm_source: utmSource,
          contact_id: contactId,
        })
        const reg = r?.participant || r
        setParticipant({ ...reg, is_registered: true })
        setAutoRegToast({ email: prefill!.email!, phone: prefill!.phone! })
        setTab('program')
        setTimeout(() => setAutoRegToast(null), 6000)
        return
      } catch (_) {
        // Не получилось — fallback на форму.
      }
    }
    setShowReg(true)
  }

  // Если у события подключён сторонний лендинг и человек ещё не зарегистрирован —
  // useEffect выше делает window.location.replace на этот лендинг. Между моментом
  // снятия loading и заменой URL React успевает отрендерить LandingTab, и
  // пользователь на долю секунды видит «Хочу участвовать» (иногда платное
  // событие — кнопка опасна). Поэтому ДО рендера прячем всё под loader, пока
  // редирект ещё не сработал.
  // ⚠️ Уводим на сторонний лендинг ТОЛЬКО когда он выбран способом регистрации
  // (registration_mode='external'). Раньше хватало заполненного landing_url —
  // у многих там ссылка на бота или на чужое событие, и человека уносило туда.
  const willRedirectToLanding =
    !!event && !!(event.landing_url || '').trim()
    && (event as any).registration_mode === 'external'
    && !registered && !ended && !regFromLanding && !noLanding
  if (willRedirectToLanding) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--gradient)',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          border: '4px solid rgba(var(--peach-rgb), 0.25)', borderTopColor: 'var(--peach)',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* ⚠️ Запас сверху — переменная --msgr-btns-top (см. global.css): правый
          край строки с логотипами попадал под крестик и «…» мессенджера.
          Число сюда не вписывать — отступ общий на все шапки. */}
      <div className="grad-header"
           style={{ padding: 'calc(14px + var(--msgr-btns-top)) 18px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
          {/* ⚠️ Стрелка «назад» — только если есть КУДА возвращаться.
              В вебе клиент известен либо из адреса, либо из контакта в ссылке;
              без него возврат высаживал на экран выбора событий общего бота —
              в браузере он пустой, и человек упирался в тупик. */}
          {canGoBack && (
            <button onClick={onBack}
                    style={{ background: 'rgba(var(--peach-rgb), 0.15)', border: 'none', color: 'white',
                             width: 36, height: 36, borderRadius: 10, cursor: 'pointer', fontSize: 20,
                             display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              ‹
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ color: 'white', fontSize: 15, fontWeight: 700, lineHeight: 1.25,
                         whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {event.title}
            </h1>
            {/* ⚠️ Подпись «идёт сейчас» лежит НА ТЁМНОЙ шапке: берём цвет,
                посчитанный от фона (--on-dark-icon), а не сам акцент — он
                может совпасть с фирменным фоном и подпись пропадёт. */}
            <p style={{ color: 'var(--on-dark-icon)', opacity: 0.85, fontSize: 12, marginTop: 2, fontWeight: 500 }}>
              {eventDateLabel(event)}
            </p>
          </div>
          {/* ⚠️ У КОЛЛАБЫ — логотипы ВСЕХ организаторов, а не одного: событие
              общее, и показывать бренд только «первого владельца» неверно.
              Шапка одна на все вкладки, поэтому логотипы видны везде.
              У обычного события организатор один — ведёт себя как раньше. */}
          {(() => {
            const collabLogos: string[] = event?.is_collab
              ? (event.collab_owners || [])
                  .map((o: any) => o.brand_logo_url)
                  .filter(Boolean)
              : []
            const logos = collabLogos.length
              ? collabLogos
              : (event.client_brand_logo ? [event.client_brand_logo] : [])
            if (!logos.length) return null
            return (
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {logos.map((url, i) => (
                  <img key={i} src={url} alt=""
                       onClick={() => setTab('ecosystem')}
                       style={{
                         width: 36, height: 36, borderRadius: 8, objectFit: 'contain',
                         background: 'transparent',
                         cursor: 'pointer', flexShrink: 0,
                       }} />
                ))}
              </div>
            )
          })()}
        </div>
      </div>

      {autoRegToast && (
        <div style={{
          background: 'var(--peach)', color: 'var(--dark)', padding: '10px 14px',
          fontSize: 12, lineHeight: 1.45, fontWeight: 700,
          borderBottom: '1px solid #f0b87a',
        }}>
          ✓ Вы зарегистрированы — данные взяты из вашей карточки:
          <div style={{ marginTop: 4, fontWeight: 600, wordBreak: 'break-all' }}>
            {autoRegToast.email} · {autoRegToast.phone}
          </div>
        </div>
      )}

      <div className="page">
        {/* ⚠️ Карта перекрывает вкладки ЦЕЛИКОМ и живёт отдельным экраном:
            это «провалиться и вернуться», а не ещё одна вкладка снизу —
            в нижней панели ей места нет, там пять постоянных разделов. */}
        {showMap && (
          <MapPage
            address={(event?.address || '').trim()}
            title={event?.title}
            onBack={() => setShowMap(false)}
          />
        )}
        {!showMap && (<>
        {tab === 'welcome'   && registered && participant?.id && (
          <WelcomePage
            event={event}
            participantId={participant.id}
            raffleEnabled={raffleOn}
            referralEnabled={refOn}
            tgUser={tgUser}
            onVipClick={redirectToVip}
            eventId={event?.id}
            contactId={participant?.contact_id}
            gateChannels={gateLocked ? gateChannels : undefined}
            onGateRecheck={async () => {
              // «Я подписался — проверить»: спрашиваем заново. Прошёл —
              // бэкенд ставит отметку, мы гасим замки и открываем программу.
              try {
                const p = getPlatform()
                const uid = p.user?.id || tgUser?.id || ''
                const r: any = await checkRegistrationGate(
                  event.id, p.name, uid, participant?.contact_id)
                if (r?.allowed) {
                  setGateChannels([])
                  setParticipant((prev: any) => ({
                    ...(prev || {}), sub_checked_at: new Date().toISOString(),
                  }))
                  return true
                }
                setGateChannels(r?.not_subscribed || [])
                return false
              } catch {
                // Сбой сети не должен запирать зарегистрированного человека.
                setGateChannels([])
                return true
              }
            }}
            onContinue={() => {
              setParticipant((p: any) => ({ ...(p || {}), welcomed_at: new Date().toISOString() }))
              setTab('program')
            }}
          />
        )}
        {tab === 'landing'   && <LandingTab  event={event} onRegister={handleWantParticipate} />}
        {tab === 'program'   && (
          event?.module_slug === 'contest' ?
            <ContestProgramTab  event={event} tgUser={tgUser} refreshKey={refreshKey} /> :
          event?.module_slug === 'turnir' ?
            // Турниры пока используют копию ProgramTab. Со временем макет
            // разойдётся: у турниров будут этапы (Этап 1 / Этап 2) с
            // диапазонами дат и вложенными внутри днями, у конференций
            // останутся «дни». См. memory/project_mini_app_unification_plan.md.
            <TurnirProgramTab   event={event} tgUser={tgUser} refreshKey={refreshKey} onVipClick={redirectToVip}
              onOpenSpeaker={(id) => { setPendingSpeakerHighlight(id); setTab('speakers') }} /> :
            <ProgramTab         event={event} tgUser={tgUser} refreshKey={refreshKey} onVipClick={redirectToVip}
              onOpenMap={() => setShowMap(true)}
              onOpenSpeaker={(id) => { setPendingSpeakerHighlight(id); setTab('speakers') }} />
        )}
        {tab === 'speakers'  && (
          <SpeakersTab
            event={event}
            tgUser={tgUser}
            highlightSpeakerEventId={pendingSpeakerHighlight}
            onHighlightConsumed={() => setPendingSpeakerHighlight(null)}
          />
        )}
        {tab === 'game'      && <GameTab     event={event} participant={participant} tgUser={tgUser} botClientId={botClientId} />}
        {tab === 'raffle'    && <RaffleTab   event={event} participant={participant} tgUser={tgUser} />}
        {tab === 'results'   && <ResultsTab  event={event} participant={participant} onOpenEvent={onOpenEvent} onVipClick={redirectToVip} />}
        {tab === 'calendar'  && event.client_id && <CalendarTab clientId={event.client_id} onOpenEvent={(s) => {
          const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
          window.location.assign(`${base}/event/${s}`)
        }} />}
        {/* ⚠️ У коллабы передаём ВСЕХ организаторов: вкладка тогда показывает
            сначала список брендов, а карточку — по выбору. Без этого был виден
            только «первый владелец», второй организатор — нигде. */}
        {tab === 'ecosystem' && event.client_id && (
          <EcosystemTab
            clientId={event.client_id}
            owners={event.is_collab ? event.collab_owners : undefined}
          />
        )}
        </>)}
      </div>

      <BottomNav items={navItems} active={tab} onTab={setTab} />

      {showTariffs && (
        <TariffPicker
          event={event}
          tariffs={tariffs}
          requestForm={requestForm}
          tgUser={tgUser}
          partnerId={partnerId}
          utmSource={utmSource}
          contactId={contactId}
          prefill={prefill}
          onClose={() => setShowTariffs(false)}
          onDone={(p) => { setShowTariffs(false); handleRegistered(p) }}
        />
      )}

      {showReg && (
        <RegistrationFlow
          event={event}
          tgUser={tgUser}
          partnerId={partnerId}
          utmSource={utmSource}
          contactId={contactId}
          botClientId={botClientId}
          onClose={() => setShowReg(false)}
          onDone={handleRegistered}
        />
      )}
    </div>
  )
}
