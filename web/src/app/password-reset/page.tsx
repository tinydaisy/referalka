'use client'

import { useState } from 'react'
import Link from 'next/link'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

type Result = { found: boolean; sent: boolean }

export default function PasswordResetRequestPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json().catch(() => ({}))
      setResult({ found: !!data.found, sent: !!data.sent })
    } catch {
      setError('Не получилось связаться с сервером. Попробуйте ещё раз.')
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setResult(null)
    setEmail('')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-[#25455D] mb-2">Восстановление пароля</h1>
        {!result ? (
          <>
            <p className="text-sm text-gray-600 mb-6">
              Введите email, под которым зарегистрировались в ПЛЮСОНе. Мы пришлём ссылку для смены пароля.
            </p>
            <form onSubmit={submit} className="space-y-4">
              <input
                type="email" value={email} required
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#FFCFA4]/40 text-sm"
              />
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button type="submit" disabled={submitting}
                className="w-full px-4 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold disabled:opacity-50">
                {submitting ? 'Отправляем...' : 'Получить ссылку'}
              </button>
            </form>
          </>
        ) : !result.found ? (
          <>
            <div className="rounded-xl bg-red-50 border border-red-200 p-4">
              <p className="text-sm text-red-800 leading-relaxed">
                Аккаунт с email <strong className="break-all">{email}</strong> не зарегистрирован в ПЛЮСОНе.
                Письмо мы не отправляли — восстанавливать нечего.
              </p>
            </div>
            <p className="text-xs text-gray-500 mt-4">
              Проверьте, нет ли опечатки, или вспомните другой адрес — возможно, вы регистрировались под ним.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button onClick={reset}
                className="w-full px-4 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold">
                Попробовать другой email
              </button>
              <Link href="/register"
                className="w-full px-4 py-3 border border-gray-200 text-[#25455D] rounded-xl font-bold text-center text-sm">
                Создать аккаунт
              </Link>
            </div>
          </>
        ) : result.sent ? (
          <>
            <p className="text-sm text-gray-700 leading-relaxed">
              Мы отправили ссылку для восстановления пароля на <strong className="break-all">{email}</strong>.
              Ссылка действует 1 час.
            </p>
            <p className="text-xs text-gray-500 mt-4">
              Не пришло? Проверьте папку «Спам» — письмо приходит от «iViSiON: ПЛЮСОН».
            </p>
          </>
        ) : (
          <>
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
              <p className="text-sm text-amber-900 leading-relaxed">
                Аккаунт <strong className="break-all">{email}</strong> найден, но письмо не удалось отправить —
                похоже, у нас сбой с почтой.
              </p>
            </div>
            <p className="text-xs text-gray-500 mt-4">
              Попробуйте ещё раз через пару минут. Если не поможет — напишите в поддержку.
            </p>
            <button onClick={reset}
              className="mt-5 w-full px-4 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold">
              Попробовать ещё раз
            </button>
          </>
        )}
        <div className="mt-6 text-center">
          <Link href="/login" className="text-sm text-[#25455D] underline">← Назад к входу</Link>
        </div>
      </div>
    </div>
  )
}
