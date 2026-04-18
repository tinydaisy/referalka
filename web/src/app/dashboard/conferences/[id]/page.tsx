'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Plus, Trash2, User, Calendar, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'

type Tab = 'settings' | 'speakers' | 'program'

const TABS: { id: Tab; label: string }[] = [
  { id: 'settings', label: 'Настройки' },
  { id: 'speakers', label: 'Спикеры' },
  { id: 'program',  label: 'Программа' },
]

const ROLE_LABELS: Record<string, string> = {
  organizer: 'Организатор', headliner: 'Хедлайнер',
  speaker: 'Спикер', partner: 'Партнёр',
  commercial: 'Коммерческий', general_partner: 'Генеральный партнёр',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SaveBar({ saving, saved, onSave }: { saving: boolean; saved: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center gap-3 mt-6">
      <button
        onClick={onSave}
        disabled={saving}
        className={`btn-gold px-6 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-2 ${saving ? 'btn-loading' : ''}`}
      >
        {saving ? <><Spinner /> Сохраняем...</> : <><Save size={15} /> Сохранить</>}
      </button>
      {saved && (
        <span className="flex items-center gap-1.5 text-sm text-green-600">
          <Check size={15} /> Сохранено
        </span>
      )}
    </div>
  )
}

// ─── Вкладка: Настройки ───────────────────────────────────────────────────────

function SettingsTab({ eventId, conf, event, onConfUpdated }: { eventId: number; conf: any; event: any; onConfUpdated: (c: any) => void }) {
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

  // Синхронизация при обновлении conf снаружи
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
      // Обновляем название события
      await api.events.update(eventId, { title: form.title })
      // Обновляем настройки конференции
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

  // Организаторы — только роль organizer из спикеров события
  const organizers = speakers.filter(s => s.role === 'organizer')

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Название */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">Основное</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Название конференции</label>
          <input
            type="text" value={form.title} onChange={set('title')}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Описание</label>
          <textarea
            value={form.description} onChange={set('description') as any} rows={3}
            placeholder="Краткое описание конференции..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на конференцию
            <span className="text-gray-400 font-normal ml-1">— лендинг или страница регистрации</span>
          </label>
          <input
            type="url" value={form.registration_url} onChange={set('registration_url')}
            placeholder="https://..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand"
          />
        </div>
      </div>

      {/* Организатор */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
        <h2 className="font-semibold text-gray-900">Организатор</h2>
        <p className="text-sm text-gray-500">
          Выберите организатора из спикеров этой конференции. Добавьте спикера с ролью «Организатор» на вкладке Спикеры — он появится здесь.
        </p>
        <div>
          <select
            value={form.organizer_speaker_id}
            onChange={set('organizer_speaker_id')}
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand bg-white"
          >
            <option value="">— не выбран —</option>
            {organizers.map(sp => (
              <option key={sp.id} value={sp.id}>{sp.name}</option>
            ))}
            {/* Если среди спикеров нет организатора — показываем всех */}
            {organizers.length === 0 && speakers.map(sp => (
              <option key={sp.id} value={sp.id}>{sp.name} ({ROLE_LABELS[sp.role] || sp.role})</option>
            ))}
          </select>
          {speakers.length === 0 && (
            <p className="text-xs text-gray-400 mt-1.5">Сначала добавьте спикеров на вкладке «Спикеры»</p>
          )}
        </div>
      </div>

      {/* Подписка */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-3">
        <h2 className="font-semibold text-gray-900">Требование подписки</h2>
        <p className="text-sm text-gray-500">Участник должен подписаться на канал(ы) перед доступом к реферальной игре.</p>

        {[
          { value: 'none',          label: 'Не требовать подписки', desc: 'Игра доступна сразу' },
          { value: 'organizer',     label: 'Только канал организатора', desc: 'Подписка на один канал' },
          { value: 'all_speakers',  label: 'Каналы всех спикеров', desc: 'Подписка на все каналы спикеров события' },
        ].map(opt => (
          <label
            key={opt.value}
            className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
              form.subscription_mode === opt.value ? 'border-brand bg-brand/5' : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <input
              type="radio" name="sub_mode" value={opt.value}
              checked={form.subscription_mode === opt.value}
              onChange={() => setForm(f => ({ ...f, subscription_mode: opt.value }))}
              className="mt-0.5 accent-brand"
            />
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
      const r = await api.speakers.list(q || undefined)
      setBaseList(r.speakers || [])
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
    if (!confirm(`Убрать «${name}» из конференции?`)) return
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
      {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
    </select>
  )

  return (
    <div className="max-w-2xl">
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-gray-500">{speakers.length} спикеров в конференции</p>
        <div className="flex gap-2">
          <button onClick={() => setModal('base')}
            className="px-4 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2">
            <User size={15} /> Из базы
          </button>
          <button onClick={() => setModal('new')}
            className="btn-gold px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2">
            <Plus size={15} /> Новый
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner className="text-brand text-2xl" /></div>
      ) : speakers.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-gray-400">
          <User size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">Спикеры ещё не добавлены</p>
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
                <p className="text-xs text-gray-400">{ROLE_LABELS[sp.role] || sp.role}{sp.speaker_topic ? ` · ${sp.speaker_topic}` : ''}</p>
              </div>
              <button onClick={() => remove(sp.id, sp.name)}
                className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Модал: новый спикер */}
      {modal === 'new' && (
        <Modal title="Новый спикер" onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Имя и фамилия *</label>
              <input type="text" value={form.name} onChange={setF('name')} autoFocus className="input" placeholder="Иван Иванов" />
            </div>
            <div>
              <label className="label">Роль</label>
              {roleSelect(form.role, setF('role'))}
            </div>
            <div>
              <label className="label">Тема выступления</label>
              <input type="text" value={form.speaker_topic} onChange={setF('speaker_topic')} className="input" />
            </div>
            <div>
              <label className="label">Подарок (название)</label>
              <input type="text" value={form.gift_title} onChange={setF('gift_title')} className="input" />
            </div>
            <div>
              <label className="label">Ссылка на подарок</label>
              <input type="url" value={form.gift_url} onChange={setF('gift_url')} className="input" placeholder="https://..." />
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={createNew} disabled={!form.name.trim() || saving}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
              {saving ? <><Spinner /> Сохраняем...</> : 'Добавить спикера'}
            </button>
            <button onClick={() => setModal(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
          </div>
        </Modal>
      )}

      {/* Модал: из базы */}
      {modal === 'base' && (
        <Modal title="Добавить из базы спикеров" onClose={() => { setModal(null); setSelectedBase(null) }}>
          {!selectedBase ? (
            <>
              <input
                type="text" value={baseQuery} placeholder="Поиск по имени..."
                onChange={e => { setBaseQuery(e.target.value); searchBase(e.target.value) }}
                autoFocus
                className="input mb-3"
              />
              {baseLoading ? (
                <div className="flex justify-center py-6"><Spinner className="text-brand text-xl" /></div>
              ) : baseList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">Ничего не найдено</p>
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
                <button onClick={() => setSelectedBase(null)} className="text-gray-400 hover:text-gray-600 text-xs underline">изменить</button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="label">Роль в этой конференции</label>
                  {roleSelect(baseForm.role, setBF('role'))}
                </div>
                <div>
                  <label className="label">Тема выступления</label>
                  <input type="text" value={baseForm.speaker_topic} onChange={setBF('speaker_topic')} className="input" />
                </div>
                <div>
                  <label className="label">Подарок (название)</label>
                  <input type="text" value={baseForm.gift_title} onChange={setBF('gift_title')} className="input" />
                </div>
                <div>
                  <label className="label">Ссылка на подарок</label>
                  <input type="url" value={baseForm.gift_url} onChange={setBF('gift_url')} className="input" placeholder="https://..." />
                </div>
              </div>
              <div className="flex gap-3 mt-5">
                <button onClick={addFromBase} disabled={saving}
                  className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
                  {saving ? <><Spinner /> Добавляем...</> : 'Добавить в конференцию'}
                </button>
                <button onClick={() => { setModal(null); setSelectedBase(null) }} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
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
      // инициализируем формы дней
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
      await api.conference.days.upsert(eventId, dayNum, {
        day_date: f.day_date || null,
        stream_url: f.stream_url || null,
      })
    } catch (err: any) { alert(err.message) } finally { setSavingDay(null) }
  }

  async function deleteDay(dayNum: number) {
    if (!confirm(`Удалить День ${dayNum}? Все сессии этого дня тоже удалятся.`)) return
    const daySessions = sessions.filter((s: any) => s.day === dayNum)
    await Promise.all(daySessions.map((s: any) => api.conference.sessions.delete(eventId, s.id)))
    // Удаляем день через уpsert с пустыми данными не получится — нет DELETE endpoint.
    // Перебираем оставшиеся дни с новой нумерацией
    const remaining = days.filter((d: any) => d.day_number !== dayNum)
    // Просто обновляем локальное состояние (день без сессий)
    setDays(remaining)
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
      if (!Array.isArray(slots)) throw new Error('Ожидается массив объектов')
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
      alert('Ошибка в JSON: ' + err.message)
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
          <p className="text-sm mb-4">Дни конференции ещё не добавлены</p>
          <button onClick={addDay} className="btn-gold px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2 mx-auto">
            <Plus size={15} /> Добавить День 1
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
            {/* Day header */}
            <div className="gradient-bg px-5 py-3.5 flex items-center justify-between">
              <span className="text-white font-semibold">День {dayNum}</span>
              <button onClick={() => deleteDay(dayNum)} className="text-white/50 hover:text-red-300 transition-colors">
                <Trash2 size={15} />
              </button>
            </div>

            {/* Day settings */}
            <div className="px-5 py-4 border-b border-gray-50 flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="label">Дата</label>
                <input
                  type="date"
                  value={df.day_date || ''}
                  onChange={e => setDayForms(f => ({ ...f, [dayNum]: { ...df, day_date: e.target.value } }))}
                  className="input"
                />
              </div>
              <div className="flex-1">
                <label className="label">Ссылка на вебинарную комнату</label>
                <input
                  type="url"
                  value={df.stream_url || ''}
                  placeholder="https://..."
                  onChange={e => setDayForms(f => ({ ...f, [dayNum]: { ...df, stream_url: e.target.value } }))}
                  className="input"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => saveDay(dayNum)}
                  disabled={isSavingThis}
                  className={`h-10 px-4 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2 transition-colors ${isSavingThis ? 'btn-loading' : ''}`}
                >
                  {isSavingThis ? <Spinner /> : <Save size={14} />}
                </button>
              </div>
            </div>

            {/* Sessions */}
            <div className="px-5 py-3">
              {daySessions.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-3">Сессии не добавлены</p>
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

              {/* Add session buttons */}
              <div className="flex gap-2 pt-1 pb-1">
                <button
                  onClick={() => setSessionModal({ day: dayNum })}
                  className="text-xs text-brand hover:text-brand/80 flex items-center gap-1.5 transition-colors"
                >
                  <Plus size={13} /> Добавить сессию
                </button>
                <span className="text-gray-300">·</span>
                <button
                  onClick={() => { setJsonDay(dayNum); setJsonModal(true) }}
                  className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1.5 transition-colors"
                >
                  Импорт из JSON
                </button>
              </div>
            </div>
          </div>
        )
      })}

      {days.length > 0 && (
        <button onClick={addDay}
          className="w-full py-3 rounded-2xl border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-2">
          <Plus size={16} /> Добавить ещё день
        </button>
      )}

      {/* Модал: добавить сессию */}
      {sessionModal && (
        <Modal title={`Новая сессия — День ${sessionModal.day}`} onClose={() => setSessionModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Название / тема *</label>
              <input type="text" value={sessionForm.title} autoFocus
                onChange={e => setSessionForm(f => ({ ...f, title: e.target.value }))}
                className="input" placeholder="Тема выступления или блока" />
            </div>
            <div>
              <label className="label">Спикер</label>
              <select value={sessionForm.speaker_id}
                onChange={e => setSessionForm(f => ({ ...f, speaker_id: e.target.value }))}
                className="input bg-white">
                <option value="">— без спикера —</option>
                {speakers.map(sp => (
                  <option key={sp.id} value={sp.id}>{sp.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Начало</label>
                <input type="time" value={sessionForm.start_time}
                  onChange={e => setSessionForm(f => ({ ...f, start_time: e.target.value }))}
                  className="input" />
              </div>
              <div>
                <label className="label">Конец</label>
                <input type="time" value={sessionForm.end_time}
                  onChange={e => setSessionForm(f => ({ ...f, end_time: e.target.value }))}
                  className="input" />
              </div>
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={addSession} disabled={!sessionForm.title.trim() || savingSession}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${savingSession ? 'btn-loading' : ''}`}>
              {savingSession ? <><Spinner /> Сохраняем...</> : 'Добавить'}
            </button>
            <button onClick={() => setSessionModal(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
          </div>
        </Modal>
      )}

      {/* Модал: импорт JSON */}
      {jsonModal && (
        <Modal title="Импорт программы из JSON" onClose={() => setJsonModal(false)}>
          <p className="text-xs text-gray-500 mb-3">
            Вставьте массив объектов. Поддерживаемые поля: <code className="bg-gray-100 px-1 rounded">title</code> (или <code className="bg-gray-100 px-1 rounded">topic</code>), <code className="bg-gray-100 px-1 rounded">time</code> (HH:MM).
          </p>
          <p className="text-xs text-gray-400 mb-2">Пример: <code className="bg-gray-100 px-1 rounded">[&#123;"time":"10:00","title":"Открытие"&#125;]</code></p>
          <textarea
            value={jsonInput} onChange={e => setJsonInput(e.target.value)}
            rows={6} autoFocus placeholder='[{"time":"10:00","title":"Открытие"}]'
            className="input resize-none font-mono text-xs"
          />
          <div className="flex gap-3 mt-4">
            <button onClick={importJson} disabled={!jsonInput.trim() || importingJson}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${importingJson ? 'btn-loading' : ''}`}>
              {importingJson ? <><Spinner /> Импортируем...</> : 'Импортировать'}
            </button>
            <button onClick={() => setJsonModal(false)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">Отмена</button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── Modal wrapper ────────────────────────────────────────────────────────────

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

// ─── Главная страница конференции ─────────────────────────────────────────────

export default function ConferencePage() {
  const { id } = useParams()
  const eventId = Number(id)
  const [tab, setTab] = useState<Tab>('settings')
  const [event, setEvent] = useState<any>(null)
  const [conf, setConf] = useState<any>(null)
  const [loading, setLoading] = useState(true)

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
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/dashboard/conferences" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{event?.title || 'Конференция'}</h1>
          <p className="text-gray-400 text-sm">{conf?.status === 'active' ? 'Активна' : 'Черновик'}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 w-fit">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'settings' && (
        <SettingsTab eventId={eventId} conf={conf} event={event} onConfUpdated={setConf} />
      )}
      {tab === 'speakers' && <SpeakersTab eventId={eventId} />}
      {tab === 'program'  && <ProgramTab  eventId={eventId} />}
    </div>
  )
}
