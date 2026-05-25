'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, User, Trash2, Pencil, X, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import { ImageThumb } from '@/components/ImagePreview'
import { useMe } from '@/hooks/useMe'

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

/** Компонент для редактирования списка тем */
function TopicsEditor({ topics, onChange }: { topics: string[]; onChange: (topics: string[]) => void }) {
  function updateTopic(i: number, val: string) {
    const next = [...topics]
    next[i] = val
    onChange(next)
  }
  function removeTopic(i: number) {
    onChange(topics.filter((_, idx) => idx !== i))
  }
  function addTopic() {
    onChange([...topics, ''])
  }

  return (
    <div className="space-y-2">
      {topics.map((t, i) => (
        <div key={i} className="flex items-start gap-2">
          <textarea
            value={t}
            onChange={e => updateTopic(i, e.target.value)}
            rows={2}
            placeholder={`Тема ${i + 1}`}
            className="input flex-1 resize-none text-sm"
          />
          {topics.length > 1 && (
            <button
              type="button"
              onClick={() => removeTopic(i)}
              className="mt-1 p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={addTopic}
        className="flex items-center gap-1.5 text-xs text-brand hover:text-brand/80 transition-colors py-1"
      >
        <Plus size={13} /> Добавить тему
      </button>
    </div>
  )
}

const emptyEventForm = { role: 'speaker', topics: [''], gift_title: '', gift_url: '', is_commercial: false }

function hasNoTopics(sp: any): boolean {
  const topics: string[] = sp.topics && sp.topics.length > 0
    ? sp.topics.map((t: any) => typeof t === 'string' ? t : t.topic)
    : (sp.speaker_topic ? [sp.speaker_topic] : [])
  return topics.length === 0 || topics.every(t => !t.trim())
}

function getMissingGiftLabels(sp: any): string[] {
  const missing: string[] = []
  if (!sp.gift_after_speech_title?.trim()) missing.push('нет названия подарка после эфира')
  if (!sp.gift_after_speech_url?.trim()) missing.push('нет ссылки подарка после эфира')
  if (!sp.gift_raffle_title?.trim()) missing.push('нет названия подарка розыгрыша')
  if (!sp.gift_raffle_url?.trim()) missing.push('нет ссылки на подарок розыгрыша')
  return missing
}

export default function SpeakersTab({ eventId }: { eventId: number }) {
  const router = useRouter()
  const { t } = useLang()
  const { isAssistant } = useMe()
  const ts = t.conferences.speakers
  const [speakers, setSpeakers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<'new' | 'base' | 'edit' | null>(null)
  const [editSpeaker, setEditSpeaker] = useState<any>(null)
  const [editForm, setEditForm] = useState({ role: 'speaker', topics: [''], gift_title: '', gift_url: '', is_commercial: false })
  const [form, setForm] = useState({
    name: '', role: 'speaker', topics: [''], gift_title: '', gift_url: '', is_commercial: false,
    personal_tg_username: '', personal_vk_username: '', personal_max_username: '',
  })
  const [baseQuery, setBaseQuery] = useState('')
  const [baseList, setBaseList] = useState<any[]>([])
  const [baseLoading, setBaseLoading] = useState(false)
  const [selectedBase, setSelectedBase] = useState<any>(null)
  const [baseForm, setBaseForm] = useState({ role: 'speaker', topics: [''], gift_title: '', gift_url: '', is_commercial: false })
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

  // Возможные match'и контактов с тем же именем — приходят с бэка как needs_choice.
  // UI: модалка с выбором «использовать существующего» / «создать нового всё равно».
  const [nameChoice, setNameChoice] = useState<{ matches: any[]; payload: any } | null>(null)

  async function createNew(opts?: { force_create?: boolean; existing_contact_id?: number | null }) {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const topics = form.topics.filter(t => t.trim())
      const payload: any = { ...form, topics, ...(opts || {}) }
      const res = await api.conference.speakers.create(eventId, payload)
      if (res?.needs_choice) {
        setNameChoice({ matches: res.matches || [], payload })
        return
      }
      setModal(null)
      setNameChoice(null)
      setForm({
        name: '', role: 'speaker', topics: [''], gift_title: '', gift_url: '', is_commercial: false,
        personal_tg_username: '', personal_vk_username: '', personal_max_username: '',
      })
      load()
    } catch (err: any) { alert(err.message) } finally { setSaving(false) }
  }

  async function addFromBase() {
    if (!selectedBase) return
    setSaving(true)
    try {
      const topics = baseForm.topics.filter(t => t.trim())
      await api.conference.speakers.addFromBase(eventId, { speaker_id: selectedBase.id, ...baseForm, topics })
      setModal(null)
      setSelectedBase(null)
      setBaseForm({ role: 'speaker', topics: [''], gift_title: '', gift_url: '', is_commercial: false })
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
    const rawTopics = sp.topics && sp.topics.length > 0 ? sp.topics : (sp.speaker_topic ? [sp.speaker_topic] : [''])
    const topics = rawTopics.map((t: any) => typeof t === 'string' ? t : t.topic)
    setEditForm({
      role: sp.role,
      topics,
      gift_title: sp.gift_title || '',
      gift_url: sp.gift_url || '',
      is_commercial: sp.is_commercial || false
    })
    setModal('edit')
  }

  async function saveEdit() {
    if (!editSpeaker) return
    setSaving(true)
    try {
      const topics = editForm.topics.filter(t => t.trim())
      await api.conference.speakers.update(eventId, editSpeaker.id, { ...editForm, topics })
      setModal(null)
      setEditSpeaker(null)
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
          {speakers.map((sp, i) => {
            const topics: string[] = sp.topics && sp.topics.length > 0
              ? sp.topics.map((t: any) => typeof t === 'string' ? t : t.topic)
              : (sp.speaker_topic ? [sp.speaker_topic] : [])
            return (
              <div
                key={sp.id}
                onClick={() => router.push(`/dashboard/conferences/${eventId}/speakers/${sp.id}`)}
                className={`flex items-center gap-4 px-5 py-3.5 group hover:bg-gray-50 transition-colors cursor-pointer ${i > 0 ? 'border-t border-gray-50' : ''}`}
              >
                <div className="w-9 h-9 rounded-full bg-gray-100 overflow-hidden flex items-center justify-center shrink-0">
                  {sp.photo_url
                    ? <ImageThumb url={sp.photo_url} alt={sp.name} className="w-full h-full block" />
                    : <User size={16} className="text-gray-400" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-gray-900 text-sm truncate group-hover:text-brand transition-colors">
                      {sp.name}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">
                    {ts.roles[sp.role as keyof typeof ts.roles] || sp.role}
                    {sp.is_commercial && <span className="ml-1 text-amber-500">· коммерч.</span>}
                  </p>
                  <div className="mt-0.5">
                    {topics.length > 0 ? (
                      <div className="space-y-0.5">
                        {topics.map((topic, ti) => (
                          <p key={ti} className="text-xs text-gray-500 truncate">
                            {topics.length > 1 && <span className="text-gray-300 mr-1">{ti + 1}.</span>}
                            {topic}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <span className="flex items-center gap-0.5 text-xs text-amber-500">
                        <AlertTriangle size={11} /> нет темы выступления
                      </span>
                    )}
                    {getMissingGiftLabels(sp).map(label => (
                      <span key={label} className="flex items-center gap-0.5 text-xs text-amber-500">
                        <AlertTriangle size={11} /> {label}
                      </span>
                    ))}
                  </div>
                </div>
                {sp.poster_url && (
                  <div className="w-8 shrink-0">
                    <ImageThumb url={sp.poster_url} alt={`Афиша ${sp.name}`}
                      className="w-8 h-12 rounded overflow-hidden block bg-gray-100" />
                  </div>
                )}
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all" onClick={e => e.stopPropagation()}>
                  <button onClick={(e) => { e.stopPropagation(); openEdit(sp) }}
                    className="p-1.5 rounded-lg text-gray-300 hover:text-brand hover:bg-brand/10 transition-colors">
                    <Pencil size={14} />
                  </button>
                  {!isAssistant && (
                    <button onClick={(e) => { e.stopPropagation(); remove(sp.id, sp.name) }}
                      className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal === 'new' && (
        <Modal title={ts.newModal.title} onClose={() => setModal(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">{ts.newModal.nameLabel}</label>
              <input type="text" value={form.name} onChange={setF('name')} autoFocus className="input" placeholder={ts.newModal.namePlaceholder} />
            </div>

            {/* Личный контакт спикера (одна из платформ обязательна) — миграция 108 */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
              <div className="text-xs text-amber-900 font-medium">Личный аккаунт спикера — нужен минимум один (для отправки инструкции по самозаполнению)</div>
              <input type="text" value={form.personal_tg_username} onChange={setF('personal_tg_username')}
                className="input" placeholder="Telegram username (без @)" />
              <input type="text" value={form.personal_vk_username} onChange={setF('personal_vk_username')}
                className="input" placeholder="VK username (id123456 или nickname)" />
              <input type="text" value={form.personal_max_username} onChange={setF('personal_max_username')}
                className="input" placeholder="MAX username" />
            </div>

            <div>
              <label className="label">{ts.newModal.role}</label>
              {roleSelect(form.role, setF('role'))}
            </div>
            <div>
              <label className="label">{ts.newModal.topic}</label>
              <TopicsEditor topics={form.topics} onChange={topics => setForm(f => ({ ...f, topics }))} />
            </div>
            <div>
              <label className="label">{ts.newModal.giftTitle}</label>
              <input type="text" value={form.gift_title} onChange={setF('gift_title')} className="input" />
            </div>
            <div>
              <label className="label">{ts.newModal.giftUrl}</label>
              <input type="url" value={form.gift_url} onChange={setF('gift_url')} className="input" placeholder="https://..." />
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={form.is_commercial} onChange={e => setForm(f => ({ ...f, is_commercial: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-300 text-brand" />
              <span className="text-sm text-gray-700">{ts.newModal.isCommercial}</span>
            </label>
          </div>
          <div className="flex gap-3 mt-5">
            {(() => {
              // Минимум один личный ник (TG/VK/MAX) обязателен — иначе бэк
              // вернёт 422 (нельзя отправить спикеру invite на самозаполнение).
              const hasPersonal =
                !!form.personal_tg_username?.trim() ||
                !!form.personal_vk_username?.trim() ||
                !!form.personal_max_username?.trim()
              const canSubmit = !!form.name.trim() && hasPersonal && !saving
              return (
                <button onClick={() => createNew()} disabled={!canSubmit}
                  title={!form.name.trim() ? 'Заполните имя' : (!hasPersonal ? 'Заполните хотя бы один личный аккаунт (TG / VK / MAX)' : '')}
                  className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''} ${!canSubmit ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {saving ? <><Spinner /> {t.common.saving}</> : ts.newModal.addBtn}
                </button>
              )
            })()}
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
                  <TopicsEditor topics={baseForm.topics} onChange={topics => setBaseForm(f => ({ ...f, topics }))} />
                </div>
                <div>
                  <label className="label">{ts.baseModal.giftTitle}</label>
                  <input type="text" value={baseForm.gift_title} onChange={setBF('gift_title')} className="input" />
                </div>
                <div>
                  <label className="label">{ts.baseModal.giftUrl}</label>
                  <input type="url" value={baseForm.gift_url} onChange={setBF('gift_url')} className="input" placeholder="https://..." />
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={baseForm.is_commercial} onChange={e => setBaseForm(f => ({ ...f, is_commercial: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-brand" />
                  <span className="text-sm text-gray-700">{ts.baseModal.isCommercial}</span>
                </label>
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
              <TopicsEditor topics={editForm.topics} onChange={topics => setEditForm(f => ({ ...f, topics }))} />
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
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={editForm.is_commercial} onChange={e => setEditForm(f => ({ ...f, is_commercial: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-300 text-brand" />
              <span className="text-sm text-gray-700">{ts.newModal.isCommercial}</span>
            </label>
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

      {/* Выбор при совпадении имени: использовать существующего контакта или создать нового всё равно */}
      {nameChoice && (
        <Modal title="Похожий контакт уже есть" onClose={() => setNameChoice(null)}>
          <p className="text-sm text-gray-600 mb-3">
            У вас уже есть {nameChoice.matches.length === 1 ? 'контакт' : 'контакты'} с именем
            <b> «{form.name.trim()}»</b>. Используем существующий или создать ещё одного?
          </p>
          <div className="space-y-2 mb-4">
            {nameChoice.matches.map(m => (
              <button
                key={m.id}
                onClick={() => createNew({ existing_contact_id: m.id })}
                disabled={m.has_collab || saving}
                className="w-full text-left p-3 rounded-xl border border-gray-200 hover:border-brand hover:bg-brand/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title={m.has_collab ? 'У этого контакта уже есть коллаборатор' : 'Привязать спикера к этому контакту'}
              >
                <div className="font-medium text-gray-900">{m.name}</div>
                {(m.email || m.phone) && (
                  <div className="text-xs text-gray-400 mt-0.5">{[m.email, m.phone].filter(Boolean).join(' · ')}</div>
                )}
                {m.has_collab && <div className="text-xs text-amber-600 mt-1">⚠️ У этого контакта уже есть коллаборатор</div>}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => createNew({ force_create: true })}
              disabled={saving}
              className={`btn-gold flex-1 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}
            >
              {saving ? <><Spinner /> Создаём...</> : 'Всё равно создать нового'}
            </button>
            <button onClick={() => setNameChoice(null)} className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
              Отмена
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
