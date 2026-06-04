'use client'
import { useEffect, useState } from 'react'
import { Check, X, Wallet, AlertCircle } from 'lucide-react'
import { api } from '@/lib/api'

const STATUS: Record<string, { label: string; cls: string }> = {
  pending:   { label: 'В обработке', cls: 'bg-amber-100 text-amber-800' },
  completed: { label: 'Выплачено',    cls: 'bg-green-100 text-green-800' },
  cancelled: { label: 'Отклонено',    cls: 'bg-red-100 text-red-700' },
}

export default function AdminWithdrawalsPage() {
  const [filter, setFilter] = useState<'pending' | 'completed' | 'cancelled' | 'all'>('pending')
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [actionFor, setActionFor] = useState<{ wd: any; action: 'complete' | 'cancel' } | null>(null)

  function load() {
    setLoading(true)
    api.adminWithdrawals.list(filter === 'all' ? undefined : filter)
      .then((r: any) => { setList(r.withdrawals || []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [filter])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Wallet size={22} /> Заявки на вывод
        </h1>
      </div>

      <div className="flex gap-2 mb-6">
        {(['pending', 'completed', 'cancelled', 'all'] as const).map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === s ? 'bg-[#25455D] text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {s === 'all' ? 'Все' : STATUS[s].label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-gray-500">Загрузка…</div>
      ) : list.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
          <AlertCircle size={32} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">Заявок нет</p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map(w => {
            const st = STATUS[w.status] || { label: w.status, cls: 'bg-gray-100 text-gray-600' }
            return (
              <div key={w.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-gray-900">#{w.id}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${st.cls}`}>
                        {st.label}
                      </span>
                    </div>
                    <div className="text-sm text-gray-700">
                      <b>{w.client_name}</b> · {w.client_email}
                      {w.telegram_username && ` · @${w.telegram_username}`}
                    </div>
                    <div className="text-xs text-gray-400 mt-1">
                      Подана: {new Date(w.requested_at).toLocaleString('ru-RU')}
                      {w.completed_at && ` · Закрыта: ${new Date(w.completed_at).toLocaleString('ru-RU')}`}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold" style={{ color: '#25455D' }}>
                      {(w.amount_kopecks / 100).toLocaleString('ru-RU')} ₽
                    </div>
                  </div>
                </div>

                <div className="mt-3 bg-gray-50 rounded-lg p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">Реквизиты</div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap">{w.payment_details}</div>
                </div>

                {w.admin_note && (
                  <div className="mt-3 bg-amber-50 border border-amber-100 rounded-lg p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 mb-1">
                      Комментарий админа
                    </div>
                    <div className="text-sm text-gray-700">{w.admin_note}</div>
                  </div>
                )}

                {w.status === 'pending' && (
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => setActionFor({ wd: w, action: 'complete' })}
                      className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 flex items-center gap-2"
                    >
                      <Check size={14} /> Отметить выплаченной
                    </button>
                    <button
                      onClick={() => setActionFor({ wd: w, action: 'cancel' })}
                      className="px-4 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm font-medium hover:bg-red-100 flex items-center gap-2"
                    >
                      <X size={14} /> Отклонить
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {actionFor && (
        <ActionModal
          wd={actionFor.wd}
          action={actionFor.action}
          onClose={() => setActionFor(null)}
          onDone={() => { setActionFor(null); load() }}
        />
      )}
    </div>
  )
}


function ActionModal({ wd, action, onClose, onDone }: {
  wd: any
  action: 'complete' | 'cancel'
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (action === 'cancel' && !note.trim()) {
      setError('Укажите причину отказа')
      return
    }
    setLoading(true)
    setError('')
    try {
      if (action === 'complete') {
        await api.adminWithdrawals.complete(wd.id, note.trim() || undefined)
      } else {
        await api.adminWithdrawals.cancel(wd.id, note.trim())
      }
      onDone()
    } catch (e: any) {
      setError(e?.message || 'Ошибка')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">
          {action === 'complete' ? 'Подтвердить выплату' : 'Отклонить заявку'}
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Заявка #{wd.id} от <b>{wd.client_name}</b> на <b>{(wd.amount_kopecks / 100).toLocaleString('ru-RU')} ₽</b>
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              {action === 'cancel' ? 'Причина отказа (обязательно)' : 'Комментарий (опц.)'}
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={action === 'cancel' ? 'Нет квитанции о переводе…' : 'Перевод СБП — 14:23'}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm h-24 resize-none"
            />
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600">
              Отмена
            </button>
            <button
              type="submit"
              disabled={loading}
              className={`px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50 text-white ${
                action === 'complete' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {loading ? 'Сохранение…' : action === 'complete' ? 'Подтвердить' : 'Отклонить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
