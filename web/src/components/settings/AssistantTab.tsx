'use client'
import { useEffect, useState } from 'react'
import { RotateCcw, Trash2, Mail, UserPlus, Info, Building2 } from 'lucide-react'
import { api } from '@/lib/api'

type AccessLevel = 'full' | 'limited' | 'orders'

interface AssistantRow {
  grant_id: number
  assistant_id: number
  email: string
  name: string | null
  access_level: AccessLevel
  /** В скольких кабинетах у этого человека есть доступ (включая ваш). */
  cabinets: number
  last_login_at: string | null
  created_at: string | null
}

const LEVEL_HINT: Record<AccessLevel, string> = {
  full: 'Может всё то же, что и вы: настройки, каналы, лид-магниты, удаление данных, оплата. Не сможет управлять помощниками и не увидит ваш пароль.',
  limited: 'Может править контакты, события, рассылки, реф-программу и продукты Mini App. Не сможет удалять данные, заходить в «Каналы» и «Настройки».',
  // ⚠️ Разрешительный список: открыты ровно два раздела, всё остальное
  // закрыто. Так новый раздел кабинета не откроется менеджеру случайно.
  orders: 'Только «Контакты» и «Анкеты»: разбирает заявки — ставит отметку «обработано», пишет заметки. Не увидит события, рассылки, деньги и настройки.',
}

export default function AssistantTab() {
  const [rows, setRows] = useState<AssistantRow[]>([])
  const [loading, setLoading] = useState(true)
  const [emailInput, setEmailInput] = useState('')
  const [levelInput, setLevelInput] = useState<AccessLevel>('limited')
  const [creating, setCreating] = useState(false)
  const [busyGrant, setBusyGrant] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const r = await api.assistant.list()
      setRows(r.assistants || [])
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить помощников')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setNotice('')
    const v = emailInput.trim().toLowerCase()
    if (!v || !v.includes('@')) { setError('Введите корректный email'); return }
    setCreating(true)
    try {
      const r = await api.assistant.create(v, levelInput)
      setEmailInput('')
      setLevelInput('limited')
      if (!r.email_sent) {
        setError(`Доступ выдан, но письмо на ${v} не ушло. Попробуйте «Напомнить пароль».`)
      } else if (r.is_new_account) {
        setNotice(`Доступ выдан. Пароль отправлен на ${v}.`)
      } else {
        setNotice(`Доступ выдан. У помощника уже есть пароль от ПЛЮСОНа — мы сообщили ему письмом.`)
      }
      await load()
    } catch (e: any) {
      setError(e?.message || 'Не удалось подключить помощника')
    } finally {
      setCreating(false)
    }
  }

  async function handleChangeLevel(row: AssistantRow, level: AccessLevel) {
    if (row.access_level === level) return
    if (level === 'full' && !confirm(
      'Выдать полный доступ? Помощник сможет всё то же, что и вы: менять настройки, ' +
      'подключать боты, удалять данные и оплачивать подписку. Ваш пароль он не увидит.'
    )) return
    setError(''); setNotice('')
    setBusyGrant(row.grant_id)
    try {
      const r = await api.assistant.setAccessLevel(row.grant_id, level)
      setRows(rs => rs.map(x => x.grant_id === row.grant_id ? { ...x, access_level: r.access_level } : x))
    } catch (e: any) {
      setError(e?.message || 'Не удалось изменить права')
    } finally {
      setBusyGrant(null)
    }
  }

  async function handleReset(row: AssistantRow) {
    if (!confirm(
      `Сгенерировать новый пароль для ${row.email}? Старый перестанет работать во ВСЕХ кабинетах, ` +
      'где у него есть доступ. Новый пароль придёт ему на почту — вы его не увидите.'
    )) return
    setError(''); setNotice('')
    setBusyGrant(row.grant_id)
    try {
      await api.assistant.resetPassword(row.grant_id)
      setNotice(`Новый пароль отправлен на ${row.email}.`)
    } catch (e: any) {
      setError(e?.message || 'Не удалось отправить пароль')
    } finally {
      setBusyGrant(null)
    }
  }

  async function handleDelete(row: AssistantRow) {
    if (!confirm(
      `Отозвать доступ у ${row.email}? Он больше не сможет войти в ваш кабинет. ` +
      (row.cabinets > 1 ? 'В других кабинетах его доступ сохранится.' : '')
    )) return
    setError(''); setNotice('')
    setBusyGrant(row.grant_id)
    try {
      await api.assistant.delete(row.grant_id)
      setRows(rs => rs.filter(x => x.grant_id !== row.grant_id))
    } catch (e: any) {
      setError(e?.message || 'Не удалось отозвать доступ')
    } finally {
      setBusyGrant(null)
    }
  }

  if (loading) return <div className="text-gray-500 text-sm">Загрузка…</div>

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border card-border shadow-sm p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[#FFCFA4]/30 flex items-center justify-center shrink-0">
            <UserPlus className="text-[#25455D]" size={20} />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800 text-lg">Помощники кабинета</h3>
            <p className="text-sm text-gray-500 mt-1">
              Подключите помощников и выдайте каждому права: <b>полный доступ</b> — как у вас,
              или <b>ограниченный</b> — без удаления данных, «Каналов» и «Настроек».
              Пароль помощника вы не видите: он приходит ему на почту.
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2.5 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}
        {notice && (
          <div className="bg-[#FFCFA4]/20 border border-[#FFCFA4] rounded-lg px-4 py-2.5 text-sm text-[#25455D] mb-4">
            {notice}
          </div>
        )}

        <form onSubmit={handleCreate} className="space-y-3">
          <label className="block text-sm font-medium text-gray-700">Email помощника</label>
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
            Новому помощнику пароль придёт письмом. Если он уже помогает другому клиенту
            ПЛЮСОНа — пароль у него есть, мы просто сообщим про доступ.
            Email, зарегистрированный как кабинет ПЛЮСОНа, помощником быть не может.
          </p>
        </form>
      </div>

      {rows.map(row => (
        <div key={row.grant_id} className="bg-white rounded-2xl border card-border shadow-sm p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Mail size={15} className="text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 truncate">{row.email}</span>
            </div>
            {row.cabinets > 1 && (
              <span className="flex items-center gap-1 text-xs text-gray-500 shrink-0"
                    title="Этот помощник ведёт несколько кабинетов">
                <Building2 size={13} /> {row.cabinets} кабинета
              </span>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
              Права доступа
            </label>
            <LevelPicker
              value={row.access_level}
              onChange={l => handleChangeLevel(row, l)}
              disabled={busyGrant === row.grant_id}
            />
          </div>

          <div className="text-xs text-gray-500 space-y-1">
            {row.last_login_at && (
              <div>Последний вход:{' '}
                <b>{new Date(row.last_login_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</b>
              </div>
            )}
            {row.created_at && (
              <div>Подключён:{' '}
                {new Date(row.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              disabled={busyGrant === row.grant_id}
              onClick={() => handleReset(row)}
              className="flex items-center gap-2 px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
            >
              <RotateCcw size={15} />
              Напомнить пароль
            </button>
            <button
              type="button"
              disabled={busyGrant === row.grant_id}
              onClick={() => handleDelete(row)}
              className="flex items-center gap-2 px-4 py-2.5 bg-red-50 hover:bg-red-100 text-red-700 rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
            >
              <Trash2 size={15} />
              Отозвать доступ
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}


function LevelPicker({
  value, onChange, disabled,
}: {
  value: AccessLevel
  onChange: (v: AccessLevel) => void
  disabled?: boolean
}) {
  const options: { id: AccessLevel; title: string }[] = [
    { id: 'orders',  title: 'Менеджер заказов' },
    { id: 'limited', title: 'Ограниченный доступ' },
    { id: 'full',    title: 'Полный доступ' },
  ]
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              <span className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                active ? 'border-[#25455D] bg-[#25455D]' : 'border-gray-300'
              }`} />
              <span className="text-sm font-medium text-gray-800">{o.title}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1.5 leading-snug">{LEVEL_HINT[o.id]}</p>
          </button>
        )
      })}
    </div>
  )
}
