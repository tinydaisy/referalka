'use client'

/**
 * Вход внедренца.
 *
 * ⚠️⚠️ ПАРОЛЬ ЗДЕСЬ КЛИЕНТСКИЙ (миграция 486): внедренец — РОЛЬ клиента, а не
 * отдельный человек. Третьего пароля в системе больше нет.
 *
 * ⚠️ Ходит в СВОЮ ручку `/auth/tech/login`, а не в общий `/login`. Куда пускать
 * человека, решает форма: у него один пароль на обе роли, и общий логин с
 * перебором ролей «до первого совпадения» всегда отдавал бы ту роль, что стоит
 * в списке выше. Именно поэтому раньше приходилось заводить почты-алиасы.
 *
 * ⚠️ Восстановление пароля здесь НЕ нужно отдельно: пароль клиентский, значит
 * восстанавливается обычным способом на /login → «Забыли пароль?». Раньше на
 * этом месте стоял текст «пароль выдаёт владелец» — он больше не верен.
 */
import { useState } from 'react'
import { Eye, EyeOff, ArrowRight } from 'lucide-react'
import { api } from '@/lib/api'

export default function TechLoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res: any = await api.auth.techLogin({ email, password })
      if (!res?.tech) {
        setError('Этот вход только для внедренцев. Кабинет клиента — на pluson.ru/login')
        return
      }
      localStorage.setItem('plusson_token', res.access_token)
      // Cookie нужен middleware Next: без него он не отличит вошедшего.
      document.cookie = `plusson_token=${res.access_token}; path=/; max-age=604800; SameSite=Lax`
      // ⚠️ Полная перезагрузка, а не router.replace: кабинет читает токен при
      // старте, и мягкий переход иногда отрабатывает раньше записи куки.
      window.location.href = '/tech'
    } catch (e: any) {
      setError(e?.message || 'Неверная почта или пароль')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Левая половина — как на входе админа: тот же логотип и тот же фон,
          иначе служебные входы выглядят страницами разных продуктов. */}
      <div className="hidden lg:flex lg:w-1/2 flex-col justify-center px-16 py-12"
           style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/logo_no_ivision_wwhite.png" alt="iViSiON: ПЛЮСОН"
             className="auth-logo mb-8" width={147} height={120}
             onError={e => { (e.target as any).style.display = 'none' }} />
        <h1 className="text-white text-3xl font-bold leading-tight">
          Кабинет внедренца<br />iViSiON: ПЛЮСОН
        </h1>
        <p className="text-white/70 mt-4 text-lg">
          Ваши клиенты, обращения и начисления — в одном месте
        </p>
      </div>

      {/* Правая половина — форма */}
      <div className="w-full lg:w-1/2 flex items-center justify-center px-6 py-12 bg-white">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8 flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/logo_no_ivision_blue.png" alt="iViSiON: ПЛЮСОН"
                 className="h-16 w-auto"
                 onError={e => { (e.target as any).style.display = 'none' }} />
            <span className="text-xl font-bold" style={{ color: '#25455D' }}>
              iViSiON: ПЛЮСОН
            </span>
          </div>

          <h2 className="text-2xl font-bold text-gray-900 mb-2">Кабинет внедренца</h2>
          <p className="text-gray-500 mb-8">
            Входите почтой и паролем от своего кабинета клиента
          </p>

          <form onSubmit={submit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Почта</label>
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
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button
              type="submit" disabled={busy}
              className="btn-gold w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2"
            >
              {busy ? 'Входим…' : <>Войти <ArrowRight size={16} /></>}
            </button>
          </form>

          {/* Пароль клиентский — восстанавливается обычным способом. */}
          <p className="mt-6 text-center text-sm text-gray-500">
            Забыли пароль?{' '}
            <a href="/password-reset" className="font-medium hover:underline"
               style={{ color: '#25455D' }}>
              Восстановите его
            </a>{' '}
            — он тот же, что у кабинета клиента.
          </p>
        </div>
      </div>
    </div>
  )
}
