'use client'
/**
 * Настройка Mini App — что видят участники в Telegram.
 *
 * Структура:
 *   • Вкладка «Бренд»     — настраивает шапку Экосистемы и логотип в углу всех страниц.
 *   • Вкладка «Основатель» — карточка-тизер «Об основателе» в Экосистеме + страница «Об основателе».
 *   • Вкладка «Продукты»   — то что в Mini App в блоках «Платно / Бесплатно».
 *
 * Сохранение:
 *   • profile (бренд + основатель) — общая кнопка «Сохранить визитку» внизу.
 *   • offerings — каждый сохраняется автоматом при создании/редактировании.
 */
import { Suspense, useEffect, useState } from 'react'
import { CharCount, overClass, POSITIONING_LIMIT, BIO_LIMIT, ACH_LABEL_LIMIT, ACH_VALUE_LIMIT, BUTTON_LABEL_LIMIT } from '@/components/FieldLimits'
import { Smartphone, Plus, Pencil, Trash2, X, Save, ExternalLink, Globe, Building2, User, ChevronUp, ChevronDown, LayoutGrid } from 'lucide-react'
import FileUploader from '@/components/FileUploader'
import HtmlTextArea from '@/components/HtmlTextArea'
import { TELEGRAM_HTML_TAGS, findHtmlIssues } from '@/lib/htmlTags'
import { FounderTgChannelsField, FounderTgChannel } from '@/components/FounderTgChannelsField'
import { FounderMaxChannelsField, FounderMaxChannel } from '@/components/FounderMaxChannelsField'
import { FounderVkChannelsField, FounderVkChannel } from '@/components/FounderVkChannelsField'
import SpeakerPhotosField from '@/components/SpeakerPhotosField'
import BrandLogosField from '@/components/BrandLogosField'
import { api } from '@/lib/api'
import LeadMagnetPicker from '@/components/LeadMagnetPicker'
import { useMe } from '@/hooks/useMe'
import { useUrlTab } from '@/hooks/useUrlTab'

const BRAND = '#25455D'
const GRADIENT = 'linear-gradient(45deg, #25455D, #0a1520)'

interface Achievement { label: string; value: string }
// Кнопка «Общего приветствия». Тип определяет, куда ведёт:
//   events — «Все события» (ссылка ставится автоматом, меняется только текст)
//   owner  — «Об основателе» (ссылка автоматом, меняется текст)
//   custom — произвольная (текст + своя ссылка)
interface StartButton {
  type: 'events' | 'owner' | 'custom' | 'product' | 'plusson'
  label: string
  url?: string
  /** Для типа 'product': какой продукт открывать. Храним slug, а не
   *  готовый адрес — у клиента может быть свой домен. */
  product_slug?: string
}

/**
 * Ссылку кастомной кнопки бэкенд чинит сам (`https//` → `https://`, `t.me/x` и
 * `@nick` → полный адрес). «Плохая» — только та, из которой домен не вытащить:
 * Telegram отвергает ВСЁ сообщение при кривом URL inline-кнопки («Wrong HTTP URL»),
 * и человек вместо приветствия увидит системный текст.
 * Пустое поле плохим не считаем — его отфильтрует сохранение.
 */
function isBadButtonUrl(url?: string): boolean {
  let s = (url || '').trim()
  if (!s) return false
  if (/^(tg:\/\/|mailto:|tel:)/i.test(s)) return false           // спецсхемы допустимы
  s = s.replace(/^(https?)(?::?\/{1,2}|:)(?=[^/])/i, '$1://')    // https// , https:/ , http:
  if (s.startsWith('@')) s = `https://telegram.me/${s.slice(1)}`
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`
  const host = s.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]
  return !host || host.includes(' ') || !host.includes('.')
}
interface Profile {
  id: number
  name: string                              // техническое (из регистрации, readonly)
  // Бренд
  brand_name?: string | null
  brand_logo_url?: string | null
  brand_logo_light_url?: string | null
  speaker_page_slug?: string | null         // код адреса /sp/{код} (мигр. 324)
  profile_photo_url?: string | null         // фото бренда
  positioning?: string | null               // позиционирование бренда
  achievements: Achievement[]               // факты в цифрах бренда
  brand_bio?: string | null                 // текст о бренде/проекте (мигр. 446)
  // Основатель (имя берётся из clients.name — отдельной колонки больше нет)
  owner_photo_url?: string | null
  owner_positioning?: string | null
  owner_achievements: Achievement[]         // факты в цифрах основателя
  bio?: string | null                       // биография основателя
  // social_links — словарь соцсетей основателя. Ключи строковые (instagram, youtube, vk, website),
  // отдельный ключ `telegram_channels` — МАССИВ TG-каналов основателя (миграция 114).
  social_links: Record<string, any>
  // Бот и ссылки
  // ⚠️ Режим задаётся ТОЛЬКО по площадкам (миграция 200). «Общего режима»
  // (default_link_mode) больше нет: переключателя для него здесь никогда не
  // было, а код читал его вместо этих полей — и настройка не действовала
  // (миграции 477–478). Пусто → 'bot' (ссылка ведёт в бота).
  link_mode_telegram?: 'miniapp' | 'bot' | null
  link_mode_vk?: 'miniapp' | 'bot' | null
  link_mode_max?: 'miniapp' | 'bot' | null
  start_greeting_text?: string | null
  start_btn_events_label?: string | null
  start_btn_owner_label?: string | null
  // Кнопки приветствия (до 5): [{type:'events'|'owner'|'custom', label, url?}]
  start_buttons?: StartButton[] | null
  start_mode?: 'greeting' | 'event' | 'lead_magnet' | null
  start_event_id?: number | null
  start_lead_magnet_id?: number | null
  start_package_id?: number | null
  events_tab_visibility?: 'always' | 'active' | 'any' | null
  // Кастомные названия вкладок Mini App (пусто = дефолт)
  tab_label_program?: string | null
  tab_label_speakers?: string | null
  tab_label_game?: string | null
  tab_label_ecosystem?: string | null
  // Вкладка «Партнёру» (миграции 347, 351)
  tab_label_partner?: string | null
  partner_tab_visibility?: string | null
  /** Применять свои цвета в Mini App и веб-версии (мигр. 331). */
  miniapp_use_brand_theme?: boolean | null
  /** Свои цвета Mini App (мигр. 333): три цвета + углы + скругление. */
  ma_bg_color?: string | null
  ma_bg_color_2?: string | null
  ma_bg_angle?: number | null
  ma_accent_color?: string | null
  ma_cta_color?: string | null
  ma_cta_color_2?: string | null
  ma_cta_angle?: number | null
  ma_cta_border?: string | null
  ma_cta_border_w?: number | null
  ma_radius?: number | null
}
interface Offering {
  id: number
  title: string
  description?: string | null
  action_url?: string | null
  is_paid: boolean
  cover_url?: string | null
  sort_order: number
  /** Выдавать лид-магнит вместо перехода по `action_url` (миграция 406). */
  lead_magnet_id?: number | null
  package_id?: number | null
  /** Название выбранного подарка — отдаёт список, чтобы показать его в строке. */
  gift_name?: string | null
}

// Telegram-каналы основателя — отдельная секция выше (FounderTgChannelsField),
// потому что их может быть несколько и они используются для проверки подписки
// (воронки лид-магнитов + чат-гейты). Здесь только остальные соцсети.
const SOCIAL_FIELDS: { key: string; label: string; placeholder: string; hint?: string }[] = [
  { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/your_profile' },
  { key: 'youtube',   label: 'YouTube',   placeholder: 'https://youtube.com/@yourchannel' },
  { key: 'vk',        label: 'VK',        placeholder: 'https://vk.com/your_page' },
  { key: 'website',   label: 'Сайт',      placeholder: 'https://yourwebsite.ru' },
]

type Tab = 'brand' | 'owner' | 'products' | 'bot' | 'tabs'
const MINIAPP_TABS: readonly Tab[] = ['brand', 'owner', 'products', 'bot', 'tabs']

// Дефолтные значения приветствия /start — те же, что бот ставит, если поля
// пустые. Показываем их предзаполненными, чтобы клиент видел готовый шаблон.
const DEFAULT_GREETING =
  'Привет, {имя}! 👋\n\nДобро пожаловать в бот {бренд}.\n\nЗагляните в события и узнайте об организаторе по кнопкам ниже 👇'
const DEFAULT_BTN_EVENTS = '📅 Все события'
const DEFAULT_BTN_OWNER  = '🌐 Об основателе'

// Дефолтные названия вкладок Mini App — те же, что фронт Mini App показывает
// при пустом поле. Предзаполняем в форме, чтобы клиент видел реальные названия.
const DEFAULT_TAB_LABELS = {
  tab_label_program:   'Программа',
  tab_label_speakers:  'Спикеры',
  tab_label_game:      'Подарки',
  tab_label_ecosystem: 'О нас',
  tab_label_partner:   'Партнёру',
} as const

/**
 * ⚠️ Обёртка в `Suspense` ОБЯЗАТЕЛЬНА, без неё СБОРКА ПАДАЕТ ЦЕЛИКОМ:
 * «useSearchParams() should be wrapped in a suspense boundary at page
 * /dashboard/mini-app». Хук `useUrlTab` (вкладка живёт в адресе) читает
 * `useSearchParams`, а этот роут — статический, и Next 14 пререндерит его на
 * сборке; у страниц вида `[id]` этого не происходит, поэтому там та же
 * связка проходит молча.
 *
 * ⚠️ Ловится только на сборке — `tsc --noEmit` такую ошибку не видит.
 * Ставя `useUrlTab` (или любой другой `useSearchParams`) на страницу БЕЗ
 * динамического сегмента в пути, сразу заворачивайте её так же.
 */
export default function MiniAppSettingsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-gray-400">Загружаем…</p>}>
      <MiniAppSettings />
    </Suspense>
  )
}

function MiniAppSettings() {
  // Ассистенту доступна ТОЛЬКО вкладка «Продукты» (client_offerings) — визитка
  // бренда/основателя/бот шлются через PATCH /auth/me, который ассистенту → 403.
  const { isAssistant, me } = useMe()
  const hasConference = !!me?.features?.includes('conference')
  // Фирменный стиль Mini App — платная возможность (мигр. 332, Экстра+admin).
  const hasBrandTheme = !!me?.features?.includes('miniapp_brand_theme')
  // Кнопка «Продукт» в приветствии — по фиче products.
  const hasProducts = !!me?.features?.includes('products')
  const [products, setProducts] = useState<any[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  // Вкладка площадки в блоке «Как открываются ваши ссылки» (Telegram/VK/MAX).
  const [linkTab, setLinkTab] = useState<'telegram' | 'vk' | 'max'>('telegram')
  // Подключено ли Mini App у TG-бота: null — ещё не проверяли / Telegram не ответил.
  const [tgMiniApp, setTgMiniApp] = useState<{ has_mini_app: boolean | null; reason: string } | null>(null)
  const [offerings, setOfferings] = useState<Offering[]>([])
  const [loadingOff, setLoadingOff] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<Offering | null>(null)
  const [creating, setCreating] = useState(false)
  const [eventList, setEventList] = useState<{ id: number; title: string; status?: string }[]>([])
  const [leadMagnets, setLeadMagnets] = useState<{ id: number; name: string }[]>([])
  const [leadPackages, setLeadPackages] = useState<{ id: number; name: string }[]>([])
  // Активная вкладка блока «Каналы основателя» (TG / VK / MAX)
  const [founderTab, setFounderTab] = useState<'telegram' | 'vk' | 'max'>('telegram')
  // ⚠️ Через useUrlTab: он не только читает вкладку из адреса, но и ПИШЕТ её
  // туда при переключении. Без записи обновление страницы всегда возвращало
  // на «Бренд», даже если человек настраивал бота.
  const [tab, setTab] = useUrlTab<Tab>('tab', 'brand', MINIAPP_TABS)

  // Ассистент видит только «Продукты» — форсим вкладку, как только роль известна.
  useEffect(() => {
    if (isAssistant) setTab('products')
  }, [isAssistant])

  // Список продуктов для кнопки «Продукт» в приветствии. Грузим только при
  // наличии фичи: без неё выбирать всё равно нечего.
  useEffect(() => {
    if (!hasProducts) return
    // ⚠️ Эндпоинт отдаёт {products: [...]} — не `items` и не голый массив.
    // Из-за неверного ключа список выпадал пустым, хотя продукты есть.
    api.products.list()
      .then((r: any) => setProducts(
        Array.isArray(r) ? r : (r?.products || r?.items || [])))
      .catch(() => setProducts([]))
  }, [hasProducts])

  // Проверяем у Telegram-бота наличие Mini App: если его нет, режим «Mini App»
  // выбрать нельзя (ссылки `?startapp=` были бы мёртвыми).
  useEffect(() => {
    api.miniApp.profile.miniAppStatus()
      .then((s: any) => setTgMiniApp({ has_mini_app: s?.has_mini_app ?? null, reason: s?.reason || '' }))
      .catch(() => setTgMiniApp(null))
  }, [])

  useEffect(() => {
    api.miniApp.profile.get().then((p: any) => {
      // нормализуем — на всякий случай
      setProfile({
        ...p,
        achievements:       Array.isArray(p.achievements)       ? p.achievements       : [],
        owner_achievements: Array.isArray(p.owner_achievements) ? p.owner_achievements : [],
        social_links:       p.social_links || {},
        // НЕ автозаполняем дефолтами — пустые поля остаются пустыми (с placeholder),
        // чтобы клиент видел, что реально заполнено, а что нет.
        start_greeting_text:    p.start_greeting_text    || '',
        start_btn_events_label: p.start_btn_events_label || '',
        start_btn_owner_label:  p.start_btn_owner_label  || '',
        // Кнопки приветствия: если клиент их ещё не настраивал — стартуем с 2 дефолтных
        // (как выглядело раньше), чтобы форма не была пустой.
        start_buttons: (Array.isArray(p.start_buttons) && p.start_buttons.length)
          ? p.start_buttons
          : [
              { type: 'events', label: p.start_btn_events_label || '📅 Все события' },
              { type: 'owner',  label: p.start_btn_owner_label  || '🌐 Об основателе' },
            ],
        // Названия вкладок — предзаполняем дефолтами, чтобы клиент видел реальные
        // названия и мог их просто отредактировать (пустое поле путало).
        tab_label_program:   p.tab_label_program   || DEFAULT_TAB_LABELS.tab_label_program,
        tab_label_speakers:  p.tab_label_speakers  || DEFAULT_TAB_LABELS.tab_label_speakers,
        tab_label_game:      p.tab_label_game      || DEFAULT_TAB_LABELS.tab_label_game,
        tab_label_ecosystem: p.tab_label_ecosystem || DEFAULT_TAB_LABELS.tab_label_ecosystem,
        tab_label_partner:   p.tab_label_partner   || DEFAULT_TAB_LABELS.tab_label_partner,
        partner_tab_visibility: p.partner_tab_visibility || 'off',
      })
    }).catch(() => {})
    loadOfferings()
    api.events.list().then((r: any) => {
      const arr = Array.isArray(r) ? r : (r?.events || r?.items || [])
      setEventList(arr.map((e: any) => ({ id: e.id, title: e.title, status: e.status })))
    }).catch(() => {})
    api.leadMagnets.list().then((r: any) => {
      const arr = Array.isArray(r) ? r : (r?.lead_magnets || r?.items || [])
      setLeadMagnets(arr.map((m: any) => ({ id: m.id, name: m.name })))
    }).catch(() => {})
    api.leadMagnetPackages.list().then((r: any) => {
      const arr = Array.isArray(r) ? r : (r?.packages || r?.lead_magnet_packages || r?.items || [])
      setLeadPackages(arr.map((p: any) => ({ id: p.id, name: p.name })))
    }).catch(() => {})
  }, [])

  async function loadOfferings() {
    setLoadingOff(true)
    try {
      const r = await api.miniApp.offerings.list()
      setOfferings(r.items || [])
    } finally {
      setLoadingOff(false)
    }
  }

  function update<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile(p => p ? { ...p, [key]: value } : p)
  }
  function updateSocial(key: string, value: string) {
    if (!profile) return
    const next = { ...profile.social_links }
    if (value.trim()) next[key] = value.trim(); else delete next[key]
    update('social_links', next)
  }
  function updateTgChannels(list: FounderTgChannel[]) {
    if (!profile) return
    const next = { ...profile.social_links, telegram_channels: list }
    update('social_links', next)
  }
  function updateMaxChannels(list: FounderMaxChannel[]) {
    if (!profile) return
    const next = { ...profile.social_links, max_channels: list }
    update('social_links', next)
  }
  function updateVkChannels(list: FounderVkChannel[]) {
    if (!profile) return
    const next = { ...profile.social_links, vk_channels: list }
    update('social_links', next)
  }
  function updateAch(field: 'achievements' | 'owner_achievements', idx: number, key: 'label' | 'value', value: string) {
    if (!profile) return
    const next = [...profile[field]]
    next[idx] = { ...next[idx], [key]: value }
    update(field, next)
  }
  // ── Кнопки приветствия ──────────────────────────────────────────
  const DEFAULT_BTN_LABEL: Record<StartButton['type'], string> = {
    events: '📅 Все события', owner: '🌐 Об основателе', custom: '', product: '',
    plusson: '🎁 ПЛЮСОН — 14 дней бесплатно',
  }
  function updateStartBtn(idx: number, patch: Partial<StartButton>) {
    if (!profile) return
    const next = [...(profile.start_buttons || [])]
    next[idx] = { ...next[idx], ...patch }
    update('start_buttons', next)
  }
  function changeStartBtnType(idx: number, type: StartButton['type']) {
    if (!profile) return
    const next = [...(profile.start_buttons || [])]
    const cur = next[idx]
    // При смене типа на готовый — подставляем дефолтную подпись, если поле пустое.
    next[idx] = {
      type,
      label: (cur.label || '').trim() || DEFAULT_BTN_LABEL[type],
      url: type === 'custom' ? (cur.url || '') : undefined,
      product_slug: type === 'product' ? (cur.product_slug || '') : undefined,
    }
    update('start_buttons', next)
  }
  function addStartBtn() {
    if (!profile) return
    const cur = profile.start_buttons || []
    if (cur.length >= 5) return
    update('start_buttons', [...cur, { type: 'custom', label: '', url: '' }])
  }
  function removeStartBtn(idx: number) {
    if (!profile) return
    update('start_buttons', (profile.start_buttons || []).filter((_, i) => i !== idx))
  }
  function moveStartBtn(idx: number, dir: -1 | 1) {
    if (!profile) return
    const next = [...(profile.start_buttons || [])]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    update('start_buttons', next)
  }
  // ⚠️ Не больше 6 цифр: столько показывает карточка в каталоге. Разрешить
  // больше — часть введённого молча не отобразилась бы.
  const MAX_ACHIEVEMENTS = 6
  function addAch(field: 'achievements' | 'owner_achievements') {
    if (!profile) return
    if (profile[field].length >= MAX_ACHIEVEMENTS) return
    update(field, [...profile[field], { label: '', value: '' }])
  }
  function removeAch(field: 'achievements' | 'owner_achievements', idx: number) {
    if (!profile) return
    update(field, profile[field].filter((_, i) => i !== idx))
  }

  async function saveProfile() {
    if (!profile) return
    // Кривая ссылка кнопки сломала бы всё приветствие в боте — не даём сохранить.
    const badBtn = (profile.start_buttons || []).find(b => b.type === 'custom' && isBadButtonUrl(b.url))
    if (badBtn) {
      alert(`Кнопка «${badBtn.label || 'без названия'}»: ссылка «${badBtn.url}» некорректна.\n\n`
            + 'Укажите полный адрес, например https://telegram.me/ваш_ник')
      return
    }
    // Кривая разметка сломала бы всё приветствие ровно так же, как кривая
    // ссылка выше: Telegram отвергает сообщение целиком, и человек видит
    // системный текст ПЛЮСОНа вместо приветствия клиента. Не даём сохранить.
    const htmlIssues = findHtmlIssues(profile.start_greeting_text || '', TELEGRAM_HTML_TAGS)
    if (htmlIssues.length) {
      alert('Не получится сохранить текст приветствия:\n\n• '
            + htmlIssues.map(i => i.message).join('\n• ')
            + '\n\nПоправьте теги — поле подсвечено красным.')
      return
    }
    // ⚠️ Регалии основателя и текст о бренде — тоже с тегами, и кривой тег там
    // так же ломает вёрстку плашки: незакрытый <b> красит жирным всё до конца
    // страницы. Раньше ошибка только подсвечивалась в поле и спокойно уезжала
    // в базу — теперь не даём сохранить, как у приветствия.
    for (const [fld, label] of [['bio', 'регалий основателя'],
                                ['brand_bio', 'текста о бренде']] as const) {
      const issues = findHtmlIssues((profile as any)[fld] || '')
      if (issues.length) {
        alert(`Не получится сохранить из-за ${label}:\n\n• `
              + issues.map(i => i.message).join('\n• ')
              + '\n\nПоправьте теги — поле подсвечено красным.')
        return
      }
    }
    // Лимиты длины: не даём сохранить полотно — карточка каталога и страница
    // «Об основателе» рассчитаны на текст, а не на целый лендинг.
    const tooLong: string[] = []
    if ((profile.owner_positioning || '').length > POSITIONING_LIMIT)
      tooLong.push(`позиционирование основателя — на ${(profile.owner_positioning || '').length - POSITIONING_LIMIT} символов длиннее`)
    if ((profile.positioning || '').length > POSITIONING_LIMIT)
      tooLong.push(`позиционирование бренда — на ${(profile.positioning || '').length - POSITIONING_LIMIT} символов длиннее`)
    if ((profile.bio || '').length > BIO_LIMIT)
      tooLong.push(`регалии — на ${(profile.bio || '').length - BIO_LIMIT} символов длиннее`)
    if ((profile.brand_bio || '').length > BIO_LIMIT)
      tooLong.push(`текст о бренде — на ${(profile.brand_bio || '').length - BIO_LIMIT} символов длиннее`)
    for (const [fld, label] of [['owner_achievements', 'фактах основателя'], ['achievements', 'фактах бренда']] as const) {
      const items = (profile as any)[fld] as Achievement[] | undefined
      if (items?.some(x => (x.label || '').length > ACH_LABEL_LIMIT)) {
        tooLong.push(`подпись в ${label} длиннее ${ACH_LABEL_LIMIT} символов`)
      }
    }
    if (tooLong.length) {
      alert('Не получится сохранить:\n\n• ' + tooLong.join('\n• ') + '\n\nСократите — счётчик под полем показывает, на сколько.')
      return
    }

    setSaving(true)
    try {
      const cleanAch = (a: Achievement[]) => a.filter(x => x.label.trim() && x.value.trim())
      const updated = await api.miniApp.profile.update({
        // бренд
        brand_name:        profile.brand_name        || null,
        brand_logo_url:    profile.brand_logo_url    || null,
        brand_logo_light_url: profile.brand_logo_light_url || null,
        profile_photo_url: profile.profile_photo_url || null,
        positioning:       profile.positioning       || null,
        achievements:      cleanAch(profile.achievements),
        brand_bio:         profile.brand_bio || null,
        // основатель
        owner_photo_url:    profile.owner_photo_url   || null,
        owner_positioning:  profile.owner_positioning || null,
        owner_achievements: cleanAch(profile.owner_achievements),
        bio:                profile.bio || null,
        social_links:       profile.social_links,
        // бот и ссылки
        // Режимы по площадкам — единственная настройка ссылок.
        link_mode_telegram:     profile.link_mode_telegram || '',
        link_mode_vk:           profile.link_mode_vk || '',
        link_mode_max:          profile.link_mode_max || '',
        events_tab_visibility:  profile.events_tab_visibility || 'always',
        // Названия вкладок Mini App — пусто → дефолт (бэк применяет model_fields_set)
        tab_label_program:      profile.tab_label_program   || '',
        tab_label_speakers:     profile.tab_label_speakers  || '',
        tab_label_game:         profile.tab_label_game      || '',
        tab_label_ecosystem:    profile.tab_label_ecosystem || '',
        tab_label_partner:      profile.tab_label_partner   || '',
        partner_tab_visibility: profile.partner_tab_visibility || 'off',
        // Галочка «фирменные цвета в Mini App». Шлём явным bool: снятая
        // галочка — это false, а не «поле не прислали».
        // ⚠️ Без фичи всегда false, иначе у клиента, ушедшего с Экстра, весь
        // профиль перестал бы сохраняться: бэкенд отвечает 403 на попытку
        // включить платную возможность, а старое `true` уезжало бы в каждом
        // запросе.
        miniapp_use_brand_theme: hasBrandTheme && !!profile.miniapp_use_brand_theme,
        // Свои цвета Mini App. Шлём только при наличии фичи: без неё бэкенд
        // отвечает 403, и весь профиль перестал бы сохраняться.
        ...(hasBrandTheme ? {
          ma_bg_color:     profile.ma_bg_color     || undefined,
          ma_bg_color_2:   profile.ma_bg_color_2   || undefined,
          ma_bg_angle:     profile.ma_bg_angle     ?? undefined,
          ma_accent_color: profile.ma_accent_color || undefined,
          ma_cta_color:    profile.ma_cta_color    || undefined,
          ma_cta_color_2:  profile.ma_cta_color_2  || undefined,
          ma_cta_angle:    profile.ma_cta_angle    ?? undefined,
          ma_cta_border:   profile.ma_cta_border   || undefined,
          ma_cta_border_w: profile.ma_cta_border_w ?? undefined,
          ma_radius:       profile.ma_radius       ?? undefined,
        } : {}),
        start_greeting_text:    profile.start_greeting_text    || null,
        start_btn_events_label: profile.start_btn_events_label || null,
        start_btn_owner_label:  profile.start_btn_owner_label  || null,
        // Кнопки приветствия: выкидываем пустые (без текста; custom без ссылки), максимум 5.
        // ⚠️ У каждого типа своё поле, которое НУЖНО отправить: у custom
        // это url, у product — какой продукт открывать. Раньше здесь всё,
        // кроме custom, сводилось к {type, label}, и product_slug терялся по
        // дороге — бэкенд отбрасывал кнопку продукта как неполную, а человек
        // жал «Сохранить» и не понимал, почему она исчезает.
        start_buttons: (profile.start_buttons || [])
          .filter(b => (b.label || '').trim()
            && (b.type !== 'custom' || (b.url || '').trim())
            && (b.type !== 'product' || (b.product_slug || '').trim()))
          .slice(0, 5)
          .map(b => b.type === 'custom'
            ? { type: 'custom', label: b.label.trim(), url: (b.url || '').trim() }
            : b.type === 'product'
              ? { type: 'product', label: b.label.trim(),
                  product_slug: (b.product_slug || '').trim() }
              : { type: b.type, label: b.label.trim() }),
        start_mode:             profile.start_mode || 'greeting',
        start_event_id:         profile.start_mode === 'event' ? (profile.start_event_id || null) : null,
        start_lead_magnet_id:   profile.start_mode === 'lead_magnet' ? (profile.start_lead_magnet_id || null) : null,
        start_package_id:       profile.start_mode === 'lead_magnet' ? (profile.start_package_id || null) : null,
      })
      setProfile(p => p ? { ...p, ...updated } : updated)
      setSavedAt(Date.now()); setTimeout(() => setSavedAt(null), 2000)
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function deleteOffering(id: number) {
    if (!confirm('Удалить продукт? Он сразу пропадёт из Mini App.')) return
    try { await api.miniApp.offerings.delete(id); await loadOfferings() }
    catch (e: any) { alert(e.message || 'Ошибка удаления') }
  }

  // Перестановка продукта внутри своего блока (платно/бесплатно).
  // Перенормируем sort_order у всего блока: 0..N-1 после перемещения.
  // Это гарантирует устойчивый порядок даже если изначально у всех было sort_order=0.
  async function moveOffering(item: Offering, direction: -1 | 1) {
    const block = offerings.filter(o => o.is_paid === item.is_paid)
                           .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
    const idx = block.findIndex(o => o.id === item.id)
    const newIdx = idx + direction
    if (idx < 0 || newIdx < 0 || newIdx >= block.length) return
    const reordered = [...block]
    ;[reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]]
    // Оптимистично обновляем UI
    const updatedAll = offerings.map(o => {
      const newPos = reordered.findIndex(x => x.id === o.id)
      return newPos >= 0 ? { ...o, sort_order: newPos } : o
    })
    setOfferings(updatedAll)
    // Параллельно отправляем PATCH для всех элементов блока
    try {
      await Promise.all(reordered.map((o, i) =>
        o.sort_order === i ? Promise.resolve() : api.miniApp.offerings.update(o.id, { sort_order: i })
      ))
    } catch (e: any) {
      alert(e.message || 'Не удалось сохранить порядок')
      await loadOfferings()
    }
  }

  return (
    <div className="pb-24">
      {/* Заголовок */}
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg text-white" style={{ background: GRADIENT }}>
            <Smartphone size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: BRAND }}>
              {isAssistant ? 'Mini App: Продукты' : 'Настройка Mini App'}
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {isAssistant
                ? 'Платные и бесплатные продукты в блоках «Платно / Бесплатно».'
                : 'Что видят участники в Telegram — на всех страницах.'}
            </p>
          </div>
        </div>
      </div>

      {/* Табы — ассистенту доступна только вкладка «Продукты», остальные требуют
          PATCH /auth/me (403), поэтому переключатель ему не показываем. */}
      {!isAssistant && (
        <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl max-w-4xl overflow-x-auto">
          <TabBtn active={tab === 'brand'}    onClick={() => setTab('brand')}    icon={<Building2 size={15} />} label="Бренд" />
          <TabBtn active={tab === 'owner'}    onClick={() => setTab('owner')}    icon={<User size={15} />}      label="Основатель" />
          <TabBtn active={tab === 'products'} onClick={() => setTab('products')} icon={<Globe size={15} />}     label="Продукты" />
          <TabBtn active={tab === 'tabs'}     onClick={() => setTab('tabs')}     icon={<LayoutGrid size={15} />} label="Вкладки" />
          <TabBtn active={tab === 'bot'}      onClick={() => setTab('bot')}      icon={<Smartphone size={15} />} label="Бот и ссылки" />
        </div>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: БРЕНД
         ════════════════════════════════════════════════ */}
      {tab === 'brand' && profile && (
        <>
          <Section
            step={1}
            title="Логотип бренда"
            hint="Маленькая иконка в правом верхнем углу всех страниц Mini App. Тап → открывает вкладку «О проекте». Лучше квадратная картинка на прозрачном/белом фоне."
          >
            <div className="max-w-2xl space-y-4">
              <div>
                <div className="mb-1.5 text-sm font-medium text-gray-700">
                  Для тёмного фона
                </div>
                <FileUploader
                  mode="single"
                  kind="brand_logo"
                  value={profile.brand_logo_url || null}
                  onChange={url => update('brand_logo_url', url)}
                  emptyText="Загрузите логотип (PNG/JPG)"
                  buttonLabel="Загрузить логотип"
                  aspectClass="aspect-square"
                />
              </div>

              {/* ⚠️ Второй файл нужен, потому что логотип обычно белый: на
                  светлой карточке (анкеты, формы) он сливается с фоном и
                  выглядит как пустое место. Не загрузили — везде берётся
                  основной, как было раньше. */}
              <div>
                <div className="mb-1.5 text-sm font-medium text-gray-700">
                  Для светлого фона
                </div>
                <p className="mb-2 text-xs text-gray-500">
                  Тёмная версия знака — её показываем на светлых страницах,
                  например в анкетах. Если не загрузить, там будет основной
                  логотип: белый на белом не виден.
                </p>
                <FileUploader
                  mode="single"
                  kind="brand_logo"
                  value={profile.brand_logo_light_url || null}
                  onChange={url => update('brand_logo_light_url', url)}
                  emptyText="Загрузите тёмную версию (PNG/JPG)"
                  buttonLabel="Загрузить логотип"
                  aspectClass="aspect-square"
                />
              </div>

              {/* Библиотека версий знака (миграция 449) — отдельно от двух
                  полей выше. Те два — РАБОЧИЙ логотип платформы: он идёт в
                  шапки, афиши, обложки и письма, и подменять его набором
                  вариантов нельзя. Библиотека — витрина для организатора:
                  сколько угодно версий с подписями, забрать нужную. */}
              <div className="pt-4 border-t border-gray-100">
                <BrandLogosField />
              </div>
            </div>
          </Section>

          <Section
            step={2}
            title="Шапка вкладки «О проекте»"
            hint="Верх вкладки «О проекте» в Mini App — название и позиционирование. Картинка слева в шапке — это тот же логотип бренда из шага 1."
          >
            <div className="space-y-4 max-w-2xl">
              <Field label="Название бренда"
                     hint="Крупно в шапке. Если оставить пустым — будет показано имя из регистрации.">
                <input type="text" value={profile.brand_name || ''}
                       onChange={e => update('brand_name', e.target.value)}
                       className="input" maxLength={60} />
                {/* Счётчик: в карточке каталога это строка «Проект: …», и
                    длинное название переносится, сдвигая всё под ним. */}
                <p className="mt-1 text-xs text-gray-400">
                  {(profile.brand_name || '').length} из 60
                </p>
              </Field>

              <Field label="Позиционирование бренда"
                     hint="Одна короткая строка под названием — что вы делаете.">
                <input type="text" value={profile.positioning || ''}
                       onChange={e => update('positioning', e.target.value)}
                       className="input" maxLength={90} />
                {/* Счётчик у всех полей с лимитом: набрать сверх нормы поле не
                    даёт, но человек должен видеть границу заранее, а не
                    упираться в неё молча посреди фразы. */}
                <p className="mt-1 text-xs text-gray-400">
                  {(profile.positioning || '').length} из 90
                </p>
              </Field>
            </div>
          </Section>

          <Section
            step={3}
            title="Факты в цифрах"
            hint="Карточки под фото бренда. Пара «цифра + подпись». Не больше 6 — столько показывает карточка в каталоге. Если фактов нет — блок не показывается."
            action={
              <button onClick={() => addAch('achievements')}
                      disabled={profile.achievements.length >= MAX_ACHIEVEMENTS}
                      className="text-sm flex items-center gap-1 disabled:opacity-40" style={{ color: BRAND }}>
                <Plus size={15} /> Добавить
              </button>
            }
          >
            <AchievementsEditor
              items={profile.achievements}
              onChange={(idx, key, val) => updateAch('achievements', idx, key, val)}
              onRemove={idx => removeAch('achievements', idx)}
            />
          </Section>

          <Section
            step={4}
            title="О бренде"
            hint="Рассказ о проекте: что делаете, для кого, чем отличаетесь. Показывается отдельной плашкой НАД блоком «Об основателе» — в Mini App и на странице организатора. Если оставить пустым — плашки не будет."
          >
            {/* ⚠️ Тот же редактор и тот же лимит, что у регалий основателя
                (вкладка «Основатель», шаг 3): поля-близнецы, разница только в
                том, про кого текст — «мы» или «я». Свой лимит здесь развёл бы
                два одинаковых с виду поля по разным правилам. */}
            <div className="max-w-2xl">
              <HtmlTextArea
                value={profile.brand_bio || ''}
                onChange={v => update('brand_bio', v)}
                placeholder="Чем занимается ваш проект, для кого он и что дают людям…"
                rows={10}
              />
              <CharCount value={profile.brand_bio || ''} limit={BIO_LIMIT} />
            </div>
          </Section>
        </>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: ОСНОВАТЕЛЬ
         ════════════════════════════════════════════════ */}
      {tab === 'owner' && profile && (
        <>
          <div className="bg-amber-50 border-l-4 border-amber-300 rounded-r-lg px-4 py-3 mb-5 max-w-3xl">
            <p className="text-xs text-amber-900">
              В Mini App: на главной Экосистемы под Фактами бренда — <b>карточка-тизер «Об основателе»</b>.
              Тап → отдельная страница с большим фото, биографией и соцсетями.
            </p>
          </div>

          <Section
            step={1}
            title="Карточка основателя"
            hint="Имя, позиционирование, фото — это и попадёт в карточку-тизер на главной Экосистемы."
          >
            <div className="space-y-4 max-w-2xl">
              {/* ⚠️ Имя и фамилия правятся В НАСТРОЙКАХ ПРОФИЛЯ (PATCH /auth/me),
                  а не в Тех.поддержке — раньше здесь стояла именно такая подпись,
                  и она отправляла клиента писать людям вместо двух полей рядом.
                  Ссылка ведёт ровно в тот блок, где эти поля лежат. */}
              <Field label="Имя в Mini App"
                     hint={<>Берётся из вашего профиля. Поменять — <a href="/dashboard/settings?tab=profile" className="text-brand underline hover:no-underline">Настройки → Профиль</a>, поля «Имя» и «Фамилия».</>}>
                <input type="text" value={profile.name || ''} disabled
                       className="input opacity-60 cursor-not-allowed" />
              </Field>

              <Field label="Фото основателя">
                <FileUploader
                  mode="single"
                  kind="owner_photo"
                  value={profile.owner_photo_url || null}
                  onChange={url => update('owner_photo_url', url)}
                  emptyText="Загрузите фото основателя"
                  buttonLabel="Загрузить фото"
                  aspectClass="aspect-square"
                />
              </Field>

              {/* ⚠️ В карточке каталога это строка под именем, и она обрезана
                  двумя строками — длинный текст ряд больше не разъезжает.
                  Поэтому предел щедрый (140), но счётчик показываем: человек
                  должен понимать, что в карточку попадёт только начало. */}
              <Field label="Позиционирование основателя"
                     hint="Одна строка о роли. В карточке каталога показываются первые 2 строки.">
                {/* ⚠️ Без maxLength: он обрезал вставленный текст МОЛЧА —
                    у двоих клиентов позиционирование обрывалось на запятой,
                    и они об этом не знали. Теперь предупреждаем. */}
                <input type="text" value={profile.owner_positioning || ''}
                       onChange={e => update('owner_positioning', e.target.value)}
                       className={`input ${overClass(profile.owner_positioning || '', POSITIONING_LIMIT)}`} />
                <CharCount value={profile.owner_positioning || ''} limit={POSITIONING_LIMIT} />
              </Field>

              {/* Библиотека фото для организаторов (миграция 323) + ссылка на
                  публичную страницу, которую спикер отдаёт вместо пересылки файлов. */}
              <div className="pt-4 border-t border-gray-100">
                <SpeakerPhotosField />
                {profile.id && <SpeakerPageLink clientId={profile.id} slug={profile.speaker_page_slug} />}
              </div>
            </div>
          </Section>

          <Section
            step={2}
            title="Факты в цифрах"
            hint="Цифры об основателе — на странице «Об основателе» и в карточке каталога. Не больше 6. Если пусто — блок скрыт."
            action={
              <button onClick={() => addAch('owner_achievements')}
                      disabled={profile.owner_achievements.length >= MAX_ACHIEVEMENTS}
                      className="text-sm flex items-center gap-1 disabled:opacity-40" style={{ color: BRAND }}>
                <Plus size={15} /> Добавить
              </button>
            }
          >
            <AchievementsEditor
              items={profile.owner_achievements}
              onChange={(idx, key, val) => updateAch('owner_achievements', idx, key, val)}
              onRemove={idx => removeAch('owner_achievements', idx)}
            />
          </Section>

          <Section
            step={3}
            title="Регалии"
            hint="Список достижений построчно."
          >
            {/* ⚠️ mode="web": регалии показываются на веб-странице и в Mini App,
                а не уходят в Telegram — списки и абзацы там отображаются как
                есть. Редактор сам чистит теги, руками HTML писать не нужно. */}
            <div className="max-w-2xl">
              {/* ⚠️ Обычное поле с тегами, а не визуальный редактор: тот терял
                  набранный текст (значение уходило из состояния формы, а не из
                  поля) — так однажды затёрлись все регалии. Теги пишутся руками,
                  как в рассылках, и проверяются до сохранения. */}
              <HtmlTextArea
                value={profile.bio || ''}
                onChange={v => update('bio', v)}
                placeholder="Ваши регалии: достижения, титулы, опыт, проекты…"
                rows={10}
              />
              <CharCount value={profile.bio || ''} limit={BIO_LIMIT} />
            </div>
          </Section>

          <Section
            step={4}
            title="Каналы основателя"
            hint="Ваши каналы на площадках. Используются для проверки подписки в воронках лид-магнитов и гейтах чатов — участник должен быть подписан на ВСЕ каналы из списка. Также показываются на странице «Об основателе» в Mini App."
          >
            <div className="max-w-2xl">
              {/* Вкладки площадок: TG / VK / MAX (зелёная точка на заполненной) */}
              {(() => {
                const tgList = Array.isArray(profile.social_links.telegram_channels) ? profile.social_links.telegram_channels as FounderTgChannel[] : []
                const vkList = Array.isArray(profile.social_links.vk_channels) ? profile.social_links.vk_channels as FounderVkChannel[] : []
                const maxList = Array.isArray(profile.social_links.max_channels) ? profile.social_links.max_channels as FounderMaxChannel[] : []
                const tabs: { key: 'telegram' | 'vk' | 'max'; label: string; badge: string; color: string; filled: boolean }[] = [
                  { key: 'telegram', label: 'Telegram',  badge: 'TG',  color: '#229ED9', filled: tgList.length > 0 },
                  { key: 'vk',       label: 'ВКонтакте', badge: 'VK',  color: '#0077FF', filled: vkList.length > 0 },
                  { key: 'max',      label: 'MAX',       badge: 'MAX', color: '#F45D22', filled: maxList.length > 0 },
                ]
                return (
                  <>
                    <div className="flex gap-1 border-b border-gray-200 mb-3">
                      {tabs.map(t => (
                        <button key={t.key} type="button" onClick={() => setFounderTab(t.key)}
                          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            founderTab === t.key ? 'border-[#25455D] text-[#25455D]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                          <span className="inline-flex items-center justify-center w-7 h-5 rounded text-[9px] font-bold text-white shrink-0"
                                style={{ background: t.color }}>{t.badge}</span>
                          {t.label}
                          {t.filled && <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" title="Есть каналы" />}
                        </button>
                      ))}
                    </div>
                    {founderTab === 'telegram' && <FounderTgChannelsField value={tgList} onChange={updateTgChannels} />}
                    {founderTab === 'vk' && <FounderVkChannelsField value={vkList} onChange={updateVkChannels} />}
                    {founderTab === 'max' && <FounderMaxChannelsField value={maxList} onChange={updateMaxChannels} />}
                  </>
                )
              })()}
            </div>
          </Section>

          <Section
            step={5}
            title="Другие соцсети основателя"
            hint="Ряд иконок на странице «Об основателе». Заполняйте только то что хотите показать."
          >
            <div className="space-y-3 max-w-2xl">
              {SOCIAL_FIELDS.map(f => (
                <div key={f.key}>
                  <label className="label">{f.label}</label>
                  <input type="url"
                         value={profile.social_links[f.key] || ''}
                         onChange={e => updateSocial(f.key, e.target.value)}
                         placeholder={f.placeholder}
                         className="input" />
                  {f.hint && <p className="text-xs text-gray-500 mt-1">{f.hint}</p>}
                </div>
              ))}
            </div>
          </Section>
        </>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: БОТ И ССЫЛКИ
         ════════════════════════════════════════════════ */}
      {tab === 'bot' && profile && (
        <div className="space-y-5 max-w-2xl pb-28">
          <Section
            step={1}
            title="Как открываются ваши ссылки"
            hint="Настраивается отдельно для каждой площадки: Mini App может быть подключён в Telegram и отсутствовать во ВКонтакте."
          >
            {/* Вкладки площадок — как в «Каналах уведомлений». */}
            <div className="flex border-b border-gray-200 mb-4">
              {([
                { k: 'telegram', label: 'Telegram', field: 'link_mode_telegram' },
                { k: 'vk',       label: 'ВКонтакте', field: 'link_mode_vk' },
                { k: 'max',      label: 'MAX',       field: 'link_mode_max' },
              ] as const).map(t => (
                <button
                  key={t.k}
                  type="button"
                  onClick={() => setLinkTab(t.k)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    linkTab === t.k
                      ? 'border-[#25455D] text-[#25455D]'
                      : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {t.label}
                  {(profile as any)[t.field] && (
                    <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" />
                  )}
                </button>
              ))}
            </div>

            {/* Предупреждение: в Telegram нельзя выбрать Mini App, если он не привязан. */}
            {linkTab === 'telegram' && tgMiniApp?.has_mini_app === false && (
              <div className="mb-3 rounded-xl border border-red-200 bg-red-500/10 p-3 text-sm text-red-800">
                {tgMiniApp.reason}
              </div>
            )}

            {/* MAX: Mini App отключён намеренно. В MAX нет запроса «разрешить
                боту писать» (в Telegram это requestWriteAccess, во ВКонтакте —
                разрешение сообщений от сообщества). Человек, зашедший через
                Mini App, на бота НЕ подписывается — рассылки, напоминания и
                подарки до него не дойдут. Веб-версия ведёт в бота (?start=),
                и подписка возникает сама. */}
            {linkTab === 'max' && (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <b>В MAX ссылки всегда открывают веб-версию.</b> В MAX нет запроса
                «разрешить боту писать», поэтому через Mini App человек не подписывается
                на бота — рассылки и подарки до него не дойдут. Веб-версия ведёт в бота,
                и подписка происходит сама.
              </div>
            )}

            <div className="space-y-2">
              {([
                // ⚠️ Названия говорят, КУДА ПОПАДЁТ ЧЕЛОВЕК, а не как это
                // устроено внутри. «Веб-версия» звучало так, будто Mini App
                // просто заменяется сайтом, — на деле ссылка ведёт В БОТА,
                // и подписка на рассылки возникает сама (жалоба владельца).
                { v: 'miniapp', t: 'Вход через Мини-апп',
                  d: 'Ссылки открывают приложение внутри Telegram/VK (Mini App).' },
                { v: 'bot',     t: 'Вход через бот + веб-версия',
                  d: 'Ссылки ведут в бота, страницы события открываются на pluson.ru. Человек подписывается на бота сам — рассылки и подарки до него дойдут.' },
              ] as const).map(opt => {
                const field = linkTab === 'telegram' ? 'link_mode_telegram'
                            : linkTab === 'vk'       ? 'link_mode_vk'
                            : 'link_mode_max'
                // Пусто → 'bot': ссылка ведёт в бота, человек подписывается сам.
                // Для MAX режим всегда 'bot' — Mini App там отключён (нет
                // подписки на бота, см. выше).
                const current = linkTab === 'max'
                  ? 'bot'
                  : ((profile as any)[field] || 'bot')
                const active = current === opt.v
                // Mini App в Telegram недоступен, если приложение не привязано к боту.
                // Mini App в MAX недоступен всегда — человек не подписывается на бота.
                const blockedMax = linkTab === 'max' && opt.v === 'miniapp'
                const blocked = blockedMax
                  || (linkTab === 'telegram' && opt.v === 'miniapp' && tgMiniApp?.has_mini_app === false)
                return (
                  <button key={opt.v} type="button" disabled={blocked}
                          onClick={() => update(field as any, opt.v)}
                          title={blockedMax
                            ? 'В MAX Mini App не используется: через него человек не подписывается на бота.'
                            : blocked ? tgMiniApp?.reason : undefined}
                          className={`w-full text-left rounded-xl border p-3 transition ${
                            blocked ? 'border-gray-200 opacity-50 cursor-not-allowed'
                            : active ? 'border-amber-300 bg-amber-50'
                            : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${active ? 'border-amber-400 bg-amber-400' : 'border-gray-300'}`} />
                      <span className="font-semibold text-gray-900 text-sm">{opt.t}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 ml-6">{opt.d}</p>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section
            step={2}
            title="Когда показывать вкладку «События»"
            hint="Вкладка «События» (Календарь) в хабе — и в Mini App, и в веб-версии. Можно скрывать, когда событий нет."
          >
            <div className="space-y-2 max-w-2xl">
              {([
                { v: 'always', t: 'Всегда', d: 'Вкладка видна всегда, даже если событий нет.' },
                { v: 'active', t: 'Только при активных', d: 'Видна, если есть текущие или предстоящие события. Скрыта, если все завершены или событий нет.' },
                { v: 'any',    t: 'При любых событиях', d: 'Видна, если есть хоть какие-то события (в т.ч. завершённые). Скрыта только если событий нет совсем.' },
              ] as const).map(opt => {
                const active = (profile.events_tab_visibility || 'always') === opt.v
                return (
                  <button key={opt.v} type="button"
                          onClick={() => update('events_tab_visibility', opt.v)}
                          className={`w-full text-left rounded-xl border p-3 transition ${active ? 'border-amber-300 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${active ? 'border-amber-400 bg-amber-400' : 'border-gray-300'}`} />
                      <span className="font-semibold text-gray-900 text-sm">{opt.t}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 ml-6">{opt.d}</p>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section
            step={3}
            title="Что открывать при /start"
            hint="Когда человек впервые пишет вашему боту: показать общее приветствие, сразу открыть конкретное событие или запустить воронку лид-магнита."
          >
            <div className="space-y-2 mb-4">
              {([
                { v: 'greeting', t: 'Общее приветствие', d: 'Текст-приветствие + свои кнопки (все события, об основателе или произвольные ссылки).' },
                { v: 'event',    t: 'Конкретное событие', d: 'Сразу открывается выбранное событие — его вход/регистрация/меню.' },
                { v: 'lead_magnet', t: 'Лид-магнит', d: 'Сразу запускается воронка выбранного лид-магнита (Telegram, ВКонтакте).' },
              ] as const).map(opt => {
                const active = (profile.start_mode || 'greeting') === opt.v
                return (
                  <button key={opt.v} type="button"
                          onClick={() => update('start_mode', opt.v)}
                          className={`w-full text-left rounded-xl border p-3 transition ${active ? 'border-amber-300 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${active ? 'border-amber-400 bg-amber-400' : 'border-gray-300'}`} />
                      <span className="font-semibold text-gray-900 text-sm">{opt.t}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 ml-6">{opt.d}</p>
                  </button>
                )
              })}
            </div>

            {(profile.start_mode || 'greeting') === 'event' ? (
              <div>
                <label className="block text-sm text-gray-700 mb-1">Событие, которое откроется при /start</label>
                <select
                  value={profile.start_event_id || ''}
                  onChange={e => update('start_event_id', e.target.value ? Number(e.target.value) : null)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400 bg-white"
                >
                  <option value="">— выберите событие —</option>
                  {eventList.map(ev => (
                    <option key={ev.id} value={ev.id}>
                      {ev.title}{ev.status === 'draft' ? ' (черновик)' : ev.status === 'ended' ? ' (завершено)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  Опубликуйте событие, чтобы оно открывалось у людей. Черновик/завершённое — не откроется.
                </p>
              </div>
            ) : (profile.start_mode || 'greeting') === 'lead_magnet' ? (
              <div>
                <label className="block text-sm text-gray-700 mb-1">Лид-магнит, воронка которого запустится при /start</label>
                {/* ⚠️ Общий пикер с поиском: магнитов у клиента десятки. */}
                <LeadMagnetPicker
                  placeholder="— выберите лид-магнит —"
                  value={profile.start_lead_magnet_id
                    ? { kind: 'magnet', id: profile.start_lead_magnet_id }
                    : profile.start_package_id
                      ? { kind: 'package', id: profile.start_package_id }
                      : null}
                  onPick={v => {
                    // Магнит ИЛИ пакет — второе поле всегда зануляем, иначе
                    // в базе останутся оба и непонятно, что запускать.
                    update('start_lead_magnet_id', v?.kind === 'magnet' ? v.id : null)
                    update('start_package_id', v?.kind === 'package' ? v.id : null)
                  }}
                />
                <p className="text-xs text-gray-400 mt-1">
                  При /start у бота человек сразу попадёт в воронку: приветствие → проверка подписки → выдача материалов.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-700 mb-1">Текст приветствия</label>
                  {/* ⚠️ Проверка тегов обязательна: текст уходит в Telegram,
                      а тот отвергает всё сообщение целиком при кривой разметке —
                      человек вместо приветствия увидит системный текст ПЛЮСОНа.
                      Набор тегов телеграмный (без <br>, <p>, списков). */}
                  <HtmlTextArea
                    value={profile.start_greeting_text || ''}
                    onChange={v => update('start_greeting_text', v)}
                    rows={4}
                    allowedTags={TELEGRAM_HTML_TAGS}
                    placeholder={`Пусто — будет показан стандартный текст:\n${DEFAULT_GREETING}`}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Можно использовать <code className="font-mono">{'{имя}'}</code> (имя человека) и
                    {' '}<code className="font-mono">{'{бренд}'}</code> (ваш бренд).
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-2">Кнопки под приветствием</label>
                  <div className="space-y-3">
                    {(profile.start_buttons || []).map((btn, idx) => (
                      <div key={idx} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-medium text-gray-500 w-5 text-center">{idx + 1}</span>
                          <select
                            value={btn.type}
                            onChange={e => changeStartBtnType(idx, e.target.value as StartButton['type'])}
                            className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-amber-400 bg-white"
                          >
                            <option value="events">Все события</option>
                            <option value="owner">Об основателе</option>
                            <option value="custom">Произвольная ссылка</option>
                            {/* Без фичи пункт виден, но выбрать нельзя: скрытый
                                вариант читается как «такого нет вовсе». */}
                            <option value="product" disabled={!hasProducts}>
                              {hasProducts ? 'Продукт' : 'Продукт 🔒'}
                            </option>
                            <option value="plusson">Моя ссылка на ПЛЮСОН</option>
                          </select>
                          <div className="ml-auto flex items-center gap-1">
                            <button type="button" onClick={() => moveStartBtn(idx, -1)} disabled={idx === 0}
                              className="w-7 h-7 rounded border border-gray-300 bg-white text-gray-500 disabled:opacity-30 hover:bg-gray-100">↑</button>
                            <button type="button" onClick={() => moveStartBtn(idx, 1)} disabled={idx === (profile.start_buttons || []).length - 1}
                              className="w-7 h-7 rounded border border-gray-300 bg-white text-gray-500 disabled:opacity-30 hover:bg-gray-100">↓</button>
                            <button type="button" onClick={() => removeStartBtn(idx)}
                              className="w-7 h-7 rounded border border-red-200 bg-white text-red-500 hover:bg-red-50">✕</button>
                          </div>
                        </div>
                        <input
                          value={btn.label || ''}
                          onChange={e => updateStartBtn(idx, { label: e.target.value })}
                          placeholder={btn.type === 'events' ? '📅 Все события' : btn.type === 'owner' ? '🌐 Об основателе' : 'Текст кнопки'}
                          className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:border-amber-400 ${
                            overClass(btn.label || '', BUTTON_LABEL_LIMIT) || 'border-gray-300'}`}
                        />
                        {/* Длинная надпись обрезается на телефоне многоточием —
                            показываем, сколько осталось. */}
                        <CharCount value={btn.label || ''} limit={BUTTON_LABEL_LIMIT} />
                        {btn.type === 'product' ? (
                          <>
                            <select
                              value={btn.product_slug || ''}
                              onChange={e => updateStartBtn(idx, { product_slug: e.target.value })}
                              className="w-full mt-2 px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:border-amber-400"
                            >
                              <option value="">— выберите продукт —</option>
                              {/* ⚠️ Черновики помечаем: их публичная страница
                                  отвечает «не найдено», и кнопка в боте вела
                                  бы в пустоту. Не прячем — человек может
                                  готовить запуск и опубликовать позже. */}
                              {products.map(p => (
                                <option key={p.id} value={p.slug}>
                                  {p.title}{p.status !== 'published' ? ' — черновик' : ''}
                                </option>
                              ))}
                            </select>
                            <p className="text-xs text-gray-400 mt-1">
                              Ссылка ставится автоматически — ведёт на страницу продукта.
                            </p>
                            {btn.product_slug && products.find(
                              p => p.slug === btn.product_slug && p.status !== 'published') && (
                              <p className="text-xs text-amber-600 mt-1">
                                Продукт в черновике — по кнопке откроется «Страница не найдена».
                                Опубликуйте его в разделе «Продукты и услуги».
                              </p>
                            )}
                            {!products.length && (
                              <p className="text-xs text-amber-600 mt-1">
                                У вас пока нет продуктов — заведите его в разделе «Продукты и услуги».
                              </p>
                            )}
                          </>
                        ) : btn.type === 'custom' ? (
                          <>
                            <input
                              value={btn.url || ''}
                              onChange={e => updateStartBtn(idx, { url: e.target.value })}
                              placeholder="https://ваша-ссылка.ру"
                              className={`w-full mt-2 px-3 py-2 text-sm border rounded-lg focus:outline-none ${
                                isBadButtonUrl(btn.url)
                                  ? 'border-red-400 bg-red-50 focus:border-red-500'
                                  : 'border-gray-300 focus:border-amber-400'
                              }`}
                            />
                            {isBadButtonUrl(btn.url) && (
                              <p className="text-xs text-red-600 mt-1">
                                Неверная ссылка. Нужен полный адрес — например <b>https://telegram.me/ваш_ник</b>.
                                С такой ссылкой Telegram не покажет приветствие вовсе.
                              </p>
                            )}
                          </>
                        ) : btn.type === 'plusson' ? (
                          <p className="text-xs text-gray-400 mt-1">
                            Ваша партнёрская ссылка на ПЛЮСОН. Подставляется сама и ведёт
                            в бот <b>той же площадки</b>: нажали в MAX — откроется MAX,
                            в Telegram — Telegram. Регистрации по ней закрепляются за вами.
                          </p>
                        ) : (
                          <p className="text-xs text-gray-400 mt-1">
                            {btn.type === 'events'
                              ? 'Ссылка ставится автоматически — ведёт на список всех ваших событий.'
                              : 'Ссылка ставится автоматически — ведёт в раздел «О проекте» (об основателе).'}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  {(profile.start_buttons || []).length < 5 ? (
                    <button
                      type="button"
                      onClick={addStartBtn}
                      className="mt-3 text-sm px-3 py-2 rounded-lg border border-dashed border-gray-300 text-gray-600 hover:border-amber-400 hover:text-amber-600 w-full"
                    >
                      + Добавить кнопку
                    </button>
                  ) : (
                    <p className="text-xs text-gray-400 mt-2">Максимум 5 кнопок.</p>
                  )}
                </div>
              </div>
            )}
          </Section>
        </div>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: ПРОДУКТЫ
         ════════════════════════════════════════════════ */}
      {tab === 'products' && (
        <Section
          step={1}
          title="Продукты и материалы"
          hint='В Mini App: внизу Экосистемы два блока — «💼 Платно» и «📄 Бесплатно». Сюда складывайте всё что хотите продавать или раздавать.'
          action={
            <button onClick={() => setCreating(true)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white text-sm font-medium"
                    style={{ background: GRADIENT }}>
              <Plus size={15} /> Добавить продукт
            </button>
          }
        >
          {loadingOff ? (
            <p className="text-gray-400 text-sm">Загрузка…</p>
          ) : offerings.length === 0 ? (
            <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-8 text-center">
              <p className="text-gray-500 text-sm">Пока нет продуктов</p>
              <button onClick={() => setCreating(true)}
                      className="text-sm underline mt-2" style={{ color: BRAND }}>
                Создать первый
              </button>
            </div>
          ) : (
            <div className="space-y-5 max-w-2xl">
              {offerings.filter(o => o.is_paid).length > 0 && (
                <SubBlock title="💼 Платно"
                          items={offerings.filter(o => o.is_paid).sort((a,b) => a.sort_order - b.sort_order || a.id - b.id)}
                          onEdit={setEditing} onDelete={deleteOffering} onMove={moveOffering} />
              )}
              {offerings.filter(o => !o.is_paid).length > 0 && (
                <SubBlock title="📄 Бесплатно"
                          items={offerings.filter(o => !o.is_paid).sort((a,b) => a.sort_order - b.sort_order || a.id - b.id)}
                          onEdit={setEditing} onDelete={deleteOffering} onMove={moveOffering} />
              )}
            </div>
          )}
        </Section>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: ВКЛАДКИ (названия вкладок Mini App)
         ════════════════════════════════════════════════ */}
      {tab === 'tabs' && profile && (
        <Section
          step={1}
          title="Названия вкладок Mini App"
          hint="Это названия вкладок внизу Mini App. Здесь стоят стандартные — измените под себя. Действует во всех ваших событиях."
        >
          <div className="space-y-4 max-w-xl">
            <Field label="Программа" hint="Расписание выступлений события.">
              <input
                value={profile.tab_label_program || ''}
                onChange={e => update('tab_label_program', e.target.value)}
                placeholder="Программа"
                maxLength={20}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
              />
            </Field>

            {hasConference && (
              <Field label="Спикеры" hint="Карточки спикеров. Вкладка есть только у конференций и турниров.">
                <input
                  value={profile.tab_label_speakers || ''}
                  onChange={e => update('tab_label_speakers', e.target.value)}
                  placeholder="Спикеры"
                  maxLength={20}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
                />
              </Field>
            )}

            <Field label="Подарки" hint="Реферальная игра — приглашай друзей за подарки.">
              <input
                value={profile.tab_label_game || ''}
                onChange={e => update('tab_label_game', e.target.value)}
                placeholder="Подарки"
                maxLength={20}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
              />
            </Field>

            <Field label="О проекте" hint="Визитка бренда, основатель и продукты (раньше называлась «Экосистема»).">
              <input
                value={profile.tab_label_ecosystem || ''}
                onChange={e => update('tab_label_ecosystem', e.target.value)}
                placeholder="О проекте"
                maxLength={20}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
              />
            </Field>

            {/* Вкладка «Партнёру» (миграция 351). ⚠️ По умолчанию выключена:
                партнёрская программа есть не у всех, и пустой раздел выглядел
                бы поломкой. */}
            <Field label="Партнёру"
                   hint="Раздел, где партнёр видит свои ссылки и вознаграждение.">
              <select
                value={profile.partner_tab_visibility || 'off'}
                onChange={e => update('partner_tab_visibility', e.target.value)}
                className="w-full mb-2 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
              >
                <option value="off">Не показывать</option>
                <option value="partners">Только партнёрам</option>
                <option value="all">Всем — вкладка приглашает в программу</option>
              </select>
              <input
                value={profile.tab_label_partner || ''}
                onChange={e => update('tab_label_partner', e.target.value)}
                placeholder="Партнёру"
                maxLength={20}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400"
              />
            </Field>

          </div>
        </Section>
      )}

      {/* ════════════════════════════════════════════════
           ВКЛАДКА: ВКЛАДКИ → пункт 2 «Фирменные цвета»
         ════════════════════════════════════════════════ */}
      {tab === 'tabs' && profile && (
        <Section
          step={2}
          title="Фирменные цвета Mini App"
          hint="Три цвета — и всё приложение станет вашим. Остальные оттенки получаются из них: подложки карточек и плашек — те же цвета, только на 20% прозрачности."
        >
          <ThemeColorsBlock
            profile={profile}
            update={update}
            locked={!hasBrandTheme}
          />
        </Section>
      )}

      {/* ════════════════════════════════════════════════
           Sticky-панель «Сохранить» (только для профиля)
         ════════════════════════════════════════════════ */}
      {tab !== 'products' && (
        <div className="fixed bottom-4 left-4 right-4 lg:left-[256px] lg:right-6 bg-white border border-gray-200 rounded-xl shadow-lg p-3 flex items-center justify-between gap-3 z-30">
          <div className="text-sm">
            <p className="text-gray-700 font-medium">
              {savedAt ? '✓ Сохранено — изменения уже видны в Mini App' : (tab === 'brand' ? 'Настройки бренда' : tab === 'bot' ? 'Бот и ссылки' : 'Настройки основателя')}
            </p>
            <p className="text-gray-400 text-xs">Файлы сохраняются в момент загрузки. Текстовые поля — по кнопке.</p>
          </div>
          <button onClick={saveProfile} disabled={saving}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg btn-gold disabled:opacity-60 whitespace-nowrap">
            <Save size={16} />
            {saving ? 'Сохраняем…' : 'Сохранить визитку'}
          </button>
        </div>
      )}

      {(creating || editing) && (
        <OfferingModal
          initial={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={async () => { setCreating(false); setEditing(null); await loadOfferings() }}
        />
      )}

    </div>
  )
}

// ═══════════════════ Helpers ═══════════════════

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
        active
          ? 'bg-white text-[#25455D] shadow-sm'
          : 'text-gray-500 hover:text-gray-700'
      }`}
    >
      {icon} {label}
    </button>
  )
}

function AchievementsEditor({
  items, onChange, onRemove,
}: {
  items: Achievement[]
  onChange: (idx: number, key: 'label' | 'value', val: string) => void
  onRemove: (idx: number) => void
}) {
  return (
    <div className="space-y-2 max-w-2xl">
      {items.map((a, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-start">
          <div className="col-span-4">
            <label className="text-xs text-gray-500 mb-1 block">Цифра</label>
            <input type="text" value={a.value}
                   onChange={e => onChange(i, 'value', e.target.value)}
                   placeholder="1500+" className="input" />
            <CharCount value={a.value} limit={ACH_VALUE_LIMIT} />
          </div>
          <div className="col-span-7">
            {/* ⚠️ Подпись — короткая расшифровка цифры, а не абзац: у одного
                клиента сюда уехало 229 символов связного текста, и карточка
                «Факты в цифрах» перестала читаться как цифры. */}
            <label className="text-xs text-gray-500 mb-1 block">Подпись</label>
            <input type="text" value={a.label}
                   onChange={e => onChange(i, 'label', e.target.value)}
                   placeholder="учеников"
                   className={`input ${overClass(a.label, ACH_LABEL_LIMIT)}`} />
            <CharCount value={a.label} limit={ACH_LABEL_LIMIT} />
          </div>
          <div className="col-span-1 pt-6">
            <button onClick={() => onRemove(i)}
                    className="p-2 text-gray-400 hover:text-red-600" title="Удалить">
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      ))}
      {items.length === 0 && (
        <p className="text-gray-400 text-sm">Пока нет фактов — добавьте 2–4 значимых.</p>
      )}
    </div>
  )
}

function Section({
  step, title, hint, action, children,
}: { step: number; title: string; hint: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
               style={{ background: GRADIENT }}>
            {step}
          </div>
          <div>
            <h2 className="font-semibold text-lg" style={{ color: BRAND }}>{title}</h2>
            <p className="text-xs text-gray-500 mt-1 max-w-2xl">{hint}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="pt-2">{children}</div>
    </div>
  )
}

/**
 * Ссылка на публичную страницу спикера. Её отдают организатору вместо того,
 * чтобы каждый раз пересылать фото, логотипы и регалии файлами.
 *
 * ⚠️ Адрес строится от домена КЛИЕНТА (publicBase), а не от window.location:
 * кабинет открыт на pluson.ru, и origin дал бы наш домен вместо клиентского.
 */
function SpeakerPageLink({ clientId, slug }: { clientId: number; slug?: string | null }) {
  const { publicBase } = useMe()
  const [copied, setCopied] = useState(false)
  // ⚠️ Адрес по СЛУЧАЙНОМУ коду (мигр. 324), а не по номеру клиента: /sp/1
  // подбирался перебором — набрал соседнее число и смотришь чужие материалы.
  // Номер оставлен запасным вариантом для старых кабинетов без кода.
  const url = `${publicBase}/sp/${slug || clientId}`

  return (
    <div className="mt-4 rounded-xl bg-[#FFF6EE] border border-[#FFCFA4] p-3">
      <p className="text-xs font-medium text-[#25455D]">Ссылка для организаторов</p>
      <p className="text-xs text-gray-500 mt-0.5">
        Отдайте её вместо пересылки файлов — организатор скачает фото, логотипы
        и скопирует регалии сам.
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <code className="flex-1 min-w-0 truncate text-xs bg-white rounded-lg px-2.5 py-2 border border-[#FFCFA4]/60">
          {url}
        </code>
        <button type="button"
          onClick={() => { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
          className="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold text-white"
          style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer" title="Открыть"
           className="shrink-0 p-2 rounded-lg hover:bg-white/60 text-gray-400 hover:text-gray-600">
          <ExternalLink size={15} />
        </a>
      </div>
    </div>
  )
}

// hint — ReactNode, а не строка: в подсказку нужны кликабельные ссылки
// (например, на раздел, где поле реально правится).
function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-gray-400 text-xs mt-1.5">{hint}</p>}
    </div>
  )
}

function SubBlock({
  title, items, onEdit, onDelete, onMove,
}: {
  title: string
  items: Offering[]
  onEdit: (o: Offering) => void
  onDelete: (id: number) => void
  onMove: (o: Offering, dir: -1 | 1) => void
}) {
  return (
    <div>
      <div className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold uppercase tracking-wider mb-2"
           style={{
             background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)',
             color: '#25455D',
             boxShadow: '0 2px 6px rgba(255,207,164,0.4)',
           }}>
        {title}
      </div>
      <div className="bg-white rounded-xl border border-gray-200 divide-y">
        {items.map((o, i) => (
          <div key={o.id} className="p-4 flex gap-3 items-start hover:bg-gray-50">
            {/* Стрелки порядка */}
            <div className="flex flex-col gap-0.5 -my-1">
              <button onClick={() => onMove(o, -1)} disabled={i === 0}
                      title="Поднять выше"
                      className="p-1 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                <ChevronUp size={15} />
              </button>
              <button onClick={() => onMove(o, 1)} disabled={i === items.length - 1}
                      title="Опустить ниже"
                      className="p-1 rounded text-gray-400 hover:text-[#25455D] hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent">
                <ChevronDown size={15} />
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900">{o.title}</p>
              {o.description && (
                <p className="text-gray-500 text-sm mt-1 whitespace-pre-wrap break-words">{o.description}</p>
              )}
              {o.action_url && (
                <a href={o.action_url} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-xs mt-2 text-gray-400 hover:underline truncate">
                  <ExternalLink size={12} />
                  <span className="truncate" style={{ maxWidth: 360 }}>{o.action_url}</span>
                </a>
              )}
            </div>
            <div className="flex gap-1">
              <button onClick={() => onEdit(o)}
                      className="p-2 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"><Pencil size={15} /></button>
              <button onClick={() => onDelete(o.id)}
                      className="p-2 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function OfferingModal({
  initial, onClose, onSaved,
}: { initial: Offering | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [title,  setTitle]  = useState(initial?.title || '')
  const [desc,   setDesc]   = useState(initial?.description || '')
  const [url,    setUrl]    = useState(initial?.action_url || '')
  const [isPaid, setIsPaid] = useState<boolean>(initial?.is_paid ?? true)
  const [saving, setSaving] = useState(false)

  // ⚠️ Карточка выдаёт ЛИБО свою ссылку, ЛИБО лид-магнит. Второе нужно,
  // потому что у магнита ссылка РАЗНАЯ на каждой площадке: человек из MAX
  // должен уйти в MAX-бота, а не в Telegram. Одним полем адреса это не
  // выразить, поэтому выбор — отдельным списком.
  // ⚠️ Список магнитов грузит сам LeadMagnetPicker (с поиском и общим кешем
  // на страницу) — своей загрузки здесь больше нет: она дублировала запрос и
  // рисовала список без поиска.
  const [lmId, setLmId] = useState<number>(initial?.lead_magnet_id || 0)

  function isDirty(): boolean {
    if (!initial) {
      return !!(title.trim() || desc.trim() || url.trim() || lmId)
    }
    return title  !== (initial.title       || '')
        || desc   !== (initial.description || '')
        || url    !== (initial.action_url  || '')
        || isPaid !== (initial.is_paid ?? true)
        || lmId   !== (initial.lead_magnet_id || 0)
  }

  function attemptClose() {
    if (isDirty() && !confirm('У вас несохранённые изменения. Закрыть карточку и потерять их?')) {
      return
    }
    onClose()
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault()
    if (!title.trim()) { alert('Укажите название'); return }
    setSaving(true)
    try {
      const payload = {
        title: title.trim(),
        description: desc.trim() || null,
        action_url: url.trim() || null,
        is_paid: isPaid,
        // ⚠️ НОЛЬ, а не null: бэкенд не различает «не прислали» и «прислали
        // пусто», и снять уже выбранный магнит через null было бы нельзя.
        lead_magnet_id: lmId || 0,
      }
      if (initial) await api.miniApp.offerings.update(initial.id, payload)
      else         await api.miniApp.offerings.create(payload)
      await onSaved()
    } catch (e: any) {
      alert(e.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <form onSubmit={save}
            className="bg-white rounded-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold" style={{ color: BRAND }}>
            {initial ? 'Редактировать продукт' : 'Новый продукт'}
          </h2>
          <button type="button" onClick={attemptClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Название</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
                   className="input" autoFocus />
          </div>
          <div>
            <label className="label">Описание</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)}
                      className="input min-h-[80px]"
                      placeholder="Что это и кому подходит" />
          </div>
          <div>
            <label className="label">Ссылка (куда ведёт кнопка «Узнать подробнее»)</label>
            <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                   className="input" placeholder="https://..." />
          </div>

          {/* ⚠️ Второй способ вместо ссылки — выдать свой лид-магнит. Его
              адрес РАЗНЫЙ на каждой площадке, поэтому Mini App подставит
              нужный сам: смотрит из MAX → ссылка на MAX-бота, из Telegram →
              на Telegram. Нет площадки зрителя — предложит выбрать. */}
          <div>
            <label className="label">Или выдать лид-магнит</label>
            {/* ⚠️ Общий пикер с ПОИСКОМ по названию: магнитов у клиента
                десятки (у первого — 36), в простом списке нужный не найти.
                ⚠️ Пакеты показываются здесь тоже — решение владельца
                (коммит 307c4417): разделения «тут только магниты» быть не
                должно. Проп `withPackages` вместе с ним удалён из пикера;
                оставшийся здесь ронял сборку ВСЕЙ ветки ошибкой типов. */}
            <LeadMagnetPicker
              placeholder="— не выдавать, вести по ссылке выше —"
              value={lmId ? { kind: 'magnet', id: lmId } : null}
              onPick={v => setLmId(v ? v.id : 0)}
            />
            <p className="mt-1 text-xs text-gray-500">
              {lmId
                ? 'Кнопка приведёт человека в вашего бота на его площадке — там он подпишется и получит материал. Ссылка выше при этом не используется.'
                : 'Выберите, если хотите выдавать материал через бота: ссылка подставится под площадку человека, а он попадёт к вам в базу.'}
            </p>
          </div>
          <div>
            <label className="label">Куда показывать в Mini App</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setIsPaid(true)}
                      className="flex-1 px-4 py-2.5 rounded-lg text-sm font-bold border-2 transition-all"
                      style={isPaid
                        ? { background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', borderColor: '#f5b97e', color: '#25455D', boxShadow: '0 2px 8px rgba(255,207,164,0.5)' }
                        : { background: 'white', borderColor: '#e5e7eb', color: '#9ca3af' }
                      }>
                💼 В блок «Платно»
              </button>
              <button type="button" onClick={() => setIsPaid(false)}
                      className="flex-1 px-4 py-2.5 rounded-lg text-sm font-bold border-2 transition-all"
                      style={!isPaid
                        ? { background: 'linear-gradient(135deg, #FFCFA4, #f5b97e)', borderColor: '#f5b97e', color: '#25455D', boxShadow: '0 2px 8px rgba(255,207,164,0.5)' }
                        : { background: 'white', borderColor: '#e5e7eb', color: '#9ca3af' }
                      }>
                📄 В блок «Бесплатно»
              </button>
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button type="button" onClick={attemptClose}
                  className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">
            Отмена
          </button>
          <button type="submit" disabled={saving}
                  className="flex-1 px-4 py-2 rounded-lg btn-gold disabled:opacity-60">
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════
   ФИРМЕННЫЕ ЦВЕТА MINI APP (миграции 331–333)

   ⚠️ ТРИ ЦВЕТА, А НЕ ПАЛИТРА. Синий (фон), персиковый (акцент) и кнопка
   призыва к действию. Всё остальное на экране — производные от них через
   прозрачность 20%. Отдельных настроек «цвет заголовка», «цвет вкладки
   дня» и т.п. здесь БЫТЬ НЕ ДОЛЖНО: ровно так и вышел разнобой из пяти
   несочетающихся оттенков, когда цвета тянулись из «Стилей лендингов».

   ⚠️ Раздел ВИДЕН ВСЕМ, но без фичи `miniapp_brand_theme` (Экстра) поля
   заблокированы и сверху висит объяснение. Прятать нельзя: клиент должен
   понимать, за что платит.
   ═══════════════════════════════════════════════════════════════════════ */

/** Поле выбора цвета: кружок-пипетка + текстовый ввод #RRGGBB. */
function ColorField({ label, hint, value, onChange, disabled }: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'
  return (
    <div>
      <label className="block text-sm font-medium text-gray-800 mb-1.5">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={safe}
          disabled={disabled}
          onChange={e => onChange(e.target.value.toUpperCase())}
          className="w-11 h-10 rounded-lg border border-gray-300 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 p-0.5 bg-white"
        />
        <input
          type="text"
          value={value}
          disabled={disabled}
          placeholder="#25455D"
          maxLength={7}
          onChange={e => onChange(e.target.value.toUpperCase())}
          className="flex-1 px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:border-amber-400 disabled:bg-gray-50 disabled:text-gray-400"
          style={{ minWidth: 0 }}
        />
      </div>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  )
}

function ThemeColorsBlock({ profile, update, locked }: {
  profile: Profile
  update: <K extends keyof Profile>(key: K, value: Profile[K]) => void
  locked: boolean
}) {
  const on = !!profile.miniapp_use_brand_theme
  const bg1    = profile.ma_bg_color     || '#25455D'
  const bg2    = profile.ma_bg_color_2   || '#0a1520'
  const bgAng  = profile.ma_bg_angle     ?? 45
  const accent = profile.ma_accent_color || '#FFCFA4'
  const cta1   = profile.ma_cta_color    || '#dc2626'
  const cta2   = profile.ma_cta_color_2  || '#7f1d1d'
  const ctaAng = profile.ma_cta_angle    ?? 135
  const ctaBrd = profile.ma_cta_border   || '#7f1d1d'
  const ctaBrdW = profile.ma_cta_border_w ?? 1
  const radius = profile.ma_radius       ?? 14

  const dis = locked || !on

  // Тёмный ли цвет — чтобы в предпросмотре текст не сливался с фоном.
  // ⚠️ Тот же расчёт, что на бэкенде (миграция 333): предпросмотр обязан
  // показывать то, что человек реально увидит, иначе он ему врёт.
  const isDark = (hex: string) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
    if (!m) return true
    const n = parseInt(m[1], 16)
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 150
  }
  const rgba = (hex: string, a: number) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex)
    if (!m) return 'transparent'
    const n = parseInt(m[1], 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }

  return (
    <div className="max-w-2xl">
      {locked && (
        <div className="mb-4 text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          🔒 Фирменный стиль Mini App входит в тариф <b>Экстра</b>.{' '}
          <a href="/dashboard/subscription"
             className="text-amber-700 underline hover:text-amber-800 font-medium">
            Посмотреть тарифы
          </a>
        </div>
      )}

      <label className={`flex items-start gap-3 mb-5 ${locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          disabled={locked}
          checked={on}
          onChange={e => update('miniapp_use_brand_theme', e.target.checked)}
          className="mt-0.5 w-4 h-4 accent-amber-500 cursor-pointer disabled:cursor-not-allowed"
        />
        <span>
          <span className="block text-sm font-medium text-gray-900">
            Использовать свои цвета
          </span>
          <span className="block text-xs text-gray-500 mt-1">
            Действует в мессенджерах и в веб-версии события. Выключено —
            стандартное оформление платформы.
          </span>
        </span>
      </label>

      <div className={dis ? 'opacity-50' : ''}>
        {/* ── 1. Синий: фон ─────────────────────────────────────────── */}
        <div className="border border-gray-200 rounded-xl p-4 mb-4">
          <p className="text-sm font-bold text-gray-900 mb-3">1. Основной фон</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <ColorField label="Цвет 1" value={bg1} disabled={dis}
                        onChange={v => update('ma_bg_color', v)} />
            <ColorField label="Цвет 2" value={bg2} disabled={dis}
                        onChange={v => update('ma_bg_color_2', v)} />
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-800 mb-1.5">
              Угол градиента: {bgAng}°
            </label>
            <input type="range" min={0} max={360} step={5} value={bgAng} disabled={dis}
                   onChange={e => update('ma_bg_angle', Number(e.target.value))}
                   className="w-full accent-amber-500 disabled:cursor-not-allowed" />
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Шапка, тёмные плашки и фон приложения. Одинаковые цвета — заливка без градиента.
          </p>
        </div>

        {/* ── 2. Акцент ─────────────────────────────────────────────── */}
        <div className="border border-gray-200 rounded-xl p-4 mb-4">
          <p className="text-sm font-bold text-gray-900 mb-3">2. Акцент</p>
          <ColorField
            label="Цвет акцента" value={accent} disabled={dis}
            onChange={v => update('ma_accent_color', v)}
            hint="Иконки меню, стрелки, активная вкладка дня. Карточки спикеров — этот же цвет на 20% прозрачности."
          />
        </div>

        {/* ── 3. Кнопка действия ────────────────────────────────────── */}
        <div className="border border-gray-200 rounded-xl p-4 mb-4">
          <p className="text-sm font-bold text-gray-900 mb-3">3. Главная кнопка</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <ColorField label="Цвет 1" value={cta1} disabled={dis}
                        onChange={v => update('ma_cta_color', v)} />
            <ColorField label="Цвет 2" value={cta2} disabled={dis}
                        onChange={v => update('ma_cta_color_2', v)} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4 mt-3">
            <div>
              <ColorField label="Цвет границы" value={ctaBrd} disabled={dis}
                          onChange={v => update('ma_cta_border', v)} />
              <label className="block text-sm font-medium text-gray-800 mt-3 mb-1.5">
                Толщина границы: {ctaBrdW} px
              </label>
              <input type="range" min={0} max={6} step={1} value={ctaBrdW} disabled={dis}
                     onChange={e => update('ma_cta_border_w', Number(e.target.value))}
                     className="w-full accent-amber-500 disabled:cursor-not-allowed" />
              <p className="text-xs text-gray-500 mt-1">0 — без границы.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-800 mb-1.5">
                Угол градиента: {ctaAng}°
              </label>
              <input type="range" min={0} max={360} step={5} value={ctaAng} disabled={dis}
                     onChange={e => update('ma_cta_angle', Number(e.target.value))}
                     className="w-full accent-amber-500 disabled:cursor-not-allowed" />
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Кнопка призыва к действию — «Получить записи», «Хочу участвовать».
          </p>
        </div>

        {/* ── 4. Скругление ─────────────────────────────────────────── */}
        <div className="border border-gray-200 rounded-xl p-4 mb-4">
          <p className="text-sm font-bold text-gray-900 mb-3">4. Скругление углов: {radius} px</p>
          <input type="range" min={0} max={28} step={1} value={radius} disabled={dis}
                 onChange={e => update('ma_radius', Number(e.target.value))}
                 className="w-full accent-amber-500 disabled:cursor-not-allowed" />
          <p className="text-xs text-gray-500 mt-2">
            Карточки, кнопки и плашки. 0 — прямые углы, 28 — сильно скруглённые.
          </p>
        </div>

        {/* ── Предпросмотр ──────────────────────────────────────────── */}
        <div className="border border-gray-200 rounded-xl p-4">
          <p className="text-sm font-bold text-gray-900 mb-3">Как это будет выглядеть</p>
          <div style={{ borderRadius: radius, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            {/* Шапка */}
            <div style={{
              background: bg1 === bg2 ? bg1 : `linear-gradient(${bgAng}deg, ${bg1}, ${bg2})`,
              padding: '14px 16px',
              color: isDark(bg1) ? '#ffffff' : '#1a2a3a',
            }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Название события</div>
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>· идёт сейчас</div>
            </div>
            {/* Тело */}
            <div style={{ background: '#f7f8fa', padding: 14 }}>
              <button type="button" style={{
                width: '100%', border: ctaBrdW ? `${ctaBrdW}px solid ${ctaBrd}` : 'none',
                background: cta1 === cta2 ? cta1 : `linear-gradient(${ctaAng}deg, ${cta1}, ${cta2})`,
                color: isDark(cta1) ? '#ffffff' : '#1a2a3a',
                borderRadius: radius, padding: '13px 16px', marginBottom: 10,
                fontWeight: 900, fontSize: 13, letterSpacing: 1.1,
                textTransform: 'uppercase', cursor: 'default',
              }}>
                Получить записи
              </button>
              {/* Карточка спикера — акцент на 20% */}
              <div style={{
                background: rgba(accent, 0.2), borderRadius: radius,
                padding: 12, display: 'flex', gap: 10, alignItems: 'center',
              }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%',
                  background: accent, flexShrink: 0,
                }} />
                <div>
                  <div style={{
                    display: 'inline-block', background: accent,
                    color: isDark(accent) ? '#ffffff' : '#1a2a3a',
                    fontSize: 9, fontWeight: 800, letterSpacing: 0.8,
                    padding: '3px 7px', borderRadius: 6, marginBottom: 3,
                  }}>СПИКЕР</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>Имя Фамилия</div>
                </div>
              </div>
              {/* Нижнее меню */}
              <div style={{
                display: 'flex', gap: 4, marginTop: 12, background: 'white',
                borderRadius: radius, padding: 6,
              }}>
                {['Программа', 'Спикеры', 'Подарки'].map((t, i) => (
                  <div key={t} style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 8, margin: '0 auto 3px',
                      background: i === 0 ? accent : 'transparent',
                    }} />
                    <div style={{
                      fontSize: 9, fontWeight: 700,
                      color: i === 0 ? '#1a2a3a' : '#8a96a3',
                    }}>{t}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
