'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Mail, CheckCircle2, XCircle } from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen gradient-bg" />}>
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
    <div className="min-h-screen gradient-bg flex items-center justify-center px-4">
      <div className="bg-white rounded-3xl shadow-2xl p-10 max-w-md w-full text-center">
        {state === 'loading' && (
          <>
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
              style={{ background: 'rgba(255,207,164,0.15)', border: '2px solid #FFCFA4' }}>
              <Mail size={36} style={{ color: '#FFCFA4' }} strokeWidth={1.5} />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Подтверждаем email…</h1>
            <p className="text-gray-500">Секундочку</p>
          </>
        )}

        {state === 'ok' && (
          <>
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
              style={{ background: 'rgba(34,197,94,0.12)', border: '2px solid #22c55e' }}>
              <CheckCircle2 size={36} className="text-green-600" strokeWidth={1.5} />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-3">Email подтверждён</h1>
            <p className="text-gray-500 mb-6 leading-relaxed">
              Спасибо! Теперь вам доступны все возможности кабинета, включая рассылки.
            </p>
            <Link href="/dashboard"
              className="btn-gold inline-block w-full py-3 rounded-xl font-semibold text-sm">
              Перейти в кабинет
            </Link>
          </>
        )}

        {state === 'error' && (
          <>
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6"
              style={{ background: 'rgba(239,68,68,0.1)', border: '2px solid #ef4444' }}>
              <XCircle size={36} className="text-red-500" strokeWidth={1.5} />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-3">Ссылка недействительна</h1>
            <p className="text-gray-500 mb-6 leading-relaxed">
              Похоже, ссылка устарела или уже была использована. Войдите в кабинет и
              нажмите «Отправить письмо заново» в плашке сверху.
            </p>
            <Link href="/login" className="block text-sm text-gray-400 hover:text-gray-600">
              Вернуться к входу
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
