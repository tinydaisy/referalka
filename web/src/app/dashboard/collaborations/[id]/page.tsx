'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, ExternalLink, Check, AlertTriangle, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Spinner } from '@/components/Spinner'
import { useLang } from '@/contexts/LangContext'
import { ImageThumb } from '@/components/ImagePreview'

const IMPORTANT_FIELDS: { key: string; label: string }[] = [
  { key: 'name', label: 'Имя и фамилия' },
  { key: 'title', label: 'Должность / специализация' },
  { key: 'achievements', label: 'Регалии' },
  { key: 'photo_url', label: 'Фото' },
  { key: 'poster_url', label: 'Афиша' },
  { key: 'tg_channel_url', label: 'Ссылка на Telegram-канал' },
  { key: 'tg_channel_id', label: 'ID канала' },
  { key: 'personal_tg_id', label: 'ID личного аккаунта' },
  { key: 'personal_tg_username', label: 'Ник личного аккаунта' },
]

function getMissingFields(form: any): string[] {
  return IMPORTANT_FIELDS
    .filter(f => {
      const v = form[f.key]
      if (Array.isArray(v)) return v.length === 0
      return !v || String(v).trim() === ''
    })
    .map(f => f.label)
}

function WarningPopup({ missing, onClose }: { missing: string[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])
  return (
    <div ref={ref} className="absolute right-0 top-full mt-2 z-50 bg-white border border-amber-200 rounded-2xl shadow-lg p-4 w-72">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-sm text-gray-900">Не заполнены важные поля</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5 rounded"><X size={14} /></button>
      </div>
      <ul className="space-y-1.5">
        {missing.map(label => (
          <li key={label} className="flex items-center gap-2 text-sm text-gray-700">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function CollaborationPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const { t } = useLang()
  const collaboratorId = parseInt(params.id)
  const [form, setForm] = useState<any>(null)
  const [achievementsText, setAchievementsText] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [showWarning, setShowWarning] = useState(false)

  useEffect(() => {
    api.collaborators.get(collaboratorId)
      .then(r => {
        setForm(r.collaborator)
        const ach = r.collaborator.achievements
        setAchievementsText(Array.isArray(ach) ? ach.join('\n') : (ach || ''))
      })
      .catch(() => router.push('/dashboard/collaborations'))
      .finally(() => setLoading(false))
  }, [collaboratorId])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f: any) => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(''); setSaved(false)
    try {
      const achievements = achievementsText
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
      const updates = {
        name: form.name,
        title: form.title,
        achievements,
        photo_url: form.photo_url,
        poster_url: form.poster_url,
        photo_folder_url: form.photo_folder_url,
        video_folder_url: form.video_folder_url,
        tg_channel_url: form.tg_channel_url,
        instagram_url: form.instagram_url,
        website_url: form.website_url,
        tg_channel_id: form.tg_channel_id,
        personal_tg_id: form.personal_tg_id,
        personal_tg_username: form.personal_tg_username,
        assistant_tg_username: form.assistant_tg_username,
      }
      await api.collaborators.update(collaboratorId, updates)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-brand rounded-full border-t-transparent animate-spin" />
      </div>
    )
  }
  if (!form) return null

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-8">
        <Link href="/dashboard/collaborations" className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <div className="flex items-center gap-3 flex-1">
          {form.photo_url && (
            <ImageThumb url={form.photo_url} alt={form.name} />
          )}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{form.name}</h1>
            {form.title && <p className="text-gray-500 text-sm">{form.title}</p>}
          </div>
        </div>
        {(() => {
          const missing = getMissingFields(form)
          if (missing.length === 0) return null
          return (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowWarning(v => !v)}
                className="p-2 rounded-xl hover:bg-amber-50 transition-colors"
                title="Не заполнены важные поля"
              >
                <AlertTriangle size={20} className="text-amber-400" />
              </button>
              {showWarning && (
                <WarningPopup missing={missing} onClose={() => setShowWarning(false)} />
              )}
            </div>
          )
        })()}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.basicInfo}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.nameRequired}</label>
            <input type="text" value={form.name || ''} onChange={set('name')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.position}</label>
            <input type="text" value={form.title || ''} onChange={set('title')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.achievements}</label>
            <textarea value={achievementsText} onChange={e => setAchievementsText(e.target.value)} rows={5}
              placeholder={'Регалия 1\nРегалия 2\nРегалия 3'}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand resize-y" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.media}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photo}</label>
            <div className="flex gap-2">
              <input type="url" value={form.photo_url || ''} onChange={set('photo_url')} placeholder="https://..."
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              <ImageThumb url={form.photo_url} alt={form.name} />
              {form.photo_url && (
                <a href={form.photo_url} target="_blank" rel="noopener"
                  className="px-3 py-2.5 rounded-xl border border-gray-200 text-gray-500 hover:text-brand transition-colors">
                  <ExternalLink size={15} />
                </a>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.posterUrl}</label>
            <div className="flex gap-2">
              <input type="url" value={form.poster_url || ''} onChange={set('poster_url')} placeholder="https://..."
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
              <ImageThumb url={form.poster_url} alt={`Афиша ${form.name}`} />
              {form.poster_url && (
                <a href={form.poster_url} target="_blank" rel="noopener"
                  className="px-3 py-2.5 rounded-xl border border-gray-200 text-gray-500 hover:text-brand transition-colors">
                  <ExternalLink size={15} />
                </a>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.photoFolder}</label>
              <input type="url" value={form.photo_folder_url || ''} onChange={set('photo_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.videoFolder}</label>
              <input type="url" value={form.video_folder_url || ''} onChange={set('video_folder_url')}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.contacts}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.instagram}</label>
            <input type="url" value={form.instagram_url || ''} onChange={set('instagram_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.website}</label>
            <input type="url" value={form.website_url || ''} onChange={set('website_url')}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
          <h2 className="font-semibold text-gray-900">{t.fields.accounts}</h2>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.telegram}</label>
            <input type="url" value={form.tg_channel_url || ''} onChange={set('tg_channel_url')}
              placeholder="https://t.me/username"
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.channelId}</label>
              <input type="text" value={form.tg_channel_id || ''} onChange={set('tg_channel_id')}
                placeholder="-100123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountId}</label>
              <input type="text" value={form.personal_tg_id || ''} onChange={set('personal_tg_id')}
                placeholder="123456789"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.personalAccountUsername}</label>
              <input type="text" value={form.personal_tg_username || ''} onChange={set('personal_tg_username')}
                placeholder="@username"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t.fields.assistantAccount}</label>
              <input type="text" value={form.assistant_tg_username || ''} onChange={set('assistant_tg_username')}
                placeholder="@assistant"
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-brand" />
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{error}</div>
        )}

        <div className="flex gap-3 items-center">
          <button type="submit" disabled={saving}
            className={`btn-gold flex-1 py-3 rounded-xl font-semibold flex items-center justify-center gap-2 ${saving ? 'btn-loading' : ''}`}>
            {saving ? <><Spinner /> {t.common.saving}</> : <><Save size={16} /> {t.common.save}</>}
          </button>
          <Link href="/dashboard/collaborations"
            className="px-6 py-3 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            {t.common.back}
          </Link>
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <Check size={15} /> {t.common.saved}
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
