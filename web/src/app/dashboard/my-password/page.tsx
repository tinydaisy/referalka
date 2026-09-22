'use client'

/**
 * Смена СВОЕГО пароля помощником кабинета.
 *
 * ⚠️ Отдельная страница, а не вкладка в «Настройках»: настройки — это
 * настройки кабинета ВЛАДЕЛЬЦА, помощнику они закрыты целиком. А пароль —
 * его личный, и менять его он должен уметь сам.
 *
 * До появления этой страницы помощник не мог сменить пароль НИКАК: забыл или
 * пароль утёк — только просить владельца выслать новый.
 *
 * ⚠️⚠️ ТЕКУЩИЙ ПАРОЛЬ НЕ СПРАШИВАЕМ (решение владельца 22.09.2026). Человек уже
 * вошёл в кабинет — повторный ввод ничего не проверяет сверх этого, а мешает в
 * живом случае: пароль выдал владелец, помощник вошёл по нему один раз и хочет
 * поставить свой, не отыскивая выданный в переписке.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound } from 'lucide-react'
import { api } from '@/lib/api'
import { useMe } from '@/hooks/useMe'

export default function MyPasswordPage() {
  const { me, isAnyAssistant } = useMe()
  const router = useRouter()
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // Владелец меняет пароль в «Настройках» — сюда он не ходит.
  if (me && !isAnyAssistant) {
    return (
      <div className="max-w-lg">
        <p className="text-sm text-gray-500">
          Эта страница — для помощников кабинета. Свой пароль вы меняете в «Настройках».
        </p>
      </div>
    )
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next.length < 8) { setError('Новый пароль — не короче 8 символов'); return }
    if (next !== repeat) { setError('Новый пароль и повтор не совпадают'); return }
    setSaving(true)
    try {
      await api.auth.changeAssistantPassword(next)
      setDone(true)
      setNext(''); setRepeat('')
    } catch (e: any) {
      setError(e?.message || 'Не удалось сменить пароль')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-1" style={{ color: '#25455D' }}>
        <KeyRound size={22} /> Сменить пароль
      </h1>
      <p className="text-sm text-gray-500 mb-6">
        Это пароль от вашего входа{me?.email ? ` (${me.email})` : ''}. Он один на все
        кабинеты, где вы помощник.
      </p>

      {done ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
          <p className="text-sm text-green-800 mb-3">
            Пароль изменён. В следующий раз входите с новым.
          </p>
          <button onClick={() => setDone(false)} className="text-sm underline text-green-900">
            Сменить ещё раз
          </button>
        </div>
      ) : (
        <form onSubmit={save} className="space-y-4 rounded-2xl border card-border bg-white p-5">
          {/* ⚠️ Поля «Текущий пароль» здесь НЕТ намеренно — см. шапку файла. */}
          <Field label="Новый пароль" value={next} onChange={setNext} autoComplete="new-password"
                 hint="Не короче 8 символов" />
          <Field label="Повторите новый" value={repeat} onChange={setRepeat} autoComplete="new-password" />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button type="submit" disabled={saving || !next || !repeat}
                  className="btn-gold disabled:opacity-60">
            {saving ? 'Сохраняем…' : 'Сменить пароль'}
          </button>
        </form>
      )}
    </div>
  )
}

function Field({ label, value, onChange, hint, autoComplete }: {
  label: string
  value: string
  onChange: (v: string) => void
  hint?: string
  autoComplete?: string
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      <input
        type="password"
        value={value}
        autoComplete={autoComplete}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-[#25455D] focus:outline-none"
      />
      {hint && <span className="mt-1 block text-[11px] text-gray-400">{hint}</span>}
    </label>
  )
}
