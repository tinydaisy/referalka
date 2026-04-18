'use client'
import { useState, useEffect } from 'react'
import { Plus, Calendar, Trash2, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function ProgramTab({ eventId }: { eventId: number }) {
  const { t, lang } = useLang()
  const tp = t.conferences.program
  const [days, setDays] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [savingDay, setSavingDay] = useState<number | null>(null)
  const [dayForms, setDayForms] = useState<Record<number, any>>({})
  const [sessionModal, setSessionModal] = useState<{ day: number } | null>(null)
  const [sessionForm, setSessionForm] = useState({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
  const [speakerTopics, setSpeakerTopics] = useState<{ id: number; topic: string }[]>([])
  const [customTitle, setCustomTitle] = useState(false)
  const [savingSession, setSavingSession] = useState(false)
  const [jsonModal, setJsonModal] = useState(false)
  const [jsonInput, setJsonInput] = useState('')
  const [jsonDay, setJsonDay] = useState(1)
  const [importingJson, setImportingJson] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [dRes, sRes, spRes] = await Promise.all([
        api.conference.days.list(eventId),
        api.conference.sessions.list(eventId),
        api.conference.speakers.list(eventId),
      ])
      const loadedDays: any[] = dRes.days || []
      setDays(loadedDays)
      setSessions(sRes.sessions || [])
      setSpeakers(spRes.speakers || [])
      const forms: Record<number, any> = {}
      loadedDays.forEach((d: any) => {
        forms[d.day_number] = { day_date: d.day_date || '', stream_url: d.stream_url || '' }
      })
      setDayForms(forms)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  async function addDay() {
    const nextNum = days.length > 0 ? Math.max(...days.map((d: any) => d.day_number)) + 1 : 1
    await api.conference.days.upsert(eventId, nextNum, { day_date: null, stream_url: null })
    load()
  }

  async function saveDay(dayNum: number) {
    setSavingDay(dayNum)
    try {
      const f = dayForms[dayNum] || {}
      await api.conference.days.upsert(eventId, dayNum, { day_date: f.day_date || null, stream_url: f.stream_url || null })
    } catch (err: any) { alert(err.message) } finally { setSavingDay(null) }
  }

  async function deleteDay(dayNum: number) {
    if (!confirm(tp.deleteDayConfirm(dayNum))) return
    const daySessions = sessions.filter((s: any) => s.day === dayNum)
    await Promise.all(daySessions.map((s: any) => api.conference.sessions.delete(eventId, s.id)))
    setDays(remaining => remaining.filter((d: any) => d.day_number !== dayNum))
    setSessions(prev => prev.filter((s: any) => s.day !== dayNum))
  }

  function onSpeakerChange(speakerId: string) {
    const sp = speakers.find((s: any) => String(s.id) === speakerId)
    // topics теперь [{id, topic}]
    const topics: { id: number; topic: string }[] = sp?.topics && sp.topics.length > 0
      ? sp.topics
      : []
    setSpeakerTopics(topics)
    setCustomTitle(false)
    // Если у спикера ровно одна тема — подставляем сразу
    const autoTopicId = topics.length === 1 ? String(topics[0].id) : ''
    const autoTitle = topics.length === 1 ? topics[0].topic : ''
    setSessionForm(f => ({ ...f, speaker_id: speakerId, topic_id: autoTopicId, title: autoTitle }))
  }

  async function addSession() {
    if (!sessionModal || !sessionForm.title.trim()) return
    setSavingSession(true)
    try {
      const startDt = sessionForm.start_time
        ? `${(dayForms[sessionModal.day]?.day_date) || '2000-01-01'}T${sessionForm.start_time}:00`
        : null
      const endDt = sessionForm.end_time
        ? `${(dayForms[sessionModal.day]?.day_date) || '2000-01-01'}T${sessionForm.end_time}:00`
        : null
      await api.conference.sessions.create(eventId, {
        day: sessionModal.day,
        title: sessionForm.title || undefined,
        topic_id: sessionForm.topic_id ? Number(sessionForm.topic_id) : undefined,
        speaker_id: sessionForm.speaker_id ? Number(sessionForm.speaker_id) : null,
        start_datetime: startDt,
        end_datetime: endDt,
      })
      setSessionModal(null)
      setSessionForm({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
      setSpeakerTopics([])
      setCustomTitle(false)
      load()
    } catch (err: any) { alert(err.message) } finally { setSavingSession(false) }
  }

  async function deleteSession(id: number) {
    await api.conference.sessions.delete(eventId, id)
    load()
  }

  async function importJson() {
    setImportingJson(true)
    try {
      const slots = JSON.parse(jsonInput)
      if (!Array.isArray(slots)) throw new Error(tp.jsonModal.errorExpected)
      const date = dayForms[jsonDay]?.day_date || '2000-01-01'
      for (const slot of slots) {
        await api.conference.sessions.create(eventId, {
          day: jsonDay,
          title: slot.title || slot.topic || '',
          speaker_id: null,
          start_datetime: slot.time ? `${date}T${slot.time}:00` : null,
        })
      }
      setJsonModal(false); setJsonInput('')
      load()
    } catch (err: any) {
      alert(tp.jsonModal.errorPrefix + err.message)
    } finally {
      setImportingJson(false)
    }
  }

  if (loading) return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>

  return (
    <div className="max-w-2xl space-y-5">
      {days.length === 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
          <Calendar size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm mb-4">{tp.noDays}</p>
          <button onClick={addDay} className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 mx-auto">
            <Plus size={15} /> {tp.addDay1}
          </button>
        </div>
      )}

      {days.map((day: any) => {
        const dayNum = day.day_number
        const daySessions = sessions.filter((s: any) => s.day === dayNum).sort((a: any, b: any) => a.sort_order - b.sort_order)
        const df = dayForms[dayNum] || {}
        const isSavingThis = savingDay === dayNum

        return (
          <div key={dayNum} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="gradient-bg px-5 py-3.5 flex items-center justify-between">
              <span className="text-white font-semibold">{tp.day(dayNum)}</span>
              <button onClick={() => deleteDay(dayNum)} className="text-white/50 hover:text-red-300 transition-colors">
                <Trash2 size={15} />
              </button>
            </div>

            <div className="px-5 py-4 border-b border-gray-50 flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="label">{tp.date}</label>
                <input type="date" value={df.day_date || ''}
                  onChange={e => setDayForms(f => ({ ...f, [dayNum]: { ...df, day_date: e.target.value } }))}
                  className="input" />
              </div>
              <div className="flex-1">
                <label className="label">{tp.streamUrl}</label>
                <input type="url" value={df.stream_url || ''} placeholder="https://..."
                  onChange={e => setDayForms(f => ({ ...f, [dayNum]: { ...df, stream_url: e.target.value } }))}
                  className="input" />
              </div>
              <div className="flex items-end">
                <button onClick={() => saveDay(dayNum)} disabled={isSavingThis}
                  className={`h-10 px-4 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors ${isSavingThis ? 'btn-loading' : ''}`}>
                  {isSavingThis ? <Spinner /> : <Save size={14} />}
                </button>
              </div>
            </div>

            <div className="px-5 py-3">
              {daySessions.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-3">{tp.noSessions}</p>
              ) : (
                <div className="space-y-1.5 mb-3">
                  {daySessions.map((s: any) => (
                    <div key={s.id} className="flex items-start gap-3 group py-1.5">
                      <span className="text-xs text-gray-400 w-24 shrink-0 pt-0.5 font-mono">
                        {s.start_datetime ? new Date(s.start_datetime).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '—:——'}
                        {s.end_datetime ? ` — ${new Date(s.end_datetime).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : ''}
                      </span>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">{s.title}</p>
                        {s.speaker_name && <p className="text-xs text-gray-400">{s.speaker_name}</p>}
                      </div>
                      <button onClick={() => deleteSession(s.id)}
                        className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all p-1 rounded">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2 pt-1 pb-1">
                <button onClick={() => setSessionModal({ day: dayNum })}
                  className="text-xs text-brand hover:text-brand/80 flex items-center gap-1.5 transition-colors">
                  <Plus size={13} /> {tp.addSession}
                </button>
                <span className="text-gray-300">·</span>
                <button onClick={() => { setJsonDay(dayNum); setJsonModal(true) }}
                  className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1.5 transition-colors">
                  {tp.importJson}
                </button>
              </div>
            </div>
          </div>
        )
      })}

      {days.length > 0 && (
        <button onClick={addDay}
          className="w-full py-3 rounded-2xl border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-2">
          <Plus size={16} /> {tp.addDayMore}
        </button>
      )}

      {sessionModal && (
        <Modal title={tp.sessionModal.title(sessionModal.day)} onClose={() => { setSessionModal(null); setSpeakerTopics([]); setCustomTitle(false) }}>
          <div className="space-y-3">
            <div>
              <label className="label">{tp.sessionModal.speaker}</label>
              <select value={sessionForm.speaker_id}
                onChange={e => onSpeakerChange(e.target.value)}
                className="input bg-white" autoFocus>
                <option value="">{tp.sessionModal.noSpeaker}</option>
                {speakers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{tp.sessionModal.topicLabel}</label>
              {speakerTopics.length > 1 && !customTitle ? (
                <select
                  onChange={e => {
                    if (e.target.value === '__custom__') {
                      setCustomTitle(true)
                      setSessionForm(f => ({ ...f, topic_id: '', title: '' }))
                    } else {
                      const t = speakerTopics.find(t => String(t.id) === e.target.value)
                      setSessionForm(f => ({ ...f, topic_id: e.target.value, title: t?.topic || '' }))
                    }
                  }}
                  value={sessionForm.topic_id}
                  className="input bg-white">
                  <option value="">— выберите тему —</option>
                  {speakerTopics.map(t => (
                    <option key={t.id} value={t.id}>{t.topic}</option>
                  ))}
                  <option value="__custom__">Другая тема...</option>
                </select>
              ) : (
                <div>
                  <input type="text" value={sessionForm.title}
                    onChange={e => setSessionForm(f => ({ ...f, title: e.target.value, topic_id: '' }))}
                    className="input" placeholder={tp.sessionModal.topicPlaceholder} />
                  {speakerTopics.length > 1 && (
                    <button type="button" onClick={() => { setCustomTitle(false); setSessionForm(f => ({ ...f, topic_id: '', title: '' })) }}
                      className="text-xs text-gray-400 hover:text-brand mt-1 transition-colors">
                      ← выбрать из тем спикера
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{tp.sessionModal.start}</label>
                <input type="time" value={sessionForm.start_time}
                  onChange={e => setSessionForm(f => ({ ...f, start_time: e.target.value }))}
                  className="input" />
              </div>
              <div>
                <label className="label">{tp.sessionModal.end}</label>
                <input type="time" value={sessionForm.end_time}
                  onChange={e => setSessionForm(f => ({ ...f, end_time: e.target.value }))}
                  className="input" />
              </div>
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={addSession} disabled={!sessionForm.title.trim() || savingSession}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${savingSession ? 'btn-loading' : ''}`}>
              {savingSession ? <><Spinner /> {t.common.saving}</> : tp.sessionModal.addBtn}
            </button>
            <button onClick={() => setSessionModal(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">{t.common.cancel}</button>
          </div>
        </Modal>
      )}

      {jsonModal && (
        <Modal title={tp.jsonModal.title} onClose={() => setJsonModal(false)}>
          <p className="text-xs text-gray-500 mb-3">
            {tp.jsonModal.hint} <code className="bg-gray-100 px-1 rounded">title</code> ({lang === 'ru' ? 'или' : 'or'} <code className="bg-gray-100 px-1 rounded">topic</code>), <code className="bg-gray-100 px-1 rounded">time</code> (HH:MM).
          </p>
          <p className="text-xs text-gray-400 mb-2">{tp.jsonModal.example} <code className="bg-gray-100 px-1 rounded">{tp.jsonModal.placeholder}</code></p>
          <textarea value={jsonInput} onChange={e => setJsonInput(e.target.value)}
            rows={6} autoFocus placeholder={tp.jsonModal.placeholder}
            className="input resize-none font-mono text-xs" />
          <div className="flex gap-3 mt-4">
            <button onClick={importJson} disabled={!jsonInput.trim() || importingJson}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${importingJson ? 'btn-loading' : ''}`}>
              {importingJson ? <><Spinner /> {t.common.importing}</> : tp.jsonModal.importBtn}
            </button>
            <button onClick={() => setJsonModal(false)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">{t.common.cancel}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
