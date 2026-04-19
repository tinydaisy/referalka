'use client'
import { useState, useEffect } from 'react'
import { Save, Bot, Globe } from 'lucide-react'
import { api } from '@/lib/api'
import { setTimezone } from '@/lib/timezone'

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
  const [form, setForm] = useState({ name: '', email: '', phone: '', telegram_username: '', timezone: 'Europe/Moscow' })
  const [tariff, setTariff] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

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
      })
      setTariff({ slug: c.tariff_slug, trial_ends_at: c.trial_ends_at })
    }).catch(() => {})
  }, [])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api.auth.updateMe({
        name: form.name,
        phone: form.phone,
        telegram_username: form.telegram_username,
        timezone: form.timezone,
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

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Настройки</h1>

      <form onSubmit={handleSave} className="space-y-6">
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

        {/* Tariff */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Подписка</h3>
          <div className="flex items-center justify-between p-4 bg-green-50 rounded-xl mb-4">
            <div>
              <p className="font-medium text-green-800">Бесплатный (Beta)</p>
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
          </div>
        </div>

        {error && <p className="text-sm text-red-500 text-center">{error}</p>}

        <button type="submit" disabled={saving}
          className={`btn-gold w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'opacity-70' : ''}`}>
          <Save size={16} />
          {saved ? 'Сохранено ✓' : saving ? 'Сохраняем...' : 'Сохранить изменения'}
        </button>
      </form>
    </div>
  )
}
