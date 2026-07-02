'use client'
import { useEffect, useState } from 'react'
import { MailWarning } from 'lucide-react'
import { api } from '@/lib/api'

export default function EmailVerifyBanner() {
  const [show, setShow] = useState(false)
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    api.auth.me()
      .then((data: any) => {
        // Плашку не показываем ассистенту — email принадлежит владельцу кабинета.
        if (data?.role === 'assistant') return
        if (data && data.email_verified === false) {
          setShow(true)
          setEmail(data.email || '')
        }
      })
      .catch(() => {})
  }, [])

  async function resend() {
    setSending(true)
    try {
      await api.auth.resendVerifyEmail()
      setSent(true)
    } catch {
      // молча — кнопка просто снова станет доступной
    } finally {
      setSending(false)
    }
  }

  if (!show) return null

  return (
    <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-3">
      <MailWarning size={20} className="text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-amber-800 text-sm">
          Email не подтверждён
        </div>
        <div className="text-amber-700 text-xs mt-0.5">
          {sent ? (
            <>Письмо отправлено{email ? <> на <strong>{email}</strong></> : ''}. Проверьте почту и папку «Спам»,
            перейдите по ссылке из письма. Пока email не подтверждён — рассылки недоступны.</>
          ) : (
            <>Мы отправили письмо со ссылкой{email ? <> на <strong>{email}</strong></> : ''}. Подтвердите email — проверьте
            почту (и папку «Спам»). Пока email не подтверждён — рассылки недоступны.</>
          )}
        </div>
      </div>
      <button
        onClick={resend}
        disabled={sending || sent}
        className="shrink-0 px-3 py-1.5 rounded-md bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 transition-colors disabled:opacity-60"
      >
        {sent ? 'Отправлено' : sending ? 'Отправляем…' : 'Отправить письмо заново'}
      </button>
    </div>
  )
}
