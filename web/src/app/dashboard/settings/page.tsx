'use client'
import { useState, useEffect } from 'react'
import { Save, Bot, Globe, Eye, EyeOff, FlaskConical, UserCheck, Gauge, HardDrive, Lock, X, CheckCircle2, User as UserIcon, Wrench, Smartphone, CreditCard, Plug, Copy, Check, RefreshCw, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { api } from '@/lib/api'
import { setTimezone } from '@/lib/timezone'
import { useLang, type Lang } from '@/contexts/LangContext'
import MiniAppSettingsPage from '../mini-app/page'

type Tab = 'profile' | 'tech' | 'integration' | 'mini-app' | 'subscription'

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

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'profile'
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null
    return (t === 'tech' || t === 'integration' || t === 'mini-app' || t === 'subscription') ? t : 'profile'
  })
  const [form, setForm] = useState({ name: '', email: '', phone: '', telegram_username: '', timezone: 'Europe/Moscow', bot_token: '', test_telegram_ids_raw: '', work_tg_username: '', work_tg_id: '', broadcast_concurrency: '30' })
  const [tariff, setTariff] = useState<any>(null)
  const [storage, setStorage] = useState<{ used_bytes: number; quota_bytes: number; used_human: string; quota_human: string; used_percent: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const { lang, setLang, t } = useLang()

  useEffect(() => {
    api.auth.me().then(c => {
      const tz = c.timezone || 'Europe/Moscow'
      setTimezone(tz)
      setForm({
        name: c.name || '',
        email: c.email || '',
        phone: c.phone || '',
        telegram_username: c.telegram_username || '',
        timezone: tz,
        bot_token: c.bot_token || '',
        test_telegram_ids_raw: (c.test_telegram_ids || []).join(', '),
        work_tg_username: c.work_tg_username || '',
        work_tg_id: c.work_tg_id ? String(c.work_tg_id) : '',
        broadcast_concurrency: c.broadcast_concurrency ? String(c.broadcast_concurrency) : '30',
      })
      setTariff({ slug: c.tariff_slug, trial_ends_at: c.trial_ends_at })
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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      const testIds = form.test_telegram_ids_raw
        .split(/[,\s]+/)
        .map((s: string) => s.trim())
        .filter(Boolean)
      const concurrency = Math.max(1, Math.min(100, Number(form.broadcast_concurrency) || 30))
      await api.auth.updateMe({
        name: form.name,
        phone: form.phone,
        telegram_username: form.telegram_username,
        timezone: form.timezone,
        bot_token: form.bot_token || null,
        test_telegram_ids: testIds,
        work_tg_username: form.work_tg_username || null,
        work_tg_id: form.work_tg_id ? Number(form.work_tg_id) : null,
        broadcast_concurrency: concurrency,
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

  const trialDate = tariff?.trial_ends_at
    ? new Date(tariff.trial_ends_at).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })
    : '—'

  const TABS: { id: Tab; label: string; icon: any }[] = [
    { id: 'profile',      label: 'Профиль',      icon: UserIcon  },
    { id: 'tech',         label: 'Техническое',  icon: Wrench    },
    { id: 'integration',  label: 'Интеграция',   icon: Plug      },
    { id: 'mini-app',     label: 'Mini App',     icon: Smartphone},
    { id: 'subscription', label: 'Подписка',     icon: CreditCard},
  ]

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Настройки</h1>

      {/* Табы */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 overflow-x-auto">
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
      {tab === 'mini-app' && <MiniAppSettingsPage />}

      {/* Интеграция — токен для чат-ботов */}
      {tab === 'integration' && <IntegrationTab />}

      {/* Подписка — отдельный блок */}
      {tab === 'subscription' && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Подписка</h3>
          <div className="flex items-center justify-between p-4 bg-green-50 rounded-xl mb-4">
            <div>
              <p className="font-medium text-green-800">
                {tariff?.slug === 'vip' ? 'VIP' : 'Бесплатный (Beta)'}
              </p>
              <p className="text-sm text-green-700 mt-0.5">Действует до: {trialDate}</p>
            </div>
            <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">Активен</span>
          </div>
          <div className="space-y-2 text-sm text-gray-600">
            <div className="flex items-center gap-2">
              <span className="text-green-500">✓</span> Неограниченное количество событий
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500">✓</span> Все модули открыты
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500">✓</span> Безлимитные участники
            </div>
            {tariff?.slug === 'vip' && (
              <div className="flex items-center gap-2">
                <span className="text-green-500">✓</span> Свой брендовый бот в Telegram
              </div>
            )}
          </div>
        </div>
      )}

      {/* Профиль и Техническое — общая форма с одной кнопкой Сохранить */}
      {(tab === 'profile' || tab === 'tech') && (
      <form onSubmit={handleSave} className="space-y-6">

        {tab === 'profile' && (
        <>
        {/* Profile */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-5">Профиль</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Имя</label>
              <input type="text" value={form.name} onChange={set('name')}
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" value={form.email} readOnly
                className="w-full px-4 py-3 border border-gray-100 rounded-xl bg-gray-50 text-sm text-gray-500 cursor-not-allowed" />
              <p className="text-xs text-gray-400 mt-1">Email изменить нельзя</p>
            </div>
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

        {/* Security — change password (в Профиле) */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <Lock size={18} className="text-white" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-800">Безопасность</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Пароль для входа в кабинет ПЛЮСОН.
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

        {/* Язык интерфейса (в Профиле) */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
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
        </>
        )}

        {tab === 'tech' && (
        <>

        {/* Bot Token */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <Bot size={18} className="text-white" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-gray-800">Telegram Bot Token</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Токен вашего бота из BotFather. Используется для рассылок и отправки программы конференции.
                Нажмите на «глаз» чтобы посмотреть текущий токен.
              </p>
            </div>
          </div>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={form.bot_token}
              onChange={set('bot_token')}
              placeholder="1234567890:AAF..."
              autoComplete="new-password"
              data-lpignore="true"
              data-1p-ignore
              data-form-type="other"
              name="bot_api_key"
              spellCheck={false}
              className="w-full px-4 py-3 pr-12 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
            />
            <button
              type="button"
              onClick={() => setShowToken(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              tabIndex={-1}
            >
              {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">Получить токен можно в <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">@BotFather</a>. Если бэкенд скажет «не похоже на токен» — Chrome autofill подсунул пароль; очистите поле и вставьте токен из BotFather.</p>
        </div>

        {/* Test Telegram IDs */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <FlaskConical size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800">Тестовые рассылки</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Telegram ID аккаунтов для тестовых рассылок. Укажите через запятую.
              </p>
            </div>
          </div>
          <input
            type="text"
            value={form.test_telegram_ids_raw}
            onChange={set('test_telegram_ids_raw')}
            placeholder="8018913774, 7879070738, 5725111966"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
          />
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

        {/* Broadcast speed */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
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

        {/* Work Account */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <UserCheck size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800">Рабочий аккаунт</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Telegram-аккаунт для тестовой проверки подписки на каналы спикеров.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Никнейм</label>
              <input
                type="text"
                value={form.work_tg_username}
                onChange={set('work_tg_username')}
                placeholder="@username"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ID аккаунта</label>
              <input
                type="text"
                value={form.work_tg_id}
                onChange={set('work_tg_id')}
                placeholder="123456789"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono"
              />
            </div>
          </div>
        </div>

        {/* Timezone */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
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

        {/* Storage usage */}
        {storage && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
                <HardDrive size={18} className="text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-800">Файловое хранилище</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Афиши, лид-магниты, сертификаты и фото — всё хранится в общем месте клиента.
                </p>
              </div>
            </div>
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-sm text-gray-700">
                <span className="font-semibold">{storage.used_human}</span>
                <span className="text-gray-400"> из {storage.quota_human}</span>
              </div>
              <div className={`text-sm font-medium ${
                storage.used_percent >= 90 ? 'text-red-600' :
                storage.used_percent >= 70 ? 'text-amber-600' : 'text-gray-500'
              }`}>
                {storage.used_percent}%
              </div>
            </div>
            <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${
                storage.used_percent >= 90 ? 'bg-red-500' :
                storage.used_percent >= 70 ? 'bg-amber-500' : 'gradient-bg'
              }`}
                style={{ width: `${Math.min(100, storage.used_percent)}%` }} />
            </div>
            {storage.used_percent >= 90 && (
              <p className="text-xs text-red-600 mt-2">
                Хранилище почти заполнено. Удалите ненужные файлы или увеличьте квоту в тарифе.
              </p>
            )}
          </div>
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
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
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

  useEffect(() => {
    api.auth.me()
      .then((c: any) => setMe(c))
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

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
      {/* Зачем нужна эта вкладка */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
            <Plug size={18} className="text-white" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800">API для конструкторов чат-ботов</h3>
            <p className="text-sm text-gray-500 mt-0.5 leading-snug">
              Эти данные нужны, чтобы Salebot, BotHelp, SendPulse, n8n или Make могли регистрировать
              участников в ПЛЮСОН, проверять подписки и доставать программу конференции.
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
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
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
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
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
