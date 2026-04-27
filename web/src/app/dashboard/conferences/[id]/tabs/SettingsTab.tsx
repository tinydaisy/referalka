'use client'
import { useState, useEffect } from 'react'
import { Save, Check } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import PublicLinks from '@/components/PublicLinks'

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
  const [chatIdsError, setChatIdsError] = useState('')
  const [form, setForm] = useState({
    title: event?.title || '',
    description: conf?.description || '',
    registration_url: conf?.registration_url || '',
    raffle_url: conf?.raffle_url || '',
    subscription_mode: conf?.subscription_mode || 'none',
    telegram_chat_ids: conf?.telegram_chat_ids || '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setForm(f => ({
      ...f,
      description: conf?.description || '',
      registration_url: conf?.registration_url || '',
      raffle_url: conf?.raffle_url || '',
      subscription_mode: conf?.subscription_mode || 'none',
      telegram_chat_ids: conf?.telegram_chat_ids || '',
    }))
  }, [conf])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    // Валидация telegram_chat_ids
    setChatIdsError('')
    if (form.telegram_chat_ids.trim()) {
      const parts = form.telegram_chat_ids.split(',').map((s: string) => s.trim()).filter(Boolean)
      if (parts.length === 0 || form.telegram_chat_ids.trim().indexOf(',') === -1 && parts.length > 1) {
        setChatIdsError('Вводите ID через запятую')
        return
      }
      const invalid = parts.filter((p: string) => !/^-?\d+$/.test(p))
      if (invalid.length > 0) {
        setChatIdsError(`Не удалось распознать: ${invalid.join(', ')} — ID должны быть числами`)
        return
      }
    }
    setSaving(true); setSaved(false)
    try {
      await api.events.update(eventId, { title: form.title })
      const updated = await api.conference.update(eventId, {
        description: form.description || null,
        registration_url: form.registration_url || null,
        raffle_url: form.raffle_url || null,
        subscription_mode: form.subscription_mode,
        telegram_chat_ids: form.telegram_chat_ids || null,
      } as any)
      onConfUpdated(updated.conference)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setSaving(false)
    }
  }

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
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Ссылка на информацию про розыгрыш
            <span className="text-gray-400 font-normal ml-1">— для шаблона «Итоги дня»</span>
          </label>
          <input type="url" value={form.raffle_url} onChange={set('raffle_url')}
            placeholder="https://..."
            className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            ID Telegram-чатов/каналов события
            <span className="text-gray-400 font-normal ml-1">— через запятую, будут добавлены в рассылки</span>
          </label>
          <input type="text" value={form.telegram_chat_ids} onChange={set('telegram_chat_ids')}
            placeholder="-1001234567890, -1009876543210"
            className={`w-full px-4 py-2.5 rounded-xl border text-sm focus:outline-none font-mono ${chatIdsError ? 'border-red-400 bg-red-50' : 'border-gray-200 focus:border-brand'}`} />
          {chatIdsError && <p className="text-xs text-red-500 mt-1">{chatIdsError}</p>}
          <p className="text-xs text-gray-400 mt-1">Узнать ID канала: перешли любое сообщение из него боту @userinfobot</p>
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

      {/* Публичные ссылки — внизу */}
      <PublicLinks slug={event?.slug} />
    </div>
  )
}
