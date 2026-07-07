'use client'
import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

function LinkPlusonInner() {
  const params = useSearchParams()
  const token = params.get('token') || ''

  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ email: string; returnUrl: string } | null>(null)
  const [info, setInfo] = useState<{ contact_name: string; already_linked_email: string | null } | null>(null)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!token) { setInvalid(true); return }
    fetch(`${API_BASE}/api/v1/pluson-connect/info?token=${encodeURIComponent(token)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setInfo({ contact_name: d.contact_name, already_linked_email: d.already_linked_email }))
      .catch(() => setInvalid(true))
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!consent) { setError('Поставьте галочку согласия на обработку персональных данных'); return }
    if (password.length < 8) { setError('Пароль — минимум 8 символов'); return }
    setSubmitting(true)
    try {
      const path = mode === 'login' ? 'link' : 'register'
      const r = await fetch(`${API_BASE}/api/v1/pluson-connect/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email: email.trim(), password, consent_pd: consent }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.detail || 'Не удалось связать аккаунт')
      setDone({ email: d.linked_client_email || email.trim(), returnUrl: d.return_url || '' })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-8">
        <div className="text-xl font-bold text-[#25455D] mb-1">iViSiON: ПЛЮСОН</div>

        {invalid ? (
          <p className="mt-4 text-sm text-red-600">
            Ссылка недействительна или устарела. Отправьте команду <b>/pluson_connect</b> в боте ещё раз.
          </p>
        ) : done ? (
          <div className="mt-4">
            <p className="text-sm text-green-700 font-medium">✅ Аккаунт ПЛЮСОН привязан ({done.email}).</p>
            <p className="text-sm text-gray-600 mt-2">Теперь приведённые вами люди будут закрепляться за вами.</p>
            {done.returnUrl && (
              <a href={done.returnUrl}
                className="mt-5 inline-flex w-full justify-center px-4 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold">
                Вернуться в бот
              </a>
            )}
          </div>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-gray-900 mt-3">Связать аккаунт ПЛЮСОН</h1>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {info?.contact_name ? `${info.contact_name}, свяжите` : 'Свяжите'} свой аккаунт ПЛЮСОН —
              тогда все, кто зарегистрируются на событие и заберут в подарок доступ к ПЛЮСОН, закрепятся за вами.
              {info?.already_linked_email && (
                <span className="block mt-1 text-amber-700">Уже привязан: {info.already_linked_email}. Можно перепривязать.</span>
              )}
            </p>

            <div className="flex gap-2 mb-4">
              <button type="button" onClick={() => setMode('login')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${mode === 'login' ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}>
                У меня есть аккаунт
              </button>
              <button type="button" onClick={() => setMode('register')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${mode === 'register' ? 'bg-[#25455D] text-white' : 'bg-gray-100 text-gray-600'}`}>
                Зарегистрироваться
              </button>
            </div>

            <form onSubmit={submit} className="space-y-3">
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
                placeholder="Email аккаунта ПЛЮСОН"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#FFCFA4]/40 text-sm" />
              <div className="relative">
                <input type={showPassword ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)} required
                  placeholder={mode === 'register' ? 'Придумайте пароль (минимум 8)' : 'Пароль'}
                  className="w-full px-4 py-3 pr-10 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#FFCFA4]/40 text-sm" />
                <button type="button" onClick={() => setShowPassword(v => !v)} tabIndex={-1}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>

              <label className="flex items-start gap-2 text-xs text-gray-600 cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={consent} onChange={e => setConsent(e.target.checked)} />
                <span>Согласен на обработку персональных данных (email) для связки аккаунта ПЛЮСОН.</span>
              </label>

              {error && <p className="text-sm text-red-600">{error}</p>}
              <button type="submit" disabled={submitting}
                className="w-full px-4 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold disabled:opacity-50">
                {submitting ? 'Связываем…' : (mode === 'login' ? 'Войти и связать' : 'Зарегистрироваться и связать')}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

export default function LinkPlusonPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400">Загрузка…</div>}>
      <LinkPlusonInner />
    </Suspense>
  )
}
