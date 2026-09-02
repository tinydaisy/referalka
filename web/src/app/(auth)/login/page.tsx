'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'
import AuthAside from '@/components/auth/AuthAside'

/** Кабинет, в который помощнику открыт доступ. */
interface CabinetChoice {
  id: number
  brand_name: string
  owner_name: string
  access_level: 'full' | 'limited'
}

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Реф-код пригласившего. Если человек попал на /login?pid=… и нажал
  // «Зарегистрироваться» — код не должен потеряться: сохраняем в localStorage
  // и подставляем в ссылку регистрации. Пробрасываем как есть (валидация —
  // на лендинге/register); тут только не теряем.
  const [referrerPid, setReferrerPid] = useState<string | null>(null)
  // Помощник кабинета может вести несколько кабинетов (миграция 209): сервер
  // отдаёт список, человек выбирает, куда войти. Один кабинет — заходит сразу.
  const [cabinets, setCabinets] = useState<CabinetChoice[] | null>(null)

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('pid')
    if (fromUrl) localStorage.setItem('pluson_referrer_pid', fromUrl)
    setReferrerPid(fromUrl || localStorage.getItem('pluson_referrer_pid'))
  }, [])

  const registerHref = referrerPid
    ? `/register?pid=${encodeURIComponent(referrerPid)}`
    : '/register'

  /** Кладём пропуск и уходим в кабинет (или в админку). */
  function enter(res: any) {
    localStorage.setItem('plusson_token', res.access_token)
    document.cookie = `plusson_token=${res.access_token}; path=/; max-age=604800; SameSite=Lax`
    const payload = JSON.parse(atob(res.access_token.split('.')[1]))
    // Через корень /dashboard — он сам решит: нет своего бота → «Каналы»
    // (с плашкой «Подключите хотя бы 1 бот»), иначе → «Мероприятия».
    window.location.href = payload.role === 'admin' ? '/admin' : '/dashboard'
  }

  async function doLogin(clientId?: number) {
    setLoading(true)
    setError('')
    try {
      const res = await api.auth.login(
        clientId ? { email, password, client_id: clientId } : { email, password }
      )
      // Помощник ведёт несколько кабинетов — сервер просит выбрать, куда войти.
      if (res.choose_client) {
        setCabinets(res.clients || [])
        return
      }
      enter(res)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await doLogin()
  }

  return (
    <div className="min-h-screen flex">
      <AuthAside />

      {/* Right */}
      <div className="w-full lg:w-1/2 flex items-center justify-center px-6 py-12 bg-white">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8 text-center">
            <span className="text-2xl font-bold" style={{ color: '#25455D' }}>iViSiON: ПЛЮСОН</span>
          </div>

          {cabinets ? (
            <>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Куда войти?</h2>
              <p className="text-gray-500 mb-8">
                Вам открыт доступ помощника в несколько кабинетов. Выберите нужный.
              </p>

              {error && (
                <div className="p-3 mb-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-3">
                {cabinets.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={loading}
                    onClick={() => doLogin(c.id)}
                    className="w-full text-left px-5 py-4 rounded-xl border border-gray-200 hover:border-[#25455D] hover:bg-gray-50 transition-colors disabled:opacity-60"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate">{c.brand_name}</div>
                        <div className="text-sm text-gray-500 truncate">{c.owner_name}</div>
                      </div>
                      <span className="text-xs text-gray-400 shrink-0">
                        {c.access_level === 'full' ? 'полный доступ' : 'ограниченный'}
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => { setCabinets(null); setError('') }}
                className="mt-6 text-sm text-gray-500 hover:text-gray-800"
              >
                ← Войти другой почтой
              </button>
            </>
          ) : (
          <>
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

            <div className="text-right">
              <Link href="/password-reset" className="text-sm hover:underline" style={{ color: '#25455D' }}>
                Забыли пароль?
              </Link>
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
            <Link href={registerHref} className="font-medium hover:underline" style={{ color: '#25455D' }}>
              Зарегистрироваться
            </Link>
          </p>
          </>
          )}
        </div>
      </div>
    </div>
  )
}
