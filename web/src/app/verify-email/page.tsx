'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#25455D]" />}>
      <Inner />
    </Suspense>
  )
}

function Inner() {
  const sp = useSearchParams()
  const token = sp.get('token') || ''
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')

  useEffect(() => {
    if (!token) {
      setState('error')
      return
    }
    fetch(`${API_BASE}/api/v1/auth/verify-email/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(r => setState(r.ok ? 'ok' : 'error'))
      .catch(() => setState('error'))
  }, [token])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#25455D] to-[#0a1520] px-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
        {state === 'loading' && (
          <>
            <h1 className="text-xl font-bold text-[#25455D] mb-2">Подтверждаем email…</h1>
            <p className="text-sm text-gray-500">Секундочку</p>
          </>
        )}
        {state === 'ok' && (
          <>
            <div className="text-5xl mb-3">✓</div>
            <h1 className="text-2xl font-bold text-green-700 mb-2">Email подтверждён</h1>
            <p className="text-sm text-gray-600 mb-6">
              Спасибо! Теперь вам доступны все возможности кабинета, включая рассылки.
            </p>
            <Link href="/dashboard"
              className="inline-block px-5 py-3 bg-[#FFCFA4] text-[#25455D] rounded-xl font-bold">
              Перейти в кабинет
            </Link>
          </>
        )}
        {state === 'error' && (
          <>
            <h1 className="text-xl font-bold text-red-600 mb-2">Ссылка недействительна</h1>
            <p className="text-sm text-gray-600 mb-6">
              Похоже, ссылка устарела или уже была использована. Войдите в кабинет и
              нажмите «Отправить письмо заново» в плашке сверху.
            </p>
            <Link href="/login" className="text-sm text-[#25455D] underline">← Войти в кабинет</Link>
          </>
        )}
      </div>
    </div>
  )
}
