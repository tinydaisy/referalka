'use client'

import { Suspense, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function PasswordResetConfirmPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#25455D]" />}>
      <Inner />
    </Suspense>
  )
}

function Inner() {
  const sp = useSearchParams()
  const router = useRouter()
  const token = sp.get('token') || ''
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError('Пароль должен быть не короче 8 символов')
      return
    }
    if (password !== password2) {
      setError('Пароли не совпадают')
      return
    }
    setSubmitting(true)
    try {
      const r = await fetch(`${API_BASE}/api/v1/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: password }),
      })
      if (!r.ok) {
        const detail = (await r.json()).detail || 'Ошибка'
        setError(detail)
        return
      }
      setDone(true)
      setTimeout(() => router.push('/login'), 2000)
    } catch (e: any) {
      setError(e?.message || 'Ошибка отправки')
    } finally {
      setSubmitting(false)
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4">
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
          <h1 className="text-xl font-bold text-red-600 mb-2">Ссылка недействительна</h1>
          <p className="text-sm text-gray-600">Нет токена в ссылке. Попробуй ещё раз через форму восстановления.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-[#25455D] mb-4">Новый пароль</h1>
        {!done ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'} value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Новый пароль (минимум 8 символов)"
                className="w-full px-4 py-3 pr-10 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#FFCFA4]/40 text-sm"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <input
              type={showPassword ? 'text' : 'password'} value={password2}
              onChange={e => setPassword2(e.target.value)}
              placeholder="Повторите пароль"
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#FFCFA4]/40 text-sm"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={submitting}
              className="w-full px-4 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold disabled:opacity-50">
              {submitting ? 'Сохраняем...' : 'Сохранить новый пароль'}
            </button>
          </form>
        ) : (
          <div className="text-center">
            <div className="text-5xl mb-3">✓</div>
            <p className="text-lg font-semibold text-green-700">Пароль обновлён</p>
            <p className="text-sm text-gray-500 mt-2">Переадресуем на вход…</p>
          </div>
        )}
      </div>
    </div>
  )
}
