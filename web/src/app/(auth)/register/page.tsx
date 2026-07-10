'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CheckCircle, ArrowRight, Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'

export default function RegisterPage() {
  const [form, setForm] = useState({
    name: '', email: '', phone: '', telegram_username: '', password: '', confirm: '', partner_code: ''
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [referrerPid, setReferrerPid] = useState<string | null>(null)
  // МедиаЛифт: id платформы из воронки → авто-связка карточки коллаба с новым аккаунтом.
  const [mlIds, setMlIds] = useState<{ tg?: string; vk?: string; max?: string }>({})

  useEffect(() => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search)
    const fromUrl = q.get('pid')
    if (fromUrl) localStorage.setItem('pluson_referrer_pid', fromUrl)
    setReferrerPid(fromUrl || localStorage.getItem('pluson_referrer_pid'))
    setMlIds({ tg: q.get('ml_tg_id') || undefined, vk: q.get('ml_vk_id') || undefined, max: q.get('ml_max_id') || undefined })
  }, [])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (form.password !== form.confirm) {
      setError('Пароли не совпадают')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.auth.register({
        name: form.name, email: form.email, phone: form.phone || undefined,
        telegram_username: form.telegram_username || undefined,
        password: form.password, partner_code: form.partner_code || undefined,
        pid: referrerPid || undefined,  // реф-код пригласившего (миграция 125)
        ml_tg_id: mlIds.tg, ml_vk_id: mlIds.vk, ml_max_id: mlIds.max,  // МедиаЛифт autolink
      })
      localStorage.setItem('plusson_token', res.access_token)
      localStorage.removeItem('pluson_referrer_pid')  // pid использован
      // Через корень /dashboard — нет своего бота → «Каналы» (с плашкой), иначе → события
      window.location.href = '/dashboard'
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left — gradient */}
      <div className="hidden lg:flex lg:w-1/2 gradient-bg flex-col justify-center px-16 py-12">
        <div className="mb-8">
          <img src="/images/logo_no_ivision_wwhite.png" alt="iViSiON: ПЛЮСОН"
            className="auth-logo mb-2"
            width={147} height={120}
            onError={e => { (e.target as any).style.display='none' }} />
          <h1 className="text-white text-3xl font-bold mt-6 leading-tight">
            Запустите реферальную<br />программу за 15 минут
          </h1>
          <p className="text-white/70 mt-3 text-lg">Платформа управляемого вирального роста</p>
        </div>

        <div className="space-y-5">
          {[
            'Участники приглашают друзей автоматически',
            'Вы видите каждый шаг в аналитике',
            'Подарки начисляются без вашего участия',
          ].map(item => (
            <div key={item} className="flex items-center gap-3">
              <CheckCircle className="text-gold shrink-0" size={20} style={{ color: '#FFCFA4' }} />
              <span className="text-white/90">{item}</span>
            </div>
          ))}
        </div>

      </div>

      {/* Right — form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center px-6 py-12 bg-white">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8 text-center">
            <span className="text-2xl font-bold" style={{ color: '#25455D' }}>iViSiON: ПЛЮСОН</span>
          </div>

          <h2 className="text-2xl font-bold text-gray-900 mb-2">Создайте аккаунт</h2>
          {referrerPid && (
            <p className="mb-6 text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 px-3 py-2 rounded-lg">
              🎁 Вас пригласили по реф-коду <b>{referrerPid}</b>
            </p>
          )}
          {!referrerPid && <div className="mb-6" />}

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Имя *</label>
              <input
                type="text" value={form.name} onChange={set('name')} required
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
              <input
                type="email" value={form.email} onChange={set('email')} required
                placeholder="you@example.com"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Телефон</label>
                <input
                  type="tel" value={form.phone} onChange={set('phone')}
                  placeholder="+7 999 000-00-00"
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Telegram</label>
                <input
                  type="text" value={form.telegram_username} onChange={set('telegram_username')}
                  placeholder="@username"
                  className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Пароль *</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'} value={form.password} onChange={set('password')} required
                  placeholder="Минимум 8 символов"
                  className="w-full px-4 py-3 pr-11 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
                />
                <button type="button" onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Повторите пароль *</label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'} value={form.confirm} onChange={set('confirm')} required
                  placeholder="Повторите пароль"
                  className="w-full px-4 py-3 pr-11 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
                />
                <button type="button" onClick={() => setShowConfirm(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1} aria-label={showConfirm ? 'Скрыть пароль' : 'Показать пароль'}>
                  {showConfirm ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button
              type="submit" disabled={loading}
              className="btn-gold w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
            >
              {loading ? 'Регистрируем...' : <>Зарегистрироваться <ArrowRight size={16} /></>}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            Уже есть аккаунт?{' '}
            <Link href="/login" className="font-medium hover:underline" style={{ color: '#25455D' }}>
              Войти
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
