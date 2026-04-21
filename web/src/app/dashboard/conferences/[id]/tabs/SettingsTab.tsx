'use client'
import { useState, useEffect } from 'react'
import { Save, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'

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

export default function SettingsTab({ eventId, conf, event, onConfUpdated }: {
  eventId: number
  conf: any
  event: any
  onConfUpdated: (c: any) => void
}) {
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
            {organizers.length > 0
              ? organizers.map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)
              : speakers.map(sp => (
                  <option key={sp.id} value={sp.id}>
                    {sp.name} ({t.conferences.speakers.roles[sp.role as keyof typeof t.conferences.speakers.roles] || sp.role})
                  </option>
                ))
            }
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
