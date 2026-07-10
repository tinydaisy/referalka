'use client'
import { useEffect, useState } from 'react'
import { Eye, EyeOff, Copy, Check, RotateCcw, Trash2, Mail, UserPlus, Info } from 'lucide-react'
import { api } from '@/lib/api'

type AccessLevel = 'full' | 'limited'

interface AssistantInfo {
  id: number
  email: string
  access_level: AccessLevel
  last_login_at: string | null
  created_at: string | null
  updated_at: string | null
}

const LEVEL_HINT: Record<AccessLevel, string> = {
  full: 'Может всё то же, что и вы: настройки, каналы, лид-магниты, удаление данных, оплата. Не сможет только управлять самим ассистентом — этот раздел остаётся за вами.',
  limited: 'Может править контакты, события, рассылки, реф-программу и продукты Mini App. Не сможет удалять данные, заходить в «Каналы» и «Настройки» (там ваш email и пароль), править лид-магниты и оплачивать.',
}

export default function AssistantTab() {
  const [assistant, setAssistant] = useState<AssistantInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [emailInput, setEmailInput] = useState('')
  const [levelInput, setLevelInput] = useState<AccessLevel>('limited')
  const [savingLevel, setSavingLevel] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  // Пароль показывается под глазиком: при первом клике дёргаем GET /password
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [password, setPassword] = useState<string | null>(null)
  const [copyState, setCopyState] = useState(false)

  // Только-что-показанный пароль после create/reset (мигалка)
  const [freshPassword, setFreshPassword] = useState<string | null>(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await api.assistant.get()
      setAssistant(r.assistant)
      setPassword(null)
      setPasswordVisible(false)
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить ассистента')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const v = emailInput.trim().toLowerCase()
    if (!v || !v.includes('@')) {
      setError('Введите корректный email')
      return
    }
    setCreating(true)
    try {
      const r = await api.assistant.create(v, levelInput)
      setFreshPassword(r.assistant.password)
      setEmailInput('')
      await load()
    } catch (e: any) {
      setError(e?.message || 'Не удалось создать ассистента')
    } finally {
      setCreating(false)
    }
  }

  async function handleChangeLevel(level: AccessLevel) {
    if (!assistant || assistant.access_level === level) return
    if (level === 'full' && !confirm(
      'Выдать полный доступ? Ассистент сможет всё то же, что и вы: менять настройки, ' +
      'ваш email и пароль, подключать боты, удалять данные и оплачивать подписку.'
    )) return
    setError('')
    setSavingLevel(true)
    try {
      const r = await api.assistant.setAccessLevel(level)
      setAssistant(a => (a ? { ...a, access_level: r.assistant.access_level } : a))
    } catch (e: any) {
      setError(e?.message || 'Не удалось изменить уровень доступа')
    } finally {
      setSavingLevel(false)
    }
  }

  async function handleReset() {
    if (!confirm('Сгенерировать новый пароль? Старый перестанет работать. Новый пароль будет отправлен ассистенту на email.')) return
    setError('')
    try {
      const r = await api.assistant.resetPassword()
      setFreshPassword(r.password)
      setPassword(r.password)
      setPasswordVisible(true)
    } catch (e: any) {
      setError(e?.message || 'Не удалось сбросить пароль')
    }
  }

  async function handleDelete() {
    if (!confirm('Отключить ассистента полностью? Он не сможет войти. Это действие обратимо — вы сможете подключить его снова.')) return
    setError('')
    try {
      await api.assistant.delete()
      setAssistant(null)
      setPassword(null)
      setFreshPassword(null)
      setPasswordVisible(false)
    } catch (e: any) {
      setError(e?.message || 'Не удалось отключить ассистента')
    }
  }

  async function handleTogglePassword() {
    if (passwordVisible) {
      setPasswordVisible(false)
      return
    }
    if (!password) {
      try {
        const r = await api.assistant.getPassword()
        setPassword(r.password)
      } catch (e: any) {
        setError(e?.message || 'Не удалось получить пароль')
        return
      }
    }
    setPasswordVisible(true)
  }

  async function handleCopyPassword() {
    if (!password) {
      try {
        const r = await api.assistant.getPassword()
        setPassword(r.password)
        await navigator.clipboard.writeText(r.password)
      } catch (e: any) {
        setError(e?.message || 'Не удалось скопировать')
        return
      }
    } else {
      await navigator.clipboard.writeText(password)
    }
    setCopyState(true)
    setTimeout(() => setCopyState(false), 1500)
  }

  if (loading) {
    return <div className="text-gray-500 text-sm">Загрузка…</div>
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[#FFCFA4]/30 flex items-center justify-center shrink-0">
            <UserPlus className="text-[#25455D]" size={20} />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800 text-lg">Ассистент кабинета</h3>
            <p className="text-sm text-gray-500 mt-1">
              Подключите одного помощника, который будет работать в вашем кабинете.
              Права выбираете вы: <b>полный доступ</b> — как у вас, или{' '}
              <b>ограниченный</b> — без удаления данных, «Каналов» и «Настроек».
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {!assistant && (
          <form onSubmit={handleCreate} className="space-y-3">
            <label className="block text-sm font-medium text-gray-700">Email ассистента</label>
            <div className="flex gap-2">
              <input
                type="email"
                value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                placeholder="assistant@example.com"
                className="flex-1 px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-brand/30 text-sm"
                required
              />
              <button
                type="submit"
                disabled={creating}
                className="px-5 py-3 bg-[#25455D] text-white rounded-xl text-sm font-medium hover:bg-[#1d3a4e] disabled:opacity-50 whitespace-nowrap"
              >
                {creating ? 'Подключаем…' : 'Подключить'}
              </button>
            </div>
            <div className="pt-1">
              <label className="block text-sm font-medium text-gray-700 mb-2">Права доступа</label>
              <LevelPicker value={levelInput} onChange={setLevelInput} />
            </div>

            <p className="text-xs text-gray-500 flex items-start gap-1.5">
              <Info size={13} className="shrink-0 mt-0.5" />
              Мы сгенерируем пароль и отправим письмо ассистенту с инструкциями.
              Также пароль можно будет посмотреть тут под иконкой-глазиком.
            </p>
          </form>
        )}

        {assistant && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                  Email
                </label>
                <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-800">
                  <Mail size={14} className="text-gray-400 shrink-0" />
                  <span className="truncate">{assistant.email}</span>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                  Пароль
                </label>
                <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm">
                  <span className="flex-1 font-mono text-gray-800 truncate">
                    {passwordVisible && password ? password : '•'.repeat(12)}
                  </span>
                  <button
                    type="button"
                    onClick={handleTogglePassword}
                    title={passwordVisible ? 'Скрыть' : 'Показать'}
                    className="text-gray-500 hover:text-gray-800 transition-colors shrink-0"
                  >
                    {passwordVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyPassword}
                    title="Скопировать"
                    className="text-gray-500 hover:text-gray-800 transition-colors shrink-0"
                  >
                    {copyState ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-1">
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                Права доступа
              </label>
              <LevelPicker
                value={assistant.access_level}
                onChange={handleChangeLevel}
                disabled={savingLevel}
              />
              {savingLevel && <div className="text-xs text-gray-500 mt-2">Сохраняем…</div>}
            </div>

            {freshPassword && (
              <div className="bg-[#FFCFA4]/20 border border-[#FFCFA4] rounded-xl px-4 py-3 text-sm text-[#25455D]">
                <b>Новый пароль сгенерирован.</b> Письмо отправлено ассистенту на{' '}
                <b>{assistant.email}</b>. Если письмо не дошло — скопируйте пароль выше
                и передайте вручную.
              </div>
            )}

            <div className="text-xs text-gray-500 space-y-1">
              {assistant.last_login_at && (
                <div>
                  Последний вход:{' '}
                  <b>{new Date(assistant.last_login_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</b>
                </div>
              )}
              {assistant.created_at && (
                <div>
                  Подключён:{' '}
                  {new Date(assistant.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={handleReset}
                className="flex items-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-xl text-sm font-medium transition-colors"
              >
                <RotateCcw size={15} />
                Сбросить пароль
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center gap-2 px-4 py-2.5 bg-red-50 hover:bg-red-100 text-red-700 rounded-xl text-sm font-medium transition-colors"
              >
                <Trash2 size={15} />
                Отключить ассистента
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


function LevelPicker({
  value,
  onChange,
  disabled,
}: {
  value: AccessLevel
  onChange: (v: AccessLevel) => void
  disabled?: boolean
}) {
  const options: { id: AccessLevel; title: string }[] = [
    { id: 'limited', title: 'Ограниченный доступ' },
    { id: 'full',    title: 'Полный доступ' },
  ]
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {options.map(o => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={`text-left rounded-xl border px-4 py-3 transition-colors disabled:opacity-60 ${
              active
                ? 'border-[#25455D] bg-[#25455D]/5 ring-1 ring-[#25455D]/20'
                : 'border-gray-200 bg-white hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                  active ? 'border-[#25455D] bg-[#25455D]' : 'border-gray-300'
                }`}
              />
              <span className="text-sm font-medium text-gray-800">{o.title}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1.5 leading-snug">{LEVEL_HINT[o.id]}</p>
          </button>
        )
      })}
    </div>
  )
}
