'use client'
import { useState, useEffect } from 'react'
import { Plus, User, Trash2, Pencil } from 'lucide-react'
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

export default function SpeakersTab({ eventId }: { eventId: number }) {
  const { t } = useLang()
  const ts = t.conferences.speakers
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'new' | 'base' | 'edit' | null>(null)
  const [editSpeaker, setEditSpeaker] = useState<any>(null)
  const [editForm, setEditForm] = useState({ role: 'speaker', speaker_topic: '', gift_title: '', gift_url: '' })
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

  function openEdit(sp: any) {
    setEditSpeaker(sp)
    setEditForm({ role: sp.role, speaker_topic: sp.speaker_topic || '', gift_title: sp.gift_title || '', gift_url: sp.gift_url || '' })
    setModal('edit')
  }

  async function saveEdit() {
    if (!editSpeaker) return
    setSaving(true)
    try {
      await api.conference.speakers.update(eventId, editSpeaker.id, editForm)
      setModal(null); setEditSpeaker(null)
      load()
    } catch (err: any) { alert(err.message) } finally { setSaving(false) }
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
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                <button onClick={() => openEdit(sp)}
                  className="p-1.5 rounded-lg text-gray-300 hover:text-brand hover:bg-brand/10 transition-colors">
                  <Pencil size={14} />
                </button>
                <button onClick={() => remove(sp.id, sp.name)}
                  className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

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
                  {selectedBase.photo_url ? <img src={selectedBase.photo_url} className="w-full h-full object-cover" alt="" /> : <User size={15} className="text-gray-400" />}
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

      {modal === 'edit' && editSpeaker && (
        <Modal title={editSpeaker.name} onClose={() => { setModal(null); setEditSpeaker(null) }}>
          <div className="space-y-3">
            <div>
              <label className="label">{ts.newModal.role}</label>
              {roleSelect(editForm.role, (e: any) => setEditForm(f => ({ ...f, role: e.target.value })))}
            </div>
            <div>
              <label className="label">{ts.newModal.topic}</label>
              <input type="text" value={editForm.speaker_topic}
                onChange={e => setEditForm(f => ({ ...f, speaker_topic: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">{ts.newModal.giftTitle}</label>
              <input type="text" value={editForm.gift_title}
                onChange={e => setEditForm(f => ({ ...f, gift_title: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="label">{ts.newModal.giftUrl}</label>
              <input type="url" value={editForm.gift_url}
                onChange={e => setEditForm(f => ({ ...f, gift_url: e.target.value }))} className="input" placeholder="https://..." />
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button onClick={saveEdit} disabled={saving}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
              {saving ? <><Spinner /> {t.common.saving}</> : t.common.save}
            </button>
            <button onClick={() => { setModal(null); setEditSpeaker(null) }} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">{t.common.cancel}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
