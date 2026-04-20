'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Send, Wand2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'

export default function QueuePage() {
  const { id } = useParams()
  const eventId = Number(id)

  const [schedules, setSchedules] = useState<any[]>([])
  const [hasTemplates, setHasTemplates] = useState(false)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    Promise.all([
      api.conference.templates.list(eventId),
      api.conference.schedules.list(eventId),
    ]).then(([tmpl, sched]) => {
      setHasTemplates((tmpl.templates || []).length > 0)
      setSchedules(sched.schedules || [])
    })
  }, [eventId])

  async function generate() {
    if (!hasTemplates) {
      alert('Сначала создайте шаблоны во вкладке «Шаблоны»')
      return
    }
    setLoading(true)
    try {
      const res = await api.conference.schedules.generate(eventId)
      const updated = await api.conference.schedules.list(eventId)
      setSchedules(updated.schedules || [])
      setMsg(`Создано ${res.created} рассылок, пропущено ${res.skipped}`)
      setTimeout(() => setMsg(''), 5000)
    } catch (e: any) {
      alert(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function cancelAll() {
    if (!confirm('Отменить все ожидающие рассылки?')) return
    await api.conference.schedules.cancelAll(eventId)
    const res = await api.conference.schedules.list(eventId)
    setSchedules(res.schedules || [])
  }

  async function cancelOne(scheduleId: number) {
    await api.conference.schedules.cancel(eventId, scheduleId)
    setSchedules(schedules.map(x => x.id === scheduleId ? { ...x, status: 'cancelled' } : x))
  }

  const statusColor: Record<string, string> = {
    pending: 'bg-amber-50 border-amber-200',
    running: 'bg-blue-50 border-blue-200',
    done: 'bg-green-50 border-green-200',
    cancelled: 'bg-gray-50 border-gray-200',
  }
  const statusLabel: Record<string, string> = {
    pending: '⏳ Ожидает',
    running: '📤 Отправляется',
    done: '✅ Отправлено',
    cancelled: '❌ Отменена',
  }

  const pendingCount = schedules.filter(s => s.status === 'pending').length

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-sm text-gray-500">
            Рассылки создаются автоматически из программы конференции и уходят по расписанию.
          </p>
          {pendingCount > 0 && (
            <p className="text-xs text-amber-600 mt-1">В очереди: {pendingCount} рассылок</p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {pendingCount > 0 && (
            <button onClick={cancelAll}
              className="flex items-center gap-2 px-3 py-2 border border-red-200 rounded-xl text-sm text-red-500 hover:bg-red-50">
              <XCircle size={14} /> Остановить всё
            </button>
          )}
          <button onClick={generate} disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-white font-medium disabled:opacity-50"
            style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
            <Wand2 size={14} /> {loading ? 'Создаю...' : 'Создать из программы'}
          </button>
        </div>
      </div>

      {msg && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 rounded-xl px-4 py-3">{msg}</div>
      )}

      {!hasTemplates && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
          Сначала создайте шаблоны во вкладке «Шаблоны» — без них рассылки не запустятся.
        </div>
      )}

      {schedules.length === 0 ? (
        <div className="py-16 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
          <Send size={32} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">Очередь пуста</p>
          <p className="text-xs mt-1">Нажмите «Создать из программы» — рассылки встанут в очередь автоматически</p>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map(s => {
            const fireAt = s.fire_at ? new Date(s.fire_at) : null
            const sec = s.seconds_until
            const timeLeft = sec != null
              ? sec > 3600 ? `${Math.floor(sec / 3600)}ч ${Math.floor((sec % 3600) / 60)}мин`
              : sec > 60 ? `${Math.floor(sec / 60)} мин`
              : `${sec} сек`
              : null

            return (
              <div key={s.id} className={`rounded-xl border p-4 ${statusColor[s.status] || 'bg-white border-gray-100'}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-xs font-medium text-gray-700">{statusLabel[s.status] || s.status}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.type === 'pre_start' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                        {s.type === 'pre_start' ? 'Анонс' : 'Подарок'}
                      </span>
                      {s.speaker_name && (
                        <span className="text-xs text-gray-600 font-medium">{s.speaker_name}</span>
                      )}
                      {s.session_title && (
                        <span className="text-xs text-gray-400 truncate max-w-[200px]">{s.session_title}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                      {fireAt && (
                        <span>{fireAt.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                      {timeLeft && s.status === 'pending' && (
                        <span className="text-amber-600 font-medium">через {timeLeft}</span>
                      )}
                      {s.status === 'done' && s.recipients_sent != null && (
                        <span className="text-green-600">отправлено {s.recipients_sent} чел.</span>
                      )}
                    </div>
                  </div>
                  {s.status === 'pending' && (
                    <button onClick={() => cancelOne(s.id)}
                      className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-red-600 shrink-0"
                      title="Отменить">
                      <XCircle size={13} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
