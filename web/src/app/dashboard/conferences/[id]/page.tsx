'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Plus, Trash2, User, Calendar, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'

type Tab = 'settings' | 'speakers' | 'program'

// ─── SaveBar ─────────────────────────────────────────────────────────────────

function SaveBar({ saving, saved, onSave }: { saving: boolean; saved: boolean; onSave: () => void }) {
  const { t } = useLang()
  return (
    <div className="flex items-center gap-3 mt-6">
      <button
        onClick={onSave}
        disabled={saving}
        className={`btn-gold px-6 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 ${saving ? 'btn-loading' : ''}`}
      >
        {saving ? <><Spinner /> {t.common.saving}</> : <><Save size={15} /> {t.common.save}</>}
      </button>
      {saved && (
        <span className="flex items-center gap-1.5 text-sm text-green-600">
          <Check size={15} /> {t.common.saved}
        </span>
      )}
    </div>
  )
}

// ─── Modal ────────────────────────────────────────────────────────────────────

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

// ─── Вкладка: Настройки ───────────────────────────────────────────────────────

function SettingsTab({ eventId, conf, event, onConfUpdated }: { eventId: number; conf: any; event: any; onConfUpdated: (c: any) => void }) {
  const { t } = useLang()
  const [form, setForm] = useState({
    title: event?.title || '',
    description: conf?.description || '',
    registration_url: conf?.registration_url || '',
    subscription_mode: conf?.subscription_mode || 'none',
    organizer_speaker_id: conf?.organizer_speaker_id || '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [speakers, setSpeakers] = useState<any[]>([])

  useEffect(() => {
    api.conference.speakers.list(eventId)
      .then(r => setSpeakers(r.speakers || []))
      .catch(() => {})
  }, [eventId])

  useEffect(() => {
    setForm(f => ({
      ...f,
      description: conf?.description || '',
      registration_url: conf?.registration_url || '',
      subscription_mode: conf?.subscription_mode || 'none',
      organizer_speaker_id: conf?.organizer_speaker_id || '',
    }))
  }, [conf])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    setSaving(true); setSaved(false)
    try {
      await api.events.update(eventId, { title: form.title })
      const updated = await api.conference.update(eventId, {
        description: form.description || null,
        registration_url: form.registration_url || null,
        subscription_mode: form.subscription_mode,
        organizer_speaker_id: form.organizer_speaker_id ? Number(form.organizer_speaker_id) : null,
      })
      onConfUpdated(updated.conference)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

  const organizers = speakers.filter(s => s.role === 'organizer')
  const ts = t.conferences.settings

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">{ts.section}</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{ts.confTitle}</label>
          <input type="text" value={form.title} onChange={set('title')}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">{ts.description}</label>
          <textarea value={form.description} onChange={set('description') as any} rows={3}
            placeholder={ts.descPlaceholder}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            {ts.confUrl}
            <span className="text-gray-400 font-normal ml-1">{ts.confUrlHint}</span>
          </label>
          <input type="url" value={form.registration_url} onChange={set('registration_url')}
            placeholder="https://..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">{ts.organizer}</h2>
        <p className="text-sm text-gray-500">{ts.organizerHint}</p>
        <div>
          <select value={form.organizer_speaker_id} onChange={set('organizer_speaker_id')}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand bg-white">
            <option value="">{ts.organizerNone}</option>
            {organizers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
            {organizers.length === 0 && speakers.map(sp => (
              <option key={sp.id} value={sp.id}>{sp.name} ({t.conferences.speakers.roles[sp.role as keyof typeof t.conferences.speakers.roles] || sp.role})</option>
            ))}
          </select>
          {speakers.length === 0 && (
            <p className="text-xs text-gray-400 mt-1.5">{ts.organizerNoSpeakers}</p>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">{ts.subscription}</h2>
        <p className="text-sm text-gray-500">{ts.subscriptionHint}</p>
        {[
          { value: 'none',         label: ts.subNone,      desc: ts.subNoneDesc },
          { value: 'organizer',    label: ts.subOrganizer, desc: ts.subOrganizerDesc },
          { value: 'all_speakers', label: ts.subAll,       desc: ts.subAllDesc },
        ].map(opt => (
          <label key={opt.value}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
              form.subscription_mode === opt.value ? 'border-brand bg-brand/5' : 'border-gray-200 hover:border-gray-300'
            }`}>
            <input type="radio" name="sub_mode" value={opt.value}
              checked={form.subscription_mode === opt.value}
              onChange={() => setForm(f => ({ ...f, subscription_mode: opt.value }))}
              className="mt-0.5 accent-brand" />
            <div>
              <p className="text-sm font-medium text-gray-900">{opt.label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
            </div>
          </label>
        ))}
      </div>

      <SaveBar saving={saving} saved={saved} onSave={handleSave} />
    </div>
  )
}

// ─── Вкладка: Спикеры ─────────────────────────────────────────────────────────

function SpeakersTab({ eventId }: { eventId: number }) {
  const { t } = useLang()
  const ts = t.conferences.speakers
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'new' | 'base' | null>(null)
  const [form, setForm] = useState({ name: '', role: 'speaker', speaker_topic: '', gift_title: '', gift_url: '' })
  const [baseQuery, setBaseQuery] = useState('')
  const [baseList, setBaseList] = useState<any[]>([])
  const [baseLoading, setBaseLoading] = useState(false)
  const [selectedBase, setSelectedBase] = useState<any>(null)
  const [baseForm, setBaseForm] = useState({ role: 'speaker', speaker_topic: '', gift_title: '', gift_url: '' })
  const [saving, setSaving] = useState(false)

  function load() {
    setLoading(true)
    api.conference.speakers.list(eventId)
      .then(r => setSpeakers(r.speakers || []))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [eventId])

  async function searchBase(q: string) {
    setBaseLoading(true)
    try {
      const r = await api.collaborators.list(q || undefined)
      setBaseList(r.collaborators || [])
    } finally {
      setBaseLoading(false)
    }
  }
  useEffect(() => { if (modal === 'base') searchBase('') }, [modal])

  async function createNew() {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      await api.conference.speakers.create(eventId, { ...form })
      setModal(null); setForm({ name: '', role: 'speaker', speaker_topic: '', gift_title: '', gift_url: '' })
      load()
    } catch (err: any) { alert(err.message) } finally { setSaving(false) }
  }

  async function addFromBase() {
    if (!selectedBase) return
    setSaving(true)
    try {
      await api.conference.speakers.addFromBase(eventId, { speaker_id: selectedBase.id, ...baseForm })
      setModal(null); setSelectedBase(null); setBaseForm({ role: 'speaker', speaker_topic: '', gift_title: '', gift_url: '' })
      load()
    } catch (err: any) { alert(err.message) } finally { setSaving(false) }
  }

  async function remove(speakerEventId: number, name: string) {
    if (!confirm(ts.removeConfirm(name))) return
    await api.conference.speakers.delete(eventId, speakerEventId)
    load()
  }

  const setF = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))
  const setBF = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setBaseForm(f => ({ ...f, [k]: e.target.value }))

  const roleSelect = (val: string, onChange: any) => (
    <select value={val} onChange={onChange}
      className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand bg-white">
      {Object.entries(ts.roles).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </select>
  )

  return (
    <div className="max-w-2xl">
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-gray-500">{ts.count(speakers.length)}</p>
        <div className="flex gap-2">
          <button onClick={() => setModal('base')}
            className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2">
            <User size={15} /> {ts.fromBase}
          </button>
          <button onClick={() => setModal('new')}
            className="btn-gold px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2">
            <Plus size={15} /> {ts.newBtn}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>
      ) : speakers.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
          <User size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{ts.empty}</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          {speakers.map((sp, i) => (
            <div key={sp.id} className={`flex items-center gap-4 px-5 py-3.5 group hover:bg-gray-50 transition-colors ${i > 0 ? 'border-t border-gray-50' : ''}`}>
              <div className="w-9 h-9 rounded-full bg-gray-100 overflow-hidden flex items-center justify-center shrink-0">
                {sp.photo_url
                  ? <img src={sp.photo_url} alt={sp.name} className="w-full h-full object-cover" />
                  : <User size={16} className="text-gray-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 text-sm truncate">{sp.name}</p>
                <p className="text-xs text-gray-400">{ts.roles[sp.role as keyof typeof ts.roles] || sp.role}{sp.speaker_topic ? ` · ${sp.speaker_topic}` : ''}</p>
              </div>
              <button onClick={() => remove(sp.id, sp.name)}
                className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Modal: новый */}
      {modal === 'new' && (
        <Modal title={ts.newModal.title} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">{ts.newModal.nameLabel}</label>
              <input type="text" value={form.name} onChange={setF('name')} autoFocus className="input" placeholder={ts.newModal.namePlaceholder} />
            </div>
            <div>
              <label className="label">{ts.newModal.role}</label>
              {roleSelect(form.role, setF('role'))}
            </div>
            <div>
              <label className="label">{ts.newModal.topic}</label>
              <input type="text" value={form.speaker_topic} onChange={setF('speaker_topic')} className="input" />
            </div>
            <div>
              <label className="label">{ts.newModal.giftTitle}</label>
              <input type="text" value={form.gift_title} onChange={setF('gift_title')} className="input" />
            </div>
            <div>
              <label className="label">{ts.newModal.giftUrl}</label>
              <input type="url" value={form.gift_url} onChange={setF('gift_url')} className="input" placeholder="https://..." />
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={createNew} disabled={!form.name.trim() || saving}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
              {saving ? <><Spinner /> {t.common.saving}</> : ts.newModal.addBtn}
            </button>
            <button onClick={() => setModal(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">{t.common.cancel}</button>
          </div>
        </Modal>
      )}

      {/* Modal: из базы */}
      {modal === 'base' && (
        <Modal title={ts.baseModal.title} onClose={() => { setModal(null); setSelectedBase(null) }}>
          {!selectedBase ? (
            <>
              <input type="text" value={baseQuery} placeholder={t.common.searchPlaceholder}
                onChange={e => { setBaseQuery(e.target.value); searchBase(e.target.value) }}
                autoFocus className="input mb-3" />
              {baseLoading ? (
                <div className="flex justify-center py-6"><Spinner className="text-brand text-xl" /></div>
              ) : baseList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">{t.common.noResults}</p>
              ) : (
                <div className="border border-gray-100 rounded-xl overflow-hidden max-h-56 overflow-y-auto">
                  {baseList.map((sp, i) => (
                    <button key={sp.id} onClick={() => setSelectedBase(sp)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-brand/5 transition-colors ${i > 0 ? 'border-t border-gray-50' : ''}`}>
                      <div className="w-8 h-8 rounded-full bg-gray-100 overflow-hidden shrink-0 flex items-center justify-center">
                        {sp.photo_url ? <img src={sp.photo_url} alt={sp.name} className="w-full h-full object-cover" /> : <User size={14} className="text-gray-400" />}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{sp.name}</p>
                        {sp.title && <p className="text-xs text-gray-400">{sp.title}</p>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 rounded-xl">
                <div className="w-9 h-9 rounded-full bg-gray-100 overflow-hidden flex items-center justify-center">
                  {selectedBase.photo_url ? <img src={selectedBase.photo_url} className="w-full h-full object-cover" /> : <User size={15} className="text-gray-400" />}
                </div>
                <div className="flex-1">
                  <p className="font-medium text-sm">{selectedBase.name}</p>
                  {selectedBase.title && <p className="text-xs text-gray-400">{selectedBase.title}</p>}
                </div>
                <button onClick={() => setSelectedBase(null)} className="text-gray-400 hover:text-gray-600 text-xs underline">{ts.baseModal.changeBtn}</button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="label">{ts.baseModal.roleInConf}</label>
                  {roleSelect(baseForm.role, setBF('role'))}
                </div>
                <div>
                  <label className="label">{ts.baseModal.topic}</label>
                  <input type="text" value={baseForm.speaker_topic} onChange={setBF('speaker_topic')} className="input" />
                </div>
                <div>
                  <label className="label">{ts.baseModal.giftTitle}</label>
                  <input type="text" value={baseForm.gift_title} onChange={setBF('gift_title')} className="input" />
                </div>
                <div>
                  <label className="label">{ts.baseModal.giftUrl}</label>
                  <input type="url" value={baseForm.gift_url} onChange={setBF('gift_url')} className="input" placeholder="https://..." />
                </div>
              </div>
              <div className="flex gap-3 mt-5">
                <button onClick={addFromBase} disabled={saving}
                  className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
                  {saving ? <><Spinner /> {t.common.adding}</> : ts.baseModal.addBtn}
                </button>
                <button onClick={() => { setModal(null); setSelectedBase(null) }} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">{t.common.cancel}</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

// ─── Вкладка: Программа ──────────────────────────────────────────────────────

function ProgramTab({ eventId }: { eventId: number }) {
  const { t } = useLang()
  const tp = t.conferences.program
  const [days, setDays] = useState<any[]>([])
  const [sessions, setSessions] = useState<any[]>([])
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [savingDay, setSavingDay] = useState<number | null>(null)
  const [dayForms, setDayForms] = useState<Record<number, any>>({})
  const [sessionModal, setSessionModal] = useState<{ day: number } | null>(null)
  const [sessionForm, setSessionForm] = useState({ title: '', speaker_id: '', start_time: '', end_time: '' })
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
        title: sessionForm.title,
        speaker_id: sessionForm.speaker_id ? Number(sessionForm.speaker_id) : null,
        start_datetime: startDt,
        end_datetime: endDt,
      })
      setSessionModal(null)
      setSessionForm({ title: '', speaker_id: '', start_time: '', end_time: '' })
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
                      <span className="text-xs text-gray-400 w-12 shrink-0 pt-0.5 font-mono">
                        {s.start_datetime ? new Date(s.start_datetime).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '—:——'}
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

      {/* Modal: сессия */}
      {sessionModal && (
        <Modal title={tp.sessionModal.title(sessionModal.day)} onClose={() => setSessionModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">{tp.sessionModal.topicLabel}</label>
              <input type="text" value={sessionForm.title} autoFocus
                onChange={e => setSessionForm(f => ({ ...f, title: e.target.value }))}
                className="input" placeholder={tp.sessionModal.topicPlaceholder} />
            </div>
            <div>
              <label className="label">{tp.sessionModal.speaker}</label>
              <select value={sessionForm.speaker_id}
                onChange={e => setSessionForm(f => ({ ...f, speaker_id: e.target.value }))}
                className="input bg-white">
                <option value="">{tp.sessionModal.noSpeaker}</option>
                {speakers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
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

      {/* Modal: JSON */}
      {jsonModal && (
        <Modal title={tp.jsonModal.title} onClose={() => setJsonModal(false)}>
          <p className="text-xs text-gray-500 mb-3">
            {tp.jsonModal.hint} <code className="bg-gray-100 px-1 rounded">title</code> ({t.lang === 'ru' ? 'или' : 'or'} <code className="bg-gray-100 px-1 rounded">topic</code>), <code className="bg-gray-100 px-1 rounded">time</code> (HH:MM).
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

// ─── Главная страница конференции ─────────────────────────────────────────────

export default function ConferencePage() {
  const { id } = useParams()
  const eventId = Number(id)
  const { t } = useLang()
  const [tab, setTab] = useState<Tab>('settings')
  const [event, setEvent] = useState<any>(null)
  const [conf, setConf] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const TABS: { id: Tab; label: string }[] = [
    { id: 'settings', label: t.conferences.tabs.settings },
    { id: 'speakers', label: t.conferences.tabs.speakers },
    { id: 'program',  label: t.conferences.tabs.program },
  ]

  useEffect(() => {
    Promise.all([
      api.events.get(eventId),
      api.conference.get(eventId),
    ]).then(([evRes, confRes]) => {
      setEvent(evRes.event)
      setConf(confRes.conference)
    }).finally(() => setLoading(false))
  }, [eventId])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="text-brand text-3xl" />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/conferences" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{event?.title || t.conferences.header.defaultTitle}</h1>
          <p className="text-gray-400 text-sm">
            {conf?.status === 'active' ? t.conferences.header.active : t.conferences.header.draft}
          </p>
        </div>
      </div>

      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 w-fit">
        {TABS.map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === tb.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === 'settings' && <SettingsTab eventId={eventId} conf={conf} event={event} onConfUpdated={setConf} />}
      {tab === 'speakers' && <SpeakersTab eventId={eventId} />}
      {tab === 'program'  && <ProgramTab  eventId={eventId} />}
    </div>
  )
}
