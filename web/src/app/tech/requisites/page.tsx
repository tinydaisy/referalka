'use client'

/**
 * Реквизиты для выплат — кабинет внедренца (миграция 517).
 *
 * ⚠️ Платим по СБП: нужен телефон И банк — одного номера для перевода мало.
 * ⚠️ Самозанятость — отметка самого человека, проверки через налоговую нет
 * (решение владельца 26.09.2026). Оферта и подписание документов перед выводом
 * появятся отдельно.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export default function TechRequisitesPage() {
  const [f, setF] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.tech.requisites().then((r: any) => setF({
      full_name: r.full_name || '', inn: r.inn || '', sbp_phone: r.sbp_phone || '',
      bank: r.bank || '', self_employed: !!r.self_employed,
    })).catch((e: any) => setError(e?.message || 'Не удалось загрузить'))
  }, [])

  async function save() {
    setBusy(true); setError('')
    try {
      const r: any = await api.tech.saveRequisites(f)
      setF({ full_name: r.full_name || '', inn: r.inn || '', sbp_phone: r.sbp_phone || '',
             bank: r.bank || '', self_employed: !!r.self_employed })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e: any) {
      setError(e?.message || 'Не удалось сохранить')
    } finally { setBusy(false) }
  }

  if (!f) return <div className="p-4 text-sm text-gray-400 md:p-8">{error || 'Загружаем…'}</div>

  const input = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm'
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })

  return (
    <div className="p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-bold text-gray-900">Реквизиты для выплат</h1>
      <p className="mb-5 max-w-2xl text-sm text-gray-500">
        Сюда переводим ваши начисления — по СБП, на номер телефона. Проверьте,
        что номер привязан к указанному банку.
      </p>

      <div className="max-w-xl space-y-4 rounded-xl bg-white p-5 shadow-sm">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">ФИО полностью</span>
          <input value={f.full_name} onChange={set('full_name')} className={input}
                 placeholder="Иванов Иван Иванович" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">Телефон для СБП</span>
          <input value={f.sbp_phone} onChange={set('sbp_phone')} className={input}
                 inputMode="tel" placeholder="+7 900 123-45-67" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">Банк получателя</span>
          <input value={f.bank} onChange={set('bank')} className={input}
                 placeholder="Т-Банк, Сбербанк, Альфа-Банк…" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">ИНН</span>
          <input value={f.inn} onChange={set('inn')} className={input}
                 inputMode="numeric" maxLength={14} placeholder="12 цифр" />
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" className="mt-0.5" checked={f.self_employed}
                 onChange={e => setF({ ...f, self_employed: e.target.checked })} />
          <span>Я самозанятый (плательщик налога на профессиональный доход)</span>
        </label>

        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy} className="btn-gold px-5 py-2 text-sm disabled:opacity-50">
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {saved && <span className="text-sm text-green-700">Сохранено</span>}
        </div>
      </div>
    </div>
  )
}
