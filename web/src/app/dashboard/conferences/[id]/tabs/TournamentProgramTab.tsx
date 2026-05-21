'use client'
import { useState, useEffect } from 'react'
import { Plus, Calendar, Trash2, Save, ChevronUp, ChevronDown, Layers } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

type Stage = {
  id: number
  sort_order: number
  title: string
  subtitle: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
}
type Day = {
  id: number
  day_number: number
  day_date: string | null
  open_time: string | null
  close_time: string | null
  stream_url: string | null
  stage_id: number | null
  title: string | null
}
type Sess = {
  id: number
  day: number
  start_time: string | null
  end_time: string | null
  title: string
  speaker_name?: string | null
  sort_order: number
}

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

export default function TournamentProgramTab({ eventId }: { eventId: number }) {
  const [stages, setStages] = useState<Stage[]>([])
  const [days, setDays] = useState<Day[]>([])
  const [sessions, setSessions] = useState<Sess[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [savingAll, setSavingAll] = useState(false)

  // Локальные формы редактирования
  const [stageForms, setStageForms] = useState<Record<number, Partial<Stage>>>({})
  const [dayForms, setDayForms] = useState<Record<number, Partial<Day>>>({})
  const [dirtyStages, setDirtyStages] = useState<Set<number>>(new Set())
  const [dirtyDays, setDirtyDays] = useState<Set<number>>(new Set())

  // Модалка добавления сессии
  const [sessionModal, setSessionModal] = useState<{ day: number } | null>(null)
  const [sessionForm, setSessionForm] = useState({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
  const [speakerTopics, setSpeakerTopics] = useState<{ id: number; topic: string }[]>([])
  const [customTitle, setCustomTitle] = useState(false)
  const [savingSession, setSavingSession] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [stRes, dRes, sRes, spRes] = await Promise.all([
        api.conference.stages.list(eventId),
        api.conference.days.list(eventId),
        api.conference.sessions.list(eventId),
        api.conference.speakers.list(eventId),
      ])
      const loadedStages: Stage[] = stRes.stages || []
      const loadedDays: Day[] = dRes.days || []
      setStages(loadedStages)
      setDays(loadedDays)
      setSessions(sRes.sessions || [])
      setSpeakers(spRes.speakers || [])

      const sf: Record<number, Partial<Stage>> = {}
      loadedStages.forEach(s => {
        sf[s.id] = {
          title: s.title,
          subtitle: s.subtitle || '',
          description: s.description || '',
          start_date: s.start_date || '',
          end_date: s.end_date || '',
        }
      })
      setStageForms(sf)

      const df: Record<number, Partial<Day>> = {}
      loadedDays.forEach(d => {
        df[d.day_number] = {
          title: d.title || '',
          day_date: d.day_date || '',
          open_time: d.open_time || '',
          close_time: d.close_time || '',
          stream_url: d.stream_url || '',
          stage_id: d.stage_id,
        }
      })
      setDayForms(df)
      setDirtyStages(new Set())
      setDirtyDays(new Set())
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [eventId])

  // ─── Этапы ──────────────────────────────────────────────────────────────────

  async function addStage() {
    const nextOrder = stages.length > 0 ? Math.max(...stages.map(s => s.sort_order)) + 1 : 0
    const res = await api.conference.stages.create(eventId, {
      title: `Этап ${stages.length + 1}`,
      sort_order: nextOrder,
    })
    setStages(prev => [...prev, res.stage])
    setStageForms(prev => ({
      ...prev,
      [res.stage.id]: { title: res.stage.title, subtitle: '', description: '', start_date: '', end_date: '' },
    }))
  }

  async function deleteStage(stageId: number) {
    const stageDays = days.filter(d => d.stage_id === stageId)
    const msg = stageDays.length > 0
      ? `Удалить этап? ${stageDays.length} ${stageDays.length === 1 ? 'день останется' : 'дня(дней) останутся'} без группировки.`
      : 'Удалить этап?'
    if (!confirm(msg)) return
    await api.conference.stages.delete(eventId, stageId)
    await load()
  }

  async function moveStage(stageId: number, dir: -1 | 1) {
    const sorted = [...stages].sort((a, b) => a.sort_order - b.sort_order)
    const idx = sorted.findIndex(s => s.id === stageId)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= sorted.length) return
    const a = sorted[idx], b = sorted[target]
    await Promise.all([
      api.conference.stages.update(eventId, a.id, { sort_order: b.sort_order }),
      api.conference.stages.update(eventId, b.id, { sort_order: a.sort_order }),
    ])
    await load()
  }

  function patchStageForm(stageId: number, patch: Partial<Stage>) {
    setStageForms(prev => ({ ...prev, [stageId]: { ...(prev[stageId] || {}), ...patch } }))
    setDirtyStages(prev => { const n = new Set(prev); n.add(stageId); return n })
  }

  // ─── Дни ────────────────────────────────────────────────────────────────────

  async function addDayToStage(stageId: number | null) {
    const nextNum = days.length > 0 ? Math.max(...days.map(d => d.day_number)) + 1 : 1
    await api.conference.days.upsert(eventId, nextNum, {
      day_date: null,
      stage_id: stageId,
      title: null,
    })
    await load()
  }

  async function deleteDay(dayNum: number) {
    if (!confirm(`Удалить день ${dayNum} и все его сессии?`)) return
    const daySessions = sessions.filter(s => s.day === dayNum)
    await Promise.all(daySessions.map(s => api.conference.sessions.delete(eventId, s.id)))
    setDays(prev => prev.filter(d => d.day_number !== dayNum))
    setSessions(prev => prev.filter(s => s.day !== dayNum))
  }

  function patchDayForm(dayNum: number, patch: Partial<Day>) {
    setDayForms(prev => ({ ...prev, [dayNum]: { ...(prev[dayNum] || {}), ...patch } }))
    setDirtyDays(prev => { const n = new Set(prev); n.add(dayNum); return n })
  }

  // ─── Глобальное сохранение ──────────────────────────────────────────────────

  async function saveAll() {
    if (dirtyStages.size === 0 && dirtyDays.size === 0) return
    setSavingAll(true)
    try {
      for (const sid of Array.from(dirtyStages)) {
        const f = stageForms[sid] || {}
        await api.conference.stages.update(eventId, sid, {
          title: f.title || 'Без названия',
          subtitle: f.subtitle || null,
          description: f.description || null,
          start_date: f.start_date || null,
          end_date: f.end_date || null,
        })
      }
      for (const dayNum of Array.from(dirtyDays)) {
        const f = dayForms[dayNum] || {}
        await api.conference.days.upsert(eventId, dayNum, {
          day_date: f.day_date || null,
          open_time: f.open_time || null,
          close_time: f.close_time || null,
          stream_url: f.stream_url || null,
          stage_id: f.stage_id ?? null,
          title: f.title || null,
        })
      }
      await load()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSavingAll(false)
    }
  }

  // ─── Сессии ─────────────────────────────────────────────────────────────────

  function onSpeakerChange(speakerId: string) {
    const sp = speakers.find((s: any) => String(s.id) === speakerId)
    const topics: { id: number; topic: string }[] = sp?.topics && sp.topics.length > 0 ? sp.topics : []
    setSpeakerTopics(topics)
    setCustomTitle(false)
    const autoTopicId = topics.length === 1 ? String(topics[0].id) : ''
    const autoTitle = topics.length === 1 ? topics[0].topic : ''
    setSessionForm(f => ({ ...f, speaker_id: speakerId, topic_id: autoTopicId, title: autoTitle }))
  }

  async function addSession() {
    if (!sessionModal || !sessionForm.title.trim()) return
    setSavingSession(true)
    try {
      await api.conference.sessions.create(eventId, {
        day: sessionModal.day,
        title: sessionForm.title || undefined,
        topic_id: sessionForm.topic_id ? Number(sessionForm.topic_id) : undefined,
        speaker_id: sessionForm.speaker_id ? Number(sessionForm.speaker_id) : null,
        start_time: sessionForm.start_time || null,
        end_time: sessionForm.end_time || null,
      })
      setSessionModal(null)
      setSessionForm({ title: '', topic_id: '', speaker_id: '', start_time: '', end_time: '' })
      setSpeakerTopics([])
      setCustomTitle(false)
      await load()
    } catch (err: any) { alert(err.message) } finally { setSavingSession(false) }
  }

  async function deleteSession(id: number) {
    await api.conference.sessions.delete(eventId, id)
    await load()
  }

  if (loading) return <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>

  const stagesSorted = [...stages].sort((a, b) => a.sort_order - b.sort_order)
  const daysByStage = (stageId: number | null) =>
    days.filter(d => d.stage_id === stageId).sort((a, b) => a.day_number - b.day_number)
  const orphanDays = daysByStage(null)

  return (
    <div className="max-w-2xl space-y-6">
      {/* Подсказка для пустого состояния */}
      {stages.length === 0 && days.length === 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
          <Layers size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm mb-2">У турнира пока нет программы.</p>
          <p className="text-xs text-gray-400 mb-4">Создайте первый этап (например, «Предстарт» или «Основной этап»). В этап можно добавить дни — с программой по спикерам.</p>
          <button onClick={addStage} className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 mx-auto">
            <Plus size={15} /> Добавить этап
          </button>
        </div>
      )}

      {/* Этапы */}
      {stagesSorted.map((stage, sIdx) => {
        const sf = stageForms[stage.id] || {}
        const stageDays = daysByStage(stage.id)
        return (
          <div key={stage.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="gradient-bg px-5 py-3.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-white">
                <Layers size={16} className="opacity-80 shrink-0" />
                <span className="font-semibold">Этап {sIdx + 1}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => moveStage(stage.id, -1)}
                  disabled={sIdx === 0}
                  className="text-white/50 hover:text-white disabled:opacity-20 disabled:hover:text-white/50 p-1"
                  title="Выше"
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  onClick={() => moveStage(stage.id, 1)}
                  disabled={sIdx === stagesSorted.length - 1}
                  className="text-white/50 hover:text-white disabled:opacity-20 disabled:hover:text-white/50 p-1"
                  title="Ниже"
                >
                  <ChevronDown size={15} />
                </button>
                <button onClick={() => deleteStage(stage.id)} className="text-white/50 hover:text-red-300 p-1" title="Удалить этап">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            <div className="px-5 py-4 space-y-3 border-b border-gray-50">
              <div>
                <label className="label">Название этапа</label>
                <input
                  type="text"
                  value={sf.title || ''}
                  onChange={e => patchStageForm(stage.id, { title: e.target.value })}
                  className="input"
                  placeholder="Например, «Предстарт: Живой автор в контенте»"
                />
              </div>
              <div>
                <label className="label">Подпись (опционально)</label>
                <input
                  type="text"
                  value={sf.subtitle || ''}
                  onChange={e => patchStageForm(stage.id, { subtitle: e.target.value })}
                  className="input"
                  placeholder="«2 недели», «офлайн», «финал»"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Дата старта</label>
                  <input
                    type="date"
                    value={sf.start_date || ''}
                    onChange={e => patchStageForm(stage.id, { start_date: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="label">Дата окончания</label>
                  <input
                    type="date"
                    value={sf.end_date || ''}
                    onChange={e => patchStageForm(stage.id, { end_date: e.target.value })}
                    className="input"
                  />
                </div>
              </div>
              <div>
                <label className="label">Описание (опционально)</label>
                <textarea
                  rows={2}
                  value={sf.description || ''}
                  onChange={e => patchStageForm(stage.id, { description: e.target.value })}
                  className="input resize-none"
                  placeholder="Что происходит на этом этапе"
                />
              </div>
            </div>

            {/* Дни этапа */}
            <div className="px-3 py-3 space-y-3 bg-gray-50/50">
              {stageDays.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-3">
                  В этом этапе пока нет дней. Этап может оставаться «анонсом» (только заголовок и диапазон дат) — или вы можете добавить программу по дням.
                </p>
              )}
              {stageDays.map(day => (
                <DayBlock
                  key={day.day_number}
                  day={day}
                  dayForm={dayForms[day.day_number] || {}}
                  sessions={sessions.filter(s => s.day === day.day_number).sort((a, b) => a.sort_order - b.sort_order)}
                  stages={stagesSorted}
                  onPatchDay={(patch) => patchDayForm(day.day_number, patch)}
                  onDelete={() => deleteDay(day.day_number)}
                  onAddSession={() => setSessionModal({ day: day.day_number })}
                  onDeleteSession={deleteSession}
                />
              ))}
              <button
                onClick={() => addDayToStage(stage.id)}
                className="w-full py-2 rounded-xl border border-dashed border-gray-200 text-xs text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-2"
              >
                <Plus size={13} /> Добавить день в этап
              </button>
            </div>
          </div>
        )
      })}

      {/* Дни без этапа */}
      {orphanDays.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-100 text-sm font-semibold text-gray-600 flex items-center gap-2">
            <Calendar size={14} className="opacity-60" />
            Без группировки
          </div>
          <div className="px-3 py-3 space-y-3">
            {orphanDays.map(day => (
              <DayBlock
                key={day.day_number}
                day={day}
                dayForm={dayForms[day.day_number] || {}}
                sessions={sessions.filter(s => s.day === day.day_number).sort((a, b) => a.sort_order - b.sort_order)}
                stages={stagesSorted}
                onPatchDay={(patch) => patchDayForm(day.day_number, patch)}
                onDelete={() => deleteDay(day.day_number)}
                onAddSession={() => setSessionModal({ day: day.day_number })}
                onDeleteSession={deleteSession}
              />
            ))}
          </div>
        </div>
      )}

      {/* Действия снизу */}
      {(stages.length > 0 || days.length > 0) && (
        <div className="flex flex-col gap-3">
          <button
            onClick={addStage}
            className="w-full py-3 rounded-2xl border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={16} /> Добавить этап
          </button>
          <button
            onClick={() => addDayToStage(null)}
            className="w-full py-2.5 rounded-2xl border border-dashed border-gray-200 text-xs text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-2"
          >
            <Plus size={13} /> Добавить день без этапа
          </button>
        </div>
      )}

      {/* Sticky-кнопка «Сохранить» */}
      {(dirtyStages.size > 0 || dirtyDays.size > 0) && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <button
            onClick={saveAll}
            disabled={savingAll}
            className="btn-gold px-7 py-3 rounded-2xl text-sm font-bold shadow-2xl flex items-center gap-2 disabled:opacity-70"
          >
            {savingAll ? <Spinner /> : <Save size={16} />}
            {savingAll ? 'Сохраняем...' : 'Сохранить программу'}
          </button>
        </div>
      )}

      {/* Модалка добавления сессии */}
      {sessionModal && (
        <Modal title={`Слот · день ${sessionModal.day}`} onClose={() => { setSessionModal(null); setSpeakerTopics([]); setCustomTitle(false) }}>
          <div className="space-y-3">
            <div>
              <label className="label">Спикер</label>
              <select value={sessionForm.speaker_id} onChange={e => onSpeakerChange(e.target.value)} className="input bg-white" autoFocus>
                <option value="">— без спикера —</option>
                {speakers.map((sp: any) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Тема выступления</label>
              {speakerTopics.length > 1 && !customTitle ? (
                <select
                  onChange={e => {
                    if (e.target.value === '__custom__') {
                      setCustomTitle(true)
                      setSessionForm(f => ({ ...f, topic_id: '', title: '' }))
                    } else {
                      const t = speakerTopics.find(x => String(x.id) === e.target.value)
                      setSessionForm(f => ({ ...f, topic_id: e.target.value, title: t?.topic || '' }))
                    }
                  }}
                  value={sessionForm.topic_id}
                  className="input bg-white"
                >
                  <option value="">— выберите тему —</option>
                  {speakerTopics.map(t => <option key={t.id} value={t.id}>{t.topic}</option>)}
                  <option value="__custom__">Другая тема...</option>
                </select>
              ) : (
                <div>
                  <input type="text" value={sessionForm.title}
                    onChange={e => setSessionForm(f => ({ ...f, title: e.target.value, topic_id: '' }))}
                    className="input" placeholder="Название слота" />
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
                <label className="label">Начало (МСК)</label>
                <input type="time" value={sessionForm.start_time}
                  onChange={e => setSessionForm(f => ({ ...f, start_time: e.target.value }))}
                  className="input" />
              </div>
              <div>
                <label className="label">Конец (МСК)</label>
                <input type="time" value={sessionForm.end_time}
                  onChange={e => setSessionForm(f => ({ ...f, end_time: e.target.value }))}
                  className="input" />
              </div>
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={addSession} disabled={!sessionForm.title.trim() || savingSession}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${savingSession ? 'btn-loading' : ''}`}>
              {savingSession ? <><Spinner /> Сохраняем...</> : 'Добавить слот'}
            </button>
            <button onClick={() => setSessionModal(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── Подкомпонент: блок дня ─────────────────────────────────────────────────────

function DayBlock({
  day, dayForm, sessions, stages,
  onPatchDay, onDelete, onAddSession, onDeleteSession,
}: {
  day: Day
  dayForm: Partial<Day>
  sessions: Sess[]
  stages: Stage[]
  onPatchDay: (patch: Partial<Day>) => void
  onDelete: () => void
  onAddSession: () => void
  onDeleteSession: (id: number) => void
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Calendar size={14} className="text-gray-400 shrink-0" />
          <span className="font-semibold text-gray-700">
            {dayForm.title || `День ${day.day_number}`}
          </span>
        </div>
        <button onClick={onDelete} className="text-gray-300 hover:text-red-400 transition-colors p-1" title="Удалить день">
          <Trash2 size={13} />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3 border-b border-gray-50">
        <div>
          <label className="label">Название дня (опционально)</label>
          <input
            type="text"
            value={dayForm.title || ''}
            onChange={e => onPatchDay({ title: e.target.value })}
            className="input"
            placeholder={`По умолчанию — «День ${day.day_number}»`}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Дата</label>
            <input
              type="date"
              value={dayForm.day_date || ''}
              onChange={e => onPatchDay({ day_date: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="label">Этап</label>
            <select
              value={dayForm.stage_id == null ? '' : String(dayForm.stage_id)}
              onChange={e => onPatchDay({ stage_id: e.target.value === '' ? null : Number(e.target.value) })}
              className="input bg-white"
            >
              <option value="">— без этапа —</option>
              {stages.map((s, i) => <option key={s.id} value={s.id}>Этап {i + 1}: {s.title}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Открытие (МСК)</label>
            <input
              type="time"
              value={dayForm.open_time || ''}
              onChange={e => onPatchDay({ open_time: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="label">Закрытие (МСК)</label>
            <input
              type="time"
              value={dayForm.close_time || ''}
              onChange={e => onPatchDay({ close_time: e.target.value })}
              className="input"
            />
          </div>
        </div>
      </div>

      <div className="px-4 py-2.5">
        {sessions.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-2">Нет слотов</p>
        ) : (
          <div className="space-y-1 mb-2">
            {sessions.map(s => (
              <div key={s.id} className="flex items-start gap-3 group py-1">
                <span className="text-[11px] text-gray-400 w-32 shrink-0 pt-0.5 font-mono whitespace-nowrap">
                  {s.start_time || ''}{s.end_time ? ` — ${s.end_time}` : ''}{s.start_time ? ' МСК' : ''}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{s.title}</p>
                  {s.speaker_name && <p className="text-xs text-gray-400">{s.speaker_name}</p>}
                </div>
                <button onClick={() => onDeleteSession(s.id)}
                  className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all p-1 rounded">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button onClick={onAddSession}
          className="text-xs text-brand hover:text-brand/80 flex items-center gap-1.5 transition-colors">
          <Plus size={13} /> Добавить слот
        </button>
      </div>
    </div>
  )
}
