'use client'
import { useState, useEffect, Suspense } from 'react'
import { Save, Globe, Eye, EyeOff, FlaskConical, UserCheck, Gauge, HardDrive, Lock, X, CheckCircle2, User as UserIcon, Wrench, Smartphone, Plug, Copy, Check, RefreshCw, ExternalLink, Bell, ShieldCheck, ShieldAlert, UserPlus, ChevronDown, Palette, CreditCard, Image as ImageIcon } from 'lucide-react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { setTimezone } from '@/lib/timezone'
import { useLang, type Lang } from '@/contexts/LangContext'
import MiniAppSettingsPage from '../mini-app/page'
import LegalTab from '@/components/settings/LegalTab'
import LandingThemeTab from '@/components/settings/LandingThemeTab'
import CoverTemplatesTab from '@/components/settings/CoverTemplatesTab'
import AssistantTab from '@/components/settings/AssistantTab'
import ChatGatesTab from '@/components/settings/ChatGatesTab'
import StorageTab from '@/components/settings/StorageTab'
import PaymentsSection from '@/components/settings/PaymentsSection'
import DomainsTab from '@/components/settings/DomainsTab'
import CallSettingsBlock from '@/components/settings/CallSettingsBlock'
import NewsEmailBlock from '@/components/settings/NewsEmailBlock'
import CopyAllLinksButton, { type PlatformLinks as PlatformLinksType } from '@/components/CopyAllLinksButton'

// ⚠️ Вкладки 'subscription' здесь БОЛЬШЕ НЕТ — подписка живёт отдельной
// страницей /dashboard/subscription. Раньше существовали обе: из меню вела
// страница, а все ссылки («осталось N дней», баннеры, возврат после оплаты) —
// на вкладку, то есть человек попадал в раздел настроек, которого в меню нет.
// Два экрана с одним смыслом расходились при каждой правке.
type Tab = 'profile' | 'tech' | 'integration' | 'mini-app' | 'legal' | 'assistant' | 'chat-gates' | 'landing-theme' | 'covers' | 'payments' | 'domains' | 'storage'

const TIMEZONES = [
  { value: 'Europe/Moscow', label: 'Москва (UTC+3)' },
  { value: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
  { value: 'Europe/Samara', label: 'Самара (UTC+4)' },
  { value: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
  { value: 'Asia/Omsk', label: 'Омск (UTC+6)' },
  { value: 'Asia/Krasnoyarsk', label: 'Красноярск (UTC+7)' },
  { value: 'Asia/Irkutsk', label: 'Иркутск (UTC+8)' },
  { value: 'Asia/Yakutsk', label: 'Якутск (UTC+9)' },
  { value: 'Asia/Vladivostok', label: 'Владивосток (UTC+10)' },
  { value: 'Asia/Magadan', label: 'Магадан (UTC+11)' },
  { value: 'Asia/Kamchatka', label: 'Камчатка (UTC+12)' },
  { value: 'Europe/Kiev', label: 'Киев (UTC+2/3)' },
  { value: 'Asia/Almaty', label: 'Алматы (UTC+5)' },
  { value: 'Asia/Tashkent', label: 'Ташкент (UTC+5)' },
  { value: 'UTC', label: 'UTC (GMT+0)' },
]


// ⚠️⚠️ ОБЯЗАТЕЛЬНАЯ ОБЁРТКА. Страница без динамического сегмента — Next
// пререндерит её на сборке. Внутри живут PaymentsSection и StorageTab, а они
// читают адрес через `useUrlTab` (`useSearchParams`): на пререндеренной
// странице это требует <Suspense>, иначе падает сборка ВСЕГО проекта.
// ⚠️ Опасность НЕ видна в самом файле — хук лежит во вложенном компоненте.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  )
}

function SettingsPageInner() {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'profile'
    // (тип Tab расширен — добавлен legal)
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null
    // ⚠️ Новую вкладку добавлять СЮДА ТОЖЕ, иначе ссылка ?tab=... молча
    // откроет профиль — так и вышло со 'storage': кнопки вели в никуда.
    const ALLOWED: Tab[] = ['tech', 'integration', 'mini-app', 'legal',
      'assistant', 'chat-gates', 'landing-theme', 'payments', 'domains', 'storage']
    return t && ALLOWED.includes(t) ? t : 'profile'
  })

  // ⚠️ Старые ссылки ?tab=subscription уводим на страницу подписки, а не молча
  // открываем профиль: такие адреса разосланы письмами о продлении и лежат в
  // закладках. Молчаливый профиль читался бы как «раздел пропал».
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (new URLSearchParams(window.location.search).get('tab') === 'subscription') {
      window.location.replace('/dashboard/subscription')
    }
  }, [])
  const [form, setForm] = useState({ name: '', last_name: '', email: '', phone: '', telegram_username: '', timezone: 'Europe/Moscow', test_telegram_ids_raw: '', test_vk_ids_raw: '', test_max_ids_raw: '', test_email_ids_raw: '', work_tg_username: '', work_vk: '', work_max: '', broadcast_concurrency: '30', notifications_telegram_chat_id: '', notifications_telegram_invite_link: '', notifications_max_chat_id: '', notifications_max_url: '', notifications_vk_peer_id: '', partner_landing_url: '', partner_dashboard_url: '', speaker_achievements_limit: '' })
  const [partnerVisibleRoles, setPartnerVisibleRoles] = useState<string[]>([])
  const [notifyTab, setNotifyTab] = useState<'telegram' | 'max' | 'vk'>('telegram')
  // Тестовые рассылки — площадки вкладками, как в «Каналах уведомлений»:
  // четыре поля подряд не помещались и терялись при прокрутке.
  const [testTab, setTestTab] = useState<'telegram' | 'max' | 'vk' | 'email'>('telegram')
  const [maxResolving, setMaxResolving] = useState(false)
  const [clientId, setClientId] = useState<number | null>(null)
  const [availablePlatforms, setAvailablePlatforms] = useState<string[]>([])
  const [botHandles, setBotHandles] = useState<{ telegram?: string | null; vk?: string | null; max?: string | null } | null>(null)
  const [vkAppId, setVkAppId] = useState<number | null>(null)
  const [tariff, setTariff] = useState<any>(null)
  const [clientFeatures, setClientFeatures] = useState<string[]>([])
  // Роль текущего токена: ограниченный ассистент не видит email/пароль владельца
  // и вкладку «Ассистент»; полный ассистент видит всё, кроме вкладки «Ассистент».
  const [role, setRole] = useState<'owner' | 'assistant'>('owner')
  const [assistantLevel, setAssistantLevel] = useState<'full' | 'limited' | null>(null)
  const [storage, setStorage] = useState<{ used_bytes: number; quota_bytes: number; used_human: string; quota_human: string; used_percent: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const { lang, setLang, t } = useLang()

  useEffect(() => {
    api.auth.me().then(c => {
      const tz = c.timezone || 'Europe/Moscow'
      setTimezone(tz)
      setForm({
        name: c.name || '',
        last_name: c.last_name || '',
        email: c.email || '',
        phone: c.phone || '',
        telegram_username: c.telegram_username || '',
        timezone: tz,
        test_telegram_ids_raw: (c.test_telegram_ids || []).join(', '),
        test_vk_ids_raw: (c.test_vk_ids || []).join(', '),
        test_max_ids_raw: (c.test_max_ids || []).join(', '),
        test_email_ids_raw: (c.test_email_ids || []).join(', '),
        work_tg_username: c.work_tg_username || '',
        work_vk: c.work_vk || '',
        work_max: c.work_max || '',
        broadcast_concurrency: c.broadcast_concurrency ? String(c.broadcast_concurrency) : '30',
        // Пусто = умолчание платформы. Не подставляем 1100 в поле: иначе не
        // отличить «клиент так решил» от «не трогал», и вернуть умолчание было
        // бы нечем.
        speaker_achievements_limit: c.speaker_achievements_limit ? String(c.speaker_achievements_limit) : '',
        notifications_telegram_chat_id: c.notifications_telegram_chat_id ? String(c.notifications_telegram_chat_id) : '',
        notifications_telegram_invite_link: c.notifications_telegram_invite_link || '',
        notifications_max_chat_id: c.notifications_max_chat_id ? String(c.notifications_max_chat_id) : '',
        notifications_max_url: c.notifications_max_url ? String(c.notifications_max_url) : '',
        notifications_vk_peer_id: c.notifications_vk_peer_id ? String(c.notifications_vk_peer_id) : '',
        partner_landing_url: c.partner_landing_url || '',
        partner_dashboard_url: c.partner_dashboard_url || '',
      })
      setPartnerVisibleRoles(Array.isArray(c.partner_visible_roles) ? c.partner_visible_roles : [])
      setRole(c.role === 'assistant' ? 'assistant' : 'owner')
      setAssistantLevel(c.assistant_access_level || null)
      setTariff(c.subscription || null)
      setClientFeatures(Array.isArray(c.features) ? c.features : [])
      setClientId(c.id || null)
      setAvailablePlatforms(Array.isArray(c.available_platforms) ? c.available_platforms : ['telegram'])
      setBotHandles(c.bot_handles || null)
      setVkAppId(c.vk_app_id ? Number(c.vk_app_id) : null)
    }).catch(() => {})
    // fetch storage usage
    const token = (typeof window !== 'undefined' && localStorage.getItem('plusson_token')) || ''
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
    fetch(`${apiUrl}/api/v1/storage/usage`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setStorage(d))
      .catch(() => {})
  }, [])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  // Получить chat_id MAX-канала уведомлений по ссылке (бот должен быть админом).
  async function resolveMaxNotifyChatId() {
    const url = (form.notifications_max_url || '').trim()
    if (!url) { alert('Сначала вставьте ссылку на MAX-канал'); return }
    try {
      setMaxResolving(true)
      const res: any = await api.miniApp.profile.resolveMaxChatId({ url })
      if (res?.chat_id) {
        setForm(f => ({ ...f, notifications_max_chat_id: String(res.chat_id) }))
        alert(`ID канала получен: ${res.chat_id}. Не забудьте сохранить.`)
      } else {
        alert('Не удалось получить ID. Проверьте, что бот добавлен админом в этот MAX-канал.')
      }
    } catch (e: any) {
      const msg = e?.message || ''
      alert(msg === 'not_found'
        ? 'Не нашёл этот канал у бота. Добавьте свой MAX-бот АДМИНИСТРАТОРОМ в канал и попробуйте снова.'
        : (msg || 'Не получилось получить ID'))
    } finally {
      setMaxResolving(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const parseIds = (raw: string) => raw.split(/[,\s]+/).map((s: string) => s.trim()).filter(Boolean)
      const testIds = parseIds(form.test_telegram_ids_raw)
      const testVkIds = parseIds(form.test_vk_ids_raw)
      const testMaxIds = parseIds(form.test_max_ids_raw)
      const testEmailIds = parseIds(form.test_email_ids_raw)
      const concurrency = Math.max(1, Math.min(100, Number(form.broadcast_concurrency) || 30))
      await api.auth.updateMe({
        name: form.name,
        last_name: form.last_name || null,
        phone: form.phone,
        telegram_username: form.telegram_username,
        timezone: form.timezone,
        test_telegram_ids: testIds,
        test_vk_ids: testVkIds,
        test_max_ids: testMaxIds,
        test_email_ids: testEmailIds,
        work_tg_username: form.work_tg_username || null,
        work_vk: form.work_vk || null,
        work_max: form.work_max || null,
        broadcast_concurrency: concurrency,
        notifications_telegram_chat_id: form.notifications_telegram_chat_id ? Number(form.notifications_telegram_chat_id) : null,
        notifications_max_chat_id: form.notifications_max_chat_id?.trim() || null,
        notifications_telegram_invite_link: form.notifications_telegram_invite_link?.trim() || null,
        notifications_max_url: form.notifications_max_url?.trim() || null,
        notifications_vk_peer_id: form.notifications_vk_peer_id?.trim() || null,
        partner_landing_url: form.partner_landing_url.trim() || null,
        partner_dashboard_url: form.partner_dashboard_url.trim() || null,
        partner_visible_roles: partnerVisibleRoles,
        // Пустое поле = вернуть умолчание платформы (сервер запишет NULL).
        speaker_achievements_limit: form.speaker_achievements_limit.trim()
          ? Number(form.speaker_achievements_limit) : null,
      })
      setTimezone(form.timezone)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // Раздел «Интеграция» (токен чат-ботов + регистрация партнёров) — по фиче
  // partner_registration (vip + admin). У Профи / Стандарт / Триал — скрыт.
  // ⚠️ Плюс фича calls: настройки автообзвонов живут в этой же вкладке, и без
  // такой проверки клиент с обзвонами, но без partner_registration, не смог бы
  // до них добраться — вкладки бы просто не было.
  const hasCalls = clientFeatures.includes('calls')
  const hasPartnerRegistration = clientFeatures.includes('partner_registration') || hasCalls
  // Стили бренда и лендинга — та же фича, что и сам конструктор лендинга (миграция 241).
  const hasLandingTheme = clientFeatures.includes('event_landing')
  // Приём оплаты за тарифы своей платёжной системой (миграция 257).
  const hasPayments = clientFeatures.includes('payments')

  const isAnyAssistant = role === 'assistant'
  const isRestrictedAssistant = isAnyAssistant && assistantLevel !== 'full'

  const TABS: { id: Tab; label: string; icon: any }[] = [
    { id: 'profile',      label: 'Профиль',      icon: UserIcon  },
    { id: 'tech',         label: 'Техническое',  icon: Wrench    },
    ...(hasPartnerRegistration ? [{ id: 'integration' as Tab, label: 'Интеграция', icon: Plug }] : []),
    { id: 'mini-app',     label: 'Mini App',     icon: Smartphone},
    ...(hasLandingTheme ? [{ id: 'landing-theme' as Tab, label: 'Стили бренда и лендинга', icon: Palette }] : []),
    // Шаблоны обложек (миграция 387) — рядом со «Стилями»: это тоже
    // фирменное оформление, только для картинок к записям и материалам.
    { id: 'covers' as Tab, label: 'Шаблоны обложек', icon: ImageIcon },
    // ⚠️ Вкладка видна ВСЕГДА: скрытый раздел выглядит как «у нас такого нет».
    // Без фичи внутри показывается замок с объяснением и ссылкой на тариф.
    { id: 'payments' as Tab, label: 'Платёжные системы', icon: CreditCard },
    // ⚠️ Вкладка видна ВСЕГДА (как «Платёжные системы» выше). Скрытая читалась
    // как «такого у нас нет», а на неё ведут ссылки из других разделов — из
    // «Каналов», где предлагается подключить свой почтовый домен. Без фичи
    // внутри показывается замок с тарифом и кнопкой перехода.
    { id: 'domains' as Tab, label: 'Свой домен', icon: Globe },
    { id: 'storage' as Tab, label: 'Файловое хранилище', icon: HardDrive },
    { id: 'chat-gates',   label: 'Гейт в чатах', icon: ShieldAlert},
    // Управлять ассистентом может только владелец — даже полный ассистент не может
    // сменить себе пароль или отключить себя.
    ...(isAnyAssistant ? [] : [{ id: 'assistant' as Tab, label: 'Помощники', icon: UserPlus }]),
    // «Подписка» вынесена в отдельную страницу /dashboard/subscription (меню пользователя).
    { id: 'legal',        label: 'Юр. данные',   icon: ShieldCheck},
  ]

  // Защита от прямого перехода ?tab=integration у не-vip: переключаем на профиль.
  let effectiveTab: Tab = (tab === 'integration' && !hasPartnerRegistration) ? 'profile' : tab
  if (isAnyAssistant && effectiveTab === 'assistant') effectiveTab = 'profile'

  // Ограниченный ассистент в «Настройки» не заходит вообще: тут email и пароль
  // владельца кабинета. Прямой переход по URL — показываем заглушку.
  if (isRestrictedAssistant) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Настройки</h1>
        <div className="bg-white rounded-2xl border card-border shadow-sm p-8 text-center">
          <p className="text-gray-700 font-medium">Раздел доступен только владельцу кабинета</p>
          <p className="text-sm text-gray-500 mt-2">
            Здесь хранятся email и пароль владельца. Если вам нужны эти настройки —
            попросите владельца выдать вам полный доступ.
          </p>
        </div>
      </div>
    )
  }

  // Бот, который реально пишет в канал уведомлений — ТОЛЬКО свой (VIP) бот клиента.
  // Системный @pluson_bot уведомления организатору больше не шлёт (2026-07-08):
  // нет своего бота → уведомления не работают, показываем подсказку подключить бота.
  const notifyBotHandle = (botHandles?.telegram || '').replace(/^@/, '')

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Настройки</h1>

      {/* Табы */}
      <div className="flex flex-wrap gap-1 mb-6 border-b border-gray-200">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                active
                  ? 'border-[#25455D] text-[#25455D]'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          )
        })}
      </div>

      {/* Mini App таб — отдельная страница, без общей формы */}
      {effectiveTab === 'mini-app' && <MiniAppSettingsPage />}

      {/* Гейт по подписке в TG-чатах — миграция 115 */}
      {effectiveTab === 'storage' && <StorageTab />}
      {effectiveTab === 'chat-gates' && <ChatGatesTab />}
      {/* Два подраздела: ключи платёжной системы и промокоды (миграция 397). */}
      {effectiveTab === 'payments' && <PaymentsSection />}

      {/* Свой домен: публичные страницы + адрес отправителя писем — миграция 270 */}
      {/* ⚠️ Без `hasCustomDomain`: вкладка открыта всем, а замок с тарифом
          рисует сама DomainsTab по ответу 403 — иначе ссылки на неё из других
          разделов вели бы в пустоту. */}
      {effectiveTab === 'domains' && <DomainsTab />}

      {/* Интеграция — токен для чат-ботов (только vip) */}
      {effectiveTab === 'integration' && <IntegrationTab />}

      {/* Юр. данные + Политика — отдельный блок */}
      {effectiveTab === 'legal' && <LegalTab />}
      {effectiveTab === 'landing-theme' && hasLandingTheme && <LandingThemeTab />}
      {effectiveTab === 'covers' && <CoverTemplatesTab />}

      {/* Ассистент кабинета — миграция 106 */}
      {effectiveTab === 'assistant' && <AssistantTab />}

      {/* Профиль, Техническое и Интеграция — общая форма с одной кнопкой Сохранить */}
      {(effectiveTab === 'profile' || effectiveTab === 'tech' || effectiveTab === 'integration') && (
      <form onSubmit={handleSave} className="space-y-6">

        {effectiveTab === 'profile' && (
        <>
        {/* Profile */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-5">Профиль</h3>
          <div className="space-y-4">
            {/* ⚠️ Фамилия — отдельное поле (миграция 381), а не часть имени.
                Заводится на регистрации; здесь её правят и заполняют те, кто
                регистрировался раньше — иначе исправить её негде. */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Имя</label>
                <input type="text" value={form.name} onChange={set('name')}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Фамилия</label>
                <input type="text" value={form.last_name} onChange={set('last_name')}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
              </div>
            </div>
            {/* Email и пароль — личные данные владельца, ассистенту (даже полному) не показываем */}
            {!isAnyAssistant && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input type="email" value={form.email} readOnly
                  className="w-full px-4 py-3 border border-gray-100 rounded-xl bg-gray-50 text-sm text-gray-500 cursor-not-allowed" />
                <p className="text-xs text-gray-400 mt-1">Email изменить нельзя</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Телефон</label>
                <input type="tel" value={form.phone} onChange={set('phone')}
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Telegram</label>
                <input type="text" value={form.telegram_username} onChange={set('telegram_username')}
                  placeholder="@username"
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
              </div>
            </div>
          </div>
        </div>

        {/* Security — change password (в Профиле). Пароль владельца ассистенту недоступен. */}
        {!isAnyAssistant && (
          <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
                <Lock size={18} className="text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-800">Безопасность</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Пароль для входа в кабинет iViSiON: ПЛЮСОН.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowPasswordModal(true)}
              className="px-4 py-2.5 rounded-xl text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Сменить пароль
            </button>
          </div>
        )}

        {/* Язык интерфейса (в Профиле) */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <Globe size={18} className="text-white" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-800">Язык интерфейса</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Меняется мгновенно, сохраняется в браузере.
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {(['ru', 'en'] as Lang[]).map(code => (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                className={`px-4 py-2 rounded-xl text-sm font-medium border ${
                  lang === code
                    ? 'border-[#25455D] bg-[#25455D] text-white'
                    : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {code === 'ru' ? '🇷🇺 Русский' : '🇬🇧 English'}
              </button>
            ))}
          </div>
        </div>

        {/* Служба поддержки (перенесено из «Техническое») */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <UserCheck size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800">Служба поддержки и контакты для связи</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Каналы для связи клиентов с вами. Указывайте <b>ссылкой</b>. Подставляются
                в команду <code>/support</code> в ботах, в кнопку «Тех. поддержка» в меню
                события и на странице регистрации, и в воронку догрева. Показываются только
                заполненные.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Телеграм <span className="text-gray-400">(ссылка)</span></label>
              <input
                type="text"
                value={form.work_tg_username}
                onChange={set('work_tg_username')}
                placeholder="https://telegram.me/username"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ВКонтакте <span className="text-gray-400">(ссылка)</span></label>
              <input
                type="text"
                value={form.work_vk}
                onChange={set('work_vk')}
                placeholder="https://vk.com/username"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">MAX <span className="text-gray-400">(ссылка)</span></label>
              <input
                type="text"
                value={form.work_max}
                onChange={set('work_max')}
                placeholder="https://max.ru/username"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
              />
            </div>
          </div>
        </div>
        </>
        )}

        {effectiveTab === 'integration' && (
        <>
        {/* Регистрация партнёров (миграция 105) — перенесено из «Техническое» в «Интеграция» */}
        <PartnerRegistrationBlock
          form={form}
          set={set}
          clientId={clientId}
          availablePlatforms={availablePlatforms}
          botHandles={botHandles}
          vkAppId={vkAppId}
          visibleRoles={partnerVisibleRoles}
          setVisibleRoles={setPartnerVisibleRoles}
        />
        </>
        )}

        {effectiveTab === 'tech' && (
        <>

        {/* Письма с новостями платформы (миграция 374). Стоит первым: это
            единственное место, где случайную отписку из письма можно вернуть. */}
        <NewsEmailBlock />

        {/* Notifications channel — первый блок (важнейшая настройка) */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <Bell size={18} className="text-white" />
            </div>
            <div>
              <h3 id="tg-chat-id" className="font-semibold text-gray-800">Каналы уведомлений</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Сюда бот пишет о новых интересантах и других важных событиях. Можно задать
                канал на каждой площадке — <strong>уведомление придёт во все три сразу</strong>.
                Добавьте бота админом в свой канал/беседу и впишите ID. Узнать ID — команда
                <strong> /getmyid</strong> прямо в этом канале/беседе (бот ответит числом).
                <br />
                <span className="text-amber-700">
                  Обратите внимание: у вас как администратора должна быть <strong>выключена
                  анонимность</strong> — иначе Telegram скрывает отправителя и бот не сможет
                  назвать ваш личный ID. Снять: название группы → Изменить → Администраторы →
                  вы → выключить «Анонимность».
                </span>
              </p>
            </div>
          </div>

          {/* Вкладки площадок */}
          <div className="flex gap-1 mb-4 border-b border-gray-200">
            {([
              { k: 'telegram', label: 'Telegram' },
              { k: 'max', label: 'MAX' },
              { k: 'vk', label: 'VK' },
            ] as const).map(t => (
              <button
                key={t.k}
                type="button"
                onClick={() => setNotifyTab(t.k)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  notifyTab === t.k
                    ? 'border-[#25455D] text-[#25455D]'
                    : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
              >
                {t.label}
                {((t.k === 'telegram' && form.notifications_telegram_chat_id) ||
                  (t.k === 'max' && form.notifications_max_chat_id) ||
                  (t.k === 'vk' && form.notifications_vk_peer_id)) && (
                  <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" />
                )}
              </button>
            ))}
          </div>

          {notifyTab === 'telegram' && (
            <div>
              <input
                type="text"
                inputMode="numeric"
                value={form.notifications_telegram_chat_id}
                onChange={set('notifications_telegram_chat_id')}
                placeholder="-1001234567890"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
              />

              {/*
                ⚠️ ССЫЛКА-ПРИГЛАШЕНИЕ В ГРУППУ — ЗДЕСЬ, а не только в мастере
                автонастройки. Мастер это ПРОЦЕСС: он завершается и уходит, а
                вступить человек может позже — с другого устройства, после
                выхода из группы или просто вспомнив о ней через неделю. По
                одному `chat_id` в Telegram вступить нельзя, и группа
                становилась недостижимой.

                ⚠️ В «Группы/Каналы для рассылок» она намеренно НЕ попадает:
                там чаты, куда уходят анонсы аудитории, а это служебная группа
                уведомлений (см. `is_setup_group` в tg_setup_events.py).

                ⚠️ Поле видно ВСЕГДА, а не только когда ссылка уже есть:
                автонастройкой пользуются не все, а канал заводят руками —
                и тогда ссылку тоже нужно куда-то записать, иначе она
                теряется в переписке.

                ⚠️ Это ПАМЯТКА, а не рабочая настройка: платформа по ней ничего
                не отправляет — отправка идёт по ID выше. Так и подписано, чтобы
                человек не искал, на что поле влияет.
              */}
              <div className="mt-3">
                <label className="block text-sm text-gray-600 mb-1.5">
                  Ссылка на канал или группу
                  <span className="text-gray-400"> — просто для вас, чтобы не потерять</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={form.notifications_telegram_invite_link}
                    onChange={set('notifications_telegram_invite_link')}
                    placeholder="https://t.me/+abcDEF…"
                    className="flex-1 min-w-0 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
                  />
                  {form.notifications_telegram_invite_link && (
                    <a href={form.notifications_telegram_invite_link}
                       target="_blank" rel="noreferrer"
                       title="Открыть"
                       className="shrink-0 flex items-center px-4 rounded-xl border border-gray-200 text-gray-500 hover:border-gray-300">
                      <ExternalLink size={16} />
                    </a>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1.5">
                  Заполняется сама при автонастройке. По ID вступить в Telegram
                  нельзя — нужна именно ссылка-приглашение.
                </p>
              </div>

              <details className="mt-3 text-sm text-gray-600">
                <summary className="cursor-pointer text-[#25455D] font-medium">Как узнать ID канала</summary>
                {notifyBotHandle ? (
                  <ol className="list-decimal pl-5 mt-2 space-y-1 text-gray-600">
                    <li>Создайте <strong>закрытый</strong> Telegram-канал.</li>
                    <li>Добавьте <a href={`https://telegram.me/${notifyBotHandle}`} target="_blank" rel="noreferrer" className="underline text-[#25455D]">@{notifyBotHandle}</a> в админы канала — <strong>оставьте все права</strong>.</li>
                    <li>Откройте личный чат с @{notifyBotHandle} и перешлите ему любое сообщение из канала — бот ответит с ID.</li>
                  </ol>
                ) : (
                  <p className="mt-2 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Уведомления в Telegram шлёт ваш бот. Сначала подключите своего бота в разделе{' '}
                    <a href="/dashboard/channels" className="underline font-medium">Каналы</a>.
                  </p>
                )}
              </details>
            </div>
          )}

          {notifyTab === 'max' && (
            <div>
              <label className="block text-sm text-gray-600 mb-1">Ссылка на MAX-канал уведомлений</label>
              <div className="flex gap-2 items-stretch flex-wrap">
                <input
                  type="url"
                  value={form.notifications_max_url || ''}
                  onChange={set('notifications_max_url')}
                  placeholder="https://max.ru/join/... или ссылка на канал"
                  className="flex-1 min-w-0 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
                />
                <button
                  type="button"
                  onClick={resolveMaxNotifyChatId}
                  disabled={maxResolving}
                  className="px-4 py-3 text-sm rounded-xl bg-[#25455D] text-white whitespace-nowrap disabled:opacity-50"
                >
                  {maxResolving ? '...' : 'Получить ID'}
                </button>
              </div>
              {form.notifications_max_chat_id ? (
                <div className="mt-3 flex items-center gap-2 flex-wrap rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3">
                  <span className="text-emerald-700 text-sm font-medium">✓ Канал уведомлений подключён</span>
                  <span className="font-mono text-sm text-emerald-900">ID {form.notifications_max_chat_id}</span>
                  <button
                    type="button"
                    onClick={() => setForm(f => ({ ...f, notifications_max_chat_id: '', notifications_max_url: '' }))}
                    className="ml-auto text-xs text-gray-500 hover:text-red-600 underline"
                  >
                    Очистить
                  </button>
                </div>
              ) : (
                <div className="mt-2 text-sm text-gray-500">ID канала пока не получен — вставьте ссылку и нажмите «Получить ID».</div>
              )}
              <p className="mt-3 text-sm text-gray-600">
                Добавьте свой MAX-бот{botHandles?.max ? <> (<strong>{botHandles.max}</strong>)</> : null} <strong>администратором</strong> в
                нужный MAX-канал, вставьте ссылку на него и нажмите <strong>«Получить ID»</strong> — ID
                определится сам. После — нажмите <strong>«Сохранить визитку»</strong> внизу.
              </p>
            </div>
          )}

          {notifyTab === 'vk' && (
            <div>
              <label className="block text-sm text-gray-600 mb-1">ID беседы VK (peer_id)</label>
              <input
                type="text"
                value={form.notifications_vk_peer_id}
                onChange={set('notifications_vk_peer_id')}
                placeholder="2000000001"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
              />
              <p className="mt-3 text-sm text-gray-600">
                Уведомления придут в <strong>беседу VK</strong> — её видите и вы, и ваша команда
                (как канал). Слать будет ваше сообщество{botHandles?.vk ? <> (<strong>{botHandles.vk}</strong>)</> : null}.
              </p>
              <ol className="mt-2 text-sm text-gray-600 list-decimal pl-5 space-y-1">
                <li>В сообществе VK: <strong>Управление → Сообщения → Настройки для бота</strong> → включите <strong>«Разрешать добавлять сообщество в чаты»</strong> (без этого VK не даст добавить сообщество в беседу).</li>
                <li>Создайте беседу VK (добавьте туда нужных людей), затем добавьте в неё <strong>своё сообщество</strong> и назначьте его <strong>администратором</strong> беседы.</li>
                <li>Напишите в беседе <strong>/getmyid</strong> — сообщество ответит peer_id (число вида 2000000001). Вставьте сюда и нажмите <strong>«Сохранить визитку»</strong>.</li>
                <li className="text-amber-700">Обратите внимание: пишите от своего имени, а не от имени сообщества — иначе отправителя не видно и бот не назовёт ваш личный ID.</li>
              </ol>
            </div>
          )}
        </div>

        {/* Test recipient IDs (TG / VK / MAX) — разворачиваемый блок */}
        <details className="bg-white rounded-2xl border card-border shadow-sm p-6 group">
          <summary className="flex items-start gap-3 cursor-pointer list-none">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <FlaskConical size={18} className="text-white" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-800 flex items-center gap-2">
                Тестовые рассылки
                <ChevronDown size={16} className="text-gray-400 transition-transform group-open:rotate-180" />
              </h3>
              <p className="text-sm text-gray-500 mt-0.5">
                ID аккаунтов, на которые отправляется тестовое сообщение из шаблонов рассылок.
                По каждой платформе указывайте через запятую или пробел.
              </p>
            </div>
          </summary>

          <div className="mt-4">

          {/* Вкладки площадок — четыре поля подряд не помещались на экране */}
          <div className="flex gap-1 mb-4 border-b border-gray-200">
            {([
              { k: 'telegram', label: 'Telegram' },
              { k: 'max', label: 'MAX' },
              { k: 'vk', label: 'VK' },
              { k: 'email', label: 'Email' },
            ] as const).map(t => (
              <button
                key={t.k}
                type="button"
                onClick={() => setTestTab(t.k)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  testTab === t.k
                    ? 'border-[#25455D] text-[#25455D]'
                    : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
              >
                {t.label}
                {((t.k === 'telegram' && form.test_telegram_ids_raw) ||
                  (t.k === 'max' && form.test_max_ids_raw) ||
                  (t.k === 'vk' && form.test_vk_ids_raw) ||
                  (t.k === 'email' && form.test_email_ids_raw)) && (
                  <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" />
                )}
              </button>
            ))}
          </div>

          {testTab === 'telegram' && (
          <div>
            <input
              type="text"
              value={form.test_telegram_ids_raw}
              onChange={set('test_telegram_ids_raw')}
              placeholder="123456789, 987654321"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              Tелеграм-ID можно узнать у бота <span className="font-mono">@userinfobot</span>.
            </p>
            {form.test_telegram_ids_raw && (
              <div className="mt-2 flex flex-wrap gap-2">
                {form.test_telegram_ids_raw.split(/[,\s]+/).filter(Boolean).map((id: string) => (
                  <span key={id} className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded-lg px-2 py-0.5 font-mono">
                    {id.trim()}
                  </span>
                ))}
              </div>
            )}
          </div>
          )}

          {testTab === 'vk' && (
          <div>
            <input
              type="text"
              value={form.test_vk_ids_raw}
              onChange={set('test_vk_ids_raw')}
              placeholder="123456789"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              Числовой ID профиля ВК (vk.com/id<span className="font-mono">123456789</span>).
              Тестовый аккаунт должен быть подписан на VK-сообщество — иначе ВК не пустит сообщение.
            </p>
            {form.test_vk_ids_raw && (
              <div className="mt-2 flex flex-wrap gap-2">
                {form.test_vk_ids_raw.split(/[,\s]+/).filter(Boolean).map((id: string) => (
                  <span key={id} className="text-xs bg-sky-50 text-sky-700 border border-sky-100 rounded-lg px-2 py-0.5 font-mono">
                    {id.trim()}
                  </span>
                ))}
              </div>
            )}
          </div>
          )}

          {testTab === 'max' && (
          <div>
            <input
              type="text"
              value={form.test_max_ids_raw}
              onChange={set('test_max_ids_raw')}
              placeholder="123456789"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              ID профиля MAX. Тестовый аккаунт должен начать диалог с вашим MAX-ботом, иначе сообщение не уйдёт.
            </p>
            {form.test_max_ids_raw && (
              <div className="mt-2 flex flex-wrap gap-2">
                {form.test_max_ids_raw.split(/[,\s]+/).filter(Boolean).map((id: string) => (
                  <span key={id} className="text-xs bg-amber-50 text-amber-700 border border-amber-100 rounded-lg px-2 py-0.5 font-mono">
                    {id.trim()}
                  </span>
                ))}
              </div>
            )}
          </div>
          )}

          {testTab === 'email' && (
          <div>
            <input
              type="text"
              value={form.test_email_ids_raw}
              onChange={set('test_email_ids_raw')}
              placeholder="test@example.com, you@gmail.com"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              Адреса для тестовых email-рассылок (через запятую или пробел). Адрес должен быть в вашей
              базе контактов и подписан на email-канал — иначе письмо не отправится.
            </p>
            {form.test_email_ids_raw && (
              <div className="mt-2 flex flex-wrap gap-2">
                {form.test_email_ids_raw.split(/[,\s]+/).filter(Boolean).map((id: string) => (
                  <span key={id} className="text-xs bg-purple-50 text-purple-700 border border-purple-100 rounded-lg px-2 py-0.5 font-mono">
                    {id.trim()}
                  </span>
                ))}
              </div>
            )}
          </div>
          )}
          </div>
        </details>

        {/* Broadcast speed */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <Gauge size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800">Скорость рассылки</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Сколько сообщений отправлять в Telegram параллельно. Чем больше — тем быстрее
                уходит рассылка, но выше шанс что Telegram ограничит вас (Too Many Requests).
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={form.broadcast_concurrency}
              onChange={set('broadcast_concurrency')}
              className="w-28 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
            />
            <span className="text-sm text-gray-500">параллельных запросов</span>
          </div>
          <div className="mt-3 text-xs text-gray-500 space-y-0.5">
            <p>• <b>10–20</b> — медленно и безопасно (точно без флуда)</p>
            <p>• <b>30</b> — рекомендуем (быстро + почти без ограничений Telegram)</p>
            <p>• <b>50+</b> — рискованно: на больших базах появляются массовые «Too Many Requests»</p>
          </div>
        </div>

        {/* Длина регалий спикера (миграция 420). Раньше 1100 было жёстко
            зашито в код: клиенту, которому нужно иначе, поменять было нечем. */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <UserIcon size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800">Длина регалий спикера</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Сколько символов можно написать в регалиях — и вам в карточке
                человека, и самому спикеру в его кабинете. Решайте сами: на
                премии список достижений номинанта длиннее, чем на коротком
                эфире.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={200}
              max={6000}
              step={100}
              value={form.speaker_achievements_limit}
              onChange={set('speaker_achievements_limit')}
              placeholder="1100"
              className="w-28 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
            />
            <span className="text-sm text-gray-500">символов</span>
          </div>
          <div className="mt-3 text-xs text-gray-500 space-y-0.5">
            <p>• Оставьте пустым — будет <b>1100</b>, как сейчас.</p>
            <p>• Допустимо от <b>200</b> до <b>6000</b>.</p>
            <p>
              • Помните, ради чего ограничение: в карточке спикера и на лендинге
              место рассчитано на перечень, а не на абзац — в это поле вставляли
              целые лендинги.
            </p>
          </div>
        </div>

        {/* Timezone */}
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <Globe size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800">Часовой пояс</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Всё время в программе конференций и расписаниях будет отображаться в этом часовом поясе
              </p>
            </div>
          </div>
          <select value={form.timezone} onChange={set('timezone')}
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm bg-white">
            {TIMEZONES.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </div>

        {/* Хранилище переехало в свою вкладку «Файловое хранилище» —
            там же детализация по файлам и подключение своего хранилища.
            Здесь оставлена короткая строка со ссылкой, чтобы клиент,
            привыкший видеть объём в «Техническом», не решил, что раздел пропал. */}
        {storage && (
          <a href="/dashboard/settings?tab=storage"
            className="w-full bg-white rounded-2xl border card-border shadow-sm p-4 flex items-center gap-3 hover:border-gray-200 text-left">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <HardDrive size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-800 text-sm">Файловое хранилище</div>
              <div className="text-xs text-gray-500">
                Занято {storage.used_human} из {storage.quota_human} — открыть раздел
              </div>
            </div>
            <ChevronDown size={16} className="-rotate-90 text-gray-400 shrink-0" />
          </a>
        )}

        </>
        )}

        {error && <p className="text-sm text-red-500 text-center">{error}</p>}

        <button type="submit" disabled={saving}
          className={`btn-gold w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'opacity-70' : ''}`}>
          <Save size={16} />
          {saved ? 'Сохранено ✓' : saving ? 'Сохраняем...' : 'Сохранить изменения'}
        </button>
      </form>
      )}

      {showPasswordModal && (
        <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />
      )}
    </div>
  )
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext]       = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  const [done, setDone]       = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next.length < 8) { setError('Новый пароль должен быть не короче 8 символов'); return }
    if (next !== confirm) { setError('Пароли не совпадают'); return }
    setSaving(true)
    try {
      await api.auth.changePassword(current, next)
      setDone(true)
      setTimeout(onClose, 1500)
    } catch (e: any) {
      setError(e.message || 'Не удалось сменить пароль')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <form onSubmit={submit}
            className="bg-white rounded-2xl max-w-md w-full p-6"
            onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Сменить пароль</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        {done ? (
          <div className="text-center py-6">
            <CheckCircle2 className="mx-auto mb-3 text-green-500" size={40} />
            <p className="font-medium text-gray-900">Пароль изменён</p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Текущий пароль</label>
                <input type="password" value={current} onChange={e => setCurrent(e.target.value)}
                       autoComplete="current-password"
                       className="w-full px-4 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Новый пароль</label>
                <input type="password" value={next} onChange={e => setNext(e.target.value)}
                       autoComplete="new-password"
                       className="w-full px-4 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
                <p className="text-xs text-gray-400 mt-1">Минимум 8 символов</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Повторите новый пароль</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                       autoComplete="new-password"
                       className="w-full px-4 py-2.5 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
              </div>
            </div>

            {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

            <div className="flex gap-2 mt-5">
              <button type="button" onClick={onClose}
                      className="flex-1 px-4 py-2.5 rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-50">
                Отмена
              </button>
              <button type="submit" disabled={saving || !current || !next || !confirm}
                      className="flex-1 px-4 py-2.5 rounded-xl btn-gold disabled:opacity-50">
                {saving ? 'Меняем…' : 'Сменить'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

// ─── Таб «Интеграция» ─────────────────────────────────────────────────────────
function IntegrationTab() {
  const [me, setMe] = useState<{ id: number; integration_token?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showToken, setShowToken] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)
  const [copiedId, setCopiedId] = useState(false)
  const [regenLoading, setRegenLoading] = useState(false)
  const [showRegenConfirm, setShowRegenConfirm] = useState(false)
  const [error, setError] = useState('')

  // МедиаЛифт: карточка клиента в системе автоподписки (если связана) + лид-магнит.
  const [mlCard, setMlCard] = useState<any>(null)
  const [mlSaving, setMlSaving] = useState(false)

  useEffect(() => {
    api.auth.me()
      .then((c: any) => setMe(c))
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false))
    api.miniApp.medialift.myCard().then((r: any) => setMlCard(r)).catch(() => setMlCard(null))
  }, [])

  async function saveMlGift(lmId: number | null) {
    setMlSaving(true)
    try {
      await api.miniApp.medialift.setCardGift(lmId)
      setMlCard((c: any) => c ? { ...c, card: { ...c.card, gift_lead_magnet_id: lmId } } : c)
    } catch (e: any) { setError(e.message) } finally { setMlSaving(false) }
  }

  function copy(value: string, which: 'token' | 'id') {
    navigator.clipboard.writeText(value)
    if (which === 'token') { setCopiedToken(true); setTimeout(() => setCopiedToken(false), 1800) }
    else { setCopiedId(true); setTimeout(() => setCopiedId(false), 1800) }
  }

  async function regenerate() {
    setRegenLoading(true)
    setError('')
    try {
      const res = await api.auth.regenerateIntegrationToken()
      setMe(prev => prev ? { ...prev, integration_token: res.integration_token } : prev)
      setShowRegenConfirm(false)
      setShowToken(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRegenLoading(false)
    }
  }

  if (loading) return <div className="text-sm text-gray-500">Загружаем…</div>

  const token = me?.integration_token || ''
  const clientId = me?.id || 0

  return (
    <div className="space-y-6">
      {/* Автообзвоны — подключение Звонопса (миграция 359). Блок сам скрывается,
          если фичи calls нет: замок на пол-экрана рядом с другими интеграциями
          был бы шумом. */}
      <CallSettingsBlock />

      {/* МедиаЛифт — карточка клиента в системе автоподписки */}
      {mlCard && (
        <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-1">МедиаЛифт — ваша карточка</h3>
          {mlCard.linked ? (
            <>
              <p className="text-sm text-gray-500 mb-4">
                Ваша карточка в системе автоподписки связана с этим аккаунтом
                {mlCard.card?.name ? <> ({mlCard.card.name})</> : null}. Выберите лид-магнит —
                он будет показываться в карточке как подарок за подписку.
              </p>
              <label className="block text-sm font-medium text-gray-700 mb-1">Лид-магнит в карточке</label>
              <select
                value={mlCard.card?.gift_lead_magnet_id || 0}
                disabled={mlSaving}
                onChange={e => saveMlGift(Number(e.target.value) || null)}
                className="input max-w-md"
              >
                <option value={0}>— без подарка —</option>
                {(mlCard.lead_magnets || []).map((lm: any) => (
                  <option key={lm.id} value={lm.id}>{lm.name}</option>
                ))}
              </select>
              {(mlCard.lead_magnets || []).length === 0 && (
                <p className="text-xs text-amber-700 mt-2">
                  У вас пока нет лид-магнитов. Создайте их в разделе «Лид-магниты».
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-500">
              Ваша карточка в МедиаЛифте не связана с этим аккаунтом. Если вы добавляли
              свой канал в системе автоподписки через <b>@pluson_bot</b> — свяжите аккаунт
              командой <code>/pluson_connect</code> в боте, и здесь появится выбор лид-магнита.
            </p>
          )}
        </div>
      )}

      {/* Зачем нужна эта вкладка */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
            <Plug size={18} className="text-white" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800">API для конструкторов чат-ботов</h3>
            <p className="text-sm text-gray-500 mt-0.5 leading-snug">
              Эти данные нужны, чтобы Salebot, BotHelp, SendPulse, n8n или Make могли регистрировать
              участников в iViSiON: ПЛЮСОН, проверять подписки и доставать программу конференции.
              Полная инструкция со всеми эндпоинтами — на{' '}
              <Link href="/docs/api" target="_blank" className="text-blue-600 hover:underline inline-flex items-center gap-0.5">
                публичной странице API <ExternalLink size={12}/>
              </Link>{' '}
              (её можно дать стороннему разработчику).
            </p>
          </div>
        </div>
      </div>

      {/* Client ID */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-1">Ваш client_id</h3>
        <p className="text-sm text-gray-500 mb-3">
          Подставляется в каждый запрос. У каждого клиента он свой — <strong>не «1»</strong>, как в примерах.
        </p>
        <div className="flex gap-2">
          <code className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono text-gray-800">
            {clientId}
          </code>
          <button
            type="button"
            onClick={() => copy(String(clientId), 'id')}
            className="px-3 py-2.5 rounded-lg text-white font-medium text-sm flex items-center gap-1.5 flex-shrink-0"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            {copiedId ? <><Check size={14}/> Скопировано</> : <><Copy size={14}/> Копировать</>}
          </button>
        </div>
      </div>

      {/* Token */}
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <h3 className="font-semibold text-gray-800 mb-1">Секретный токен</h3>
        <p className="text-sm text-gray-500 mb-3">
          Передаётся в заголовке <code className="bg-gray-100 px-1 rounded">X-Salebot-Secret</code>{' '}
          (или параметром <code className="bg-gray-100 px-1 rounded">?secret=…</code>).
          Токен <strong>вечный</strong> — не истекает. Создан автоматически при регистрации кабинета.
        </p>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              readOnly
              className="w-full px-3 py-2.5 pr-10 border border-gray-200 rounded-lg bg-gray-50 text-sm font-mono text-gray-800"
            />
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
              tabIndex={-1}
            >
              {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => copy(token, 'token')}
            className="px-3 py-2.5 rounded-lg text-white font-medium text-sm flex items-center gap-1.5 flex-shrink-0"
            style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}
          >
            {copiedToken ? <><Check size={14}/> Скопировано</> : <><Copy size={14}/> Копировать</>}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900 mt-4">
          🔒 Никому не показывайте токен. Если попал в публичный сценарий Salebot или скриншот —
          сразу перевыпустите и обновите его в настройках бота.
        </div>

        {/* Перевыпуск */}
        <div className="mt-5 pt-5 border-t border-gray-100">
          {!showRegenConfirm ? (
            <button
              type="button"
              onClick={() => setShowRegenConfirm(true)}
              className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 inline-flex items-center gap-2"
            >
              <RefreshCw size={14} /> Перевыпустить токен
            </button>
          ) : (
            <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4">
              <p className="text-sm font-semibold text-red-800 mb-2">
                Старый токен сразу перестанет работать
              </p>
              <p className="text-sm text-red-700 mb-3">
                После перевыпуска все боты с этим токеном начнут получать ошибку 401,
                пока не подставите новый. Действительно перевыпустить?
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={regenerate}
                  disabled={regenLoading}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {regenLoading ? 'Создаём…' : 'Да, перевыпустить'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRegenConfirm(false)}
                  className="px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Отмена
                </button>
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      </div>
    </div>
  )
}


// ─── Блок «Регистрация партнёров» (миграция 105) ────────────────────────────
// Партнёрка живёт ТОЛЬКО в TG/VK/MAX. Email не показываем (нет интерактивности).
const PARTNER_PLATFORMS = ['telegram', 'vk', 'max']

function PartnerRegistrationBlock({
  form, set, clientId, availablePlatforms, botHandles, vkAppId, visibleRoles, setVisibleRoles,
}: {
  form: any
  set: (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void
  clientId: number | null
  availablePlatforms: string[]
  botHandles: { telegram?: string | null; vk?: string | null; max?: string | null } | null
  vkAppId: number | null
  visibleRoles: string[]
  setVisibleRoles: (v: string[]) => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  function copy(label: string, text: string) {
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  const isConfigured = !!(form.partner_landing_url || '').trim()
  // Только TG/VK/MAX, в порядке: TG, VK, MAX. Из подключённых платформ.
  const platforms = PARTNER_PLATFORMS.filter(p => (availablePlatforms || []).includes(p))
  // TG всегда показываем (fallback на @pluson_bot если своего бота нет)
  if (!platforms.includes('telegram')) platforms.unshift('telegram')

  const platformLabel: Record<string, string> = {
    telegram: 'Telegram',
    vk: 'VK',
    max: 'MAX',
  }

  // Прямая ссылка платформы — корневая (без рефовода)
  function rootUrlFor(p: string): string | null {
    if (!clientId) return null
    if (p === 'telegram') {
      // Только свой бот клиента (как VK/MAX ниже). Нет бота → ссылки нет,
      // системный @pluson_bot не подставляем (2026-07-08).
      const handle = (botHandles?.telegram || '').replace(/^@/, '')
      if (!handle) return null
      return `https://telegram.me/${handle}?start=prtc_${clientId}`
    }
    if (p === 'vk') {
      // Партнёрская корневая ссылка через VK Mini App клиента
      // (vk.com/app{aid}#prtc_<client_id>). Без своего VK Mini App не работает —
      // нужен токен сообщества для отправки в личку, а он есть только у клиентского VK канала.
      if (!vkAppId) return null
      return `https://vk.com/app${vkAppId}#prtc_${clientId}`
    }
    if (p === 'max') {
      const handle = (botHandles?.max || '').replace(/^@/, '')
      if (!handle) return null
      return `https://max.ru/${handle}?start=prtc_${clientId}`
    }
    return null
  }

  // Прямая ссылка возврата после сабмита формы
  function returnUrlFor(p: string): string | null {
    if (!clientId) return null
    if (p === 'telegram') {
      // Только свой бот клиента. Нет бота → ссылки возврата нет (2026-07-08).
      const handle = (botHandles?.telegram || '').replace(/^@/, '')
      if (!handle) return null
      return `https://telegram.me/${handle}?start=partner_done_${clientId}`
    }
    if (p === 'vk') {
      const handle = (botHandles?.vk || '').replace(/^@/, '')
      if (!handle) return null
      return `https://vk.me/${handle}?ref=partner_done_${clientId}`
    }
    if (p === 'max') {
      const handle = (botHandles?.max || '').replace(/^@/, '')
      if (!handle) return null
      return `https://max.ru/${handle}?start=partner_done_${clientId}`
    }
    return null
  }

  return (
    <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
          <UserPlus size={18} className="text-white" />
        </div>
        <div>
          <h3 className="font-semibold text-gray-800">Регистрация партнёров</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Сторонний партнёрский лендинг (GetCourse / Bizon360 / Tilda). Человек открывает
            одну из ваших ссылок ниже → попадает в бот → бот шлёт сообщение с кнопкой на
            форму, в URL уже подставлены ваш ID контакта и код того, кто привёл.
            После сабмита формы наш webhook обновит контакту его сторонний партнёрский код —
            он сам становится партнёром. Возврат через ссылку-возврата в боте: бот
            подтверждает регистрацию и присылает партнёрский код.
          </p>
        </div>
      </div>

      {/* URL стороннего лендинга */}
      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-700 mb-1">
          Ссылка на регистрацию партнёром
        </label>
        <input
          type="url"
          value={form.partner_landing_url}
          onChange={set('partner_landing_url')}
          placeholder="https://example.com/partner-form"
          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
        />
        <p className="text-xs text-gray-500 mt-1">
          Бот дополнит ваш URL параметрами: <span className="font-mono">?pluson_cid=&lt;id&gt;&amp;&lt;код_рефовода&gt;</span>.{' '}
          Настройте в форме скрытое поле <span className="font-mono">pluson_cid</span> и поля под ключи кода (например{' '}
          <span className="font-mono">gcpc</span>), чтобы они отправились в наш webhook.
        </p>
      </div>

      {/* URL кабинета партнёра (миграция 118) */}
      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-700 mb-1">
          Кабинет партнёра / отслеживание оплат
        </label>
        <input
          type="url"
          value={form.partner_dashboard_url}
          onChange={set('partner_dashboard_url')}
          placeholder="https://example.com/affiliate/login"
          className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
        />
        <p className="text-xs text-gray-500 mt-1">
          Страница входа в аффилиат-кабинет вашей внешней системы (GetCourse / Bizon360 /
          Tilda). Если задана — в кабинете спикера у тех, кто уже зарегистрирован
          партнёром, появится кнопка «Открыть кабинет партнёра» вместо ссылок на регистрацию.
        </p>
      </div>

      {/* Кому показывать партнёрский блок (миграция 148) */}
      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-700 mb-2">
          Кому показывать в кабинете ссылки регистрации партнёром и отслеживания оплат
        </label>
        <div className="flex flex-wrap gap-2">
          {([
            { k: 'jury', l: 'Жюри' },
            { k: 'speaker', l: 'Спикеры' },
            { k: 'participant', l: 'Участники' },
            { k: 'organizer', l: 'Организаторы' },
            { k: 'partner', l: 'Партнёры' },
          ]).map(r => {
            const on = visibleRoles.includes(r.k)
            return (
              <button
                key={r.k}
                type="button"
                onClick={() => setVisibleRoles(on ? visibleRoles.filter(x => x !== r.k) : [...visibleRoles, r.k])}
                className={`px-3 py-2 rounded-xl text-sm font-medium border transition ${
                  on ? 'bg-brand text-white border-brand' : 'bg-white text-gray-600 border-gray-200'
                }`}
              >
                {on ? '✓ ' : ''}{r.l}
              </button>
            )
          })}
        </div>
        <p className="text-xs text-gray-500 mt-1.5">
          «Спикеры» включает хедлайнеров, «Партнёры» — генеральных партнёров.
          Если ничего не выбрано — блок не показывается никому.
        </p>
      </div>

      {/* Ссылки возврата (по платформам) */}
      <div className="mb-4">
        <label className="block text-xs font-semibold text-gray-700 mb-2">
          Ссылки возврата (вставьте в редирект после сабмита формы)
        </label>
        <div className="space-y-2">
          {platforms.map((p) => {
            const url = returnUrlFor(p)
            const disabled = !isConfigured || !url
            return (
              <div key={`ret-${p}`} className="flex gap-2 items-center">
                <span className="w-20 shrink-0 text-xs font-semibold text-gray-500">{platformLabel[p] || p}</span>
                <input
                  type="text"
                  value={isConfigured && url ? url : ''}
                  readOnly
                  placeholder={!url ? '— у вас не подключён канал этой платформы' : (!isConfigured ? '— настройте URL выше' : '')}
                  className={`flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono ${
                    disabled ? 'bg-gray-100 text-gray-400' : 'bg-gray-50 text-gray-700'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => url && copy(`ret-${p}`, url)}
                  disabled={disabled}
                  className="px-2.5 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Скопировать"
                >
                  {copied === `ret-${p}` ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                </button>
              </div>
            )
          })}
        </div>
        {isConfigured && (
          <div className="mt-2">
            <CopyAllLinksButton
              links={Object.fromEntries(
                platforms.map((p) => [p, returnUrlFor(p) || '']),
              ) as PlatformLinksType}
            />
          </div>
        )}
        <p className="text-xs text-gray-500 mt-2">
          Выберите одну из ссылок (по платформе, через которую вы привлекаете партнёров)
          и вставьте её в настройку «редирект после сабмита формы» вашего партнёрского сервиса —
          как есть, без подстановок. Когда человек заполнит форму, его кинет в этот бот,
          и бот пришлёт ему «Вы зарегистрированы. Ваш код: XXX».
        </p>
      </div>

      {/* Платформенные корневые ссылки — прямые на TG/VK/MAX */}
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-2">
          Корневые ссылки (для распространения)
        </label>
        <div className="space-y-2">
          {platforms.map((p) => {
            const url = rootUrlFor(p)
            const disabled = !isConfigured || !url
            return (
              <div key={`root-${p}`} className="flex gap-2 items-center">
                <span className="w-20 shrink-0 text-xs font-semibold text-gray-500">{platformLabel[p] || p}</span>
                <input
                  type="text"
                  value={isConfigured && url ? url : ''}
                  readOnly
                  placeholder={!url ? '— у вас не подключён канал этой платформы' : (!isConfigured ? '— настройте URL выше' : '')}
                  className={`flex-1 min-w-0 px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono ${
                    disabled ? 'bg-gray-100 text-gray-400' : 'bg-gray-50 text-gray-700'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => url && copy(`root-${p}`, url)}
                  disabled={disabled}
                  className="px-2.5 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Скопировать"
                >
                  {copied === `root-${p}` ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                </button>
              </div>
            )
          })}
        </div>
        {isConfigured && (
          <div className="mt-2">
            <CopyAllLinksButton
              links={Object.fromEntries(
                platforms.map((p) => [p, rootUrlFor(p) || '']),
              ) as PlatformLinksType}
            />
          </div>
        )}
        <p className="text-xs text-gray-500 mt-2">
          Это «безымянные» ссылки — без указания, кто привёл нового партнёра. Личные ссылки
          каждого партнёра (с проброшенным кодом-партнёра) находятся в карточке контакта внизу.
        </p>
      </div>
    </div>
  )
}
