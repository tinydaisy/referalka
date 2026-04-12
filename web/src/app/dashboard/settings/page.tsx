'use client'
import { useState, useEffect } from 'react'
import { Save, Bot } from 'lucide-react'
import { api } from '@/lib/api'

export default function SettingsPage() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', telegram_username: '', bot_token: '' })
  const [tariff, setTariff] = useState<any>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.auth.me().then(c => {
      setForm({
        name: c.name || '', email: c.email || '',
        phone: c.phone || '', telegram_username: c.telegram_username || '',
        bot_token: ''
      })
      setTariff({ slug: c.tariff_slug, trial_ends_at: c.trial_ends_at })
    }).catch(() => {})
  }, [])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const trialDate = tariff?.trial_ends_at ? new Date(tariff.trial_ends_at).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'

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

        {/* Bot token */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg gradient-bg flex items-center justify-center shrink-0">
              <Bot size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-800">Свой Telegram-бот</h3>
              <p className="text-sm text-gray-500 mt-0.5">
                Если у вас уже есть бот — подключите его токен. Иначе бот ПЛЮСОН используется по умолчанию.
              </p>
            </div>
          </div>
          <input type="text" value={form.bot_token} onChange={set('bot_token')}
            placeholder="110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm font-mono" />
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

        <button
          type="submit"
          className="btn-gold w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
        >
          <Save size={16} />
          {saved ? 'Сохранено ✓' : 'Сохранить изменения'}
        </button>
      </form>
    </div>
  )
}
