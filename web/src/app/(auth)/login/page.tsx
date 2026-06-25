'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await api.auth.login({ email, password })
      localStorage.setItem('plusson_token', res.access_token)
      document.cookie = `plusson_token=${res.access_token}; path=/; max-age=604800; SameSite=Lax`

      // Определяем роль из JWT токена
      const payload = JSON.parse(atob(res.access_token.split('.')[1]))
      const role = payload.role

      // Редиректим в зависимости от роли
      if (role === 'admin') {
        window.location.href = '/admin'
      } else {
        window.location.href = '/dashboard/events'
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left */}
      <div className="hidden lg:flex lg:w-1/2 gradient-bg flex-col justify-center px-16 py-12">
        <img src="/images/logo_no_ivision_wwhite.png" alt="iViSiON: ПЛЮСОН"
          className="auth-logo mb-8"
          width={147} height={120}
          onError={e => { (e.target as any).style.display = 'none' }} />
        <h1 className="text-white text-3xl font-bold leading-tight">
          Добро пожаловать<br />в iViSiON: ПЛЮСОН
        </h1>
        <p className="text-white/70 mt-4 text-lg">
          Платформа для организаторов и экспертов: управляйте событием от А до Я — спикеры, рассылки, рефералы в одном месте
        </p>
        <div className="mt-10 p-5 rounded-2xl bg-white/10 border border-white/20">
          <p className="text-white/80 text-sm italic">
            «Участники приглашают друзей, вы видите каждый шаг, подарки начисляются автоматически.»
          </p>
        </div>
      </div>

      {/* Right */}
      <div className="w-full lg:w-1/2 flex items-center justify-center px-6 py-12 bg-white">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8 text-center">
            <span className="text-2xl font-bold" style={{ color: '#25455D' }}>iViSiON: ПЛЮСОН</span>
          </div>

          <h2 className="text-2xl font-bold text-gray-900 mb-2">Войдите в кабинет</h2>
          <p className="text-gray-500 mb-8">Управляйте событиями и аналитикой</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)} required
                placeholder="you@example.com"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Пароль</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  placeholder="Ваш пароль"
                  className="w-full px-4 py-3 pr-10 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button
              type="submit" disabled={loading}
              className="btn-gold w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
            >
              {loading ? 'Входим...' : <>Войти <ArrowRight size={16} /></>}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-gray-500">
            Нет аккаунта?{' '}
            <Link href="/register" className="font-medium hover:underline" style={{ color: '#25455D' }}>
              Зарегистрироваться
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
