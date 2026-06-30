'use client'
import { useState, useEffect } from 'react'
import { Plus, Calendar, Trash2, Save } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" />
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
  const [savingAll, setSavingAll] = useState(false)
  // dirtyDays — какие day_number имеют несохранённые правки (для подсветки кнопки).
  // Сбрасывается после успешного сохранения.
  const [dirtyDays, setDirtyDays] = useState<Set<number>>(new Set())
  const [dayForms, setDayForms] = useState<Record<number, any>>({})
  const [sessionModal, setSessionModal] = useState<{ day: number } | null>(null)
  const [sessionForm, setSessionForm] = useState({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
  const [speakerTopics, setSpeakerTopics] = useState<{ id: number; topic: string }[]>([])
  const [customTitle, setCustomTitle] = useState(false)
  const [savingSession, setSavingSession] = useState(false)
  const [jsonModal, setJsonModal] = useState(false)
  const [jsonInput, setJsonInput] = useState('')
  const [jsonDay, setJsonDay] = useState(1)
  // Тайминг дня — авто-генерация N пустых слотов
  const [timingModal, setTimingModal] = useState<{ day: number } | null>(null)
  const [timingForm, setTimingForm] = useState({ start_time: '10:00', speaker_count: '10', talk_duration: '20', break_duration: '10' })
  const [savingTiming, setSavingTiming] = useState(false)

  async function saveTiming() {
    if (!timingModal) return
    const count = parseInt(timingForm.speaker_count, 10)
    const talk = parseInt(timingForm.talk_duration, 10)
    const brk = parseInt(timingForm.break_duration, 10)
    if (!count || count < 1) { alert('Укажите количество спикеров'); return }
    if (!talk || talk < 1) { alert('Укажите длительность выступления'); return }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(timingForm.start_time)) { alert('Укажите время начала в формате ЧЧ:ММ'); return }
    setSavingTiming(true)
    try {
      await api.conference.sessions.generateTiming(eventId, {
        day: timingModal.day,
        start_time: timingForm.start_time,
        speaker_count: count,
        talk_duration: talk,
        break_duration: isNaN(brk) ? 0 : brk,
      })
      setTimingModal(null)
      load()
    } catch (e: any) {
      alert(e?.message || 'Не удалось сгенерировать слоты')
    } finally { setSavingTiming(false) }
  }
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
    await api.conference.days.upsert(eventId, nextNum, { day_date: null })
    load()
  }

  // Глобальное сохранение всех дней программы — заменяет per-day кнопку-дискету.
  // Шлёт PUT для каждого dirtyDays, после успеха сбрасывает dirtyDays и перезагружает.
  async function saveAllDays() {
    if (dirtyDays.size === 0) return
    setSavingAll(true)
    try {
      for (const dayNum of Array.from(dirtyDays)) {
        const f = dayForms[dayNum] || {}
        await api.conference.days.upsert(eventId, dayNum, {
          day_date: f.day_date || null,
          stream_url: f.stream_url || null,
        })
      }
      setDirtyDays(new Set())
      // Перезагружаем с бэка — клиент видит ровно то, что улетело в БД.
      await load()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSavingAll(false)
    }
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
    if (!sessionModal) return
    const speakerId = sessionForm.speaker_id ? Number(sessionForm.speaker_id) : null
    // Без спикера тема обязательна; со спикером — тема живёт по topic_id, иначе заглушка.
    if (!speakerId && !sessionForm.title.trim()) return
    const title = sessionForm.title.trim() || (speakerId ? 'Тема будет уточнена позже' : '')
    setSavingSession(true)
    try {
      await api.conference.sessions.create(eventId, {
        day: sessionModal.day,
        title: title || undefined,
        topic_id: sessionForm.topic_id ? Number(sessionForm.topic_id) : undefined,
        speaker_id: speakerId,
        start_time: sessionForm.start_time || null,
        end_time: sessionForm.end_time || null,
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
      for (const slot of slots) {
        await api.conference.sessions.create(eventId, {
          day: jsonDay,
          title: slot.title || slot.topic || '',
          speaker_id: null,
          start_time: slot.time || null,
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

        return (
          <div key={dayNum} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="gradient-bg px-5 py-3.5 flex items-center justify-between">
              <span className="text-white font-semibold">{tp.day(dayNum)}</span>
              <button onClick={() => deleteDay(dayNum)} className="text-white/50 hover:text-red-300 transition-colors">
                <Trash2 size={15} />
              </button>
            </div>

            <div className="px-5 py-4 border-b border-gray-50">
              <label className="label">{tp.date}</label>
              <input type="date" value={df.day_date || ''}
                onChange={e => {
                  const v = e.target.value
                  setDayForms(prev => ({ ...prev, [dayNum]: { ...(prev[dayNum] || {}), day_date: v } }))
                  setDirtyDays(prev => { const n = new Set(prev); n.add(dayNum); return n })
                }}
                className="input" />
            </div>

            <div className="px-5 py-3">
              {daySessions.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-3">{tp.noSessions}</p>
              ) : (
                <div className="space-y-1.5 mb-3">
                  {daySessions.map((s: any) => (
                    <div key={s.id} className="flex items-start gap-3 group py-1.5">
                      <span className="text-xs text-gray-400 w-40 shrink-0 pt-0.5 font-mono whitespace-nowrap">
                        {s.start_time || ''}
                        {s.end_time ? ` — ${s.end_time}` : ''}
                        {s.start_time ? ' МСК' : ''}
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

              <div className="flex gap-2 pt-1 pb-1 items-center">
                <button onClick={() => setSessionModal({ day: dayNum })}
                  className="text-xs text-brand hover:text-brand/80 flex items-center gap-1.5 transition-colors">
                  <Plus size={13} /> {tp.addSession}
                </button>
                <span className="text-gray-300">·</span>
                <button onClick={() => setTimingModal({ day: dayNum })}
                  className="text-xs text-[#25455D] hover:opacity-80 flex items-center gap-1.5 transition-colors font-medium">
                  ⏱ Задать тайминг
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

      {/* Глобальная sticky-кнопка «Сохранить программу» — появляется только при
          наличии несохранённых правок (dirtyDays > 0). Заменяет per-day иконки-дискеты:
          клиент не должен жать сохранить у каждого дня отдельно. */}
      {dirtyDays.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <button onClick={saveAllDays} disabled={savingAll}
            className="btn-gold px-7 py-3 rounded-2xl text-sm font-bold shadow-2xl flex items-center gap-2 disabled:opacity-70">
            {savingAll ? <Spinner /> : <Save size={16} />}
            {savingAll
              ? 'Сохраняем...'
              : `Сохранить программу${dirtyDays.size > 1 ? ` (${dirtyDays.size})` : ''}`}
          </button>
        </div>
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
            {/* Тема вписывается ТОЛЬКО без спикера. Со спикером тема живёт в его карточке (live). */}
            {!sessionForm.speaker_id ? (
              <div>
                <label className="label">{tp.sessionModal.topicLabel}</label>
                <input type="text" value={sessionForm.title}
                  onChange={e => setSessionForm(f => ({ ...f, title: e.target.value, topic_id: '' }))}
                  className="input" placeholder={tp.sessionModal.topicPlaceholder} />
              </div>
            ) : speakerTopics.length > 1 ? (
              <div>
                <label className="label">{tp.sessionModal.topicLabel}</label>
                <select
                  onChange={e => {
                    const t = speakerTopics.find(t => String(t.id) === e.target.value)
                    setSessionForm(f => ({ ...f, topic_id: e.target.value, title: t?.topic || '' }))
                  }}
                  value={sessionForm.topic_id}
                  className="input bg-white">
                  <option value="">— выберите тему —</option>
                  {speakerTopics.map(t => (
                    <option key={t.id} value={t.id}>{t.topic}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">У спикера несколько тем — выберите для этого слота.</p>
              </div>
            ) : speakerTopics.length === 1 ? (
              <div>
                <label className="label">{tp.sessionModal.topicLabel}</label>
                <div className="input bg-gray-50 text-gray-700">{speakerTopics[0].topic}</div>
                <p className="text-xs text-gray-400 mt-1">Тема берётся из карточки спикера и обновится автоматически, если он её изменит.</p>
              </div>
            ) : (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5">
                <p className="text-xs text-amber-800">
                  У спикера пока не задана тема — в программе будет «Тема будет уточнена позже».
                  Как только спикер впишет тему в своей карточке, она подставится сюда автоматически.
                </p>
              </div>
            )}
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
            <button onClick={addSession} disabled={(!sessionForm.speaker_id && !sessionForm.title.trim()) || savingSession}
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

      {timingModal && (
        <Modal title="Задать тайминг дня" onClose={() => setTimingModal(null)}>
          <p className="text-xs text-gray-500 mb-4">
            Сгенерируем пустые слоты по порядку — спикеры сами займут их в кабинете.
            Слоты <b>добавятся</b> к уже существующим в этом дне.
          </p>
          <div className="space-y-3">
            <div>
              <label className="label">Время начала (МСК)</label>
              <input type="time" value={timingForm.start_time}
                onChange={e => setTimingForm(f => ({ ...f, start_time: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">Количество спикеров (слотов)</label>
              <input type="number" min={1} max={100} value={timingForm.speaker_count}
                onChange={e => setTimingForm(f => ({ ...f, speaker_count: e.target.value }))} className="input" placeholder="10" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Выступление (мин)</label>
                <input type="number" min={1} value={timingForm.talk_duration}
                  onChange={e => setTimingForm(f => ({ ...f, talk_duration: e.target.value }))} className="input" placeholder="20" />
              </div>
              <div>
                <label className="label">Перерыв (мин)</label>
                <input type="number" min={0} value={timingForm.break_duration}
                  onChange={e => setTimingForm(f => ({ ...f, break_duration: e.target.value }))} className="input" placeholder="10" />
              </div>
            </div>
            {(() => {
              const c = parseInt(timingForm.speaker_count, 10), tlk = parseInt(timingForm.talk_duration, 10), b = parseInt(timingForm.break_duration, 10)
              if (!c || !tlk) return null
              const total = c * tlk + Math.max(0, c - 1) * (isNaN(b) ? 0 : b)
              const [hh, mm] = timingForm.start_time.split(':').map(Number)
              const endMin = (hh * 60 + mm + total) % (24 * 60)
              const endStr = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
              return <p className="text-xs text-gray-500">Итого: {c} слот(ов), с {timingForm.start_time} до ~{endStr} МСК.</p>
            })()}
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={saveTiming} disabled={savingTiming}
              className="btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm disabled:opacity-60">
              {savingTiming ? 'Генерирую…' : 'Сгенерировать слоты'}
            </button>
            <button onClick={() => setTimingModal(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">{t.common.cancel}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
