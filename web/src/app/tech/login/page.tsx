'use client'

/**
 * Вход тех-специалиста.
 *
 * ⚠️ Ходит в ОБЩИЙ `/auth/login`, а не в свою ручку: там уже разобраны все три
 * роли по порядку (клиент → помощник → тех-спец → админ). Отдельный эндпоинт
 * означал бы вторую копию проверки пароля.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

export default function TechLoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const res: any = await api.auth.login({ email, password })
      if (!res?.tech) {
        // Почта существует, но принадлежит клиенту или админу — их вход в
        // другом месте, и молча пускать сюда нельзя.
        setError('Этот вход только для тех-специалистов')
        return
      }
      localStorage.setItem('plusson_token', res.access_token)
      // Cookie нужен middleware Next: без него он не отличит вошедшего.
      document.cookie = `plusson_token=${res.access_token}; path=/; max-age=604800; SameSite=Lax`
      router.replace('/tech')
    } catch (e: any) {
      setError(e?.message || 'Неверная почта или пароль')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4"
         style={{ background: 'linear-gradient(45deg, #25455D, #0a1520)' }}>
      <form onSubmit={submit}
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg">
        <div className="mb-1 text-lg font-bold text-gray-900">Кабинет внедренца</div>
        <p className="mb-5 text-sm text-gray-500">
          Вход по почте и паролю, которые выдал владелец платформы.
        </p>

        <input value={email} onChange={e => setEmail(e.target.value)}
               type="email" required placeholder="Почта"
               className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm" />
        <input value={password} onChange={e => setPassword(e.target.value)}
               type="password" required placeholder="Пароль"
               className="mb-4 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm" />

        {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

        <button type="submit" disabled={busy} className="btn-gold w-full py-2.5 text-sm">
          {busy ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </div>
  )
}
