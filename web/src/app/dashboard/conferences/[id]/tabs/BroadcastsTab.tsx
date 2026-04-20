'use client'
import { useState, useEffect } from 'react'
import { Plus, Edit2, Trash2, Eye, ExternalLink, X, Send, Wand2, XCircle } from 'lucide-react'
import { api } from '@/lib/api'

const emptyForm = { name: '', type: 'pre_start', text: '', photo_url: '', button_text: '', button_url: '' }

function TemplatesSection({ eventId, templates, setTemplates }: { eventId: number; templates: any[]; setTemplates: (t: any[]) => void }) {
  const [modal, setModal] = useState<any>(null)
  const [form, setForm] = useState(emptyForm)

  async function save() {
    if (modal === 'new') {
      const res = await api.conference.templates.create(eventId, form)
      setTemplates([...templates, res])
    } else {
      const res = await api.conference.templates.update(eventId, modal.id, form)
      setTemplates(templates.map((x: any) => x.id === modal.id ? res : x))
    }
    setModal(null)
  }

  async function del(id: number) {
    await api.conference.templates.delete(eventId, id)
    setTemplates(templates.filter((x: any) => x.id !== id))
  }

  return (
    <div className="mb-8">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h4 className="font-semibold text-gray-800">Шаблоны</h4>
          <p className="text-xs text-gray-400 mt-0.5">Создайте шаблоны — потом запустите рассылки кнопкой «Создать из программы»</p>
        </div>
        <button onClick={() => { setModal('new'); setForm(emptyForm) }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm text-white font-medium"
          style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
          <Plus size={13} /> Новый шаблон
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="py-8 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
          <Edit2 size={24} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">Шаблонов нет</p>
          <p className="text-xs mt-1">Создайте шаблон «За 5 мин до старта» и «Подарок спикера»</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t: any) => (
            <div key={t.id} className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.type === 'pre_start' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                      {t.type === 'pre_start' ? 'За 5 мин до старта' : 'Подарок спикера'}
                    </span>
                    <span className="text-sm font-medium text-gray-800">{t.name}</span>
                  </div>
                  {t.text && (
                    <p className="text-sm text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 mb-2">{t.text}</p>
                  )}
                  <div className="flex flex-wrap gap-3 text-xs text-gray-400">
                    {t.photo_url && <span className="flex items-center gap-1"><Eye size={11} /> Есть фото</span>}
                    {t.button_text && <span className="flex items-center gap-1"><ExternalLink size={11} /> Кнопка: {t.button_text}</span>}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => { setModal(t); setForm({ name: t.name, type: t.type, text: t.text || '', photo_url: t.photo_url || '', button_text: t.button_text || '', button_url: t.button_url || '' }) }}
                    className="p-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-700">
                    <Edit2 size={13} />
                  </button>
                  <button onClick={() => del(t.id)}
                    className="p-1.5 border border-red-100 rounded-lg text-red-400 hover:text-red-600">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-800">{modal === 'new' ? 'Новый шаблон' : 'Редактировать шаблон'}</h3>
              <button onClick={() => setModal(null)}><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Название шаблона</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Например: Анонс спикера"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Тип</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none">
                  <option value="pre_start">За 5 минут до старта</option>
                  <option value="gift">Подарок спикера (за 10 мин до конца)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Текст сообщения</label>
                <p className="text-xs text-gray-400 mb-1">Переменные: {'{speaker_name}'} {'{speaker_topic}'} {'{stream_url}'} {'{gift_title}'} {'{gift_url}'} {'{start_time}'} {'{end_time}'}</p>
                <textarea value={form.text} onChange={e => setForm({ ...form, text: e.target.value })}
                  rows={6} placeholder="Текст сообщения..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none resize-none" />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Фото (URL) — если нет, берётся афиша спикера</label>
                <input value={form.photo_url} onChange={e => setForm({ ...form, photo_url: e.target.value })}
                  placeholder="https://..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Текст кнопки</label>
                  <input value={form.button_text} onChange={e => setForm({ ...form, button_text: e.target.value })}
                    placeholder="СМОТРЕТЬ ЭФИР"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Ссылка кнопки</label>
                  <input value={form.button_url} onChange={e => setForm({ ...form, button_url: e.target.value })}
                    placeholder="https://..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={save}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: 'linear-gradient(45deg,#25455D,#0a1520)' }}>
                Сохранить
              </button>
              <button onClick={() => setModal(null)}
                className="px-4 py-2 border border-gray-200 rounded-xl text-sm text-gray-500">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function BroadcastsTab({ eventId }: { eventId: number }) {
  const [templates, setTemplates] = useState<any[]>([])
  const [schedules, setSchedules] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    Promise.all([
      api.conference.templates.list(eventId),
      api.conference.schedules.list(eventId),
    ]).then(([tmpl, sched]) => {
      setTemplates(tmpl.templates || [])
      setSchedules(sched.schedules || [])
    })
  }, [eventId])

  async function generate() {
    if (templates.length === 0) { alert('Сначала создайте шаблоны'); return }
    setLoading(true)
    const res = await api.conference.schedules.generate(eventId)
    const updated = await api.conference.schedules.list(eventId)
    setSchedules(updated.schedules || [])
    setLoading(false)
    setMsg(`Создано ${res.created} рассылок, пропущено ${res.skipped}`)
    setTimeout(() => setMsg(''), 4000)
  }

  async function cancelAll() {
    if (!confirm('Отменить все ожидающие рассылки?')) return
    await api.conference.schedules.cancelAll(eventId)
    const res = await api.conference.schedules.list(eventId)
    setSchedules(res.schedules || [])
  }

  async function cancelOne(id: number) {
    await api.conference.schedules.cancel(eventId, id)
    setSchedules(schedules.map(x => x.id === id ? { ...x, status: 'cancelled' } : x))
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

  return (
    <div>
      {/* Шаблоны внутри раздела */}
      <TemplatesSection eventId={eventId} templates={templates} setTemplates={setTemplates} />

      {/* Разделитель */}
      <div className="border-t border-gray-100 mb-6" />

      {/* Очередь рассылок */}
      <div className="flex justify-between items-center mb-4">
        <div>
          <h4 className="font-semibold text-gray-800">Очередь рассылок</h4>
          <p className="text-xs text-gray-400 mt-0.5">Рассылки уйдут автоматически по расписанию</p>
        </div>
        <div className="flex gap-2">
          {schedules.some(s => s.status === 'pending') && (
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

      {msg && <div className="mb-3 text-sm text-green-700 bg-green-50 rounded-xl px-4 py-2">{msg}</div>}

      {schedules.length === 0 ? (
        <div className="py-12 text-center text-gray-400 bg-white rounded-2xl border border-gray-100">
          <Send size={28} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">Рассылок нет</p>
          <p className="text-xs mt-1">Создайте шаблоны и нажмите «Создать из программы»</p>
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
                      <span className={`text-xs px-2 py-0.5 rounded-full ${s.type === 'pre_start' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                        {s.type === 'pre_start' ? 'Анонс' : 'Подарок'}
                      </span>
                      {s.speaker_name && <span className="text-xs text-gray-600 font-medium">{s.speaker_name}</span>}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      {fireAt && <span>{fireAt.toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                      {timeLeft && s.status === 'pending' && <span className="text-amber-600 font-medium">через {timeLeft}</span>}
                      {s.status === 'done' && <span className="text-green-600">отправлено {s.recipients_sent} чел.</span>}
                    </div>
                  </div>
                  {s.status === 'pending' && (
                    <button onClick={() => cancelOne(s.id)}
                      className="p-1.5 border border-red-200 rounded-lg text-red-400 hover:text-red-600 shrink-0">
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
