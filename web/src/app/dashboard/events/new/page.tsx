'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight, Zap, Calendar, Radio } from 'lucide-react'
import { api } from '@/lib/api'

const MODULES = [
  {
    slug: 'base',
    label: 'Базовый',
    desc: 'Только реферальная игра [Игра]',
    icon: Zap,
  },
  {
    slug: 'conference',
    label: 'Конференция',
    desc: '[Программа] [Розыгрыш] [Услуги] + [Игра]',
    icon: Calendar,
  },
  {
    slug: 'webinar',
    label: 'Вебинар',
    desc: '[Программа] [Запись] + [Игра]',
    icon: Radio,
  },
]

export default function NewEventPage() {
  const router = useRouter()
  const [form, setForm] = useState({
    title: '', description: '', landing_url: '',
    module_slug: 'base', require_subscription: false, channel_username: ''
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleNext(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await api.events.create({
        title: form.title,
        description: form.description || undefined,
        landing_url: form.landing_url || undefined,
        module_slug: form.module_slug,
        require_subscription: form.require_subscription,
      })
      router.push(`/dashboard/events/new/gifts?event_id=${res.event.id}`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl">
      {/* Progress */}
      <div className="flex items-center gap-3 mb-8">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full gradient-bg flex items-center justify-center text-white text-xs font-bold">1</div>
          <span className="text-sm font-medium text-gray-900">Основное</span>
        </div>
        <div className="flex-1 h-px bg-gray-200" />
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full border-2 border-gray-200 flex items-center justify-center text-gray-400 text-xs font-bold">2</div>
          <span className="text-sm text-gray-400">Подарки</span>
        </div>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-6">Новое событие</h1>

      <form onSubmit={handleNext} className="space-y-6">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Название события *</label>
          <input
            type="text" value={form.title} onChange={set('title')} required
            placeholder="Например: Конференция iVision 7"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Описание</label>
          <textarea
            value={form.description} onChange={set('description') as any}
            rows={3} placeholder="Расскажите о событии"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm resize-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            URL лендинга
            <span className="text-gray-400 font-normal ml-1">— куда ведёт реферальная ссылка</span>
          </label>
          <input
            type="url" value={form.landing_url} onChange={set('landing_url')}
            placeholder="https://example.com/registration"
            className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
          />
        </div>

        {/* Module selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-3">Модуль</label>
          <div className="space-y-3">
            {MODULES.map(({ slug, label, desc, icon: Icon }) => (
              <label
                key={slug}
                className={`flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${
                  form.module_slug === slug
                    ? 'border-brand bg-brand/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="radio" name="module" value={slug}
                  checked={form.module_slug === slug}
                  onChange={() => setForm(f => ({ ...f, module_slug: slug }))}
                  className="hidden"
                />
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                  form.module_slug === slug ? 'gradient-bg' : 'bg-gray-100'
                }`}>
                  <Icon size={18} className={form.module_slug === slug ? 'text-white' : 'text-gray-500'} />
                </div>
                <div>
                  <p className="font-medium text-gray-900 text-sm">{label}</p>
                  <p className="text-gray-500 text-xs mt-0.5">{desc}</p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Subscription toggle */}
        <div className="flex items-start gap-4 p-4 bg-gray-50 rounded-xl">
          <div className="mt-0.5">
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, require_subscription: !f.require_subscription }))}
              className={`w-11 h-6 rounded-full transition-colors flex items-center px-0.5 ${
                form.require_subscription ? 'bg-brand' : 'bg-gray-300'
              }`}
              style={{ background: form.require_subscription ? '#25455D' : undefined }}
            >
              <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${
                form.require_subscription ? 'translate-x-5' : 'translate-x-0'
              }`} />
            </button>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-700">Требовать подписку на канал</p>
            <p className="text-xs text-gray-400 mt-0.5">Участник должен подписаться перед доступом к игре</p>
          </div>
        </div>

        {form.require_subscription && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Username Telegram-канала</label>
            <input
              type="text" value={form.channel_username}
              onChange={set('channel_username')}
              placeholder="@mychannel или -100123456789"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
            />
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Link href="/dashboard" className="px-5 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">
            Отмена
          </Link>
          <button
            type="submit" disabled={loading}
            className="btn-gold flex-1 py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
          >
            {loading ? 'Создаём...' : <>Далее: настройка подарков <ArrowRight size={16} /></>}
          </button>
        </div>
      </form>
    </div>
  )
}
