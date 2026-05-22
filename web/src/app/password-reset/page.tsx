'use client'

import { useState } from 'react'
import Link from 'next/link'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function PasswordResetRequestPage() {
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await fetch(`${API_BASE}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setDone(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-[#25455D] mb-2">Восстановление пароля</h1>
        {!done ? (
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
              <button type="submit" disabled={submitting}
                className="w-full px-4 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold disabled:opacity-50">
                {submitting ? 'Отправляем...' : 'Получить ссылку'}
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-700 leading-relaxed">
              Если email <strong>{email}</strong> зарегистрирован в ПЛЮСОНе — мы только что отправили на него ссылку для восстановления пароля.
              Ссылка действует 1 час.
            </p>
            <p className="text-xs text-gray-500 mt-4">
              Не пришло? Проверь папку «Спам». Если и там нет — возможно, аккаунт с таким email не зарегистрирован.
            </p>
          </>
        )}
        <div className="mt-6 text-center">
          <Link href="/login" className="text-sm text-[#25455D] underline">← Назад к входу</Link>
        </div>
      </div>
    </div>
  )
}
